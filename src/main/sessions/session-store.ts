// 会话数据存储：
// <sessionsDir>/index.json — 元信息注册表（registry.ts 管）
// <sessionsDir>/data/<id>.json — 单会话完整消息 { v:1, messages: PersistedMessage[] }
// 写入统一走 atomicWriteJson（tmp → renameSync 原子替换），崩溃不会留下半写文件；
// 主进程同步 fs + 单事件循环 = 天然免锁（无 await 穿插，成熟实现同款哲学，零额外依赖）。

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import type { ToolCallSpec } from '@shared/protocol'
import type {
  ChatAttachmentPayload,
  PersistedMessage,
  SessionStats,
  TokenUsage
} from '@shared/types'

const DATA_SUBDIR = 'data'
/** 注册表文件名（与 registry.ts 的 index.json 契约一致；此处只做只读探测，避免引入 electron） */
const REGISTRY_FILE = 'index.json'
/** 会话 id 白名单：字母数字下划线连字符（渲染层生成的 s-/m- 前缀 id 均匹配），防路径穿越 */
const ID_RE = /^[\w-]{1,64}$/

export function isValidSessionId(id: string): boolean {
  return typeof id === 'string' && ID_RE.test(id)
}

function dataDir(dir: string): string {
  return join(dir, DATA_SUBDIR)
}

function dataPath(dir: string, id: string): string {
  return join(dataDir(dir), `${id}.json`)
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.tmp`
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  renameSync(tmpPath, filePath)
}

/** 单条消息防御校验：必需字段缺失即丢弃该条（坏行跳过，不阻塞整文件） */
function sanitizeMessage(raw: unknown): PersistedMessage | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id === '') return null
  if (r.role !== 'user' && r.role !== 'assistant' && r.role !== 'tool') return null
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts)) return null
  if (typeof r.text !== 'string') return null
  const msg: PersistedMessage = { id: r.id, role: r.role, ts: r.ts, text: r.text }
  // 工具结果消息必须带 toolCallId，否则无法与 assistant 的调用配对（丢弃防脏数据）
  if (r.role === 'tool' && typeof r.toolCallId !== 'string') return null
  if (typeof r.toolCallId === 'string' && r.toolCallId !== '') msg.toolCallId = r.toolCallId
  if (Array.isArray(r.attachments)) {
    const atts: ChatAttachmentPayload[] = []
    for (const a of r.attachments) {
      if (typeof a !== 'object' || a === null) continue
      const ar = a as Record<string, unknown>
      if (typeof ar.name !== 'string' || ar.name === '') continue
      if (ar.kind !== 'image' && ar.kind !== 'text' && ar.kind !== 'sticker' && ar.kind !== 'file')
        continue
      atts.push({
        name: ar.name,
        kind: ar.kind,
        size: typeof ar.size === 'number' && Number.isFinite(ar.size) ? ar.size : undefined,
        dataUrl: typeof ar.dataUrl === 'string' ? ar.dataUrl : undefined,
        text: typeof ar.text === 'string' ? ar.text : undefined,
        // 本地路径：恢复历史时附件说明里要用（她能接着处理那个文件）
        path: typeof ar.path === 'string' && ar.path !== '' ? ar.path : undefined
      })
    }
    if (atts.length > 0) msg.attachments = atts
  }
  // 工具调用字段原样读写（早期恒缺省）。
  // 只做结构校验不改内容：P1 的工具调用消息存读往返不丢。
  if (r.toolCalls === null) {
    msg.toolCalls = null
  } else if (Array.isArray(r.toolCalls)) {
    const calls: ToolCallSpec[] = []
    for (const c of r.toolCalls) {
      if (typeof c !== 'object' || c === null) continue
      const cr = c as Record<string, unknown>
      if (
        typeof cr.id !== 'string' ||
        typeof cr.name !== 'string' ||
        typeof cr.argsJson !== 'string'
      ) {
        continue
      }
      calls.push({ id: cr.id, name: cr.name, argsJson: cr.argsJson })
    }
    if (calls.length > 0) msg.toolCalls = calls
  }
  if (typeof r.toolCallId === 'string' && r.toolCallId !== '') msg.toolCallId = r.toolCallId
  // 思考内容：字符串才透传，超长截 8000（thinking 是展示性内容，防体积膨胀）
  if (typeof r.thinking === 'string' && r.thinking !== '') {
    msg.thinking = r.thinking.length > 8000 ? r.thinking.slice(0, 8000) : r.thinking
  }
  return msg
}

export type LoadSessionResult =
  | { ok: true; messages: PersistedMessage[]; usage?: TokenUsage; stats?: SessionStats }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'corrupt' }

function sanitizeUsage(raw: unknown): TokenUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (
    typeof r.promptTokens !== 'number' ||
    typeof r.completionTokens !== 'number' ||
    typeof r.totalTokens !== 'number'
  ) {
    return undefined
  }
  return {
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    totalTokens: r.totalTokens
  }
}

function sanitizeStats(raw: unknown): SessionStats | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    rounds: num(r.rounds),
    steps: num(r.steps),
    toolMs: num(r.toolMs),
    inputTok: num(r.inputTok),
    outputTok: num(r.outputTok),
    llmMs: num(r.llmMs),
    cachedTok: num(r.cachedTok),
    cacheKnown: r.cacheKnown === true,
    ttftMsLast: num(r.ttftMsLast),
    ttftMsSum: num(r.ttftMsSum),
    tpsLast: num(r.tpsLast),
    samples: num(r.samples)
  }
}

/** 遥测累加（纯函数）：base 缺省视为全零；last 类字段取 delta 最新值 */
export function accumulateStats(base: SessionStats | undefined, delta: SessionStats): SessionStats {
  const b: SessionStats = base ?? {
    rounds: 0,
    steps: 0,
    toolMs: 0,
    inputTok: 0,
    outputTok: 0,
    llmMs: 0,
    cachedTok: 0,
    cacheKnown: false,
    ttftMsLast: 0,
    ttftMsSum: 0,
    tpsLast: 0,
    samples: 0
  }
  return {
    rounds: b.rounds + delta.rounds,
    steps: b.steps + delta.steps,
    toolMs: b.toolMs + delta.toolMs,
    inputTok: b.inputTok + delta.inputTok,
    outputTok: b.outputTok + delta.outputTok,
    llmMs: b.llmMs + delta.llmMs,
    cachedTok: b.cachedTok + delta.cachedTok,
    cacheKnown: b.cacheKnown || delta.cacheKnown,
    ttftMsLast: delta.ttftMsLast,
    // 合并的是各轮 ttft 之和（delta.ttftMsSum），不是最后一轮值（delta.ttftMsLast）——
    // 此前误用 last，多轮任务的存档"平均首 token"被顶成最后一轮。
    ttftMsSum: b.ttftMsSum + delta.ttftMsSum,
    tpsLast: delta.tpsLast,
    samples: b.samples + delta.samples
  }
}

/** 读取会话消息；文件缺失 = missing；JSON 解析失败/结构非法 = corrupt（坏条目逐条跳过） */
export function loadSessionMessages(dir: string, id: string): LoadSessionResult {
  if (!isValidSessionId(id)) return { ok: false, reason: 'missing' }
  const file = dataPath(dir, id)
  if (!existsSync(file)) return { ok: false, reason: 'missing' }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    const list =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>).messages
        : null
    if (!Array.isArray(list)) return { ok: false, reason: 'corrupt' }
    const messages: PersistedMessage[] = []
    for (const raw of list) {
      const msg = sanitizeMessage(raw)
      if (msg !== null) messages.push(msg)
    }
    const usage = sanitizeUsage((parsed as Record<string, unknown>).usage)
    const stats = sanitizeStats((parsed as Record<string, unknown>).stats)
    const out: LoadSessionResult = { ok: true, messages }
    if (usage !== undefined) out.usage = usage
    if (stats !== undefined) out.stats = stats
    return out
  } catch {
    return { ok: false, reason: 'corrupt' }
  }
}

export function saveSessionMessages(
  dir: string,
  id: string,
  messages: PersistedMessage[],
  usage?: TokenUsage,
  stats?: SessionStats
): void {
  if (!isValidSessionId(id)) throw new Error(`非法会话 id: ${id}`)
  mkdirSync(dataDir(dir), { recursive: true })
  const file: Record<string, unknown> = { v: 1, messages }
  if (usage !== undefined) file.usage = usage
  if (stats !== undefined) file.stats = stats
  atomicWriteJson(dataPath(dir, id), file)
}

/**
 * 追加 turns：读（容忍）→ 追加 → 整写。
 * 文件损坏时先备份为 <id>.json.corrupt-<ts>（数据不丢，可人工恢复），再从新消息起始。
 * usage 传入时覆盖存储的最近一次真实用量。
 * statsDelta 传入时累加到会话遥测。
 */
export function appendSessionTurns(
  dir: string,
  id: string,
  turns: PersistedMessage[],
  usage?: TokenUsage,
  statsDelta?: SessionStats
): void {
  // 空 turns 但带用量/统计时仍需落盘（harness 步数熔断等无正文收尾场景）
  if (turns.length === 0 && usage === undefined && statsDelta === undefined) return
  const loaded = loadSessionMessages(dir, id)
  let messages: PersistedMessage[]
  let currentUsage: TokenUsage | undefined
  let currentStats: SessionStats | undefined
  if (loaded.ok) {
    messages = loaded.messages
    currentUsage = loaded.usage
    currentStats = loaded.stats
  } else if (loaded.reason === 'corrupt') {
    const src = dataPath(dir, id)
    try {
      renameSync(src, `${src}.corrupt-${Date.now()}`)
    } catch {
      /* 备份失败不阻塞：新消息照常落盘 */
    }
    messages = []
  } else {
    messages = []
  }
  messages.push(...turns)
  const nextStats =
    statsDelta !== undefined ? accumulateStats(currentStats, statsDelta) : currentStats
  saveSessionMessages(dir, id, messages, usage ?? currentUsage, nextStats)
}

/** 删除会话数据文件（含损坏备份）；id 非法静默忽略 */
export function deleteSessionData(dir: string, id: string): void {
  if (!isValidSessionId(id)) return
  const d = dataDir(dir)
  if (!existsSync(d)) return
  for (const name of readdirSync(d)) {
    if (name === `${id}.json` || name.startsWith(`${id}.json.corrupt-`)) {
      try {
        unlinkSync(join(d, name))
      } catch {
        /* 单文件删除失败不阻塞其余清理 */
      }
    }
  }
}

/** 孤儿清理：data 目录中不在 validIds 里的会话文件删除（元信息同步/硬删后调用）；返回删除数 */
export function pruneOrphanSessionData(dir: string, validIds: string[]): number {
  const d = dataDir(dir)
  if (!existsSync(d)) return 0
  const valid = new Set(validIds)
  let removed = 0
  for (const name of readdirSync(d)) {
    const m = /^(.+)\.json(\.corrupt-\d+)?$/.exec(name)
    if (m === null) continue
    if (!valid.has(m[1])) {
      try {
        unlinkSync(join(d, name))
        removed += 1
      } catch {
        /* 忽略单个失败 */
      }
    }
  }
  return removed
}

/** 主进程侧生成消息 id（与渲染层 newId 同风格，仅要求会话内唯一） */
export function newPersistedId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 会话是否仍在注册表（index.json）在册。
 * 落盘前校验用：不在册 = 会话已被删除，跳过写盘避免数据文件"复活"。
 * fail-open 策略：index.json 缺失或损坏时返回 true（宁可多写不可丢数据）——
 * 显式删除必然产生一份可读的新 index，所以"在册判定"只依赖可读状态；
 * 唯一误判窗口是 index 损坏期间删会话，此时 fail-open 保数据，孤儿由 prune 兜底。
 */
export function isSessionRegistered(dir: string, id: string): boolean {
  try {
    const file = join(dir, REGISTRY_FILE)
    if (!existsSync(file)) return true
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    const list =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>).sessions
        : null
    if (!Array.isArray(list)) return true
    return list.some(
      (s) => typeof s === 'object' && s !== null && (s as { id?: unknown }).id === id
    )
  } catch {
    return true
  }
}
