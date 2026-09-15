// 思考采集单测：三协议的 thinking 抽取 + 会话存储透传。
// anthropic/gemini 走各自的流式聚合器（真实 SSE 事件喂入）；session-store 走真实落盘往返。

import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnthropicStreamAggregator } from '../src/main/llm/anthropic'
import { GeminiStreamAggregator } from '../src/main/llm/gemini'
import { appendSessionTurns, loadSessionMessages } from '../src/main/sessions/session-store'

// ── anthropic：thinking_delta 被动透传，不混入正文 ─────────────────────────
describe('AnthropicStreamAggregator.thinking', () => {
  const agg = new AnthropicStreamAggregator()
  it('thinking_delta 累积到 thinking、不进 text；text_delta 照旧', () => {
    const t1 = agg.feed({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: '先分析' }
    })
    const t2 = agg.feed({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: '答案' }
    })
    const t3 = agg.feed({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: '需求' }
    })
    expect(t1.isThinkingDelta).toBe(true)
    expect(t1.isTextDelta).toBe(false)
    expect(t1.chunk).toBe('先分析')
    expect(t2.isTextDelta).toBe(true)
    expect(t2.isThinkingDelta).toBe(false)
    expect(t3.chunk).toBe('需求')
    const final = agg.finalize()
    expect(final.thinking).toBe('先分析需求')
    expect(final.text).toBe('答案')
  })
})

// ── gemini：thought:true 的 part 进 thinking，不进正文 ────────────────────
describe('GeminiStreamAggregator.thinking', () => {
  const agg = new GeminiStreamAggregator()
  it('thought part 与正文 part 分流', () => {
    const t1 = agg.feed({
      candidates: [{ content: { parts: [{ text: '推理过程', thought: true }] } }]
    })
    const t2 = agg.feed({
      candidates: [{ content: { parts: [{ text: '最终回答' }] } }]
    })
    expect(t1.isThinkingDelta).toBe(true)
    expect(t1.chunk).toBe('推理过程')
    expect(t2.isThinkingDelta).toBe(false)
    expect(t2.chunk).toBe('最终回答')
    const final = agg.finalize()
    expect(final.thinking).toBe('推理过程')
    expect(final.text).toBe('最终回答')
  })
})

// ── session-store：thinking 落盘往返 + 8000 截断 ──────────────────────────
describe('session-store thinking 透传', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aemeath-thinking-'))
  })
  afterEach(() => {
    // 临时目录留给系统清理（测试无删除权限问题）
  })

  it('thinking 随消息落盘并原样读回', () => {
    appendSessionTurns(dir, 's-think1', [
      { id: 'm1', role: 'assistant', ts: 1, text: '结论', thinking: '我的推理…' }
    ])
    const loaded = loadSessionMessages(dir, 's-think1')
    expect(loaded.ok).toBe(true)
    if (loaded.ok) expect(loaded.messages[0]?.thinking).toBe('我的推理…')
  })

  it('超长 thinking 在读取侧截断到 8000（sanitize 位于 load 路径）', () => {
    const long = '想'.repeat(9000)
    appendSessionTurns(dir, 's-think2', [
      { id: 'm1', role: 'assistant', ts: 1, text: 'x', thinking: long }
    ])
    const loaded = loadSessionMessages(dir, 's-think2')
    expect(loaded.ok).toBe(true)
    if (loaded.ok) expect([...(loaded.messages[0]?.thinking ?? '')].length).toBe(8000)
  })

  it('无 thinking 的消息往返不受影响', () => {
    appendSessionTurns(dir, 's-think3', [{ id: 'm1', role: 'user', ts: 1, text: 'hi' }])
    const loaded = loadSessionMessages(dir, 's-think3')
    expect(loaded.ok).toBe(true)
    if (loaded.ok) expect(loaded.messages[0]?.thinking).toBeUndefined()
  })
})
