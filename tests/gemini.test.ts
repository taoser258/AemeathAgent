import { describe, expect, it, vi } from 'vitest'
import type { ChatTurn, LlmTool } from '../src/main/llm/client'
import {
  GeminiStreamAggregator,
  buildGeminiBody,
  dataUrlToGeminiInline,
  geminiEndpoint,
  synthesizeCallId,
  toGeminiContents,
  toGeminiTools
} from '../src/main/llm/gemini'

const PNG_URL = 'data:image/png;base64,AAAA'

/** 工具往返标准剧本：assistant 发起两个调用 → 两条 tool 结果（openai 形态） */
function toolRoundTrip(): ChatTurn[] {
  return [
    { role: 'user', content: '帮我建个文件' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_a',
          type: 'function',
          function: { name: 'write_file', arguments: '{"path":"a.txt"}' }
        },
        {
          id: 'call_b',
          type: 'function',
          function: { name: 'list_dir', arguments: '{"path":"."}' }
        }
      ]
    },
    { role: 'tool', tool_call_id: 'call_a', content: '已写入' },
    { role: 'tool', tool_call_id: 'call_b', content: '["a.txt"]' }
  ]
}

describe('Gemini 请求转换', () => {
  it('system 提词进 systemInstruction，不进 contents', () => {
    const body = buildGeminiBody({
      model: 'gemini-2.5-flash',
      temperature: 0.7,
      messages: [
        { role: 'system', content: '你是爱弥斯' },
        { role: 'user', content: '嗨' }
      ]
    })
    expect(body.systemInstruction).toEqual({ parts: [{ text: '你是爱弥斯' }] })
    expect(body.contents).toHaveLength(1)
    expect(body.contents[0]?.role).toBe('user')
  })

  it('user 文本 → role=user 的 text part；assistant 文本 → role=model', () => {
    const contents = toGeminiContents([
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '回答' }
    ])
    expect(contents).toEqual([
      { role: 'user', parts: [{ text: '问题' }] },
      { role: 'model', parts: [{ text: '回答' }] }
    ])
  })

  it('★ assistant.tool_calls → functionCall part：id 丢弃、arguments 解析成对象', () => {
    const [assistant] = toGeminiContents(toolRoundTrip().filter((t) => t.role === 'assistant'))
    expect(assistant?.role).toBe('model')
    expect(assistant?.parts).toEqual([
      { functionCall: { name: 'write_file', args: { path: 'a.txt' } } },
      { functionCall: { name: 'list_dir', args: { path: '.' } } }
    ])
  })

  it('★ tool 结果 → functionResponse：函数名靠 id→name 映射、response 包成对象', () => {
    const contents = toGeminiContents(toolRoundTrip())
    // 剧本转换后：user(问题) + model(2 个 functionCall) + user(2 个 functionResponse 合并)
    expect(contents).toHaveLength(3)
    const results = contents[2]
    expect(results?.role).toBe('user')
    expect(results?.parts).toEqual([
      { functionResponse: { name: 'write_file', response: { result: '已写入' } } },
      { functionResponse: { name: 'list_dir', response: { result: '["a.txt"]' } } }
    ])
  })

  it('★ id 映射缺失时按「最近 assistant 的调用顺序」兜底（历史裁剪也不丢配对）', () => {
    // 场景：tool_call_id 是合成 id 在历史重放后变了，映射查不到 → 靠顺序对上
    const turns: ChatTurn[] = [
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'orig_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
          { id: 'orig_2', type: 'function', function: { name: 'list_dir', arguments: '{}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'replayed_A', content: '内容' },
      { role: 'tool', tool_call_id: 'replayed_B', content: '列表' }
    ]
    const contents = toGeminiContents(turns)
    const parts = contents[2]?.parts ?? []
    expect(parts[0]).toEqual({
      functionResponse: { name: 'read_file', response: { result: '内容' } }
    })
    expect(parts[1]).toEqual({
      functionResponse: { name: 'list_dir', response: { result: '列表' } }
    })
  })

  it('映射与顺序队列都落空 → unknown_tool（Gemini 给可读报错，好过静默丢）', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: 'x' },
      { role: 'tool', tool_call_id: 'nope', content: '孤儿结果' }
    ]
    // tool 结果按 user 角色转换，会与相邻的 user 文本合并进同一条 content
    const parts = toGeminiContents(turns)[0]?.parts ?? []
    expect(parts).toEqual([
      { text: 'x' },
      { functionResponse: { name: 'unknown_tool', response: { result: '孤儿结果' } } }
    ])
  })

  it('图片 dataUrl → inlineData；非法 dataUrl 跳过；全空 parts 补空文本；相邻 user 合并', () => {
    const contents = toGeminiContents([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这张图' },
          { type: 'image_url', image_url: { url: PNG_URL } },
          { type: 'image_url', image_url: { url: 'https://not-a-data-url' } }
        ]
      },
      { role: 'user', content: [] }
    ])
    // 两条 user 相邻 → 合并成一条；空数组 content 循环后为空 → 补 {text:''}
    expect(contents).toHaveLength(1)
    expect(contents[0]?.parts).toEqual([
      { text: '看这张图' },
      { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
      { text: '' }
    ])
  })

  it('相邻同角色合并（两条 user 结果合成一条 user），openai 顺序保持', () => {
    const contents = toGeminiContents(toolRoundTrip())
    // user(问题) / model(调用) / user(两条结果合并) —— 不产生连续同角色
    const roles = contents.map((c) => c.role)
    expect(roles).toEqual(['user', 'model', 'user'])
    for (let i = 1; i < roles.length; i++) expect(roles[i]).not.toBe(roles[i - 1])
  })

  it('tool_calls 的 arguments 不是对象时包成 { value }（防整请求 400）', () => {
    const turns: ChatTurn[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '[1,2]' } }]
      }
    ]
    const parts = toGeminiContents(turns)[0]?.parts ?? []
    expect(parts[0]).toEqual({ functionCall: { name: 'f', args: { value: [1, 2] } } })
  })

  it('openai tools → 包一层 functionDeclarations，JSON Schema 直透', () => {
    const tools: LlmTool[] = [
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: '写文件',
          parameters: { type: 'object', properties: { path: { type: 'string' } } }
        }
      }
    ]
    expect(toGeminiTools(tools)).toEqual([
      {
        functionDeclarations: [
          {
            name: 'write_file',
            description: '写文件',
            parameters: { type: 'object', properties: { path: { type: 'string' } } }
          }
        ]
      }
    ])
  })

  it('generationConfig.temperature 钳到 [0,2]；带工具时才有 tools 键', () => {
    const hot = buildGeminiBody({
      model: 'm',
      temperature: 2.5,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: { name: 't', description: '', parameters: { type: 'object' } }
        }
      ]
    })
    expect(hot.generationConfig?.temperature).toBe(2)
    expect(hot.tools).toBeDefined()
    const cold = buildGeminiBody({
      model: 'm',
      temperature: -1,
      messages: [{ role: 'user', content: 'hi' }]
    })
    expect(cold.generationConfig?.temperature).toBe(0)
    expect(cold.tools).toBeUndefined()
  })

  it('端点拼装：容忍尾斜杠 / 已带 v1beta / 模型名转义；alt=sse 必带', () => {
    expect(geminiEndpoint('https://x.com/', 'g', 'streamGenerateContent')).toBe(
      'https://x.com/v1beta/models/g:streamGenerateContent?alt=sse'
    )
    expect(geminiEndpoint('https://x.com/v1beta', 'g', 'generateContent')).toBe(
      'https://x.com/v1beta/models/g:generateContent?alt=sse'
    )
    expect(geminiEndpoint('https://x.com', 'gemini-2.5-flash', 'generateContent')).toBe(
      'https://x.com/v1beta/models/gemini-2.5-flash:generateContent?alt=sse'
    )
  })

  it('dataUrl 解析：合法 png 通过、非 base64 图返回 null', () => {
    expect(dataUrlToGeminiInline(PNG_URL)).toEqual({ mimeType: 'image/png', data: 'AAAA' })
    expect(dataUrlToGeminiInline('data:text/plain;base64,AA')).toBeNull()
    expect(dataUrlToGeminiInline('https://x/a.png')).toBeNull()
  })

  it('合成调用 id 稳定可读（流式无 id，靠它回放配对）', () => {
    expect(synthesizeCallId(0, 'write_file')).toBe('call_0_write_file')
    expect(synthesizeCallId(2, 'list_dir')).toBe('call_2_list_dir')
  })
})

describe('Gemini SSE 聚合', () => {
  /** 造一条候选事件的小工具 */
  const chunk = (
    parts: unknown,
    finishReason?: string
  ): { candidates: Array<{ content: { parts: unknown }; finishReason?: string }> } => ({
    candidates: [{ content: { parts }, finishReason }]
  })

  it('文本分片：累积 + isTextDelta + chunk 透传；空文本 part 不算增量', () => {
    const agg = new GeminiStreamAggregator()
    const a = agg.feed(chunk([{ text: '你' }]))
    const b = agg.feed(chunk([{ text: '好' }]))
    const c = agg.feed(chunk([{ text: '' }]))
    expect(a).toEqual({ isTextDelta: true, isThinkingDelta: false, chunk: '你' })
    expect(b).toEqual({ isTextDelta: true, isThinkingDelta: false, chunk: '好' })
    expect(c.isTextDelta).toBe(false)
    expect(agg.text).toBe('你好')
  })

  it('★ functionCall part → 成品 toolCalls（合成 id + argsJson 序列化）', () => {
    const agg = new GeminiStreamAggregator()
    agg.feed(chunk([{ functionCall: { name: 'write_file', args: { path: 'a.txt' } } }]))
    const final = agg.finalize()
    expect(final.toolCalls).toEqual([
      { id: 'call_0_write_file', name: 'write_file', argsJson: '{"path":"a.txt"}' }
    ])
  })

  it('★ 混合分片（先文本后调用）→ finishReason=tool_calls（即使流标 STOP）', () => {
    const agg = new GeminiStreamAggregator()
    agg.feed(chunk([{ text: '我来建文件。' }]))
    agg.feed(chunk([{ functionCall: { name: 'write_file', args: {} } }], 'STOP'))
    const final = agg.finalize()
    expect(final.finishReason).toBe('tool_calls')
    expect(final.text).toBe('我来建文件。')
  })

  it('无调用的正常结束：STOP → stop；MAX_TOKENS → length（截断可感知）', () => {
    const stop = new GeminiStreamAggregator()
    stop.feed(chunk([{ text: '好' }], 'STOP'))
    expect(stop.finalize().finishReason).toBe('stop')

    const truncated = new GeminiStreamAggregator()
    truncated.feed(chunk([{ text: '说到一半' }], 'MAX_TOKENS'))
    expect(truncated.finalize().finishReason).toBe('length')
  })

  it('★ usageMetadata → 统一用量；cachedContentTokenCount → 缓存命中可见', () => {
    const agg = new GeminiStreamAggregator()
    agg.feed({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 8,
        totalTokenCount: 108,
        cachedContentTokenCount: 64
      }
    })
    const final = agg.finalize()
    expect(final.usage).toEqual({ promptTokens: 100, completionTokens: 8, totalTokens: 108 })
    expect(final.cachedTokens).toBe(64)
    expect(final.cacheKnown).toBe(true)
  })

  it('没报缓存字段 → cacheKnown=false（遥测不假装知道）', () => {
    const agg = new GeminiStreamAggregator()
    agg.feed({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 }
    })
    const final = agg.finalize()
    expect(final.cacheKnown).toBe(false)
    expect(final.cachedTokens).toBeUndefined()
  })

  it('同帧多 part（文本+调用）一次喂入也能全收；finalize 的 tokPerS 有限值', () => {
    const agg = new GeminiStreamAggregator()
    agg.feed(chunk([{ text: '好' }, { functionCall: { name: 't', args: {} } }], 'STOP'))
    const final = agg.finalize()
    expect(final.text).toBe('好')
    expect(final.toolCalls).toHaveLength(1)
    expect(Number.isFinite(final.tokPerS)).toBe(true)
  })

  it('★ 思考摘要计入生成口径：TTFT 由首片 thought 触发，genMs 覆盖思考+正文（tok/s 修复）', () => {
    // 可控时钟精确验证（t0=1000：思考 1040 起、正文 1190 止 → genMs=150）
    let clock = 1000
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    try {
      const agg = new GeminiStreamAggregator()
      agg.feed(chunk([])) // 只触发 markStart（t0），无增量
      clock = 1040
      const t1 = agg.feed(chunk([{ text: '推一步', thought: true }]))
      expect(t1.isThinkingDelta).toBe(true)
      expect(agg.ttftMs).toBe(40) // 首片思考即 TTFT（修复前恒 0）
      clock = 1190
      agg.feed(chunk([{ text: '结论' }]))
      const f = agg.finalize()
      expect(f.thinking).toBe('推一步')
      expect(f.text).toBe('结论')
      // 纯生成期 = 首增量 → 末增量 = 1190-1040 = 150ms（修复前只算正文段）
      expect(f.genMs).toBe(150)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('★ functionCall part 计入 TTFT：纯调用轮不再"首 token —"', () => {
    let clock = 1000
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    try {
      const agg = new GeminiStreamAggregator()
      agg.feed(chunk([])) // 只触发 markStart（t0），无增量
      clock = 1060
      agg.feed(chunk([{ functionCall: { name: 'current_time', args: {} } }], 'STOP'))
      const f = agg.finalize()
      expect(f.ttftMs).toBe(60) // 首片调用即 TTFT（修复前恒 0）
      expect(f.finishReason).toBe('tool_calls')
    } finally {
      nowSpy.mockRestore()
    }
  })
})
