// Gemini 原生协议适配：openai 形态的 ChatTurn[]/LlmTool ↔ Gemini
// generateContent 的 contents/tools 双向转换 + 原生 fetch SSE 流式解析。
// 照 anthropic.ts 同款范式：纯转换函数与 SSE 聚合器全部导出，
// vitest 直接单测（不依赖网络）；零新增依赖（fetch + 手写 SSE 行解析）。
//
// 与 Anthropic 的两个关键差异（为什么不能照抄）：
// 1. Gemini 的工具调用**没有 id**，结果用「函数名」配对（functionResponse.name），
// 而 openai 形态的 tool 消息只带 tool_call_id —— 转换时要回扫历史里的
// assistant.tool_calls 建 id→name 映射；映射缺失时按出现顺序兜底。
// 2. functionResponse.response 必须是 **JSON 对象**，不是字符串——纯文本结果包成
// { result: 文本 } 再交出去，否则 Gemini 直接 400。

import type {
  ChatTurn,
  LlmTool,
  StreamChatRequest,
  StreamChatHandlers,
  StreamChatResult,
  ToolCallDraft
} from './client'
import type { TokenUsage } from '@shared/types'

/** Gemini temperature 合法范围 0~2（闭区间，与 openai 兼容层的开区间坑不同） */
export const GEMINI_MAX_TEMPERATURE = 2

// ── 请求转换：openai 形态 → Gemini generateContent 形态 ───────────────────

export interface GeminiPart {
  text?: string
  /** 思考摘要标记（2.5 系；仅 generationConfig 附带 thought 时返回，我们被动透传） */
  thought?: boolean
  inlineData?: { mimeType: string; data: string }
  functionCall?: { name: string; args: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
}

export interface GeminiContent {
  /** 'user' | 'model'；system 不进 contents（走 systemInstruction） */
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export interface GeminiTool {
  functionDeclarations: Array<{
    name: string
    description?: string
    parameters: Record<string, unknown>
  }>
}

export interface GeminiRequest {
  contents: GeminiContent[]
  systemInstruction?: { parts: Array<{ text: string }> }
  tools?: GeminiTool[]
  generationConfig?: { temperature?: number }
}

/** dataUrl（data:image/png;base64,xxx）→ Gemini inlineData；解析失败返回 null */
export function dataUrlToGeminiInline(dataUrl: string): { mimeType: string; data: string } | null {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl)
  if (match === null) return null
  return { mimeType: match[1], data: match[2] }
}

/** 工具调用 id（Gemini 无 id，流式侧需合成）→ 稳定可读的合成 id */
export function synthesizeCallId(index: number, name: string): string {
  return `call_${index}_${name}`
}

/**
 * 单条 openai 消息 → Gemini parts。
 * @param toolNameOf 查 tool_call_id 对应的函数名（工具结果配对用，见 toGeminiContents）
 */
function toGeminiParts(turn: ChatTurn, toolNameOf: (id: string) => string): GeminiPart[] {
  const parts: GeminiPart[] = []
  if (turn.role === 'assistant' && turn.tool_calls !== undefined && turn.tool_calls.length > 0) {
    // assistant：正文（可空）+ 每个工具调用一个 functionCall part（id 丢弃，Gemini 靠顺序）
    if (typeof turn.content === 'string' && turn.content !== '') {
      parts.push({ text: turn.content })
    }
    for (const call of turn.tool_calls) {
      let args: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(call.function.arguments === '' ? '{}' : call.function.arguments)
        // Gemini 要求 args 是对象；模型输出数组/标量时包一层，避免整请求 400
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>
        } else {
          args = { value: parsed }
        }
      } catch {
        args = {} // 坏参数按空对象透传
      }
      parts.push({ functionCall: { name: call.function.name, args } })
    }
    return parts
  }
  if (turn.role === 'tool') {
    // 工具结果 → user 消息里的 functionResponse part（Gemini 语义：结果由 user 转交）；
    // response 必须是对象，纯文本包成 { result }。
    const name = toolNameOf(turn.tool_call_id ?? '')
    const text = typeof turn.content === 'string' ? turn.content : ''
    parts.push({ functionResponse: { name, response: { result: text } } })
    return parts
  }
  // user：文本与图片
  if (typeof turn.content === 'string' || turn.content === null) {
    parts.push({ text: typeof turn.content === 'string' ? turn.content : '' })
    return parts
  }
  for (const part of turn.content) {
    if (part.type === 'text') {
      if (part.text !== '') parts.push({ text: part.text })
    } else {
      const inline = dataUrlToGeminiInline(part.image_url.url)
      if (inline !== null) parts.push({ inlineData: inline })
    }
  }
  if (parts.length === 0) parts.push({ text: '' })
  return parts
}

/**
 * openai 形态消息 → Gemini contents。
 * tool_call_id → 函数名的解析策略：
 * ① 回扫同一次请求里所有 assistant.tool_calls 建 id→name 映射（主路径，覆盖正常往返）；
 * ② 映射未命中（历史被裁剪等）时，按「最近一个 assistant 的调用顺序」队列兜底；
 * ③ 都没有 → 'unknown_tool'（Gemini 会给出可读报错，好过静默丢结果）。
 */
export function toGeminiContents(turns: ChatTurn[]): GeminiContent[] {
  const idToName = new Map<string, string>()
  for (const turn of turns) {
    for (const call of turn.tool_calls ?? []) idToName.set(call.id, call.function.name)
  }
  // 兜底队列：遇到 assistant.tool_calls 时重置为当次调用名序列
  let fallbackNames: string[] = []
  const toolNameOf = (id: string): string => {
    const mapped = idToName.get(id)
    if (mapped !== undefined) return mapped
    return fallbackNames.shift() ?? 'unknown_tool'
  }

  const out: GeminiContent[] = []
  for (const turn of turns) {
    if (turn.role === 'system') continue // system 由调用方单独提取
    if (turn.role === 'assistant' && turn.tool_calls !== undefined && turn.tool_calls.length > 0) {
      fallbackNames = turn.tool_calls.map((c) => c.function.name)
    }
    const role = turn.role === 'assistant' ? 'model' : 'user'
    const parts = toGeminiParts(turn, toolNameOf)
    const prev = out[out.length - 1]
    if (prev !== undefined && prev.role === role) {
      prev.parts.push(...parts) // 相邻同角色合并（工具往返会产生连续 user 结果）
    } else {
      out.push({ role, parts })
    }
  }
  return out
}

/** openai tools → Gemini tools（parameters JSON Schema 直透，包一层 functionDeclarations） */
export function toGeminiTools(tools: LlmTool[]): GeminiTool[] {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters
      }))
    }
  ]
}

/** 组装完整请求体（streamGemini / 单测共用；导出是为了直接断言 body 形状） */
export function buildGeminiBody(
  request: Pick<
    StreamChatRequest,
    'model' | 'temperature' | 'messages' | 'tools' | 'reasoningEffort'
  >
): GeminiRequest {
  const systemTurn = request.messages.find((t) => t.role === 'system')
  const rest = request.messages.filter((t) => t.role !== 'system')
  const body: GeminiRequest = {
    contents: toGeminiContents(rest),
    generationConfig: {
      temperature: Math.min(Math.max(request.temperature, 0), GEMINI_MAX_TEMPERATURE),
      // 思考强度：2.5 系 thinkingBudget（flash 全程 0~24576；pro 最低 128——
      // 档位映射 low 1024 / medium 8192 / high 24576，default 不注入跟随模型默认）
      ...(request.reasoningEffort !== undefined && request.reasoningEffort !== 'default'
        ? {
            thinkingConfig: {
              thinkingBudget: { low: 1024, medium: 8192, high: 24576 }[
                request.reasoningEffort as 'low' | 'medium' | 'high'
              ]
            }
          }
        : {})
    }
  }
  // 刻意不带 maxOutputTokens：Gemini 2.5 系的思考 token 计入 maxOutputTokens，
  // 设小了会出现「空回复 + finishReason=MAX_TOKENS」，交给模型默认值反而稳。
  if (
    systemTurn !== undefined &&
    typeof systemTurn.content === 'string' &&
    systemTurn.content !== ''
  ) {
    body.systemInstruction = { parts: [{ text: systemTurn.content }] }
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = toGeminiTools(request.tools)
  }
  return body
}

// ── SSE 事件聚合：Gemini 流式 → 统一 StreamChatResult ─────────────────────

/** 流式候选里的 content part（只声明我们消费的字段） */
export interface GeminiStreamPart {
  text?: string
  /** 思考摘要标记（2.5 系；仅请求附带 thought 配置时返回，我们被动透传） */
  thought?: boolean
  functionCall?: { name: string; args?: Record<string, unknown> }
}

/** 流式候选（usageMetadata 单独一项） */
export interface GeminiStreamCandidate {
  content?: { parts?: GeminiStreamPart[] }
  finishReason?: string
}

/** 流式事件（data: 行的 JSON；只声明我们消费的字段） */
export interface GeminiStreamEvent {
  candidates?: GeminiStreamCandidate[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
    cachedContentTokenCount?: number
  }
}

/** 流结束原因 → openai 语义（finishReason 映射表；未列出的一律按自然结束） */
function mapFinishReason(reason: string | undefined, hasToolCall: boolean): string {
  if (hasToolCall) return 'tool_calls'
  if (reason === 'MAX_TOKENS') return 'length'
  return 'stop' // STOP / SAFETY / RECITATION / 缺省 …都按「这轮到此为止」处理
}

/** 流式聚合器：喂入每条 SSE data JSON，结束时输出统一结果 */
export class GeminiStreamAggregator {
  text = ''
  thinking = ''
  finishReasonRaw = ''
  usage?: TokenUsage
  cachedTokens?: number
  cacheKnown = false
  ttftMs = 0
  private t0 = 0
  /** 首个增量（正文或思考）时刻；与 lastDeltaAt 一起给出纯生成期 genMs */
  private firstDeltaAt = 0
  private lastDeltaAt = 0
  private sawFirstDelta = false
  /** 收到的 functionCall part（Gemini 一次给全 args 对象，无需分片拼装） */
  private calls: Array<{ id: string; name: string; args: Record<string, unknown> }> = []

  markStart(): void {
    if (this.t0 === 0) this.t0 = performance.now()
  }

  /** 喂一条 SSE 事件（data: 后的 JSON 对象）；返回是否为文本/思考增量（供 TTFT/转发判定） */
  feed(event: GeminiStreamEvent): {
    isTextDelta: boolean
    isThinkingDelta: boolean
    chunk: string
  } {
    let isTextDelta = false
    let isThinkingDelta = false
    let chunk = ''
    this.markStart()
    const candidate = event.candidates?.[0]
    for (const part of candidate?.content?.parts ?? []) {
      // 思考摘要 part 先于正文判定（thought:true 的 text 不进正文）
      if (part.thought === true && typeof part.text === 'string' && part.text !== '') {
        // ★ 思考增量同样计入生成口径（口径说明详见 client.ts）：候选 token 数含思考，
        // 时长若不含思考期就会让 tok/s 虚高。首 token 与末 token 都算它。
        const now = performance.now()
        if (!this.sawFirstDelta) {
          this.sawFirstDelta = true
          this.firstDeltaAt = now
          this.ttftMs = Math.round(now - this.t0)
        }
        this.lastDeltaAt = now
        this.thinking += part.text
        chunk = part.text
        isThinkingDelta = true
      } else if (typeof part.text === 'string' && part.text !== '') {
        this.text += part.text
        chunk = part.text
        isTextDelta = true
        const now = performance.now()
        if (!this.sawFirstDelta) {
          this.sawFirstDelta = true
          this.firstDeltaAt = now
          this.ttftMs = Math.round(now - this.t0)
        }
        this.lastDeltaAt = now
      } else if (part.functionCall !== undefined) {
        // Gemini 不给调用 id：按到达顺序合成（历史回放时靠 id→name 映射配对结果）
        const name = part.functionCall.name ?? ''
        this.calls.push({
          id: synthesizeCallId(this.calls.length, name),
          name,
          args: part.functionCall.args ?? {}
        })
        // ★ 工具调用也是模型输出（对齐 成熟实现isTokenDelta）：计入首/末 token 计时
        const now = performance.now()
        if (!this.sawFirstDelta) {
          this.sawFirstDelta = true
          this.firstDeltaAt = now
          this.ttftMs = Math.round(now - this.t0)
        }
        this.lastDeltaAt = now
      }
    }
    if (candidate?.finishReason !== undefined) this.finishReasonRaw = candidate.finishReason
    const u = event.usageMetadata
    if (u !== undefined) {
      const prompt = u.promptTokenCount ?? 0
      const completion = u.candidatesTokenCount ?? 0
      this.usage = {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: u.totalTokenCount ?? prompt + completion
      }
      if (typeof u.cachedContentTokenCount === 'number') {
        this.cachedTokens = u.cachedContentTokenCount
        this.cacheKnown = true
      }
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
    const toolCalls: ToolCallDraft[] = this.calls.map((c) => ({
      id: c.id,
      name: c.name,
      argsJson: JSON.stringify(c.args)
    }))
    // 纯生成期 = 首个增量 → 末个增量（对齐 openai 协议口径；原先用 now - t0 含建连时间）
    const genMs =
      this.firstDeltaAt > 0 && this.lastDeltaAt > 0
        ? Math.round(this.lastDeltaAt - this.firstDeltaAt)
        : 0
    const completion = this.usage?.completionTokens ?? 0
    return {
      text: this.text,
      thinking: this.thinking,
      toolCalls,
      finishReason: mapFinishReason(this.finishReasonRaw, toolCalls.length > 0),
      usage: this.usage,
      cachedTokens: this.cachedTokens,
      cacheKnown: this.cacheKnown,
      ttftMs: this.ttftMs,
      genMs,
      tokPerS: genMs > 0 && completion > 0 ? Math.round((completion / genMs) * 1000) : 0
    }
  }
}

// ── 流式请求入口：client.streamChat 按 protocol==='gemini' 分派到这里 ──

/** Gemini 端点拼装（stream / 测试连接共用）：baseUrl 容忍尾斜杠与带版本两种写法 */
export function geminiEndpoint(
  baseUrl: string,
  model: string,
  method: 'streamGenerateContent' | 'generateContent'
): string {
  const base = baseUrl.replace(/\/+$/, '')
  const withVersion = base.endsWith('/v1beta') ? base : `${base}/v1beta`
  return `${withVersion}/models/${encodeURIComponent(model)}:${method}?alt=sse`
}

export async function streamGemini(
  request: StreamChatRequest,
  handlers: StreamChatHandlers
): Promise<StreamChatResult> {
  const aggregator = new GeminiStreamAggregator()
  // ★ t0 在 fetch 前起表（对齐 成熟实现「请求发出→首增量」，同 anthropic）：markStart 此前在
  // 首帧才打点，把建连+等首帧全漏掉 → 带缓存端点 ttft 恒 0、监测栏"首 token —"。
  aggregator.markStart()
  const t0 = Date.now()
  const response = await fetch(
    geminiEndpoint(request.baseUrl, request.model, 'streamGenerateContent'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': request.apiKey },
      body: JSON.stringify(buildGeminiBody(request)),
      signal: handlers.signal
    }
  )
  if (!response.ok || response.body === null) {
    const detail = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}：${detail.slice(0, 300)}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  // SSE 行解析：Gemini alt=sse 与 Anthropic 同款，事件以 data: {...} 行承载，按 \n 分帧
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
            const parsed = JSON.parse(payload) as GeminiStreamEvent
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

/** 连接测试（gemini 分支）：非流式最小 generateContent 请求，区分网络/Key/模型名 */
export async function testConnectionGemini(options: {
  baseUrl: string
  apiKey: string
  model: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(
      geminiEndpoint(options.baseUrl, options.model, 'generateContent'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 1 }
        }),
        signal: AbortSignal.timeout(15_000)
      }
    )
    if (response.ok) return { ok: true }
    const detail = await response.text().catch(() => '')
    if (response.status === 400 && /api.key/i.test(detail)) {
      return { ok: false, error: 'API Key 无效（Gemini 对坏密钥返回 400）。请检查密钥是否正确。' }
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: 'API Key 无效或无权限。请检查密钥是否正确。' }
    }
    if (response.status === 404) {
      return { ok: false, error: '模型不存在（404）。请检查模型名拼写（如 gemini-2.5-flash）。' }
    }
    return { ok: false, error: `HTTP ${response.status}：${detail.slice(0, 200)}` }
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return { ok: false, error: '连接超时（15 秒无响应）。请检查网络与 baseUrl 是否可访问。' }
    }
    return { ok: false, error: `网络错误：${err instanceof Error ? err.message : String(err)}` }
  }
}
