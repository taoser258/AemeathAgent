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

  it('★ 内容审核拦截（千问 data_inspection_failed 现场报文）→ content，文案给行动指引', () => {
    // 真实 fixture：owner 2026-09-15 实测，长技术清单会话被 DashScope 审核拦
    const info = classifyLlmError({
      status: 400,
      message:
        '400 data: {"error":{"code":"data_inspection_failed","param":null,' +
        '"message":"Input text data may contain inappropriate content.",' +
        '"type":"data_inspection_failed","id":"chatcmpl-dedcead3-ce18-9982-84f1-408beb1b1b12"}}'
    })
    expect(info.kind).toBe('content')
    expect(info.message).toContain('内容审核')
    expect(info.message).toContain('重发') // 给行动指引而非裸 JSON
  })

  it('审核形态变体（sensitive / prohibited）同样归 content；普通 400 仍是 unknown', () => {
    expect(classifyLlmError({ status: 400, message: 'your input contains sensitive information' }).kind).toBe('content')
    expect(classifyLlmError({ status: 400, message: 'response prohibited by policy' }).kind).toBe('content')
    expect(classifyLlmError({ status: 400, message: 'max_tokens too large' }).kind).toBe('unknown')
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
