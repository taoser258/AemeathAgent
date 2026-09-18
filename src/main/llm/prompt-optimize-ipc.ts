// 提示词优化主进程 IPC（P9-T4）。
// 渲染层只给「输入框原文 + 当前模式」；这里取当前激活模型的密钥，静默跑一次
// 三协议流式调用（结果很短，不往 UI 推），清洗后返回。**绝不自动发送、绝不带历史。**

import { ipcMain } from 'electron'
import { PROMPT_OPTIMIZE } from '@shared/ipc-channels'
import { buildOptimizeMessages, cleanOptimized } from '@shared/prompt-optimize'
import { classifyLlmError } from './errors'
import { streamChat, type ChatTurn } from './client'
import { readProfileKey } from './secrets'
import { configDir } from '../paths'
import { readAppConfig } from '../settings/app-config'

/** 改写一次的最长等待（超时按失败处理，输入框不动） */
const OPTIMIZE_TIMEOUT_MS = 60_000

export type PromptOptimizeResult = { ok: true; text: string } | { ok: false; error: string }

export function registerPromptOptimizeIpc(): void {
  ipcMain.handle(
    PROMPT_OPTIMIZE,
    async (_e, payload: { text?: unknown; mode?: unknown }): Promise<PromptOptimizeResult> => {
      const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
      if (text === '') return { ok: false, error: '输入内容为空' }
      if (text.length > 8000) return { ok: false, error: '内容太长了（上限 8000 字）' }
      const mode = payload?.mode === 'work' || payload?.mode === 'learn' ? payload.mode : 'chat'

      const config = readAppConfig(configDir())
      const profile =
        config.model.profiles.find((p) => p.id === config.model.activeId) ??
        config.model.profiles[0]
      if (profile === undefined || profile.model === '') {
        return { ok: false, error: '还没选好模型（设置 → 模型 里填好模型名再来）。' }
      }
      const apiKey = readProfileKey(configDir(), profile.id)
      if (apiKey === null || apiKey === '') {
        return { ok: false, error: `「${profile.name}」还没配 API Key（设置 → 模型）。` }
      }

      try {
        const result = await streamChat(
          {
            baseUrl: profile.baseUrl,
            apiKey,
            model: profile.model,
            temperature: 0.4, // 改写要稳，不要发散
            messages: buildOptimizeMessages(text, mode) as ChatTurn[],
            protocol: profile.protocol
          },
          {
            signal: AbortSignal.timeout(OPTIMIZE_TIMEOUT_MS),
            onDelta: () => {
              // 静默积累：结果由 streamChat 返回，不在输入框上做流式抖动
            }
          }
        )
        const cleaned = cleanOptimized(result.text)
        if (cleaned === '') {
          return { ok: false, error: '改写结果为空，请重试一次。' }
        }
        return { ok: true, text: cleaned }
      } catch (err) {
        if (err instanceof Error && err.name === 'TimeoutError') {
          return { ok: false, error: '改写超时（60 秒无响应），请重试。' }
        }
        return { ok: false, error: classifyLlmError(err).message }
      }
    }
  )
}
