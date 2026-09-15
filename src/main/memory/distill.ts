// 记忆提炼管线：每轮对话正常结束后，异步用主 profile 提炼「关于用户的
// 长期有效信息」并入库。fire-and-forget：失败静默，绝不阻塞/影响主对话。
//
// 设计约束：
// - 只在 privacy.memory === true 时调用（调用方把关）
// - 输出 JSON 数组 ≤300 token；无值得记输出 []（一次性任务/寒暄不记）
// - 解析容错：截取首个 [ 到最后一个 ]；解析失败 = 本轮无沉淀（下轮再来）

import { streamChat } from '../llm/client'
import { appendDebugLog } from '../log'
import { addEntry } from './memory-store'
import type { MemoryCandidate, MemoryKind } from '@shared/memory'

const KINDS: readonly MemoryKind[] = ['preference', 'fact', 'commitment']

const DISTILL_SYSTEM = `你是记忆提炼器。从一段对话中提炼「关于用户的长期有效信息」，输出 JSON 数组，每项：
{"kind":"preference|fact|commitment","content":"一句话，不超过60字","keywords":["关键词",3~6个]}

只记长期有效信息：
- preference：用户偏好（"我喜欢简洁的回复"、"别用表情符号"）
- fact：个人事实（"我在某大学读大二"、"下周有期末考试"）
- commitment：承诺约定（"答应周末帮忙改简历"）

不要记：一次性任务细节、寒暄、你（助手）自己的回答、对话里已有的文件内容。
没有值得记的输出 []。

正例：用户说"我下周要期末考试了" → [{"kind":"fact","content":"用户下周有期末考试","keywords":["期末考试","考试","学生","复习"]}]
反例：用户说"帮我读一下这个文件" → []

只输出 JSON 数组，不要任何解释或代码块标记。`

/** 解析提炼输出（容错：剥代码块/截取 JSON 数组段） */
export function parseDistillOutput(text: string): MemoryCandidate[] {
  let t = text.trim()
  const start = t.indexOf('[')
  const end = t.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  t = t.slice(start, end + 1)
  try {
    const raw: unknown = JSON.parse(t)
    if (!Array.isArray(raw)) return []
    const out: MemoryCandidate[] = []
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue
      const r = item as Record<string, unknown>
      const kind = r.kind
      const content = r.content
      if (typeof kind !== 'string' || !KINDS.includes(kind as MemoryKind)) continue
      if (typeof content !== 'string' || content.trim() === '') continue
      const keywords = Array.isArray(r.keywords)
        ? r.keywords.filter((k): k is string => typeof k === 'string' && k.trim() !== '')
        : []
      out.push({
        kind: kind as MemoryKind,
        content: content.trim().slice(0, 120),
        keywords: keywords.slice(0, 6)
      })
    }
    return out
  } catch {
    return []
  }
}

export interface DistillDeps {
  baseUrl: string
  apiKey: string
  model: string
  protocol: 'openai' | 'anthropic' | 'gemini'
  logsDir: () => string
}

/**
 * 异步提炼并入库（fire-and-forget）。任何失败只落日志，不抛错。
 * userText / replyText 截断各 1500 字（提炼不需要全文）。
 */
export function distillMemory(
  deps: DistillDeps,
  userText: string,
  replyText: string,
  sessionId: string
): void {
  void (async () => {
    const u = userText.slice(0, 1500)
    const a = replyText.slice(0, 1500)
    if (u.trim() === '') return
    const res = await streamChat(
      {
        baseUrl: deps.baseUrl,
        apiKey: deps.apiKey,
        model: deps.model,
        temperature: 0,
        messages: [
          { role: 'system', content: DISTILL_SYSTEM },
          {
            role: 'user',
            content: `【用户消息】\n${u}\n\n【助手回复】\n${a}\n\n请输出记忆 JSON 数组（无值得记输出 []）：`
          }
        ]
      },
      // 不接 abort：提炼是后台锦上添花，主对话中断也不牵连它
      { signal: new AbortController().signal, onDelta: () => {} }
    )
    const candidates = parseDistillOutput(res.text)
    if (candidates.length === 0) return
    const results = candidates.map((c) => addEntry(c, sessionId))
    appendDebugLog(
      deps.logsDir(),
      `[memory] 提炼 ${candidates.length} 条（${results.filter((r) => r === 'added').length} 新增 / ${results.filter((r) => r === 'updated').length} 合并）`
    )
  })().catch((err: unknown) => {
    try {
      appendDebugLog(deps.logsDir(), `[memory] 提炼失败（静默跳过）: ${String(err)}`)
    } catch {
      // 日志也失败就只能吞掉——提炼是锦上添花，绝不影响主流程
    }
  })
}
