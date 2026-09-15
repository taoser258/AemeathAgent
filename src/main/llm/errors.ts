// LLM 错误分类器（纯函数，不 import 任何 SDK —— 供单测与 client.ts 共用）。
// 目标：把各家 OpenAI 兼容端点的报错翻译成 能直接行动的中文提示，
// 区分四类：网络不通 / Key 无效 / 模型名或端点不存在 / 服务端异常。

export type LlmErrorKind = 'network' | 'auth' | 'model' | 'rate' | 'server' | 'unknown'

export interface LlmErrorInfo {
  kind: LlmErrorKind
  /** 面向用户的可读文案（已含排查建议与原始错误摘要） */
  message: string
}

/** 从未知错误对象中尽力提取 HTTP 状态码 */
function readStatus(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : null
}

function readRawMessage(err: unknown): string {
  if (err instanceof Error && err.message !== '') return err.message
  const message = (err as { message?: unknown } | null)?.message
  if (typeof message === 'string' && message !== '') return message
  return String(err ?? '未知错误')
}

export function classifyLlmError(err: unknown): LlmErrorInfo {
  const status = readStatus(err)
  const raw = readRawMessage(err)
  const hint = `服务返回：${raw.slice(0, 300)}`

  if (status === 401 || status === 403) {
    return {
      kind: 'auth',
      message: `API Key 无效或没有权限（HTTP ${status}）。请到 设置 → 模型 检查密钥是否复制完整、账号是否已开通对应模型服务。${hint}`
    }
  }
  if (status === 404) {
    return {
      kind: 'model',
      message: `端点或模型不存在（HTTP 404）。请检查：① baseUrl 是否正确（通常以 /v1 或 /compatible-mode/v1 结尾）② 模型名是否拼写正确。${hint}`
    }
  }
  if (status === 429) {
    return {
      kind: 'rate',
      message: `请求被限流或额度不足（HTTP 429），请稍后重试或检查账户额度。${hint}`
    }
  }
  if (status !== null && status >= 500) {
    return {
      kind: 'server',
      message: `模型服务端暂时不可用（HTTP ${status}），请稍后重试。${hint}`
    }
  }
  if (status === 400) {
    if (/model/i.test(raw)) {
      return { kind: 'model', message: `请求被拒绝：模型名可能不存在或当前账号无权使用。${hint}` }
    }
    return { kind: 'unknown', message: `请求被拒绝（HTTP 400）。${hint}` }
  }

  const networkish =
    /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|certificate|ssl|network|getaddrinfo/i
  if (networkish.test(raw)) {
    return {
      kind: 'network',
      message: `网络错误，连不上模型服务。请检查本机网络与 baseUrl 是否可访问。${hint}`
    }
  }
  return { kind: 'unknown', message: `连接失败。${hint}` }
}
