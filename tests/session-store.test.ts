// T5 会话数据存储层测试：原子写往返 / 追加 / 损坏容忍与备份 / 删除清理 / 孤儿清理 / id 校验
// （对应 ①：每会话整写 JSON + tmp/rename 原子替换，弃 JSONL）

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  saveSessions,
  loadSessions,
  sanitizeSessionMeta,
  sweepSessionStore
} from '../src/main/sessions/registry'
import {
  accumulateStats,
  appendSessionTurns,
  deleteSessionData,
  isSessionRegistered,
  isValidSessionId,
  loadSessionMessages,
  pruneOrphanSessionData,
  saveSessionMessages,
  type PersistedMessage,
  type SessionStats
} from '../src/main/sessions/session-store'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aemeath-sess-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function msg(id: string, role: 'user' | 'assistant', text: string): PersistedMessage {
  return { id, role, ts: 1700000000000, text }
}

function stats(rounds: number, inputTok: number, outputTok: number, llmMs: number): SessionStats {
  return {
    rounds,
    steps: 0,
    toolMs: 0,
    inputTok,
    outputTok,
    llmMs,
    cachedTok: Math.floor(inputTok * 0.8),
    cacheKnown: true,
    ttftMsLast: 900,
    ttftMsSum: 900 * rounds,
    tpsLast: 123,
    samples: rounds
  }
}

describe('session-store', () => {
  it('保存后原样读回（往返）', () => {
    const messages = [msg('m-1', 'user', '你好'), msg('m-2', 'assistant', '嗨呀，来啦？')]
    saveSessionMessages(dir, 's-a', messages)
    const loaded = loadSessionMessages(dir, 's-a')
    expect(loaded).toEqual({ ok: true, messages })
  })

  it('追加按顺序累积；读取上限由调用方控制', () => {
    appendSessionTurns(dir, 's-b', [msg('m-1', 'user', '第一问')])
    appendSessionTurns(dir, 's-b', [msg('m-2', 'assistant', '第一答')])
    appendSessionTurns(dir, 's-b', [msg('m-3', 'user', '第二问')])
    const loaded = loadSessionMessages(dir, 's-b')
    expect(loaded.ok && loaded.messages.map((m) => m.text)).toEqual(['第一问', '第一答', '第二问'])
  })

  it('原子写不残留 .tmp 文件', () => {
    saveSessionMessages(dir, 's-c', [msg('m-1', 'user', 'hi')])
    appendSessionTurns(dir, 's-c', [msg('m-2', 'assistant', 'yo')])
    const dataDir = join(dir, 'data')
    const leftovers = existsSync(dataDir)
      ? readdirSync(dataDir).filter((n) => n.endsWith('.tmp'))
      : []
    expect(leftovers).toEqual([])
  })

  it('缺失会话返回 missing；非法 id 一律按 missing 处理且拒绝路径穿越', () => {
    expect(loadSessionMessages(dir, 's-none')).toEqual({ ok: false, reason: 'missing' })
    expect(loadSessionMessages(dir, '../escape')).toEqual({ ok: false, reason: 'missing' })
    expect(isValidSessionId('a/b')).toBe(false)
    expect(isValidSessionId('..')).toBe(false)
    expect(isValidSessionId('s-abc_123')).toBe(true)
  })

  it('损坏文件：读取报 corrupt；追加时自动备份 .corrupt-* 并从新消息起始', () => {
    mkdirSync(join(dir, 'data'), { recursive: true })
    writeFileSync(join(dir, 'data', 's-bad.json'), '{ 不是 JSON', 'utf8')
    expect(loadSessionMessages(dir, 's-bad')).toEqual({ ok: false, reason: 'corrupt' })

    appendSessionTurns(dir, 's-bad', [msg('m-1', 'user', '重新开始')])
    const loaded = loadSessionMessages(dir, 's-bad')
    expect(loaded.ok && loaded.messages.map((m) => m.text)).toEqual(['重新开始'])
    // 备份文件存在且内容可读（数据不丢）
    const dataDir = join(dir, 'data')
    const backups = readdirSync(dataDir).filter((n) => n.includes('.corrupt-'))
    expect(backups.length).toBe(1)
    expect(readFileSync(join(dataDir, backups[0]), 'utf8')).toContain('不是 JSON')
  })

  it('结构合法但含坏条目：坏行跳过，好行保留', () => {
    const file = join(dir, 'data', 's-mixed.json')
    mkdirSync(join(dir, 'data'), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        messages: [
          { id: 'm-1', role: 'user', ts: 1, text: '好的' },
          { id: 'm-2', role: 'system', ts: 2, text: '不该出现的角色' },
          { id: 'm-3', ts: 3, text: '缺 role' },
          { id: 'm-4', role: 'assistant', ts: 4, text: '正常回复' }
        ]
      })
    )
    const loaded = loadSessionMessages(dir, 's-mixed')
    expect(loaded.ok && loaded.messages.map((m) => m.id)).toEqual(['m-1', 'm-4'])
  })

  it('删除会话：数据文件与损坏备份一并清理', () => {
    saveSessionMessages(dir, 's-del', [msg('m-1', 'user', 'bye')])
    mkdirSync(join(dir, 'data'), { recursive: true })
    writeFileSync(join(dir, 'data', 's-del.json.corrupt-123'), 'x', 'utf8')
    deleteSessionData(dir, 's-del')
    expect(existsSync(join(dir, 'data', 's-del.json'))).toBe(false)
    expect(existsSync(join(dir, 'data', 's-del.json.corrupt-123'))).toBe(false)
  })

  it('孤儿清理：不在 validIds 中的数据文件被删除，在册的不动', () => {
    saveSessionMessages(dir, 's-keep', [msg('m-1', 'user', '留')])
    saveSessionMessages(dir, 's-gone', [msg('m-1', 'user', '走')])
    const removed = pruneOrphanSessionData(dir, ['s-keep'])
    expect(removed).toBe(1)
    expect(loadSessionMessages(dir, 's-keep').ok).toBe(true)
    expect(loadSessionMessages(dir, 's-gone')).toEqual({ ok: false, reason: 'missing' })
  })

  it('遥测累加：appendSessionTurns 带 statsDelta 跨轮累计，last 类字段取最新', () => {
    appendSessionTurns(
      dir,
      's-stats',
      [msg('m-1', 'user', 'q1'), msg('m-2', 'assistant', 'a1')],
      undefined,
      stats(1, 4200, 120, 3000)
    )
    appendSessionTurns(
      dir,
      's-stats',
      [msg('m-3', 'user', 'q2'), msg('m-4', 'assistant', 'a2')],
      undefined,
      stats(1, 4500, 200, 3500)
    )
    const loaded = loadSessionMessages(dir, 's-stats')
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    const s = loaded.stats!
    expect(s.rounds).toBe(2)
    expect(s.inputTok).toBe(8700)
    expect(s.outputTok).toBe(320)
    expect(s.llmMs).toBe(6500)
    expect(s.cachedTok).toBe(Math.floor(8700 * 0.8))
    expect(s.cacheKnown).toBe(true)
    expect(s.samples).toBe(2)
  })

  it('accumulateStats 纯函数：base 缺省全零起算', () => {
    const next = accumulateStats(undefined, stats(1, 100, 10, 500))
    expect(next.rounds).toBe(1)
    expect(next.inputTok).toBe(100)
    expect(next.ttftMsSum).toBe(900)
  })

  it('★ accumulateStats：ttftMsSum 累加 delta 的 sum（不是 last！），last 取最新', () => {
    // 回归 合并曾写 b.sum + delta.ttftMsLast，多轮存档"平均首 token"被顶成
    // 最后一轮值。用 sum≠last 的 delta 才抓得住（rounds=1 时二者相等会假绿）。
    const base: SessionStats = { ...stats(3, 300, 30, 1500), ttftMsSum: 2400, ttftMsLast: 800 }
    const delta: SessionStats = { ...stats(2, 200, 20, 1000), ttftMsSum: 500, ttftMsLast: 300 }
    const next = accumulateStats(base, delta)
    expect(next.rounds).toBe(5)
    expect(next.ttftMsSum).toBe(2900) // 2400 + 500（delta.sum），不是 2400+300
    expect(next.ttftMsLast).toBe(300) // last 取最新 delta
  })

  it('预留点①：toolCalls / toolCallId 原样往返', () => {
    const withCalls: PersistedMessage = {
      ...msg('m-1', 'assistant', '我看看'),
      toolCalls: [{ id: 'tc-1', name: 'read_file', argsJson: '{"path":"a.txt"}' }],
      toolCallId: undefined
    }
    const withResult: PersistedMessage = {
      ...msg('m-2', 'user', '[工具结果] ...'),
      toolCallId: 'tc-1'
    }
    const withNull: PersistedMessage = { ...msg('m-3', 'assistant', '纯文本'), toolCalls: null }
    saveSessionMessages(dir, 's-tools', [withCalls, withResult, withNull])
    const loaded = loadSessionMessages(dir, 's-tools')
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.messages[0].toolCalls).toEqual([
      { id: 'tc-1', name: 'read_file', argsJson: '{"path":"a.txt"}' }
    ])
    expect(loaded.messages[1].toolCallId).toBe('tc-1')
    expect(loaded.messages[2].toolCalls).toBeNull()
  })

  it('预留点①：结构非法的 toolCalls 条目剔除、合法条目保留', () => {
    // 故意混入非法条目验证过滤（正常代码不可表达，模拟手改/损坏文件）
    const raw: PersistedMessage = {
      ...msg('m-1', 'assistant', 'x'),
      toolCalls: [
        { id: 'ok-1', name: 'tool_a', argsJson: '{}' },
        { id: 42, name: 'bad', argsJson: '{}' }
      ] as unknown as PersistedMessage['toolCalls']
    }
    saveSessionMessages(dir, 's-badtool', [raw])
    const loaded = loadSessionMessages(dir, 's-badtool')
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.messages[0].toolCalls).toEqual([{ id: 'ok-1', name: 'tool_a', argsJson: '{}' }])
  })

  it('isSessionRegistered：在册 true / 可读但不在册 false / index 缺失或损坏 fail-open true', () => {
    // 可读注册表：仅含 s-live
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'index.json'),
      JSON.stringify({
        v: 1,
        sessions: [{ id: 's-live', title: 't', createdAt: 1, updatedAt: 1 }]
      }),
      'utf8'
    )
    expect(isSessionRegistered(dir, 's-live')).toBe(true)
    expect(isSessionRegistered(dir, 's-deleted')).toBe(false)
    // index 缺失（新装/未同步）：fail-open 保数据
    rmSync(join(dir, 'index.json'))
    expect(isSessionRegistered(dir, 's-any')).toBe(true)
    // index 损坏：fail-open 保数据
    writeFileSync(join(dir, 'index.json'), 'not json{', 'utf8')
    expect(isSessionRegistered(dir, 's-any')).toBe(true)
  })
})

describe('sanitizeSessionMeta 模式字段', () => {
  it('合法 mode 透传；非法/缺失不落字段（读取侧按 work）', () => {
    const base = { id: 's1', title: 't', createdAt: 1, updatedAt: 2 }
    expect(sanitizeSessionMeta({ ...base, mode: 'learn' })?.mode).toBe('learn')
    expect(sanitizeSessionMeta({ ...base, mode: 'chat' })?.mode).toBe('chat')
    expect(sanitizeSessionMeta({ ...base, mode: 'work' })?.mode).toBe('work')
    expect(sanitizeSessionMeta(base)?.mode).toBeUndefined()
    expect(sanitizeSessionMeta({ ...base, mode: 'hacker' })?.mode).toBeUndefined()
    expect(sanitizeSessionMeta({ ...base, mode: 42 })?.mode).toBeUndefined()
  })
})

describe('sanitizeSessionMeta 置顶字段', () => {
  it('pinned=true 透传；缺失/脏值不落字段（读取侧按未置顶）', () => {
    const base = { id: 's1', title: 't', createdAt: 1, updatedAt: 2 }
    expect(sanitizeSessionMeta({ ...base, pinned: true })?.pinned).toBe(true)
    expect(sanitizeSessionMeta(base)?.pinned).toBeUndefined()
    expect(sanitizeSessionMeta({ ...base, pinned: false })?.pinned).toBeUndefined()
    expect(sanitizeSessionMeta({ ...base, pinned: 'yes' })?.pinned).toBeUndefined()
    expect(sanitizeSessionMeta({ ...base, pinned: 1 })?.pinned).toBeUndefined()
  })
})

describe('sweepSessionStore 一致性清扫', () => {
  const NOW = 1_800_000_000_000
  const OLD = NOW - 72 * 3600 * 1000 // 72h 前
  const YOUNG = NOW - 3600 * 1000 // 1h 前

  it('孤儿条目（无数据文件且过期）清除；年轻空会话与正常会话保留', () => {
    saveSessions(dir, [
      { id: 's-old-orphan', title: '老孤儿', createdAt: OLD, updatedAt: OLD }, // 无文件+过期 → 清
      { id: 's-young-empty', title: '新建未发言', createdAt: YOUNG, updatedAt: YOUNG }, // 无文件+年轻 → 留
      { id: 's-normal', title: '正常', createdAt: OLD, updatedAt: NOW } // 有文件 → 留
    ])
    mkdirSync(join(dir, 'data'), { recursive: true })
    writeFileSync(join(dir, 'data', 's-normal.json'), '{"messages":[]}', 'utf8')

    const r = sweepSessionStore(dir, {}, { now: NOW })
    expect(r.prunedRegistry).toEqual(['s-old-orphan'])
    const left = loadSessions(dir).map((x) => x.id)
    expect(left).toContain('s-young-empty')
    expect(left).toContain('s-normal')
    expect(left).not.toContain('s-old-orphan')
  })

  it('.bak/.tmp 残留清除；孤儿旁路档清除、在册会话档保留', () => {
    saveSessions(dir, [{ id: 's-keep', title: 't', createdAt: OLD, updatedAt: NOW }])
    mkdirSync(join(dir, 'data'), { recursive: true })
    writeFileSync(join(dir, 'data', 's-keep.json'), '{}', 'utf8')
    writeFileSync(join(dir, 'data', 's-keep.json.bak'), '{}', 'utf8')
    writeFileSync(join(dir, 'data', 's-keep.json.tmp'), '{}', 'utf8')
    const ledgerDir = join(dir, 'ledger')
    const todosDir = join(dir, 'todos')
    mkdirSync(ledgerDir, { recursive: true })
    mkdirSync(todosDir, { recursive: true })
    writeFileSync(join(ledgerDir, 's-keep.json'), '{}', 'utf8') // 在册 → 留
    writeFileSync(join(ledgerDir, 's-gone.json'), '{}', 'utf8') // 不在册 → 清
    writeFileSync(join(todosDir, 's-gone.json'), '{}', 'utf8')

    const r = sweepSessionStore(dir, { ledger: ledgerDir, todos: todosDir }, { now: NOW })
    expect(r.removedResiduals).toBe(2)
    expect(r.cleanedArchives).toBe(2)
    expect(existsSync(join(dir, 'data', 's-keep.json.bak'))).toBe(false)
    expect(existsSync(join(ledgerDir, 's-keep.json'))).toBe(true)
    expect(existsSync(join(ledgerDir, 's-gone.json'))).toBe(false)
    expect(existsSync(join(todosDir, 's-gone.json'))).toBe(false)
  })
})
