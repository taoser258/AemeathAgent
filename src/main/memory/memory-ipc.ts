// 记忆管理 IPC：设置页「记忆」分区的三条只读/删除通道。
// 开关本身走既有 settingsSet({ privacy: { memory } })，不在这里。

import { ipcMain } from 'electron'
import { MEMORY_CLEAR, MEMORY_DELETE, MEMORY_LIST } from '@shared/ipc-channels'
import type { MemoryEntry } from '@shared/memory'
import { clearAll, deleteEntry, readEntries } from './memory-store'

/** 按 updatedAt 倒序的全量条目（设置页展示） */
export function listMemoryEntries(): MemoryEntry[] {
  return readEntries().slice().sort((a, b) => b.updatedAt - a.updatedAt)
}

export function registerMemoryIpc(): void {
  ipcMain.handle(MEMORY_LIST, (): MemoryEntry[] => listMemoryEntries())

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
