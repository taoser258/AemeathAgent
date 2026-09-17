// openai 兼容流的 tok/s 分子口径回归测试（P9 修复：实时/终值速率同量级）。
// 旧口径“一个 SSE delta 算一个 token”在攒批端点（百炼等一条 delta 含多个 token）
// 会严重偏低、结束用真实 usage 又暴涨（实测 18→68）。这里用本地 SSE 服务直接验证。
import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { Server } from 'node:http'
import { streamChat } from '../src/main/llm/client'

async function sseServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ url: string; close: () => void }> {
  const server: Server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const url = addr && typeof addr === 'object' ? `http://127.0.0.1:${addr.port}/v1` : ''
  return { url, close: () => server.close() }
}

function sse(res: http.ServerResponse, obj: unknown): void {
  res.write(`data: ${JSON.stringify(obj)}\n\n`)
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const HAN =
  '谓词逻辑等值式证明需要消去量词并保持约束变元一致这是一段四十个汉字的输出内容用于测试攒批' // 44 汉字

describe('openai 流 tok/s 分子口径', () => {
  let server: { url: string; close: () => void } | null = null
  afterEach(() => server?.close())

  it('无 usage：一条 delta 含多个汉字时按字符估算 token，而不是按 chunk 条数（3 条 ≠ 3 token）', async () => {
    server = await sseServer(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      // 3 条 delta，每条 44 个汉字（模拟攒批发送），片间隔 30ms，不带 usage
      for (let i = 0; i < 3; i++) {
        sse(res, { choices: [{ index: 0, delta: { content: HAN } }] })
        await delay(30)
      }
      sse(res, { choices: [{ index: 0, finish_reason: 'stop', delta: {} }] })
      res.write('data: [DONE]\n\n')
      res.end()
    })
    const out = await streamChat(
      {
        baseUrl: server.url,
        apiKey: 'sk-test',
        model: 'qwen-flash',
        temperature: 0.5,
        messages: [{ role: 'user', content: 'hi' }]
      },
      { signal: new AbortController().signal, onDelta: () => {} }
    )
    expect(out.text).toBe(HAN.repeat(3))
    expect(out.usage).toBeUndefined()
    // 120 个汉字 ≈ 120 token；旧口径会得到 3（=delta 条数）。留足启发式容差。
    expect(out.genMs).toBeGreaterThan(0)
    expect(out.tokPerS).toBeGreaterThan(0)
    // 用结果反推 completionTokens = tokPerS * genMs/1000，验证分子在字符量级而非条数量级
    const implied = Math.round((out.tokPerS * out.genMs) / 1000)
    expect(implied).toBeGreaterThan(100)
    expect(implied).toBeLessThan(140)
  })

  it('有 usage：终值以供应商 completion_tokens 为准（精确，不受估算影响）', async () => {
    server = await sseServer(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      sse(res, { choices: [{ index: 0, delta: { content: HAN } }] })
      await delay(30)
      sse(res, { choices: [{ index: 0, delta: { content: '续' } }] })
      await delay(30)
      sse(res, {
        choices: [{ index: 0, finish_reason: 'stop', delta: {} }],
        usage: { prompt_tokens: 50, completion_tokens: 999, total_tokens: 1049 }
      })
      res.write('data: [DONE]\n\n')
      res.end()
    })
    const out = await streamChat(
      {
        baseUrl: server.url,
        apiKey: 'sk-test',
        model: 'qwen-flash',
        temperature: 0.5,
        messages: [{ role: 'user', content: 'hi' }]
      },
      { signal: new AbortController().signal, onDelta: () => {} }
    )
    expect(out.usage?.completionTokens).toBe(999)
    const implied = Math.round((out.tokPerS * out.genMs) / 1000)
    expect(implied).toBe(999)
  })
})
