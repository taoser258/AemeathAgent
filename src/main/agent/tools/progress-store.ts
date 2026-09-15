// 学习进度：知识点掌握度 + 学习计划（目标/截止日）。
//
// 定位：复习队列管"这张卡什么时候再练"，这里管"整门课学到哪了"——
// · 目标（goal）与截止日（deadline）→ 还剩几天、每天要推进多少，用户有节奏感；
// · 知识点掌握度：模型用 study_progress_write 记（讲解完 / 测完一轮后更新），
// 复习卡片的评分也会回流掌握度（见 run.ts 的 review:grade 处理器）。
//
// 掌握度来源优先级：**用户亲手复习过的卡**（实测数据）> 模型自评（主观估计）。
// 两者都存，展示时以实测为准；没有实测的知识点才显示自评值，并标注来源。
// 无 electron 依赖，vitest 直接单测。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

/** 单个知识点的掌握档 */
export interface TopicProgress {
  /** 知识点名（≤60 字；与 note entry 的 topic 字段对位） */
  topic: string
  /** 模型自评掌握度 0-100（主观） */
  selfScore: number
  /** 实测掌握度 0-100（由复习评分回流；null = 还没数据） */
  measuredScore: number | null
  /** 关联的卡片数（由 note 表统计，读写落盘时不存，展示时算） */
  updatedAt: number
}

/** 学习计划 */
export interface StudyPlan {
  /** 学习目标（一句话，如"期末考过 90 分 / 学完《线性代数》前三章"） */
  goal: string
  /** 截止日（毫秒；0 = 不设） */
  deadline: number
  /** 目标备注（可选：范围、考试形式等） */
  notes: string
}

export interface ProgressDb {
  plan: StudyPlan
  topics: TopicProgress[]
  updatedAt: number
}

/** 单会话知识点上限 */
export const PROGRESS_MAX_TOPICS = 100

let progressBase = ''

export function setProgressBase(base: string): void {
  progressBase = base
}

export function getProgressBase(): string {
  return progressBase
}

function emptyDb(): ProgressDb {
  return { plan: { goal: '', deadline: 0, notes: '' }, topics: [], updatedAt: 0 }
}

function clampScore(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0
  return Math.max(0, Math.min(100, n))
}

/** 读进度档；无档/损坏 → 空档 */
export function readProgress(sessionId: string): ProgressDb {
  if (progressBase === '') return emptyDb()
  const file = join(progressBase, `${sessionId}.json`)
  if (!existsSync(file)) return emptyDb()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as ProgressDb
    const topics: TopicProgress[] = []
    if (Array.isArray(raw?.topics)) {
      for (const t of raw.topics) {
        if (typeof t?.topic !== 'string' || t.topic.trim() === '') continue
        topics.push({
          topic: t.topic.trim().slice(0, 60),
          selfScore: clampScore(t.selfScore),
          measuredScore:
            typeof t.measuredScore === 'number' && Number.isFinite(t.measuredScore)
              ? clampScore(t.measuredScore)
              : null,
          updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : 0
        })
      }
    }
    return {
      plan: {
        goal: typeof raw?.plan?.goal === 'string' ? raw.plan.goal.trim().slice(0, 200) : '',
        deadline:
          typeof raw?.plan?.deadline === 'number' && Number.isFinite(raw.plan.deadline)
            ? raw.plan.deadline
            : 0,
        notes: typeof raw?.plan?.notes === 'string' ? raw.plan.notes.trim().slice(0, 500) : ''
      },
      topics,
      updatedAt: typeof raw?.updatedAt === 'number' ? raw.updatedAt : 0
    }
  } catch {
    return emptyDb()
  }
}

export function writeProgress(sessionId: string, db: ProgressDb): void {
  if (progressBase === '') return
  const file = join(progressBase, `${sessionId}.json`)
  mkdirSync(dirname(file), { recursive: true }) // 首次写入时目录可能还不存在（同 note-store 口径）
  writeFileSync(file, JSON.stringify({ ...db, updatedAt: Date.now() }, null, 2), 'utf8')
}

/** 设置/更新学习计划（goal 空串 = 清除计划）；返回新档 */
export function setPlan(
  sessionId: string,
  plan: { goal?: unknown; deadline?: unknown; notes?: unknown }
): ProgressDb {
  const db = readProgress(sessionId)
  const goal = typeof plan.goal === 'string' ? plan.goal.trim().slice(0, 200) : db.plan.goal
  let deadline = db.plan.deadline
  if (typeof plan.deadline === 'number' && Number.isFinite(plan.deadline)) deadline = plan.deadline
  else if (typeof plan.deadline === 'string' && plan.deadline.trim() !== '') {
    const parsed = Date.parse(plan.deadline)
    if (Number.isFinite(parsed)) deadline = parsed
  }
  const notes = typeof plan.notes === 'string' ? plan.notes.trim().slice(0, 500) : db.plan.notes
  const next: ProgressDb = { ...db, plan: { goal, deadline, notes } }
  writeProgress(sessionId, next)
  return next
}

/** 记一个知识点的自评掌握度（同名覆盖，保留既有实测值） */
export function upsertTopic(
  sessionId: string,
  topic: string,
  selfScore: number,
  measuredScore?: number | null
): ProgressDb {
  const db = readProgress(sessionId)
  const name = topic.trim().slice(0, 60)
  if (name === '') return db
  const idx = db.topics.findIndex((t) => t.topic === name)
  const next: TopicProgress = {
    topic: name,
    selfScore: clampScore(selfScore),
    measuredScore:
      measuredScore === undefined
        ? idx >= 0
          ? db.topics[idx].measuredScore
          : null
        : measuredScore === null
          ? null
          : clampScore(measuredScore),
    updatedAt: Date.now()
  }
  const topics = idx >= 0 ? db.topics.map((t, i) => (i === idx ? next : t)) : [...db.topics, next]
  const capped = topics.slice(-PROGRESS_MAX_TOPICS) // 超限丢最早的
  const out: ProgressDb = { ...db, topics: capped }
  writeProgress(sessionId, out)
  return out
}

/** 复习评分回流：把某知识点的实测掌握度写成新值（仅当有实测时用） */
export function setMeasured(sessionId: string, topic: string, measured: number): ProgressDb {
  const db = readProgress(sessionId)
  const name = topic.trim()
  const idx = db.topics.findIndex((t) => t.topic === name)
  if (idx < 0) return db
  const topics = db.topics.map((t, i) =>
    i === idx ? { ...t, measuredScore: clampScore(measured), updatedAt: Date.now() } : t
  )
  const out: ProgressDb = { ...db, topics }
  writeProgress(sessionId, out)
  return out
}

/** 展示用有效掌握度：实测优先，无实测用自评 */
export function effectiveScore(t: TopicProgress): number {
  return t.measuredScore ?? t.selfScore
}

/** 距截止日还剩几天（向上取整；未设截止日返回 null；已过期为负） */
export function daysLeft(deadline: number, now: number): number | null {
  if (deadline <= 0) return null
  return Math.ceil((deadline - now) / (24 * 60 * 60 * 1000))
}
