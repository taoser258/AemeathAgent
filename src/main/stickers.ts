// 表情包支持：resources/stickers/*.gif 经自定义 sticker:// 协议服务给渲染层（<img> 直接可用）。
// 为什么走协议而不是 base64/IPC：46 张 GIF 共 146MB，协议按需流式读取，零内存驻留；
// 渲染层只需 STICKER_LIST 拿文件名列表。中文文件名经 encodeURIComponent 放进 URL。

import { existsSync, readdirSync } from 'fs'
import { basename, join } from 'path'
import { ipcMain, net, protocol } from 'electron'
import { pathToFileURL } from 'url'
import { STICKER_LIST } from '@shared/ipc-channels'
import { stickersDir } from './paths'

/**
 * 必须在 app ready 之前调用：把 sticker 声明为标准安全协议，
 * 否则渲染层 http://localhost:5173 源里 <img src="sticker://…"> 会被当作非标准协议拒绝。
 */
export function registerStickerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'sticker',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

/** sticker://local/<encoded-name> → resources/stickers/<name>（basename 防目录穿越） */
function resolveStickerUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'local') return null
    const name = decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
    if (name === '' || name.includes('\\') || name.includes('/')) return null
    const file = join(stickersDir(), basename(name))
    return existsSync(file) ? file : null
  } catch {
    return null
  }
}

export function registerStickerSupport(): void {
  protocol.handle('sticker', (request) => {
    const file = resolveStickerUrl(request.url)
    if (file === null) return new Response('sticker not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })

  ipcMain.handle(STICKER_LIST, (): string[] => {
    const dir = stickersDir()
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((n) => /\.(gif|png|jpg|jpeg|webp)$/i.test(n))
      .sort()
  })
}
