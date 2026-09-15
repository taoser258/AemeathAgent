// LLM 客户端：官方 openai npm SDK + 自定义 baseUrl 的流式封装。
// 面向任何 OpenAI 兼容端点（千问 DashScope / GLM / DeepSeek / Kimi …），
// baseUrl/model/key 全部来自设置页；中断走 AbortSignal（对接 chat:cancel）。
// 异常翻译见 errors.ts（区分网络 / Key 无效 / 端点或模型不存在 / 服务端异常）。

import OpenAI from 'openai'
import type { Stream } from 'openai/streaming'
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming
} from 'openai/resources/chat/completions'
import { classifyLlmError } from './errors'
import type { TokenUsage, ReasoningEffort } from '@shared/types'

/** 多模态 content part（OpenAI 兼容视觉格式）；纯文本消息继续用 string */
export type ChatContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

/** 工具调用意图（流式分片拼装后的成品；id/参数由 LLM 生成） */
export interface ToolCallDraft {
  id: string
  name: string
  /** 参数 JSON 字符串（原样，解析由执行方负责） */
  argsJson: string
}

/**
 * 一条送给 LLM 的消息。支持工具往返：
 * - assistant 消息可带 tool_calls（模型发起的调用）
 * - tool 消息承载执行结果（tool_call_id 与发起侧配对）
 */
export interface ChatTurn {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ChatContentPart[] | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

/** 取一条消息的纯文本长度（上下文预算/裁剪用；图片按约 1000 token 折算） */
export function turnTextLength(turn: ChatTurn): number {
  if (turn.content === null) return 0
  if (typeof turn.content === 'string') return turn.content.length
  return turn.content.reduce((n, part) => n + (part.type === 'text' ? part.text.length : 1600), 0)
}

/** openai SDK 的 tools 参数形状（由 registry 生成后透传） */
export interface LlmTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface StreamChatRequest {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  messages: ChatTurn[]
  /** 可用工具；缺省 = 不带 tools 参数，纯对话 */
  tools?: LlmTool[]
  /** 协议：缺省 'openai'（兼容端点）；'anthropic' 原生 Messages；'gemini' 原生 generateContent */
  protocol?: 'openai' | 'anthropic' | 'gemini'
  /** 思考强度：default/缺省不注入；openai 协议映射 reasoning_effort */
  reasoningEffort?: ReasoningEffort
}

export interface StreamChatHandlers {
  signal: AbortSignal
  /** 收到一个文本增量 */
  onDelta: (chunk: string) => void
  /** 收到一个思考增量（模型主动输出的推理内容；供应商没给就不触发——我们不主动开启，P4 过程时间线 v1） */
  onThinking?: (chunk: string) => void
}

export interface StreamChatResult {
  text: string
  /** 模型主动输出的思考内容（reasoning/thinking；供应商没给 = 空串。只透传不落请求参数） */
  thinking: string
  /** 模型发起的工具调用（流式分片拼装成品；无则为空数组） */
  toolCalls: ToolCallDraft[]
  /** 本轮流结束原因：'stop'（自然结束）| 'tool_calls'（要求调用工具）等 */
  finishReason: string
  /** 本次请求的真实 token 用量（stream_options.include_usage；供应商不支持时缺省） */
  usage?: TokenUsage
  /** 缓存命中 tokens（DeepSeek 专用字段或 OpenAI cached_tokens；未上报 = undefined） */
  cachedTokens?: number
  /** 供应商是否上报了缓存字段 */
  cacheKnown: boolean
  /** 首 token 延迟 ms（请求发出 → 首个非空增量；无增量 = 0） */
  ttftMs: number
  /** 整次请求耗时 ms（含建连与 TTFT） */
  totalMs: number
  /** 纯生成阶段耗时 ms（首 token → 末 token） */
  genMs: number
  /** 输出速度 tokens/s（completion_tokens ÷ genMs） */
  tokPerS: number
}

/**
 * 发起一次流式对话，resolve 时返回完整回复文本与真实 token 用量。
 * 中断（signal 已 abort）会以异常抛出，由调用方检查 signal.aborted 区分处理。
 * include_usage 优先：部分兼容端点不认识 stream_options 会直接报错——
 * 此时在"尚未产出任何增量"的安全点降级为不带 stream_options 重试一次。
 */
export async function streamChat(
  request: StreamChatRequest,
  handlers: StreamChatHandlers
): Promise<StreamChatResult> {
  if (request.protocol === 'anthropic') {
    const { streamAnthropic } = await import('./anthropic')
    return streamAnthropic(request, handlers)
  }
  if (request.protocol === 'gemini') {
    const { streamGemini } = await import('./gemini')
    return streamGemini(request, handlers)
  }
  const client = new OpenAI({
    apiKey: request.apiKey,
    baseURL: request.baseUrl,
    timeout: 120_000,
    maxRetries: 0 // 不静默重试：流式重试会造成重复输出，失败交给用户决策
  })

  // 部分厂商（qwen/dashscope 兼容层等）虽然文档写 [0, 2.0]，实际校验对恰好 2.0 也拒绝
  // （开区间，报 400 "Temperature should be in [0.0, 2.0]"）——发送前钳到 1.99 兜底。
  const temperature = Math.min(Math.max(request.temperature, 0), 1.99)

  const base = {
    model: request.model,
    temperature,
    messages: request.messages,
    ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
    // 思考强度：OpenAI 兼容语义 reasoning_effort（o 系/兼容网关广泛支持；不支持的服务端会忽略）
    ...(request.reasoningEffort !== undefined && request.reasoningEffort !== 'default'
      ? { reasoning_effort: request.reasoningEffort }
      : {}),
    stream: true
  }

  // 遥测计时（performance.now 单调时钟）：t0 必须**在发起请求前**取——含建连与
  // 等响应头（对齐 成熟实现「请求发出→首增量」口径）。此前放在 createOnce 之后取，
  // 带缓存端点（qwen 等）首块在连接期就已生成、流一建好立刻吐出 → ttft 恒 0，
  // 监测栏显示"首 token —"。降级重试重置：每次尝试单独计时。
  let t0 = performance.now()
  let stream: Awaited<ReturnType<typeof createOnce>>
  try {
    stream = await createOnce(true)
  } catch (err) {
    if (handlers.signal.aborted) throw err
    t0 = performance.now() // 不认识 stream_options 的端点：降级重发=重新计时
    stream = await createOnce(false)
  }

  async function createOnce(withUsage: boolean): Promise<Stream<ChatCompletionChunk>> {
    const params: ChatCompletionCreateParamsStreaming = withUsage
      ? {
          ...base,
          messages: base.messages as ChatCompletionCreateParamsStreaming['messages'],
          stream_options: { include_usage: true },
          stream: true
        }
      : {
          ...base,
          messages: base.messages as ChatCompletionCreateParamsStreaming['messages'],
          stream: true
        }
    return client.chat.completions.create(params, { signal: handlers.signal })
  }

  let accumulated = ''
  let thinking = ''
  let usage: TokenUsage | undefined
  let cachedTokens: number | undefined // 供应商上报的缓存命中 tokens（未上报 = undefined）
  // 工具调用分片拼装：流式下 tool_calls 按 index 分多片到达（id/name/arguments 各自续片）
  const pendingCalls = new Map<number, { id: string; name: string; args: string[] }>()
  let finishReason = ''
  let firstAt: number | null = null
  let lastAt: number | null = null
  let deltaCount = 0
  /** 思考增量数（仅在供应商未上报 usage 时用于近似 completionTokens；见下方口径说明） */
  let reasoningDeltas = 0
  for await (const chunk of stream) {
    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
        totalTokens: chunk.usage.total_tokens ?? 0
      }
      // 缓存命中：DeepSeek 专用字段 prompt_cache_hit_tokens，OpenAI 系 prompt_tokens_details.cached_tokens
      const raw = chunk.usage as {
        prompt_cache_hit_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
      }
      if (typeof raw.prompt_cache_hit_tokens === 'number') {
        cachedTokens = raw.prompt_cache_hit_tokens
      } else if (typeof raw.prompt_tokens_details?.cached_tokens === 'number') {
        cachedTokens = raw.prompt_tokens_details.cached_tokens
      }
    }
    const choice = chunk.choices[0]
    if (choice?.finish_reason) finishReason = choice.finish_reason
    // 工具调用分片：同一 index 的 name/arguments 分多次到达，按片续接。
    // ★ 对齐 成熟实现isTokenDelta：工具参数也是模型逐 token 生成的输出——
    // 计入首/末 token 计时与近似增量数。此前只算正文/思考，导致「不写文字直接调用」
    // 的轮次 ttft=0（监测栏显示"首 token —"）、genMs 不含工具段而 usage 含工具 tokens
    // → tok/s 口径错位。
    let toolDelta = false
    for (const dc of choice?.delta?.tool_calls ?? []) {
      const entry = pendingCalls.get(dc.index) ?? { id: '', name: '', args: [] }
      if (dc.id) entry.id = dc.id
      if (dc.function?.name) entry.name += dc.function.name
      if (dc.function?.arguments) entry.args.push(dc.function.arguments)
      pendingCalls.set(dc.index, entry)
      if (dc.function?.name !== undefined || dc.function?.arguments !== undefined) toolDelta = true
    }
    if (toolDelta) {
      const now = performance.now()
      if (firstAt === null) firstAt = now
      lastAt = now
      deltaCount += 1
    }
    const delta = choice?.delta?.content ?? ''
    if (delta !== '') {
      const now = performance.now()
      if (firstAt === null) firstAt = now // 空增量不算首 token
      lastAt = now
      deltaCount += 1
      accumulated += delta
      handlers.onDelta(delta)
    }
    // 思考增量：DeepSeek R1 系的 reasoning_content（OpenAI 兼容网关的事实标准字段，
    // SDK 类型未收录）；模型给了就透传，没给不触发——不主动开启思考（行为与成本不变）
    const reasoning = (choice?.delta as { reasoning_content?: unknown } | undefined)
      ?.reasoning_content
    if (typeof reasoning === 'string' && reasoning !== '') {
      // ★ 思考增量同样计入「生成」口径：
      // usage.completion_tokens **包含** reasoning tokens，若时长只统计正文段，
      // 就成了「分子含思考、分母不含思考期」→ 分母偏小 → tok/s 虚高。
      // 思考也是被模型生成的 token，这里让它参与首 token / 末 token 计时。
      const now = performance.now()
      if (firstAt === null) firstAt = now
      lastAt = now
      reasoningDeltas += 1
      thinking += reasoning
      handlers.onThinking?.(reasoning)
    }
  }
  const end = performance.now()
  const totalMs = Math.round(end - t0)
  const genMs = firstAt !== null && lastAt !== null ? Math.round(lastAt - firstAt) : 0
  const ttftMs = firstAt !== null ? Math.round(firstAt - t0) : 0
  // 供应商未上报 usage 时用增量数近似：正文 + 思考（与时长口径一致，避免一边含一边不含）
  const completionTokens = usage?.completionTokens ?? deltaCount + reasoningDeltas
  const tokPerS = genMs > 0 ? Math.round((completionTokens / genMs) * 1000) : 0
  const toolCalls: ToolCallDraft[] = [...pendingCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, c]) => ({ id: c.id, name: c.name, argsJson: c.args.join('') }))
  return {
    text: accumulated,
    thinking,
    toolCalls,
    finishReason: finishReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
    usage,
    cachedTokens,
    cacheKnown: cachedTokens !== undefined,
    ttftMs,
    totalMs,
    genMs,
    tokPerS
  }
}

export type TestConnectionResult = { ok: true } | { ok: false; error: string }

/** 测试连接：发一条 max_tokens=1 的最小请求；失败时返回可读错误（验收：区分网络/401/模型名） */
export async function testConnection(options: {
  baseUrl: string
  apiKey: string
  model: string
  protocol?: 'openai' | 'anthropic' | 'gemini'
}): Promise<TestConnectionResult> {
  if (options.protocol === 'anthropic') {
    const { testConnectionAnthropic } = await import('./anthropic')
    return testConnectionAnthropic(options)
  }
  if (options.protocol === 'gemini') {
    const { testConnectionGemini } = await import('./gemini')
    return testConnectionGemini(options)
  }
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    timeout: 15_000,
    maxRetries: 0
  })
  try {
    await client.chat.completions.create(
      {
        model: options.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1
      },
      { signal: AbortSignal.timeout(15_000) }
    )
    return { ok: true }
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return { ok: false, error: '连接超时（15 秒无响应）。请检查网络与 baseUrl 是否可访问。' }
    }
    return { ok: false, error: classifyLlmError(err).message }
  }
}
