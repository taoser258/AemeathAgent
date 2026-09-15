// HTML → PDF 打印实现（export_pdf 工具的 electron 侧）。
// 走 Chromium 排版引擎：中文天然无缺字、CSS/图表直接印——零外部依赖（对比 Python 系
// reportlab 全家桶）。隐藏窗口一次性使用，用完即毁。registry 侧不 import electron，
// 本模块由 main ready 时注入（screen.ts 探针同款模式）。

import { BrowserWindow } from 'electron'
import { writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'

export interface PrintPdfInput {
  /** 工作区内的 HTML 文件（与 html 二选一，文件优先） */
  htmlPath?: string
  /** 内联 HTML 字符串（大文件请走 htmlPath） */
  html?: string
  /** 输出 PDF 绝对路径（调用方已解析+校验在工作区内） */
  outPath: string
  landscape?: boolean
}

const PRINT_TIMEOUT_MS = 60_000

export async function printHtmlToPdf(input: PrintPdfInput): Promise<{ bytes: number }> {
  const job = doPrint(input)
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`打印超时（${PRINT_TIMEOUT_MS / 1000} 秒）`)),
      PRINT_TIMEOUT_MS
    )
  )
  return await Promise.race([job, timeout])
}

async function doPrint(input: PrintPdfInput): Promise<{ bytes: number }> {
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 1400,
    // 打印的是模型产出的 HTML：全隔离，不给任何 node 能力
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  try {
    let loadPath = input.htmlPath
    let cleanup = ''
    if (loadPath === undefined) {
      // 内联 HTML 也落临时文件再 loadFile：data: URL 有体积上限且相对资源解析不友好
      cleanup = join(tmpdir(), `aemeath-print-${Date.now()}.html`)
      writeFileSync(cleanup, input.html ?? '', 'utf8')
      loadPath = cleanup
    }
    await win.loadFile(loadPath)
    // did-finish-load 后再给一帧 + 300ms：等 webfont 与内联 SVG/图表稳定
    await new Promise((r) => setTimeout(r, 300))
    const buf = await win.webContents.printToPDF({
      landscape: input.landscape === true,
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'custom', top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 }
    })
    mkdirSync(dirname(input.outPath), { recursive: true })
    writeFileSync(input.outPath, buf)
    return { bytes: buf.length }
  } finally {
    win.destroy()
  }
}
