// 上下文压缩（P8-T1）：把"更早的对话"摘要成一段交接转述，只作用于**发送视图**。
//
// 学谁（调研见 docs/交接文档/交接文档-P8.md §1.1）：
// - Pi（badlogic/pi-mono）：阈值触发 `tokens > 窗口 − reserveTokens`、用 **API 返回的真实
//   usage** 估 token、**增量合并**摘要（第二次压缩把"旧摘要 + 新丢段落"合并重写）、
//   溢出自救（收到超限 400 → 压缩后重试**一次**，标志位防循环）。
// - Codex CLI：压缩 prompt 是"给接手的人看的 handoff"，不是泛泛的对话总结。
// - OpenHands：**非破坏**——原文从不删除，只在视图里遮蔽（我们天然如此：会话档全量落盘）。
//
// 本文件只放**纯逻辑**（阈值 / 切点 / 转写 / 提示词 / 溢出识别），可 vitest 直测；
// 真正调用模型做摘要的胶水在 run.ts，持久化在 compact-store.ts。

import type { ChatTurn } from '../llm/client'
import { turnTextLength } from '../llm/client'

/** 触发余量：给系统提示、工具清单与本轮回复留的空间（Codex / opencode 同档 ~16K） */
export const COMPACT_RESERVE_TOKENS = 16_384
/** 压缩后保留的**最近原文**预算（Pi 同款 ~20K；按 token 而不是按轮数，轮有长有短） */
export const KEEP_RECENT_TOKENS = 20_000
/** 单次摘要调用超时（比普通对话宽松：要读进的原文可能很长，慢端点上 60s 会直接判死） */
export const SUMMARY_TIMEOUT_MS = 120_000
/** 送进摘要调用的原文上限（字符）——防"要压缩的东西本身就把摘要调用撑爆" */
export const SUMMARY_INPUT_MAX_CHARS = 120_000

/** 中英混合的粗估比例（与 run.ts 的裁剪公式同一口径） */
const CHARS_PER_TOKEN = 1.6

/** 一条消息折算多少 token（图片 part 按 turnTextLength 的既有口径折算） */
export function estimateTurnTokens(turn: ChatTurn): number {
  return Math.ceil(turnTextLength(turn) / CHARS_PER_TOKEN)
}

/**
 * 整个视图的 token 粗估（字符口径）。
 * 用途：**新 run 的第一轮没有真实 usage**（这个 run 还没发过请求）——
 * 只按 usage 判定的话，"一打开就已经 88%" 这种永远压不到（owner 实测踩到）。
 */
export function estimateViewTokens(view: readonly ChatTurn[]): number {
  return view.reduce((n, turn) => n + estimateTurnTokens(turn), 0)
}

export interface CompactPolicy {
  reserveTokens: number
  keepRecentTokens: number
}

export const DEFAULT_COMPACT_POLICY: CompactPolicy = {
  reserveTokens: COMPACT_RESERVE_TOKENS,
  keepRecentTokens: KEEP_RECENT_TOKENS
}

/**
 * 按**实际窗口**把保留区缩到合理比例（纯函数）。
 *
 * 为什么必须有这一步（实测踩到）：Pi 的 keepRecent 20K 是按 128K+ 窗口定的。
 * 用户把窗口设成 32K 时，`usable = 32K − 16K = 16K < 20K` → 旧逻辑直接判定
 * "窗口太小、压了也没意义" → **永远不压缩**，用量一路涨到 90% 什么都发生不了
 * （owner 实测：29.3K/32.8K = 89.4% 却纹丝不动）。
 * 现在保留区取 `min(20K, 可用额度的 50%)`：小窗口下也能压，且保留区仍然够模型干活。
 */
export function resolveCompactPolicy(
  contextWindow: number,
  base: CompactPolicy = DEFAULT_COMPACT_POLICY
): CompactPolicy {
  if (!(contextWindow > 0)) return base
  // 余量也跟着缩：窗口才 20K 却留 16K 余量的话，可用额度只剩 4K，压了等于失忆
  const reserveTokens = Math.min(
    base.reserveTokens,
    Math.max(2_000, Math.floor(contextWindow * 0.25))
  )
  const usable = contextWindow - reserveTokens
  if (usable <= 0) return base
  const keepRecentTokens = Math.max(
    1_000,
    Math.min(base.keepRecentTokens, Math.floor(usable * 0.5))
  )
  return { reserveTokens, keepRecentTokens }
}

/**
 * 该不该压缩（纯函数）。
 * **只在拿到真实 usage 时判断**：没有 usage = 不知道实际占用，宁可不压
 * （压错比不压更难查：摘要一丢，模型就"失忆"且看不出来）。
 * 窗口未设置（context ≤ 0）同样返回 false——没有窗口就无从谈阈值。
 */
export function shouldCompact(input: {
  usedTokens: number | null
  contextWindow: number
  policy?: CompactPolicy
}): boolean {
  const policy = input.policy ?? resolveCompactPolicy(input.contextWindow)
  if (input.usedTokens === null || !Number.isFinite(input.usedTokens)) return false
  if (!(input.contextWindow > 0)) return false
  const usable = input.contextWindow - policy.reserveTokens
  if (usable <= policy.keepRecentTokens) return false // 窗口太小：连保留区都放不下（正常窗口不会走到这）
  return input.usedTokens > usable
}

export interface CompactCut {
  dropped: ChatTurn[]
  kept: ChatTurn[]
  /**
   * 真实/估算 的折算比（≥1，不知道真实值时 = 1）。
   * 用途：把"估算省下多少 token"换算成**真实口径**再报给用户——估算系统性偏低，
   * 不换算的话提示里那个数会小一大截，用户会以为没压下来。
   */
  scale: number
}

/**
 * 把视图切成"可压缩的旧部分"与"必须保留的近期部分"（纯函数）。
 *
 * 切点粒度 = **轮组**：一条 user 消息自成一组，一条 assistant 连同它后面的 tool 结果
 * 也算一组。这样**永远不会切开 assistant(tool_calls) ↔ tool(result) 的配对**
 * （切开会让服务端 400—— `trimHistoryForRequest` 早就踩过这个坑）。
 * system（第 0 条）永远保留、永不进摘要。
 * 返回 null = 没有可丢的部分（全在保留窗口内）。
 *
 * `@param actualTokens` 这次请求的**真实** token 数（有 usage 时务必给）。
 * 为什么必须给（实测踩到两轮）：触发看真实 usage，切点却只能数字符——
 * 两把尺子差得很远（真实 29.1K 的会话，字符口径只估出 13.7K：估算里没有 system、
 * 没有工具清单、没有工具**参数**，`turnTextLength` 只数 content）。
 * 于是"该压"成立了，保留区却判定"全都在保留区内" → 静默无可压、百分比纹丝不动。
 * 给了真实值就把保留区**折算回估算单位**，两把尺子对齐（`null` = 退化为纯估算口径）。
 */
export function pickCompactCut(
  view: readonly ChatTurn[],
  policy: CompactPolicy = DEFAULT_COMPACT_POLICY,
  actualTokens: number | null = null
): CompactCut | null {
  if (view.length <= 1) return null
  const body = view.slice(1)
  const bodyEstimate = body.reduce((n, t) => n + estimateTurnTokens(t), 0)
  // 保留区额度（估算单位）= keepRecent ÷ 折算比；真实 ≤ 估算时比值为 1（不放大）
  const scale =
    actualTokens !== null && actualTokens > bodyEstimate && bodyEstimate > 0
      ? actualTokens / bodyEstimate
      : 1
  const keepBudget = Math.max(1, Math.floor(policy.keepRecentTokens / scale))
  // 轮组边界：每条非 tool 消息起新组；tool 结果**永远跟随它前面那条 assistant**
  // （配对不拆开是硬约束，理由见函数注释）
  const groups: ChatTurn[][] = []
  for (const turn of body) {
    if (turn.role !== 'tool') groups.push([turn])
    else if (groups.length === 0)
      groups.push([turn]) // 开头就是孤立 tool：自成一组兜底
    else groups[groups.length - 1].push(turn)
  }
  // 从尾部往回攒保留区
  let keptTokens = 0
  let cut = groups.length
  while (cut > 0) {
    const size = groups[cut - 1].reduce((n, t) => n + estimateTurnTokens(t), 0)
    if (keptTokens + size > keepBudget && keptTokens > 0) break
    keptTokens += size
    cut -= 1
  }
  if (cut === 0) return null // 全都塞得进保留区 → 没有可压缩的部分
  const dropped = groups.slice(0, cut).flat()
  const kept = groups.slice(cut).flat()
  return { dropped, kept, scale }
}

/**
 * 把被丢弃的消息转成纯文本（喂给摘要模型）。
 * 工具结果按**头尾截断**（中间省略）：摘要是"知道发生过什么"，不需要全文。
 */
export function renderTranscript(
  turns: readonly ChatTurn[],
  maxChars = SUMMARY_INPUT_MAX_CHARS
): string {
  const parts: string[] = []
  let used = 0
  for (const turn of turns) {
    const role = turn.role === 'assistant' ? '助手' : turn.role === 'tool' ? '工具结果' : '用户'
    let text: string
    if (turn.content === null) text = ''
    else if (typeof turn.content === 'string') text = turn.content
    else text = turn.content.map((p) => (p.type === 'text' ? p.text : '[图片]')).join('\n')
    if (turn.tool_calls !== undefined && turn.tool_calls.length > 0) {
      text += `\n（调用了工具：${turn.tool_calls.map((c) => c.function.name).join('、')}）`
    }
    const clipped =
      text.length > 2000 ? `${text.slice(0, 1200)}\n…（略）…\n${text.slice(-600)}` : text
    const block = `${role}：${clipped.trim()}`
    if (used + block.length > maxChars) break
    parts.push(block)
    used += block.length
  }
  return parts.join('\n\n')
}

/**
 * 摘要提示词（**handoff 结构**，照 Codex 学：产物要能"接着干活"）。
 * 有旧摘要时走**合并重写**（Pi 的增量摘要）——不写成"上次…这次…"的流水账。
 */
export function buildSummaryPrompt(input: { previous: string | null; transcript: string }): string {
  const head = [
    '你在为一段更早的对话写"交接摘要"。接手的是同一个助手，但它**看不到原始记录**，',
    '只能靠你这份摘要继续干活。',
    '',
    '按下面五段输出（没有信息的段写"（无）"）：',
    '【进度】已经完成什么、进行到哪一步',
    '【决策与理由】做过哪些决定、为什么（含被否决的方案）',
    '【用户的要求与约束】用户明确提过的偏好、限制、交付要求（能引原话就引）',
    '【待办】还没做完的事、下一步该做什么',
    '【关键数据】后面还要用到的具体信息：文件路径、命令、数字、结论',
    '',
    '硬要求：中文陈述句；不编造（原文没写的一律"（无）"）；不写客套话；不要大段照抄原文；',
    '**不要写"用户问/我回答"这类流水账**——要写"现在该知道什么"。'
  ].join('\n')
  if (input.previous === null || input.previous.trim() === '') {
    return `${head}\n\n【待压缩的对话片段】\n${input.transcript}`
  }
  return (
    `${head}\n\n` +
    '注意：下面是**已有摘要**（更早的部分）与**新增片段**。请把两者**合并重写成一份完整摘要**' +
    '（不要出现"上次提到…本次又…"的对比结构，也不要丢掉旧摘要里仍然有效的信息）。\n\n' +
    `【已有摘要】\n${input.previous.trim()}\n\n【新增片段】\n${input.transcript}`
  )
}

/** 摘要失败时的兜底转述（不阻断对话：至少让模型知道"前面有很多内容被省略了"） */
export const COMPACT_FALLBACK_NOTE =
  '（更早的对话太长，已从本次上下文中省略；摘要生成失败——需要旧信息时请重新读文件或问用户。）'

/** token 数 → 紧凑文案（1234 → "1.2K"；不足 1K 原样；非法 → "?"） */
export function fmtKTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?'
  if (n < 1000) return String(Math.round(n))
  return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`
}

export interface CompactOutcomeInput {
  /** 压缩**之后**第一次请求的真实总用量（prompt+completion）；供应商没报 usage = null */
  after: number | null
  /** 档案上下文窗口（tokens）；0/未设置 = 不判超限 */
  contextWindow: number
  /** 压缩后视图 body（除 system）的字符估算 token——用于反推压不掉的固定占用 */
  bodyTokensAfter: number
  /** 折叠了几条旧消息 */
  droppedCount: number
}

/**
 * 压缩后第一次真实请求回来时的"验收气泡"（纯函数）。
 *
 * 为什么必须有它（owner 实测踩到）：他把窗口设成 10K，压缩提示也出了，用量环却纹丝不动。
 * 取证：整个会话正文只有 136 字符，真实 prompt 却有 17.7K——**人设 + 33 个工具的 schema
 * 是固定占用，压缩只动历史消息，数学上不可能把 17.7K 压进 10K**。旧气泡还按折算比把
 * 几百 token 的历史报成"省下上万"，双重误导。
 *
 * 口径：
 * - 压完仍超窗口 → 必须解释清楚"什么压不掉 + 下一步怎么办"（这是用户最需要的信息）；
 * - 已回到窗口内 → 返回 null（压缩当下那条中性气泡已够，不刷屏）；
 * - 没有真实 usage / 窗口未设置 → null（不知道就不评）。
 */
export function compactResultNotice(input: CompactOutcomeInput): string | null {
  const { after, contextWindow, bodyTokensAfter, droppedCount } = input
  if (after === null || !(contextWindow > 0) || after <= contextWindow) return null
  const fixed = Math.max(0, Math.round(after - bodyTokensAfter))
  const head = `更早的 ${droppedCount} 条对话已压成摘要，但这次请求仍有 ${fmtKTokens(after)} tokens、超过你设置的 ${fmtKTokens(contextWindow)} 窗口。`
  if (fixed >= 2000) {
    return (
      head +
      `其中人设与工具说明等固定占用约 ${fmtKTokens(fixed)}——这部分不随对话压缩，再压历史也省不出来。` +
      '建议把上下文窗口调大（多数模型支持 32K 以上），或到「设置 → 工具」关掉用不到的工具。'
    )
  }
  return head + '可以再发一句触发继续压缩，或把上下文窗口调大。'
}

/**
 * 拼装压缩后的视图（纯函数）：`[system, 转述轮, ...保留的近期原文]`。
 * 转述用 **user 角色**而不是 system：三家协议里"中途插入 system"都可能被拒；
 * 且开头就把"这不是用户原话"说死（红P7 教训：把转述当亲眼所见会错得自然）。
 */
export function buildCompactedView(
  view: readonly ChatTurn[],
  kept: readonly ChatTurn[],
  summary: string
): ChatTurn[] {
  const system = view[0]
  const note =
    '[系统提示：以下是**更早对话的压缩转述**（原始记录仍完整保存在会话档案里，只是不在本次上下文内）。' +
    '它不是用户的原话，也不等于已经核实的事实——引用细节前，不确定的请用工具重新确认或直接问用户。]\n\n' +
    summary.trim()
  const middle: ChatTurn = { role: 'user', content: note }
  return system === undefined ? [middle, ...kept] : [system, middle, ...kept]
}

// ── 溢出自救 ────────────────────────────────────────────────────────────

/**
 * 上下文超限类错误的识别（纯函数）。
 * 各厂商措辞不同，这里只认**明确的超限信号**——宁可漏判（退回现有裁剪），
 * 也不能把限流（429）、审核（data_inspection_failed）误判成超限去重试：
 * 那类错误重试一次只是白花一次钱，还拖慢回复。
 */
export function isContextOverflowError(err: unknown): boolean {
  const raw =
    err instanceof Error
      ? err.message
      : typeof (err as { message?: unknown } | null)?.message === 'string'
        ? String((err as { message: string }).message)
        : String(err ?? '')
  const text = raw.toLowerCase()
  const patterns = [
    'context_length_exceeded',
    'maximum context length',
    'context window',
    'reduce the length',
    'too many tokens',
    'input is too long',
    'prompt is too long',
    'exceeds the maximum',
    'string too long',
    'max_tokens is too large'
  ]
  if (patterns.some((p) => text.includes(p))) return true
  // 中文/国产端点常见措辞
  return /(超过|超出).{0,6}(长度|上限|限制)|(长度|上下文).{0,4}(超限|过长)/.test(raw)
}
