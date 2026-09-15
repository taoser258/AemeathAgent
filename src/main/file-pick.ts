// 本地文件选择：渲染层 <input type="file"> 在透明窗里弹原生对话框明显偏慢，
// 改走主进程 dialog.showOpenDialog（原生、瞬时），文件内容也由主进程读取后经 IPC 下发——
// 渲染层零 FileReader，附件即拿即用。读取规则与聊天管线（main/chat/run.ts）对齐：
// 图片 ≤6MB → dataUrl（多模态用）；文本 ≤40K 字符 → 内联正文；其余仅名字占位。
//
// ：
// ① 每个附件都带绝对路径（path）——她才能接着处理这个文件（写回同目录、跑外部命令）；
// ② Office 文档（docx/xlsx/pptx）在这里就把正文抽出来内联（doc-extract.ts），
// 选完文件她的第一句话就能读懂内容，不需要任何"找文件"的工具来回。

import { readFile, stat } from 'fs/promises'
import { basename } from 'path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { DIALOG_PICK_DIRECTORY, DIALOG_PICK_FILES } from '@shared/ipc-channels'
import type { ChatAttachmentPayload } from '@shared/types'
import { extractOfficeText, isExtractableDoc } from './chat/doc-extract'

const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i
const TEXT_RE =
  /\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|cfg|conf|csv|log|ts|tsx|js|jsx|mjs|cjs|css|scss|html?|xml|svg|py|java|kt|go|rs|c|h|cpp|hpp|cs|sh|bat|ps1|sql|gitignore|diff|patch)$/i
const MAX_IMAGE_BYTES = 6 * 1024 * 1024
const MAX_TEXT_CHARS = 40_000
const MAX_FILES = 8

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

export interface PickFilesResult {
  attachments: ChatAttachmentPayload[]
  warnings: string[]
}

export function registerFilePickIpc(): void {
  // 目录选择：工作区绑定用；取消返回 null
  ipcMain.handle(DIALOG_PICK_DIRECTORY, async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: '选择要绑定的工作目录',
      properties: ['openDirectory', 'createDirectory']
    }
    const result =
      win !== null
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(DIALOG_PICK_FILES, async (event): Promise<PickFilesResult> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: '选择要发送的文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '全部文件', extensions: ['*'] }]
    }
    // 挂靠到发送方窗口（模态）；窗口已关则退化为独立对话框
    const result =
      win !== null
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) {
      return { attachments: [], warnings: [] }
    }

    const attachments: ChatAttachmentPayload[] = []
    const warnings: string[] = []
    for (const filePath of result.filePaths) {
      if (attachments.length >= MAX_FILES) {
        warnings.push(`一次最多选择 ${MAX_FILES} 个文件`)
        break
      }
      const name = basename(filePath)
      const info = await stat(filePath).catch(() => null)
      if (info === null) {
        warnings.push(`文件 ${name} 读取失败`)
        continue
      }
      if (IMAGE_RE.test(name)) {
        if (info.size > MAX_IMAGE_BYTES) {
          warnings.push(`图片 ${name} 超过 6MB，仅记录文件名`)
          attachments.push({ name, kind: 'file', size: info.size, path: filePath })
          continue
        }
        const mime = IMAGE_MIME[name.toLowerCase().slice(name.lastIndexOf('.'))] ?? 'image/png'
        const buffer = await readFile(filePath).catch(() => null)
        if (buffer === null) {
          warnings.push(`图片 ${name} 读取失败`)
          continue
        }
        attachments.push({
          name,
          kind: 'image',
          size: info.size,
          path: filePath,
          dataUrl: `data:${mime};base64,${buffer.toString('base64')}`
        })
      } else if (isExtractableDoc(name)) {
        // Office 文档：抽正文内联（"发给她 = 她能看"）。抽不出来（旧格式/加密/损坏）就退化为
        // 文件名 + 路径占位，并在提示里说清下一步，免得她满磁盘找。
        const buffer = await readFile(filePath).catch(() => null)
        const text = buffer === null ? null : extractOfficeText(buffer, name)
        if (text === null) {
          warnings.push(`${name} 正文未能解析（可能是加密/损坏文档），只发了文件名`)
          attachments.push({ name, kind: 'file', size: info.size, path: filePath })
          continue
        }
        attachments.push({ name, kind: 'text', size: info.size, path: filePath, text })
        if (text.includes('已截断')) warnings.push(`${name} 过长，只发送前 40K 字符`)
      } else if (TEXT_RE.test(name)) {
        const full = await readFile(filePath, 'utf8').catch(() => null)
        if (full === null) {
          warnings.push(`文件 ${name} 读取失败`)
          continue
        }
        const truncated = full.length > MAX_TEXT_CHARS
        attachments.push({
          name,
          kind: 'text',
          size: info.size,
          path: filePath,
          text: truncated ? `${full.slice(0, MAX_TEXT_CHARS)}\n…（超出部分已截断）` : full
        })
        if (truncated) warnings.push(`${name} 过长，只发送前 40K 字符`)
      } else {
        attachments.push({ name, kind: 'file', size: info.size, path: filePath })
      }
    }
    return { attachments, warnings }
  })
}
