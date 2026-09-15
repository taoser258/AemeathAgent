// 复习调度：闪卡按**间隔重复**排期。
//
// 为什么要有它：note_write 已经在往 userData/notes 里沉淀闪卡，但此前只能靠用户自己翻——
// "记住了"和"记过一次"是两回事。这里给每张卡记一个复习档位（level）与到期时间，
// 答对推后、答错提前重来，首页显示"今日待复习 N 张"，把沉淀变成真正的记忆闭环。
//
// 算法取**固定阶梯**（对齐 Anki 的简化版：1 → 3 → 7 → 16 → 35 天）而不是动态 ease：
// 单机学习场景卡片量小、反馈清晰，固定阶梯可预期、好解释、好调试；不追求最优 SRS。
// 无 electron 依赖：根目录由 main 注入，vitest 直接单测（含注入时钟）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

/** 阶梯（天）：level i 答对 → 隔 INTERVALS[i] 天再复习 */
export const REVIEW_INTERVALS_DAYS = [1, 3, 7, 16, 35] as const
/** 答错后的重来间隔（分钟）：当天稍后再练，不推到明天 */
export const REVIEW_AGAIN_MINUTES = 10
/** 单会话单日新卡上限（防一次灌太多，只显示最早的 N 张） */
export const REVIEW_DAILY_NEW_LIMIT = 12

/** 一张卡的复习档 */
export interface ReviewState {
  /** 当前档位（0..REVIEW_INTERVALS_DAYS.length-1）；-1 = 还没复习过 */
  level: number
  /** 下次到期时间（毫秒） */
  due: number
  /** 复习次数 */
  reps: number
  /** 答错次数（lapses）——掌握度会扣它 */
  lapses: number
  /** 最近一次复习时间 */
  lastAt: number
}

export interface ReviewDb {
  /** 卡 id（NoteEntry.id）→ 档 */
  cards: Record<string, ReviewState>
  updatedAt: number
}

/** 用户评分（三档，与 Anki 的 Again/Good/Easy 同构，文案用中文） */
export type ReviewGrade = 'again' | 'good' | 'easy'

const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

let reviewBase = ''

/** 注入存储根目录（main ready 时 = userData/review；单测 = 临时目录） */
export function setReviewBase(base: string): void {
  reviewBase = base
}

export function getReviewBase(): string {
  return reviewBase
}

/**
 * 评分 → 新档（纯函数，时钟注入便于单测）。
 * - again：回到 0 档、10 分钟后再来，lapses+1（"又错了"要留痕）
 * - good：进一档
 * - easy：进两档（已经熟了，别浪费时间）
 */
export function gradeCard(
  prev: ReviewState | undefined,
  grade: ReviewGrade,
  now: number
): ReviewState {
  const level = prev?.level ?? -1
  const maxLevel = REVIEW_INTERVALS_DAYS.length - 1
  let nextLevel: number
  let due: number
  if (grade === 'again') {
    nextLevel = 0
    due = now + REVIEW_AGAIN_MINUTES * MINUTE_MS
  } else {
    nextLevel = Math.min(maxLevel, level + (grade === 'easy' ? 2 : 1))
    due = now + REVIEW_INTERVALS_DAYS[nextLevel] * DAY_MS
  }
  return {
    level: nextLevel,
    due,
    reps: (prev?.reps ?? 0) + 1,
    lapses: (prev?.lapses ?? 0) + (grade === 'again' ? 1 : 0),
    lastAt: now
  }
}

/** 掌握度 0-100（纯函数）：档位给底分，答错按次数打折。
 * 0 档（刚答错或刚起步）≈ 20 分，满档 = 100；每次 lapse 扣 12 分，地板 0。 */
export function estimateMastery(state: ReviewState | undefined): number {
  if (state === undefined || state.reps === 0) return 0
  const maxLevel = REVIEW_INTERVALS_DAYS.length - 1
  const base = Math.round(((state.level + 1) / (maxLevel + 1)) * 100)
  const penalty = state.lapses * 12
  return Math.max(0, Math.min(100, base - penalty))
}

/** 卡片是否到期（没有档 = 新卡，立即可练；刚做完闪卡就能自测） */
export function isDue(state: ReviewState | undefined, now: number): boolean {
  if (state === undefined) return true
  return state.due <= now
}

export interface DueSummary {
  /** 到期（含新卡）总数 */
  due: number
  /** 卡片总数 */
  total: number
  /** 已进入复习循环（reps > 0）的卡片数 */
  started: number
  /** 已"毕业"（满档）的卡片数 */
  mature: number
  /** 全部卡片的平均掌握度（0-100） */
  mastery: number
}

/** 汇总（纯函数）：给学习卡与进度卡用 */
export function summarize(
  total: number,
  states: Record<string, ReviewState>,
  now: number
): DueSummary {
  const list = Object.values(states)
  const started = list.filter((s) => s.reps > 0)
  const mature = list.filter((s) => s.level >= REVIEW_INTERVALS_DAYS.length - 1)
  const due = list.filter((s) => s.due <= now).length + Math.max(0, total - list.length)
  const mastery =
    started.length === 0
      ? 0
      : Math.round(started.reduce((sum, s) => sum + estimateMastery(s), 0) / started.length)
  return { due, total, started: started.length, mature: mature.length, mastery }
}

// ── 落盘 ────────────────────────────────────────────────────────────────
function fileOf(sessionId: string): string {
  return join(reviewBase, `${sessionId}.json`)
}

/** 读某会话复习档；无档/损坏 → 空档（不抛错，宁可让用户重新开始练） */
export function readReview(sessionId: string): ReviewDb {
  if (reviewBase === '') return { cards: {}, updatedAt: 0 }
  const file = fileOf(sessionId)
  if (!existsSync(file)) return { cards: {}, updatedAt: 0 }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as ReviewDb
    if (typeof raw?.cards !== 'object' || raw.cards === null) return { cards: {}, updatedAt: 0 }
    const cards: Record<string, ReviewState> = {}
    for (const [id, st] of Object.entries(raw.cards)) {
      if (typeof st?.due !== 'number' || !Number.isFinite(st.due)) continue
      cards[id] = {
        level: typeof st.level === 'number' ? st.level : -1,
        due: st.due,
        reps: typeof st.reps === 'number' ? st.reps : 0,
        lapses: typeof st.lapses === 'number' ? st.lapses : 0,
        lastAt: typeof st.lastAt === 'number' ? st.lastAt : 0
      }
    }
    return { cards, updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0 }
  } catch {
    return { cards: {}, updatedAt: 0 }
  }
}

/** 写复习档（整读整写；复习动作在渲染层串行，无并发冲突）。
 * 目录可能尚未存在（首次评分时 review/ 还没建）→ 先 mkdir，与 note-store 同口径。 */
export function writeReview(sessionId: string, db: ReviewDb): void {
  if (reviewBase === '') return
  const file = fileOf(sessionId)
  mkdirSync(dirname(file), { recursive: true })
  const next: ReviewDb = { cards: db.cards, updatedAt: Date.now() }
  writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
}

/** 给一张卡评分并落盘，返回新档与整会话汇总（渲染层刷新用） */
export function gradeAndSave(
  sessionId: string,
  cardId: string,
  grade: ReviewGrade,
  now: number,
  totalCards: number
): { state: ReviewState; summary: DueSummary } {
  const db = readReview(sessionId)
  const state = gradeCard(db.cards[cardId], grade, now)
  const cards = { ...db.cards, [cardId]: state }
  writeReview(sessionId, { cards, updatedAt: Date.now() })
  return { state, summary: summarize(totalCards, cards, now) }
}

/** 丢掉已不存在的卡的档（笔记被清空/导出整理后调用），返回清理条数 */
export function pruneReview(sessionId: string, validIds: string[]): number {
  const db = readReview(sessionId)
  const valid = new Set(validIds)
  const kept: Record<string, ReviewState> = {}
  let dropped = 0
  for (const [id, st] of Object.entries(db.cards)) {
    if (valid.has(id)) kept[id] = st
    else dropped += 1
  }
  if (dropped > 0) writeReview(sessionId, { cards: kept, updatedAt: Date.now() })
  return dropped
}
