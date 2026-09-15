// Anthropic Messages API 适配：openai 形态的 ChatTurn[]/LlmTool ↔ Anthropic
// messages/tools 的双向转换 + 原生 fetch SSE 流式解析。
// 为什么手写而不装 @anthropic-ai/sdk：本阶段唯一解禁依赖是 MCP SDK，
// Anthropic 走原生 fetch + 自研 SSE 行解析（协议稳定，代码可控）。
// 纯转换函数与 SSE 事件聚合全部导出，vitest 可直接单测（不依赖网络）。

import type {
  ChatTurn,
  LlmTool,
  StreamChatRequest,
  StreamChatHandlers,
  StreamChatResult,
  ToolCallDraft
} from './client'
import type { TokenUsage } from '@shared/types'

/** Anthropic temperature 合法范围 0~1（与 openai 兼容端点的 0~2 不同，发送前钳制） */
export const ANTHROPIC_MAX_TEMPERATURE = 1
/** max_tokens 必填：默认输出上限（够日常对话与工具编排；后续可按档案扩展） */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096

// ── 请求转换：openai 形态 → Anthropic Messages 形态 ────────────────────────

export interface AnthropicRequest {
  model: string
  maxTokens: number
  temperature: number
  /** system 提示词（openai 形态的首条 system turn 提出） */
  system?: string
  messages: AnthropicMessage[]
  tools?: AnthropicTool[]
}

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; tool_use_id: string; content: string }
  >
}

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

/** dataUrl（data:image/png;base64,xxx）→ Anthropic image source；解析失败返回 null */
export function dataUrlToAnthropicSource(
  dataUrl: string
): { type: 'base64'; media_type: string; data: string } | null {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl)
  if (match === null) return null
  return { type: 'base64', media_type: match[1], data: match[2] }
}

/** 单条 openai user/assistant 消息 → Anthropic content 块数组 */
function toAnthropicContent(turn: ChatTurn): AnthropicMessage['content'] {
  const blocks: AnthropicMessage['content'] = []
  if (turn.role === 'assistant' && turn.tool_calls !== undefined && turn.tool_calls.length > 0) {
    // assistant：正文（可空）+ 每个工具调用一个 tool_use 块
    if (typeof turn.content === 'string' && turn.content !== '') {
      blocks.push({ type: 'text', text: turn.content })
    }
    for (const call of turn.tool_calls) {
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(call.function.arguments === '' ? '{}' : call.function.arguments)
      } catch {
        input = {} // 坏参数按空对象透传（Anthropic 侧会给出明确错误）
      }
      blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input })
    }
    return blocks
  }
  if (turn.role === 'tool') {
    // 工具结果 → user 消息里的 tool_result 块（Anthropic 语义：结果由 user 转交）
    blocks.push({
      type: 'tool_result',
      tool_use_id: turn.tool_call_id ?? '',
      content: typeof turn.content === 'string' ? turn.content : ''
    })
    return blocks
  }
  // user：文本与图片（openai 多模态 parts → text/image 块）
  if (typeof turn.content === 'string' || turn.content === null) {
    blocks.push({ type: 'text', text: typeof turn.content === 'string' ? turn.content : '' })
    return blocks
  }
  for (const part of turn.content) {
    if (part.type === 'text') {
      if (part.text !== '') blocks.push({ type: 'text', text: part.text })
    } else {
      const source = dataUrlToAnthropicSource(part.image_url.url)
      if (source !== null) blocks.push({ type: 'image', source })
    }
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
  return blocks
}

/**
 * openai 形态消息 → Anthropic messages（相邻同角色合并——Anthropic 要求 user/assistant
 * 严格交替，而工具往返会产生连续的 assistant(tool_use)+user(tool_result)…+user(tool_result)。
 * 合并策略：同角色相邻则 content 块直接拼接，顺序保持。
 */
export function toAnthropicMessages(turns: ChatTurn[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  for (const turn of turns) {
    if (turn.role === 'system') continue // system 由调用方单独提取
    const role = turn.role === 'assistant' ? 'assistant' : 'user'
    const content = toAnthropicContent(turn)
    const prev = out[out.length - 1]
    if (prev !== undefined && prev.role === role) {
      prev.content.push(...content)
    } else {
      out.push({ role, content })
    }
  }
  return out
}

/** openai tools → Anthropic tools（parameters → input_schema 直透） */
export function toAnthropicTools(tools: LlmTool[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters
  }))
}

// ── SSE 事件聚合：Anthropic 流式 → 统一 StreamChatResult ─────────────────

/** 流式聚合器：喂入每条 SSE data JSON，结束时输出统一结果 */
export class AnthropicStreamAggregator {
  text = ''
  thinking = ''
  toolCalls: ToolCallDraft[] = []
  finishReason = 'stop'
  usage?: TokenUsage
  cachedTokens?: number
  cacheKnown = false
  ttftMs = 0
  private t0 = 0
  /** 首个增量（正文或思考）时刻；与 lastDeltaAt 一起给出纯生成期 genMs */
  private firstDeltaAt = 0
  private lastDeltaAt = 0
  /** 进行中的 tool_use 块：index → { id, name, json 分片 } */
  private pending = new Map<number, { id: string; name: string; json: string[] }>()
  private sawFirstDelta = false

  markStart(): void {
    if (this.t0 === 0) this.t0 = performance.now()
  }

  /** 喂一条 SSE 事件（data: 后的 JSON 对象）；返回是否为文本/思考增量（供 TTFT/转发判定） */
  feed(event: {
    type: string
    message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number } }
    content_block?: { type: string; id?: string; name?: string }
    index?: number
    delta?: {
      type?: string
      text?: string
      thinking?: string
      partial_json?: string
      stop_reason?: string
    }
    usage?: { output_tokens?: number }
  }): { isTextDelta: boolean; isThinkingDelta: boolean; chunk: string } {
    let isTextDelta = false
    let isThinkingDelta = false
    let chunk = ''
    this.markStart()
    switch (event.type) {
      case 'message_start': {
        const u = event.message?.usage
        if (u !== undefined) {
          const input = u.input_tokens ?? 0
          const cached = u.cache_read_input_tokens
          this.usage = { promptTokens: input, completionTokens: 0, totalTokens: input }
          if (typeof cached === 'number') {
            this.cachedTokens = cached
            this.cacheKnown = true
          }
        }
        break
      }
      case 'content_block_start': {
        if (event.content_block?.type === 'tool_use' && event.content_block.id !== undefined) {
          this.pending.set(event.index ?? 0, {
            id: event.content_block.id,
            name: event.content_block.name ?? '',
            json: []
          })
        }
        break
      }
      case 'content_block_delta': {
        if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
          this.text += event.delta.text
          chunk = event.delta.text
          isTextDelta = true
          const now = performance.now()
          if (!this.sawFirstDelta) {
            this.sawFirstDelta = true
            this.firstDeltaAt = now
            this.ttftMs = Math.round(now - this.t0)
          }
          this.lastDeltaAt = now
        } else if (
          event.delta?.type === 'input_json_delta' &&
          typeof event.delta.partial_json === 'string'
        ) {
          const pending = this.pending.get(event.index ?? 0)
          if (pending) pending.json.push(event.delta.partial_json)
          // ★ 工具参数也是逐 token 生成的输出（对齐 成熟实现isTokenDelta）：
          // 计入首/末 token 计时，否则「不写文字直接调用」的轮次 ttft=0、tok/s 分母缺段。
          if (event.delta.partial_json !== '') {
            const now = performance.now()
            if (!this.sawFirstDelta) {
              this.sawFirstDelta = true
              this.firstDeltaAt = now
              this.ttftMs = Math.round(now - this.t0)
            }
            this.lastDeltaAt = now
          }
        } else if (
          // 思考增量（extended thinking；仅在请求显式开启时供应商才会返回——我们被动透传）
          event.delta?.type === 'thinking_delta' &&
          typeof event.delta.thinking === 'string'
        ) {
          // ★ 思考增量同样计入生成口径（口径说明详见 client.ts）：out_tokens 含思考 tokens，
          // 时长若不含思考期就会让 tok/s 虚高。首 token 与末 token 都算它。
          const now = performance.now()
          if (!this.sawFirstDelta) {
            this.sawFirstDelta = true
            this.firstDeltaAt = now
            this.ttftMs = Math.round(now - this.t0)
          }
          this.lastDeltaAt = now
          this.thinking += event.delta.thinking
          chunk = event.delta.thinking
          isThinkingDelta = true
        }
        break
      }
      case 'message_delta': {
        if (event.delta?.stop_reason === 'tool_use') this.finishReason = 'tool_calls'
        else if (event.delta?.stop_reason === 'end_turn') this.finishReason = 'stop'
        const output = event.usage?.output_tokens
        if (typeof output === 'number') {
          this.usage = {
            promptTokens: this.usage?.promptTokens ?? 0,
            completionTokens: output,
            totalTokens: (this.usage?.promptTokens ?? 0) + output
          }
        }
        break
      }
      default:
        break // ping / content_block_stop / message_stop 无需处理
    }
    return { isTextDelta, isThinkingDelta, chunk }
  }

  /** 流结束：拼装工具调用与输出速度 */
  finalize(): {
    text: string
    thinking: string
    toolCalls: ToolCallDraft[]
    finishReason: string
    usage?: TokenUsage
    cachedTokens?: number
    cacheKnown: boolean
    ttftMs: number
    genMs: number
    tokPerS: number
  } {
    const toolCalls: ToolCallDraft[] = [...this.pending.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        argsJson: p.json.join('') === '' ? '{}' : p.json.join('')
      }))
    // 纯生成期 = 首个增量 → 末个增量（对齐 openai 协议口径）。
    // 原先用 now - t0，把建连等待也算进了"生成"，与"纯输出 token"的分子口径不一致 → tok/s 偏低。
    const genMs =
      this.firstDeltaAt > 0 && this.lastDeltaAt > 0
        ? Math.round(this.lastDeltaAt - this.firstDeltaAt)
        : 0
    const completion = this.usage?.completionTokens ?? 0
    return {
      text: this.text,
      thinking: this.thinking,
      toolCalls,
      finishReason: this.finishReason,
      usage: this.usage,
      cachedTokens: this.cachedTokens,
      cacheKnown: this.cacheKnown,
      ttftMs: this.ttftMs,
      genMs,
      tokPerS: genMs > 0 && completion > 0 ? Math.round((completion / genMs) * 1000) : 0
    }
  }
}

// ── 流式请求入口：client.streamChat 按 protocol==='anthropic' 分派到这里 ──

export async function streamAnthropic(
  request: StreamChatRequest,
  handlers: StreamChatHandlers
): Promise<StreamChatResult> {
  const systemTurn = request.messages.find((t) => t.role === 'system')
  const rest = request.messages.filter((t) => t.role !== 'system')
  // 思考强度：extended thinking 预算档位。开启时 Anthropic 要求 temperature 恒为 1，
  // 且 max_tokens 必须大于预算（预算含在 completion 里）。
  const budget =
    request.reasoningEffort !== undefined && request.reasoningEffort !== 'default'
      ? { low: 4096, medium: 10240, high: 20480 }[request.reasoningEffort]
      : undefined
  const body = {
    model: request.model,
    max_tokens: budget !== undefined ? budget + 4096 : ANTHROPIC_DEFAULT_MAX_TOKENS,
    temperature:
      budget !== undefined
        ? ANTHROPIC_MAX_TEMPERATURE
        : Math.min(Math.max(request.temperature, 0), ANTHROPIC_MAX_TEMPERATURE),
    ...(budget !== undefined ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
    ...(systemTurn !== undefined && typeof systemTurn.content === 'string'
      ? { system: systemTurn.content }
      : {}),
    messages: toAnthropicMessages(rest),
    ...(request.tools !== undefined && request.tools.length > 0
      ? { tools: toAnthropicTools(request.tools) }
      : {}),
    stream: true
  }

  const aggregator = new AnthropicStreamAggregator()
  // ★ t0 在 fetch 前起表（对齐 成熟实现「请求发出→首增量」）：markStart 此前在首帧才打点，
  // 把建连+等首帧全漏掉 → 带缓存端点 ttft 恒 0、监测栏"首 token —"。
  aggregator.markStart()
  const t0 = Date.now()
  const response = await fetch(`${request.baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': request.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body),
    signal: handlers.signal
  })
  if (!response.ok || response.body === null) {
    const detail = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}：${detail.slice(0, 300)}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  // SSE 行解析：事件以 data: {...} 行承载（Anthropic 无多行 data），按 \n\n 分帧
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newlineAt = buffer.indexOf('\n')
    while (newlineAt !== -1) {
      const line = buffer.slice(0, newlineAt).replace(/\r$/, '')
      buffer = buffer.slice(newlineAt + 1)
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim()
        if (payload !== '') {
          try {
            const parsed = JSON.parse(payload) as Parameters<AnthropicStreamAggregator['feed']>[0]
            const { isTextDelta, isThinkingDelta, chunk } = aggregator.feed(parsed)
            if (isTextDelta) handlers.onDelta(chunk)
            else if (isThinkingDelta) handlers.onThinking?.(chunk)
          } catch {
            // 非法 JSON 帧跳过（网络分帧噪音）
          }
        }
      }
      newlineAt = buffer.indexOf('\n')
    }
  }

  const final = aggregator.finalize()
  const totalMs = Date.now() - t0
  return {
    text: final.text,
    thinking: final.thinking,
    toolCalls: final.toolCalls,
    finishReason: final.finishReason,
    usage: final.usage,
    cachedTokens: final.cachedTokens,
    cacheKnown: final.cacheKnown,
    ttftMs: final.ttftMs,
    totalMs,
    genMs: final.genMs,
    tokPerS: final.tokPerS
  }
}

/** 连接测试（anthropic 分支）：非流式最小 messages 请求，区分网络/401/模型名 */
export async function testConnectionAnthropic(options: {
  baseUrl: string
  apiKey: string
  model: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': options.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: options.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }]
      }),
      signal: AbortSignal.timeout(15_000)
    })
    if (response.ok) return { ok: true }
    if (response.status === 401)
      return { ok: false, error: 'API Key 无效（401）。请检查密钥是否正确。' }
    if (response.status === 404)
      return { ok: false, error: '模型不存在（404）。请检查模型名拼写。' }
    const detail = await response.text().catch(() => '')
    return { ok: false, error: `HTTP ${response.status}：${detail.slice(0, 200)}` }
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return { ok: false, error: '连接超时（15 秒无响应）。请检查网络与 baseUrl 是否可访问。' }
    }
    return { ok: false, error: `网络错误：${err instanceof Error ? err.message : String(err)}` }
  }
}
