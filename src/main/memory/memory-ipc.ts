// 记忆管理 IPC：设置页「记忆」分区的列表/编辑/删除/清空通道。
// 开关本身走既有 settingsSet({ privacy: { memory } })，不在这里。

import { ipcMain } from 'electron'
import { MEMORY_CLEAR, MEMORY_DELETE, MEMORY_LIST, MEMORY_UPDATE } from '@shared/ipc-channels'
import type { MemoryEntry } from '@shared/memory'
import { clearAll, deleteEntry, readEntries, updateEntry } from './memory-store'

/** 按 updatedAt 倒序的全量条目（设置页展示） */
export function listMemoryEntries(): MemoryEntry[] {
  return readEntries()
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function registerMemoryIpc(): void {
  ipcMain.handle(MEMORY_LIST, (): MemoryEntry[] => listMemoryEntries())

  ipcMain.handle(
    MEMORY_UPDATE,
    (_e, id: unknown, content: unknown): { ok: boolean; entry?: MemoryEntry; error?: string } => {
      if (typeof id !== 'string' || id === '') return { ok: false, error: '缺少条目 id' }
      if (typeof content !== 'string' || content.trim() === '') {
        return { ok: false, error: '内容不能为空' }
      }
      const entry = updateEntry(id, content)
      if (entry === null) return { ok: false, error: '条目不存在（可能已被删除）' }
      return { ok: true, entry }
    }
  )

  ipcMain.handle(MEMORY_DELETE, (_e, id: unknown): { ok: boolean; error?: string } => {
    if (typeof id !== 'string' || id === '') return { ok: false, error: '缺少条目 id' }
    const ok = deleteEntry(id)
    return ok ? { ok: true } : { ok: false, error: '条目不存在（可能已被删除）' }
  })

  ipcMain.handle(MEMORY_CLEAR, (): { ok: boolean } => {
    clearAll()
    return { ok: true }
  })
}
