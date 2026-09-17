// 上下文压缩单测（P8-T1）：阈值 / 切点 / 转写 / 提示词 / 溢出识别全是纯函数。
// 最要紧的两条守护：
// ① **切点绝不切开 assistant(tool_calls) ↔ tool(result) 配对**（切开必被服务端 400）；
// ② 只有在拿到**真实 usage** 且窗口已设置时才触发（不知道占用就不压：压错更难查）。

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatTurn } from '../src/main/llm/client'
import {
  COMPACT_RESERVE_TOKENS,
  DEFAULT_COMPACT_POLICY,
  buildCompactedView,
  buildSummaryPrompt,
  compactResultNotice,
  estimateTurnTokens,
  fmtKTokens,
  isContextOverflowError,
  pickCompactCut,
  renderTranscript,
  resolveCompactPolicy,
  shouldCompact
} from '../src/main/chat/compact'
import {
  COMPACT_SUMMARY_MAX_CHARS,
  clearCompactSummary,
  readCompactSummary,
  setCompactBase,
  writeCompactSummary
} from '../src/main/chat/compact-store'

const sys: ChatTurn = { role: 'system', content: '系统提示' }
const user = (text: string): ChatTurn => ({ role: 'user', content: text })
const assistant = (text: string, calls?: string[]): ChatTurn => ({
  role: 'assistant',
  content: text,
  ...(calls === undefined
    ? {}
    : {
        tool_calls: calls.map((name, i) => ({
          id: `c${i}`,
          type: 'function' as const,
          function: { name, arguments: '{}' }
        }))
      })
})
const tool = (id: string, text: string): ChatTurn => ({
  role: 'tool',
  content: text,
  tool_call_id: id
})

/** 造一条大约 tokens 量级的长文本（1 token ≈ 1.6 字符） */
const filler = (tokens: number): string => 'x'.repeat(Math.ceil(tokens * 1.6))

describe('compact · token 估算与阈值', () => {
  it('文本按 1 token ≈ 1.6 字符折算；图片 part 按既有口径折 1000 token', () => {
    expect(estimateTurnTokens(user(filler(100)))).toBe(100)
    expect(
      estimateTurnTokens({
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:x' } }]
      })
    ).toBe(1000)
    expect(estimateTurnTokens({ role: 'assistant', content: null })).toBe(0)
  })

  it('没拿到真实 usage → 不压（宁可不压，也不瞎猜占用）', () => {
    expect(shouldCompact({ usedTokens: null, contextWindow: 128000 })).toBe(false)
    expect(shouldCompact({ usedTokens: Number.NaN, contextWindow: 128000 })).toBe(false)
  })

  it('窗口未设置（context ≤ 0）→ 不压（无从谈阈值）', () => {
    expect(shouldCompact({ usedTokens: 999999, contextWindow: 0 })).toBe(false)
  })

  it('越过"窗口 − 余量"才压；余量默认 16K', () => {
    const window = 100_000
    const usable = window - COMPACT_RESERVE_TOKENS
    expect(shouldCompact({ usedTokens: usable, contextWindow: window })).toBe(false)
    expect(shouldCompact({ usedTokens: usable + 1, contextWindow: window })).toBe(true)
  })

  it('未设置窗口 / 极小窗口不炸（20K 窗口按比例缩，仍能触发）', () => {
    expect(shouldCompact({ usedTokens: 999_999, contextWindow: 0 })).toBe(false)
    // 20K 窗口：余量 5K、保留 7.5K → 阈值 15K；20K 用量已越线
    expect(shouldCompact({ usedTokens: 20_000, contextWindow: 20_000 })).toBe(true)
    expect(shouldCompact({ usedTokens: 9_000, contextWindow: 20_000 })).toBe(false)
  })

  it('★ 小窗口也按比例压（回归 owner 实测：32K 窗口 89.4% 却永不触发）', () => {
    // 32K 窗口：余量缩到 8.2K、保留区 12.3K → 阈值 24.6K
    const p32 = resolveCompactPolicy(32_768)
    expect(p32.reserveTokens).toBe(8_192)
    expect(p32.keepRecentTokens).toBe(Math.floor((32_768 - 8_192) * 0.5))
    expect(shouldCompact({ usedTokens: 29_300, contextWindow: 32_768 })).toBe(true)
    expect(shouldCompact({ usedTokens: 20_000, contextWindow: 32_768 })).toBe(false)
    // 大窗口保持 Pi 原口径（余量 16K、保留 20K），行为不变
    expect(resolveCompactPolicy(128_000)).toEqual({
      reserveTokens: 16_384,
      keepRecentTokens: 20_000
    })
    // 极小窗口：至少留 1K 保留区，不出现 0
    const tiny = resolveCompactPolicy(6_000)
    expect(tiny.keepRecentTokens).toBeGreaterThanOrEqual(1_000)
    // 未设置窗口 → 原样返回（不压缩，与 shouldCompact 的早退一致）
    expect(resolveCompactPolicy(0)).toEqual(DEFAULT_COMPACT_POLICY)
  })

  it('策略可覆盖（子代理/单测可给更小的余量）', () => {
    const policy = { reserveTokens: 1_000, keepRecentTokens: 500 }
    // 可用额度 = 5000 − 1000 = 4000
    expect(shouldCompact({ usedTokens: 4_100, contextWindow: 5_000, policy })).toBe(true)
    expect(shouldCompact({ usedTokens: 900, contextWindow: 5_000, policy })).toBe(false)
  })
})

describe('compact · 切点（pickCompactCut）', () => {
  const view = (): ChatTurn[] => [
    sys,
    user(filler(2000)),
    assistant(filler(2000)),
    user(filler(100)),
    assistant('', ['read_file']),
    tool('c0', filler(100)),
    user(filler(100))
  ]

  it('全在保留窗口内 → null（没什么可丢的）', () => {
    expect(pickCompactCut(view(), { reserveTokens: 1000, keepRecentTokens: 1_000_000 })).toBeNull()
  })

  it('丢掉旧的、保留最近的；system 永不进摘要', () => {
    const v = view()
    const cut = pickCompactCut(v, { reserveTokens: 1000, keepRecentTokens: 300 })
    expect(cut).not.toBeNull()
    if (cut === null) return
    expect(cut.dropped.some((t) => t.role === 'system')).toBe(false)
    expect(cut.dropped).toContain(v[1]) // 最老的 user 一定被丢
    expect(cut.kept.length).toBeGreaterThan(0)
    // 视图 = system + 全部切掉的 + 全部保留的（一条不丢、一条不重）
    expect(cut.dropped.length + cut.kept.length).toBe(v.length - 1)
  })

  it('★ 绝不切开 assistant(tool_calls) ↔ tool(result)：工具结果永远跟着它的调用', () => {
    // 保留区只有 50 token：会切到中间；无论切在哪，都不能出现"留下 tool 结果而丢掉调用"
    for (const keep of [10, 50, 120, 300, 500]) {
      const cut = pickCompactCut(view(), { reserveTokens: 1000, keepRecentTokens: keep })
      if (cut === null) continue
      const keptToolIds = cut.kept.filter((t) => t.role === 'tool').map((t) => t.tool_call_id)
      const keptCallIds = new Set(cut.kept.flatMap((t) => (t.tool_calls ?? []).map((c) => c.id)))
      for (const id of keptToolIds) expect(keptCallIds.has(id ?? '')).toBe(true)
      const droppedToolIds = cut.dropped.filter((t) => t.role === 'tool').map((t) => t.tool_call_id)
      const droppedCallIds = new Set(
        cut.dropped.flatMap((t) => (t.tool_calls ?? []).map((c) => c.id))
      )
      for (const id of droppedToolIds) expect(droppedCallIds.has(id ?? '')).toBe(true)
    }
  })

  it('超长的一组也会被完整保留（不会因为放不下就切一半）', () => {
    const oneShot: ChatTurn[] = [sys, user(filler(10)), assistant(filler(5000))]
    const cut = pickCompactCut(oneShot, { reserveTokens: 1000, keepRecentTokens: 100 })
    expect(cut?.kept).toHaveLength(1)
    expect(cut?.dropped).toHaveLength(1)
  })

  it('只剩 system → null', () => {
    expect(pickCompactCut([sys])).toBeNull()
    expect(pickCompactCut([])).toBeNull()
  })

  it('★ 真实用量参与切点：字符口径够不着保留区，也要按真实占用压掉（owner 实测踩到两轮）', () => {
    const v = view() // body 字符口径 = 2000+2000+100+100+100 ≈ 4300 token
    const tight = { reserveTokens: 1000, keepRecentTokens: 1_000 }
    // 不给真实值：按估算攒保留区，只丢最老两组（g1/g2）
    const noActual = pickCompactCut(v, tight, null)
    expect(noActual).not.toBeNull()
    expect(noActual!.dropped).toHaveLength(2)
    // 给上真实占用（30K ≈ 估算的 7 倍）：保留区折算成估算单位 ≈ 1000/7 ≈ 143 →
    // 只留住最后一组（工具配对那组一起被丢掉），丢掉的四组共 5 条才是真正省下来的
    const withActual = pickCompactCut(v, tight, 30_000)
    expect(withActual!.dropped).toHaveLength(5)
    expect(withActual!.kept).toHaveLength(1)
    // 折算比透出给调用方（"省下约 N token"按真实口径报，不折算会小一大截）
    expect(withActual!.scale).toBeCloseTo(30_000 / 4_300, 1)
    expect(noActual!.scale).toBe(1)
    expect(tight.keepRecentTokens).toBe(1_000) // 入参不被改写
    // 真实值 ≤ 估算 → 比值不放大，与旧口径逐条一致
    expect(pickCompactCut(v, tight, 100)!.dropped).toEqual(noActual!.dropped)
    // 没有真实值（也没有窗口下限）时永不凭空放大：全视图塞得进保留区就是无可压
    expect(pickCompactCut(v, { reserveTokens: 1000, keepRecentTokens: 100_000 })).toBeNull()
  })
})

describe('compact · 压缩后的验收气泡（compactResultNotice）', () => {
  it('fmtKTokens：不足 K 取整、K 以上一位小数（去 .0）、非法给 ?', () => {
    expect(fmtKTokens(129)).toBe('129')
    expect(fmtKTokens(17_733)).toBe('17.7K')
    expect(fmtKTokens(10_000)).toBe('10K')
    expect(fmtKTokens(Number.NaN)).toBe('?')
  })

  it('压回窗口内 → null（不刷屏，压缩当下那条中性气泡已够）', () => {
    expect(
      compactResultNotice({
        after: 9000,
        contextWindow: 32768,
        bodyTokensAfter: 4000,
        droppedCount: 10
      })
    ).toBeNull()
  })

  it('没有真实 usage / 窗口未设置 → null（不知道就不评）', () => {
    expect(
      compactResultNotice({
        after: null,
        contextWindow: 32768,
        bodyTokensAfter: 100,
        droppedCount: 3
      })
    ).toBeNull()
    expect(
      compactResultNotice({ after: 99999, contextWindow: 0, bodyTokensAfter: 100, droppedCount: 3 })
    ).toBeNull()
  })

  it('★ 压完仍超窗口且固定占用 ≥2K：点明"什么压不掉"+ 给建议（owner 实测 136 字符/17.7K 案）', () => {
    // 正文只剩 ~400 token 估算，真实占用 17.7K → 固定占用 ≈ 17.3K
    const note = compactResultNotice({
      after: 17_733,
      contextWindow: 10_000,
      bodyTokensAfter: 400,
      droppedCount: 3
    })
    expect(note).not.toBeNull()
    expect(note).toContain('17.7K')
    expect(note).toContain('10K')
    expect(note).toContain('固定占用')
    expect(note).toContain('人设')
    expect(note).toContain('工具')
    expect(note).toContain('32K')
    expect(note).toContain('3 条')
  })

  it('超窗口但固定占用不大（历史本身长）：给"继续压缩/调大窗口"的通用文案', () => {
    const note = compactResultNotice({
      after: 41_000,
      contextWindow: 32_768,
      bodyTokensAfter: 40_000,
      droppedCount: 2
    })
    expect(note).not.toBeNull()
    expect(note).toContain('41K')
    expect(note).not.toContain('固定占用')
  })
})

describe('compact · 转写与提示词', () => {
  it('转写带角色前缀、工具调用与图片占位', () => {
    const text = renderTranscript([
      user('你好'),
      assistant('我看下', ['read_file']),
      tool('c0', '文件内容'),
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }] }
    ])
    expect(text).toContain('用户：你好')
    expect(text).toContain('助手：我看下')
    expect(text).toContain('read_file')
    expect(text).toContain('工具结果：文件内容')
    expect(text).toContain('[图片]')
  })

  it('超长消息头尾保留（中间省略）、总量有上限', () => {
    const text = renderTranscript([user('A'.repeat(5000))])
    expect(text).toContain('（略）')
    expect(text.length).toBeLessThan(3000)
    const capped = renderTranscript([user(filler(2000)), user(filler(2000))], 500)
    expect(capped.length).toBeLessThanOrEqual(2000)
  })

  it('首次摘要：只带片段；二次摘要：合并重写（不出流水账口径）', () => {
    const first = buildSummaryPrompt({ previous: null, transcript: '用户：甲' })
    expect(first).toContain('用户：甲')
    expect(first).not.toContain('已有摘要')
    const second = buildSummaryPrompt({ previous: '【进度】做了一半', transcript: '用户：乙' })
    expect(second).toContain('【进度】做了一半')
    expect(second).toContain('用户：乙')
    expect(second).toContain('合并重写')
  })

  it('提示词要的是交接单五段（进度/决策/约束/待办/数据）', () => {
    const p = buildSummaryPrompt({ previous: null, transcript: 'x' })
    for (const seg of [
      '【进度】',
      '【决策与理由】',
      '【用户的要求与约束】',
      '【待办】',
      '【关键数据】'
    ]) {
      expect(p).toContain(seg)
    }
  })
})

describe('compact · 压缩后的视图', () => {
  it('形态 = system + 转述轮 + 保留原文；转述轮明说"不是用户原话"', () => {
    const kept = [user('最近一句')]
    const out = buildCompactedView([sys, user('老的')], kept, '【进度】已完成 A')
    expect(out).toHaveLength(3)
    expect(out[0].role).toBe('system')
    expect(out[1].role).toBe('user') // 用 user 角色：中途插 system 会被部分端点拒
    const note = String(out[1].content)
    expect(note).toContain('压缩转述')
    expect(note).toContain('不是用户的原话')
    expect(note).toContain('【进度】已完成 A')
    expect(out[2]).toEqual(kept[0])
  })
})

describe('compact · 溢出自救的错误识别', () => {
  it('各家"超限"措辞都认（要能触发压缩后重试）', () => {
    const cases = [
      "400 This model's maximum context length is 128000 tokens",
      'context_length_exceeded',
      'Input is too long for requested model',
      'Prompt is too long: 250000 tokens > 200000',
      'Range of input length should be [1, 30720]：输入长度超过上限',
      '请求的上下文长度超出限制'
    ]
    for (const c of cases) expect(isContextOverflowError(new Error(c))).toBe(true)
  })

  it('限流/审核/网络不算超限（重试一次只是白花钱、还拖慢）', () => {
    const cases = [
      '429 rate limit exceeded',
      'HTTP 400 data_inspection_failed',
      'content_policy_violation',
      'fetch failed',
      'API Key 无效'
    ]
    for (const c of cases) expect(isContextOverflowError(new Error(c))).toBe(false)
    expect(isContextOverflowError('随便一个字符串')).toBe(false)
  })
})

describe('compact · 默认策略常量', () => {
  it('保留 16K 余量 / 20K 近期原文（与 Codex、opencode、Pi 同档）', () => {
    expect(DEFAULT_COMPACT_POLICY.reserveTokens).toBe(16_384)
    expect(DEFAULT_COMPACT_POLICY.keepRecentTokens).toBe(20_000)
  })
})

describe('compact · 摘要落盘（compact-store）', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aemeath-compact-'))
    setCompactBase(dir)
  })

  afterEach(() => {
    setCompactBase('')
    rmSync(dir, { recursive: true, force: true })
  })

  it('写入 → 读回（跨 run 复用摘要的关键路径）', () => {
    expect(readCompactSummary('s-1')).toBeNull()
    expect(writeCompactSummary('s-1', '【进度】做了一半')).toBe(true)
    expect(readCompactSummary('s-1')).toBe('【进度】做了一半')
    expect(existsSync(join(dir, 's-1.json'))).toBe(true)
  })

  it('摘要文件坏掉 → 按"没有摘要"处理（最坏是多花一次摘要调用，不能炸）', () => {
    writeFileSync(join(dir, 's-2.json'), '{不是 JSON')
    expect(readCompactSummary('s-2')).toBeNull()
    writeFileSync(join(dir, 's-3.json'), '{"summary":"   "}')
    expect(readCompactSummary('s-3')).toBeNull()
  })

  it('超长摘要截断（压缩器自己不能变成新负担）', () => {
    writeCompactSummary('s-4', 'x'.repeat(COMPACT_SUMMARY_MAX_CHARS + 500))
    const back = readCompactSummary('s-4') ?? ''
    expect(back.length).toBeLessThan(COMPACT_SUMMARY_MAX_CHARS + 100)
    expect(back).toContain('摘要过长已截断')
  })

  it('非法会话 id（路径穿越）→ 一律拒绝', () => {
    expect(writeCompactSummary('../evil', 'x')).toBe(false)
    expect(readCompactSummary('../evil')).toBeNull()
    expect(existsSync(join(dir, '..', 'evil.json'))).toBe(false)
  })

  it('清摘要：会话被删后不留孤儿', () => {
    writeCompactSummary('s-5', '内容')
    clearCompactSummary('s-5')
    expect(readCompactSummary('s-5')).toBeNull()
  })
})
