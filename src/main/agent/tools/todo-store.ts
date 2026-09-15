// todo 存储：模型的任务清单（整表替换式）。
// 每会话一份 userData/todos/<sessionId>.json = { items: [{id,text,status}], updatedAt }。
// 工具语义：todo_write 提交"当前完整清单"（模型每次全量上报，无增量合并——简单可靠）。
// 这是 harness 内部进度记录（userData 内），不属于用户文件变更 → 不弹审批、不进账本。
// 无 electron 依赖：基路径注入（setTodoBase），vitest 可直接单测。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export type TodoStatus = 'pending' | 'done'

export interface TodoItem {
  id: string
  text: string
  status: TodoStatus
}

export interface TodoState {
  items: TodoItem[]
  updatedAt: number
}

/** 清单项上限（防失控刷屏；真正的任务规划不该超过这个量级） */
const MAX_ITEMS = 20
/** 单条文本长度上限 */
const MAX_TEXT = 200

let todoBase = ''

export function setTodoBase(dir: string): void {
  todoBase = dir
}

export function getTodoBase(): string {
  return todoBase
}

function todoPath(sessionId: string): string {
  return join(todoBase, `${sessionId}.json`)
}

/** 读会话 todo；没有清单返回 null */
export function readTodos(sessionId: string): TodoState | null {
  if (todoBase === '' || !existsSync(todoPath(sessionId))) return null
  try {
    const parsed = JSON.parse(readFileSync(todoPath(sessionId), 'utf8')) as TodoState
    if (!Array.isArray(parsed.items)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 整表替换写入：模型提交完整清单，store **宽容归一**后生成稳定 id（t0..tn）。
 * items=[] 合法（清空清单）。
 *
 * P6 修：原先 status 只认 'pending'/'done'，其余**整表抛错**。
 * 实况——她提交 status:"in_progress" 被拒，退让重写成全 pending 之后**再也不敢碰这个工具**，
 * 清单于是永远停在 0/5。严格枚举 + 模型先验 = 工具变砖（同 genui 那次的教训）。
 * 现在的口径：**先宽容归一，只对"完全读不出内容"的输入报错**——
 * · status 认 in_progress/completed/doing/已完成… 等别名（见 normalizeStatus），认不出按未完成；
 * · 条目可以是字符串（"建目录骨架"），也可以是对象（text/title/label/content 任取其一）；
 * · 超过上限 → 截断前 N 项并把 dropped 回执给模型（不再整表拒）；
 * · 只有"提交了非空数组却一条都读不出文字"才抛错（避免静默把已有清单清空）。
 */
export interface TodoWriteResult {
  state: TodoState
  /** 超出上限被忽略的条数（回执里如实告知模型） */
  dropped: number
  /** 认不出的 status 被按"未完成"处理的条数 */
  coerced: number
}

/** status 别名表（比较前把空白、下划线、连字符去掉，所以这里都写成紧凑形式） */
const DONE_ALIASES = new Set([
  'done',
  'complete',
  'completed',
  'finish',
  'finished',
  'success',
  'succeeded',
  'ok',
  'true',
  '已完成',
  '完成',
  '已办',
  '已做'
])
const PENDING_ALIASES = new Set([
  'pending',
  'todo',
  'inprogress',
  'doing',
  'doingit',
  'active',
  'started',
  'open',
  'wip',
  '未完成',
  '待办',
  '进行中',
  '在做'
])

/** 条目文字的候选字段（模型换着花样写：text/title/label/content…） */
const TEXT_KEYS = ['text', 'title', 'label', 'content', 'name', 'step', 'task', 'desc'] as const

function normalizeStatus(raw: unknown): TodoStatus {
  if (typeof raw === 'boolean') return raw ? 'done' : 'pending'
  if (typeof raw === 'number') return raw > 0 ? 'done' : 'pending'
  if (typeof raw !== 'string') return 'pending'
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
  if (DONE_ALIASES.has(s)) return 'done'
  if (PENDING_ALIASES.has(s)) return 'pending'
  return 'pending' // 认不出：按未完成（保守方向——不会误报进度）
}

/** status 是否已是我们自己的规范值（用于统计"被归一"的条数） */
function isCanonicalStatus(raw: unknown): boolean {
  return raw === 'pending' || raw === 'done'
}

/** 是否是我们**认识的**写法（规范值或别名）。
 * 用来区分两种"被归一"：别名折算（预期行为，不必惊动模型）vs 真认不出（要如实告知）。 */
function isKnownStatus(raw: unknown): boolean {
  if (typeof raw === 'boolean' || typeof raw === 'number') return true
  if (typeof raw !== 'string') return false
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
  return DONE_ALIASES.has(s) || PENDING_ALIASES.has(s)
}

/** 从条目里取文字：字符串直接当文字，对象按候选字段找 */
function textOf(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim()
  if (typeof raw !== 'object' || raw === null) return ''
  const r = raw as Record<string, unknown>
  for (const key of TEXT_KEYS) {
    const v = r[key]
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return ''
}

export function writeTodos(sessionId: string, items: readonly unknown[]): TodoWriteResult {
  if (todoBase === '') throw new Error('todo 存储未初始化（应用尚未就绪）')
  if (!Array.isArray(items)) throw new Error('items 必须是数组（完整清单）')
  const dropped = Math.max(0, items.length - MAX_ITEMS)
  const normalized: TodoItem[] = []
  let coerced = 0
  for (const raw of items.slice(0, MAX_ITEMS)) {
    const text = textOf(raw)
    if (text === '') continue // 读不出文字的条目丢掉，不为一条废条目报废整表
    const rawStatus =
      typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>)['status']
        : undefined
    if (
      rawStatus !== undefined &&
      rawStatus !== '' &&
      !isCanonicalStatus(rawStatus) &&
      !isKnownStatus(rawStatus) // 别名（in_progress 等）是预期写法，不算"认不出"
    ) {
      coerced += 1
    }
    normalized.push({
      id: `t${normalized.length}`,
      text: text.slice(0, MAX_TEXT),
      status: normalizeStatus(rawStatus)
    })
  }
  // 非空输入却一条都没读出来 → 宁可报错，也别把用户已有清单静默清空
  if (items.length > 0 && normalized.length === 0) {
    throw new Error(
      '清单里每一项都读不出文字：每项需要 text 字段（非空字符串），也可以直接传字符串数组'
    )
  }
  mkdirSync(todoBase, { recursive: true })
  const state: TodoState = { items: normalized, updatedAt: Date.now() }
  writeFileSync(todoPath(sessionId), JSON.stringify(state, null, 2), 'utf8')
  return { state, dropped, coerced }
}
