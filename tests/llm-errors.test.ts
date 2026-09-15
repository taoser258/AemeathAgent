// classifyLlmError：把各家 OpenAI 兼容端点的异常翻译成可读中文（§6-T4 验收：区分网络/401/模型名）。

import { describe, expect, it } from 'vitest'
import { classifyLlmError } from '../src/main/llm/errors'

describe('llm/errors · classifyLlmError', () => {
  it('HTTP 401/403 → auth（提示检查密钥）', () => {
    for (const status of [401, 403]) {
      const info = classifyLlmError({ status, message: 'Unauthorized' })
      expect(info.kind).toBe('auth')
      expect(info.message).toContain('API Key')
      expect(info.message).toContain(String(status))
    }
  })

  it('HTTP 404 → model（提示 baseUrl 与模型名）', () => {
    const info = classifyLlmError({ status: 404, message: 'model not found' })
    expect(info.kind).toBe('model')
    expect(info.message).toContain('baseUrl')
  })

  it('HTTP 400 且报文含 model → model', () => {
    const info = classifyLlmError({ status: 400, message: 'invalid model: qwen-xxx' })
    expect(info.kind).toBe('model')
  })

  it('HTTP 429 → rate；5xx → server', () => {
    expect(classifyLlmError({ status: 429, message: 'rate limited' }).kind).toBe('rate')
    expect(classifyLlmError({ status: 503, message: 'overloaded' }).kind).toBe('server')
  })

  it('无状态码的网络类报错 → network', () => {
    for (const message of ['fetch failed', 'getaddrinfo ENOTFOUND api.x.com', 'ECONNREFUSED']) {
      expect(classifyLlmError(new Error(message)).kind).toBe('network')
    }
  })

  it('Error 实例与裸对象都能取到原始信息；未知 → unknown', () => {
    const info = classifyLlmError(new Error('something weird'))
    expect(info.kind).toBe('unknown')
    expect(info.message).toContain('something weird')
    expect(classifyLlmError(undefined).kind).toBe('unknown')
  })
})
