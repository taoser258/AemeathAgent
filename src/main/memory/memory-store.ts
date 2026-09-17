// 长期记忆存储层：userData/memory/entries.json 全局单文件。
//
// 沿用既有存储决议：每次整写 JSON + atomicWrite（tmp → rename 原子替换），
// 禁 JSONL。删除/清空前快照到 memory/backups/（滚 10 份）——记忆是用户数据，
// 红线②精神适用。合并/淘汰的纯逻辑在 shared/memory.ts（可单测），这里只做 IO 编排。

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { dirname, join } from 'path'
import {
  mergeInto,
  MEMORY_CONTENT_MAX,
  type MemoryCandidate,
  type MemoryEntry
} from '@shared/memory'

let memoryDir: string | null = null
const BACKUP_KEEP = 10

export function setMemoryBase(dir: string): void {
  memoryDir = dir
}

function entriesPath(): string {
  if (memoryDir === null) throw new Error('memory base 未初始化')
  return join(memoryDir, 'entries.json')
}

function backupsDir(): string {
  if (memoryDir === null) throw new Error('memory base 未初始化')
  return join(memoryDir, 'backups')
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp`
  writeTextSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, filePath)
}

function writeTextSync(filePath: string, text: string): void {
  // tmp 与目标同目录，rename 才是原子的
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, text, 'utf8')
}

/** 读全部条目（文件不存在/脏数据 → 空数组，不抛错） */
export function readEntries(): MemoryEntry[] {
  const p = entriesPath()
  if (!existsSync(p)) return []
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (e): e is MemoryEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as MemoryEntry).id === 'string' &&
        typeof (e as MemoryEntry).content === 'string'
    )
  } catch {
    return []
  }
}

function writeEntries(entries: MemoryEntry[]): void {
  atomicWriteJson(entriesPath(), entries)
}

/** 删除/清空前快照（滚 BACKUP_KEEP 份） */
function snapshotBeforeDestructive(): void {
  const p = entriesPath()
  if (!existsSync(p)) return
  const dir = backupsDir()
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  copyFileSync(p, join(dir, `entries-${stamp}.json`))
  const backups = readdirSync(dir)
    .filter((f) => f.startsWith('entries-') && f.endsWith('.json'))
    .sort()
  while (backups.length > BACKUP_KEEP) {
    try {
      unlinkSync(join(dir, backups[0]))
    } catch {
      break
    }
    backups.shift()
  }
}

/**
 * 合并一条候选（去重/淘汰纯逻辑在 shared）；返回 'added' | 'updated' | 'skipped'。
 * memoryDir 未初始化 → 'skipped'（无伤调用方）。
 */
export function addEntry(
  candidate: MemoryCandidate,
  sourceSessionId: string
): 'added' | 'updated' | 'skipped' {
  if (memoryDir === null) return 'skipped'
  const entries = readEntries()
  const before = new Set(entries.map((e) => e.id))
  const { entries: next, mergedId } = mergeInto(entries, candidate, sourceSessionId)
  const existed = before.has(mergedId)
  writeEntries(next)
  return existed ? 'updated' : 'added'
}

/** 删除一条（先快照）；不存在返回 false */
export function deleteEntry(id: string): boolean {
  const entries = readEntries()
  if (!entries.some((e) => e.id === id)) return false
  snapshotBeforeDestructive()
  writeEntries(entries.filter((e) => e.id !== id))
  return true
}

/**
 * 编辑一条的正文（设置页手动改错字/补全用；P7-T3）。
 * 与 delete 同款口径：先快照，误改可从 backups 找回。
 * - trim 后为空拒绝（不允许把条目改成空串）；
 * - 长度上限沿用 MEMORY_CONTENT_MAX（超长截断，与自动沉淀同一契约）；
 * - 只动 content/updatedAt：kind/keywords/hits/createdAt 都保留。
 *   keywords 不重算（存储层无 LLM）——检索打分已把正文纳入命中（见 shared/memory.scoreEntries），
 *   所以改过的内容照样搜得到。
 * 返回更新后的条目；id 不存在返回 null。
 */
export function updateEntry(id: string, content: string): MemoryEntry | null {
  if (typeof content !== 'string') return null
  const next = content.trim().slice(0, MEMORY_CONTENT_MAX)
  if (next === '') return null
  const entries = readEntries()
  if (!entries.some((e) => e.id === id)) return null
  snapshotBeforeDestructive()
  let updated: MemoryEntry | null = null
  const nextEntries = entries.map((e) => {
    if (e.id !== id) return e
    updated = { ...e, content: next, updatedAt: Date.now() }
    return updated
  })
  writeEntries(nextEntries)
  return updated
}

/** 清空全部（先快照） */
export function clearAll(): void {
  snapshotBeforeDestructive()
  writeEntries([])
}

/** 批量累加 hits（注入后调用；静默失败不影响主流程） */
export function bumpHits(ids: string[]): void {
  if (ids.length === 0) return
  const entries = readEntries()
  const set = new Set(ids)
  writeEntries(entries.map((e) => (set.has(e.id) ? { ...e, hits: e.hits + 1 } : e)))
}
