// 学习笔记存储：学习模式的三段式教学产出的沉淀。
// 语义：按会话一档 userData/notes/<sessionId>.json，条目只追加（note_write 追加、note_read 回显）。
// 两种条目：note = 知识点笔记；card = 闪卡（title 为问题、content 为答案，导出 Markdown 复习用）。
// 无 electron 依赖：根目录由 main 注入（setNotesBase），vitest 可直接单测。

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { mkdirSync } from 'fs'

export interface NoteEntry {
  /** 稳定 id（review 复习状态按它对位；旧档无 id 时读入时补发） */
  id: string
  /** 记入时间（毫秒） */
  ts: number
  /** note = 知识点笔记；card = 闪卡（title=问题，content=答案） */
  kind: 'note' | 'card'
  /** 笔记主题 / 闪卡问题（≤80 字） */
  title: string
  /** 笔记内容 / 闪卡答案（≤2000 字） */
  content: string
  /** 关联知识点（可选）：掌握度按知识点聚合，闪卡出卡时填 */
  topic?: string
}

export interface NotesState {
  items: NoteEntry[]
  updatedAt: number
}

/** 单次 note_write 最多追加条数（防刷屏） */
export const NOTES_MAX_BATCH = 10
/** 单会话笔记条目总量上限 */
export const NOTES_MAX_TOTAL = 500

let notesBase = ''

/** 注入存储根目录（main ready 时 = userData/notes；单测 = 临时目录）；空串 = 未初始化 */
export function setNotesBase(base: string): void {
  notesBase = base
}

export function getNotesBase(): string {
  return notesBase
}

/** 生成条目标识（时间戳 + 随机尾巴，够用且不引依赖） */
function newNoteId(): string {
  return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function sanitizeEntry(raw: unknown, index: number): NoteEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const kind = r.kind === 'card' ? 'card' : r.kind === 'note' ? 'note' : null
  if (kind === null) return null
  const title = typeof r.title === 'string' ? r.title.trim().slice(0, 80) : ''
  const content = typeof r.content === 'string' ? r.content.trim().slice(0, 2000) : ''
  if (title === '' || content === '') return null
  const entry: NoteEntry = { id: newNoteId(), ts: Date.now(), kind, title, content }
  // 知识点归属（可选）：掌握度按它聚合；没给就算作无归属（进度页按标题兜底归组）
  if (typeof r.topic === 'string' && r.topic.trim() !== '') {
    entry.topic = r.topic.trim().slice(0, 60)
  }
  void index
  return entry
}

/**
 * 追加笔记条目（整读整写，进程内无并发冲突——工具调用在 harness 内串行）。
 * 校验失败的条目跳过；全部非法抛错。返回追加后的完整状态。
 */
export function appendNotes(sessionId: string, entries: unknown[]): NotesState {
  if (notesBase === '') {
    throw new Error('笔记存储未初始化（应用尚未就绪）。')
  }
  if (sessionId.includes('/') || sessionId.includes('\\') || sessionId === '') {
    throw new Error('会话标识不合法。')
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('entries 必须是非空数组。')
  }
  if (entries.length > NOTES_MAX_BATCH) {
    throw new Error(`一次最多写入 ${NOTES_MAX_BATCH} 条。`)
  }
  const valid = entries.map((e, i) => sanitizeEntry(e, i)).filter((e): e is NoteEntry => e !== null)
  if (valid.length === 0) {
    throw new Error('没有合法条目：每条需要 kind（note/card）、title、content 字段。')
  }

  const file = join(notesBase, `${sessionId}.json`)
  const state = readNotes(sessionId) ?? { items: [], updatedAt: 0 }
  if (state.items.length + valid.length > NOTES_MAX_TOTAL) {
    throw new Error(`笔记已达总量上限（${NOTES_MAX_TOTAL} 条），请先导出整理。`)
  }
  const next: NotesState = {
    items: [...state.items, ...valid],
    updatedAt: Date.now()
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
  return next
}

/** 读某会话笔记；无档/损坏文件返回 null。
 * 旧档条目没有 id → **读入时补发并回写**，复习状态才有的可依。 */
export function readNotes(sessionId: string): NotesState | null {
  if (notesBase === '') return null
  const file = join(notesBase, `${sessionId}.json`)
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as NotesState
    if (!Array.isArray(raw.items)) return null
    let dirty = false
    const items = raw.items.map((it) => {
      if (typeof it?.id === 'string' && it.id !== '') return it
      dirty = true
      return { ...it, id: newNoteId() }
    })
    const state: NotesState = { items, updatedAt: raw.updatedAt ?? 0 }
    if (dirty) {
      // 回写补发的 id（否则每次读都新发一串，复习状态永远对不上）
      try {
        writeFileSync(file, JSON.stringify(state, null, 2), 'utf8')
      } catch {
        /* 只读失败不致命：内存里这轮仍可用 */
      }
    }
    return state
  } catch {
    return null
  }
}

/** 列出所有有笔记档的会话 id（note_export 的 scope=all 用）；目录缺失/未初始化返回空表 */
export function listNoteSessions(): string[] {
  if (notesBase === '') return []
  try {
    return readdirSync(notesBase)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter((id) => /^[A-Za-z0-9_-]+$/.test(id))
  } catch {
    return []
  }
}

/** 删除某会话笔记档（测试与清理用） */
export function removeNotes(sessionId: string): void {
  if (notesBase === '') return
  rmSync(join(notesBase, `${sessionId}.json`), { force: true })
}
