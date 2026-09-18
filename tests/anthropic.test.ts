// Anthropic 适配单测：消息/工具转换 + SSE 事件聚合（不依赖网络）。

import { describe, expect, it, vi } from 'vitest'
import {
  AnthropicStreamAggregator,
  dataUrlToAnthropicSource,
  toAnthropicMessages,
  toAnthropicTools
} from '../src/main/llm/anthropic'
import type { ChatTurn } from '../src/main/llm/client'

describe('toAnthropicMessages（openai → Anthropic 转换）', () => {
  it('system 提取不在消息里（由调用方单独传 system 参数）', () => {
    const turns: ChatTurn[] = [
      { role: 'system', content: '你是爱弥斯' },
      { role: 'user', content: '你好' }
    ]
    const out = toAnthropicMessages(turns)
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('user')
    expect(out[0].content).toEqual([{ type: 'text', text: '你好' }])
  })

  it('assistant 工具调用 → tool_use 块（argsJson 解析为 input）', () => {
    const turns: ChatTurn[] = [
      {
        role: 'assistant',
        content: '我来查一下',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a"}' }
          }
        ]
      }
    ]
    const out = toAnthropicMessages(turns)
    expect(out[0].role).toBe('assistant')
    expect(out[0].content).toEqual([
      { type: 'text', text: '我来查一下' },
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a' } }
    ])
  })

  it('role=tool → user 消息的 tool_result 块（Anthropic 语义）', () => {
    const out = toAnthropicMessages([{ role: 'tool', content: '结果文本', tool_call_id: 'call_1' }])
    expect(out[0].role).toBe('user')
    expect(out[0].content).toEqual([
      { type: 'tool_result', tool_use_id: 'call_1', content: '结果文本' }
    ])
  })

  it('相邻同角色合并（工具往返后连续 user 块拼一条）', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: '问题' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }]
      },
      { role: 'tool', content: '结果1', tool_call_id: 'c1' },
      { role: 'user', content: '继续' }
    ]
    const out = toAnthropicMessages(turns)
    // assistant(tool_use) 与 user(结果) 交替正常；最后的 user『继续』与前面不同块
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('多模态 image parts → base64 source；坏 dataUrl 丢弃', () => {
    const turns: ChatTurn[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
          { type: 'image_url', image_url: { url: 'not-a-data-url' } }
        ]
      }
    ]
    const out = toAnthropicMessages(turns)
    expect(out[0].content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }
    ])
  })

  it('dataUrlToAnthropicSource：解析/拒绝', () => {
    expect(dataUrlToAnthropicSource('data:image/jpeg;base64,ZZ')).toEqual({
      type: 'base64',
      media_type: 'image/jpeg',
      data: 'ZZ'
    })
    expect(dataUrlToAnthropicSource('data:text/plain;base64,ZZ')).toBeNull()
    expect(dataUrlToAnthropicSource('junk')).toBeNull()
  })

  it('toAnthropicTools：parameters → input_schema 直透', () => {
    const out = toAnthropicTools([
      {
        type: 'function',
        function: { name: 't', description: 'd', parameters: { type: 'object', properties: {} } }
      }
    ])
    expect(out[0]).toEqual({
      name: 't',
      description: 'd',
      input_schema: { type: 'object', properties: {} }
    })
  })
})

describe('AnthropicStreamAggregator（SSE 事件聚合）', () => {
  it('文本流：text_delta 拼接 + TTFT 记录', () => {
    const agg = new AnthropicStreamAggregator()
    agg.feed({ type: 'message_start', message: { usage: { input_tokens: 100 } } })
    const r1 = agg.feed({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '你好' }
    })
    expect(r1.isTextDelta).toBe(true)
    agg.feed({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '呀' } })
    const f = agg.finalize()
    expect(f.text).toBe('你好呀')
    expect(f.ttftMs).toBeGreaterThanOrEqual(0)
  })

  it('工具调用流：tool_use 块 + input_json_delta 拼装 + finishReason=tool_calls', () => {
    const agg = new AnthropicStreamAggregator()
    agg.feed({ type: 'message_start', message: { usage: { input_tokens: 10 } } })
    agg.feed({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'tu_1', name: 'read_file' }
    })
    agg.feed({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"pa' }
    })
    agg.feed({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: 'th":"a"}' }
    })
    agg.feed({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 42 }
    })
    const f = agg.finalize()
    expect(f.finishReason).toBe('tool_calls')
    expect(f.toolCalls).toEqual([{ id: 'tu_1', name: 'read_file', argsJson: '{"path":"a"}' }])
    expect(f.usage?.completionTokens).toBe(42)
  })

  it('缓存命中：cache_read_input_tokens 上报 → cacheKnown=true', () => {
    const agg = new AnthropicStreamAggregator()
    agg.feed({
      type: 'message_start',
      message: { usage: { input_tokens: 100, cache_read_input_tokens: 80 } }
    })
    const f = agg.finalize()
    expect(f.cachedTokens).toBe(80)
    expect(f.cacheKnown).toBe(true)
  })

  it('★ 输入口径：Anthropic 的 input_tokens 不含缓存 → promptTokens 必须是三者之和', () => {
    // 实测（owner 的 dots3 会话）：input_tokens=548 而 cache_read=143360，
    // 旧口径把 548 当输入 → 上下文环低报、压缩永不触发、缓存命中率算成 663%。
    const agg = new AnthropicStreamAggregator()
    agg.feed({
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 548,
          cache_read_input_tokens: 143360,
          cache_creation_input_tokens: 2000
        }
      }
    })
    agg.feed({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 135 }
    })
    const f = agg.finalize()
    expect(f.usage?.promptTokens).toBe(548 + 143360 + 2000) // 145908
    expect(f.usage?.completionTokens).toBe(135)
    expect(f.usage?.totalTokens).toBe(145908 + 135)
    // 命中率分母（promptTokens）必须 ≥ 分子（cachedTokens），否则显示会 >100%
    expect(f.cachedTokens ?? 0).toBeLessThanOrEqual(f.usage?.promptTokens ?? 0)
  })

  it('end_turn → finishReason stop；无增量 tokPerS=0', () => {
    const agg = new AnthropicStreamAggregator()
    agg.feed({ type: 'message_start', message: { usage: { input_tokens: 5 } } })
    agg.feed({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 3 }
    })
    const f = agg.finalize()
    expect(f.finishReason).toBe('stop')
    expect(f.text).toBe('')
    expect(f.tokPerS).toBe(0)
  })

  it('★ 思考增量计入生成口径：TTFT 由首片思考触发，genMs 覆盖思考+正文（tok/s 修复）', () => {
    // "1621 tok/s 不可能"的根因：thinking_delta 不参与计时，
    // 而 completion_tokens 含思考 tokens → 分子含思考、分母只剩正文段 → 虚高。
    // 用可控时钟精确验证口径（t0=1000：思考 1050 起、正文 1250 止）。
    let clock = 1000
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    try {
      const agg = new AnthropicStreamAggregator()
      agg.feed({ type: 'message_start', message: { usage: { input_tokens: 10 } } })
      clock = 1050
      const t1 = agg.feed({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '让我想想' }
      })
      expect(t1.isThinkingDelta).toBe(true)
      expect(agg.ttftMs).toBe(50) // 首片思考即 TTFT（修复前恒 0）
      clock = 1130
      agg.feed({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '……好了' }
      })
      clock = 1250
      agg.feed({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '答案' }
      })
      agg.feed({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 100 }
      })
      const f = agg.finalize()
      expect(f.thinking).toBe('让我想想……好了')
      expect(f.text).toBe('答案')
      // 纯生成期 = 首增量 → 末增量 = 1250-1050 = 200ms（修复前只算正文 120ms）
      expect(f.genMs).toBe(200)
      // tok/s = 100 tok ÷ 0.2s = 500（分母覆盖思考期后回到真实量级）
      expect(f.tokPerS).toBe(500)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('★ 工具参数增量计入 TTFT：纯调用轮不再显示"首 token —"', () => {
    // 不写文字直接调用工具时，此前 input_json_delta 不参与计时 → ttftMs=0、genMs=0。
    let clock = 1000
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    try {
      const agg = new AnthropicStreamAggregator()
      agg.feed({ type: 'message_start', message: { usage: { input_tokens: 10 } } })
      clock = 1040
      agg.feed({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'current_time' }
      })
      clock = 1080
      agg.feed({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{}' }
      })
      agg.feed({ type: 'content_block_stop', index: 0 })
      agg.feed({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 8 }
      })
      const f = agg.finalize()
      expect(f.ttftMs).toBe(80) // 首片参数（1080-1000）即 TTFT（修复前恒 0）
      expect(f.genMs).toBe(0) // 单片参数无跨度（多片时才有正数）；块起始不算生成时刻
      expect(f.finishReason).toBe('tool_calls')
    } finally {
      nowSpy.mockRestore()
    }
  })
})
