// 摘要调用（P8-T1 唯一实现）：自动压缩（run.ts 每轮判定）与手动压缩（IPC）都走这里。
// 单独成文件的原因：调用模型这件事只该有一份实现——两处各写一段迟早会分叉
// （提示词漂移、超时口径不一致、一处忘了合并旧摘要）。

import { streamChat } from '../llm/client'
import type { ChatTurn } from '../llm/client'
import { classifyLlmError } from '../llm/errors'
import type { ModelProfile } from '@shared/types'
import { SUMMARY_TIMEOUT_MS, buildSummaryPrompt, renderTranscript } from './compact'

/** 摘要调用的 system：只准输出摘要本体（否则摘要里会混进"好的，我来总结…"） */
const SUMMARY_SYSTEM =
  '你是对话摘要器。只输出摘要本身，不要寒暄、不要解释你在做什么、不要复述指令。'

export interface SummarizeInput {
  profile: ModelProfile
  apiKey: string
  /** 上一版摘要（增量合并用）；没有就 null */
  previous: string | null
  /** 本次要被折叠掉的消息 */
  dropped: readonly ChatTurn[]
}

/**
 * 生成/合并摘要；失败**带原因**返回（调用方要留痕并提示用户）。
 * 不接主人对话的 signal：用户按停止不该把已经烧了一半的摘要掐掉，它自带超时。
 */
export type SummarizeResult = { ok: true; text: string } | { ok: false; error: string }
export async function summarizeTurns(input: SummarizeInput): Promise<SummarizeResult> {
  const transcript = renderTranscript(input.dropped)
  if (transcript.trim() === '') return { ok: false, error: '没有可摘要的内容' }
  try {
    const res = await streamChat(
      {
        baseUrl: input.profile.baseUrl,
        apiKey: input.apiKey,
        model: input.profile.model,
        temperature: 0,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM },
          {
            role: 'user',
            content: buildSummaryPrompt({ previous: input.previous, transcript })
          }
        ],
        protocol: input.profile.protocol
      },
      // 超时给宽：要读进的原文可能很长（120K 字符），60s 在慢端点上会直接判死
      { signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS), onDelta: () => {} }
    )
    const text = res.text.trim()
    if (text === '') return { ok: false, error: '摘要模型返回了空内容' }
    return { ok: true, text }
  } catch (err) {
    // 失败必须说清是什么错：静默返回 null 会让"88% 却毫无反应"变成无解之谜（实测踩到）
    return { ok: false, error: classifyLlmError(err).message }
  }
}
