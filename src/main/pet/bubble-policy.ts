// 气泡策略（P9-T5）：什么条件下允许桌宠冒泡。**纯函数、无 electron**，单测守护。
// 调度器（bubble-scheduler.ts）只负责"什么时候想冒泡"，能不能冒泡由这里判。
//
// 防打扰硬约束（owner 拍板，对齐成熟桌宠）：
// · 三档：off 全关 / greet 只打招呼（回应型）/ all 连主动提醒也开；
// · 主动型（启动/时段/空闲/任务/提醒）：全局冷却 4 分钟、每小时上限 3 条、
//   免打扰时段默认 23:00–08:00（reminder 可穿越）、全屏不冒泡；
// · **回应型（戳/拖/主窗收起）是用户主动互动，豁免以上全部门槛，只留 2 秒防抖**——
//   否则启动问候后的 4 分钟冷却会把"戳她"全憋掉（owner 实测反馈：戳/拖/关窗一声不吭）。

import type { AppConfig } from '@shared/types'

export type BubbleLevel = 'off' | 'greet' | 'all'

export type BubbleKind =
  | 'startup' // 启动问候（延迟数秒，避开开窗动画）
  | 'greeting' // 早/中/晚，当天每个时段首次
  | 'pet_tap' // 被点了一下（回应型）
  | 'pet_drag' // 被拖动（回应型）
  | 'minimize' // 主窗收起（回应型）
  | 'idle' // 用户空闲 N 分钟（主动）
  | 'task_done' // 任务顺利完成（主动提醒）
  | 'task_fail' // 任务失败（主动提醒）
  | 'reminder' // 复习到期等提醒：唯一可穿越免打扰时段

/** 各事件需要的最低档位：greet 档放行回应型，idle/任务类要 all 档 */
const KIND_MIN_LEVEL: Record<BubbleKind, BubbleLevel> = {
  startup: 'greet',
  greeting: 'greet',
  pet_tap: 'greet',
  pet_drag: 'greet',
  minimize: 'greet',
  idle: 'all',
  task_done: 'all',
  task_fail: 'all',
  reminder: 'all'
}

const LEVEL_RANK: Record<BubbleLevel, number> = { off: 0, greet: 1, all: 2 }

/**
 * 回应型事件：用户主动互动（戳一下 / 拖完 / 收起主窗）。
 * 这类气泡是"用户要的"，不算打扰——豁免冷却、免打扰、全屏、每小时上限。
 */
const RESPONSE_KINDS: readonly BubbleKind[] = ['pet_tap', 'pet_drag', 'minimize']

/**
 * 免打扰时段仍放行的事件：
 * · 回应型（用户当场互动）；
 * · startup（用户主动打开应用——启动时她一声不吭会被当成"坏了"，实测困惑：
 *   深夜启动看不到问候来问"为什么没气泡"）。仍受冷却/上限约束（不会连发）；
 * · reminder（复习到期等正事提醒，原设计即放行）。
 */
const DND_EXEMPT_KINDS: readonly BubbleKind[] = [...RESPONSE_KINDS, 'startup', 'reminder']

/** 回应型防抖：连续戳/连续拖不至于刷屏（很短，够防连点） */
export const RESPONSE_DEBOUNCE_MS = 2_000

/** 主动型全局冷却：两条主动气泡最小间隔 */
export const BUBBLE_COOLDOWN_MS = 4 * 60_000
/** 每小时上限（防止话痨；只统计主动型，回应型不占配额） */
export const BUBBLE_HOURLY_MAX = 3

/** 运行时状态（不落盘；重启即归零） */
export interface BubbleRuntimeState {
  /** 上一条成功冒泡的时间戳 */
  lastShownAt: number | null
  /** 小时桶：跨小时自动视为新桶 */
  hourBucket: { key: string; count: number }
  /** 当天已发过的时段问候 */
  greetingDay: string | null
  greetingParts: Array<'morning' | 'noon' | 'evening'>
  /** 当前空闲段是否已经发过 idle（用户回活跃后由调度器复位） */
  idleFired: boolean
}

export function createBubbleRuntime(now: Date): BubbleRuntimeState {
  return {
    lastShownAt: null,
    hourBucket: { key: hourBucketKey(now), count: 0 },
    greetingDay: null,
    greetingParts: [],
    idleFired: false
  }
}

export function hourBucketKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}`
}

export function dayKey(d: Date): string {
  return hourBucketKey(d).split('T')[0]
}

export type DayPart = 'morning' | 'noon' | 'evening' | null

/** 时段问候归属：5–11 早、11–14 午、17–24 晚；下午与深夜不主动发时段问候 */
export function dayPart(d: Date): DayPart {
  const h = d.getHours()
  if (h >= 5 && h < 11) return 'morning'
  if (h >= 11 && h < 14) return 'noon'
  if (h >= 17 && h <= 23) return 'evening'
  return null
}

/** "HH:MM" → 分钟数（0–1439）；非法返回 null */
export function parseClock(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const m = value.trim().match(/^(\d{2}):(\d{2})$/)
  if (m === null) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (hh > 23 || mm > 59) return null
  return hh * 60 + mm
}

/**
 * 此刻是否处于免打扰时段。start>end = 跨午夜（如 23:00–08:00）；
 * 两端相等（含都为 00:00）= 不启用，永远返回 false。
 */
export function isInDnd(now: Date, startMin: number | null, endMin: number | null): boolean {
  if (startMin === null || endMin === null || startMin === endMin) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  if (startMin < endMin) return cur >= startMin && cur < endMin
  // 跨午夜：在 [start,24:00) 或 [0:00,end) 内都算
  return cur >= startMin || cur < endMin
}

export type BubbleDenyReason =
  'level-off' | 'level-low' | 'dnd' | 'fullscreen' | 'cooldown' | 'hourly-cap'

export interface DecideBubbleInput {
  kind: BubbleKind
  level: BubbleLevel
  now: Date
  dndStartMin: number | null
  dndEndMin: number | null
  /** 前台是否有全屏应用（游戏/视频） */
  fullscreen: boolean
  rt: BubbleRuntimeState
}

export type BubbleDecision = { allow: true } | { allow: false; reason: BubbleDenyReason }

/**
 * 核心判定。
 * 回应型：档位 → 2 秒防抖（用户戳她必须马上有反应，其余门槛全免）。
 * 主动型：档位 → 免打扰 → 全屏 → 冷却 → 每小时上限（顺序即优先级，别随意换）。
 */
export function decideBubble(input: DecideBubbleInput): BubbleDecision {
  const { kind, level, now, dndStartMin, dndEndMin, fullscreen, rt } = input

  if (level === 'off') return { allow: false, reason: 'level-off' }
  if (LEVEL_RANK[level] < LEVEL_RANK[KIND_MIN_LEVEL[kind]]) {
    return { allow: false, reason: 'level-low' }
  }

  if (RESPONSE_KINDS.includes(kind)) {
    if (rt.lastShownAt !== null && now.getTime() - rt.lastShownAt < RESPONSE_DEBOUNCE_MS) {
      return { allow: false, reason: 'cooldown' }
    }
    return { allow: true }
  }

  // 免打扰：回应型 / startup / reminder 可穿越（见 DND_EXEMPT_KINDS）；全屏仍不冒泡
  if (!DND_EXEMPT_KINDS.includes(kind) && isInDnd(now, dndStartMin, dndEndMin)) {
    return { allow: false, reason: 'dnd' }
  }
  if (fullscreen) return { allow: false, reason: 'fullscreen' }
  if (rt.lastShownAt !== null && now.getTime() - rt.lastShownAt < BUBBLE_COOLDOWN_MS) {
    return { allow: false, reason: 'cooldown' }
  }
  const hourCount = rt.hourBucket.key === hourBucketKey(now) ? rt.hourBucket.count : 0
  if (hourCount >= BUBBLE_HOURLY_MAX) return { allow: false, reason: 'hourly-cap' }
  return { allow: true }
}

/**
 * 成功展示后推进运行时：冷却时间、小时桶计数、时段问候标记、idle 标记。
 * 小时桶只统计主动型——戳她 / 拖她不该挤掉"主动关心"的配额。
 */
export function noteBubbleShown(
  rt: BubbleRuntimeState,
  kind: BubbleKind,
  now: Date
): BubbleRuntimeState {
  const sameBucket = rt.hourBucket.key === hourBucketKey(now)
  const isResponse = RESPONSE_KINDS.includes(kind)
  const baseCount = sameBucket ? rt.hourBucket.count : 0
  const next: BubbleRuntimeState = {
    lastShownAt: now.getTime(),
    hourBucket: {
      key: hourBucketKey(now),
      count: isResponse ? baseCount : baseCount + 1
    },
    greetingDay: rt.greetingDay,
    greetingParts: [...rt.greetingParts],
    idleFired: kind === 'idle' ? true : rt.idleFired
  }
  if (kind === 'greeting') {
    const part = dayPart(now)
    const today = dayKey(now)
    if (part !== null && (next.greetingDay !== today || !next.greetingParts.includes(part))) {
      next.greetingDay = today
      next.greetingParts.push(part)
    }
  }
  return next
}

/** 这个时段的问候今天发过没有（调度器据此决定要不要触发 greeting） */
export function greetingAlreadyFired(rt: BubbleRuntimeState, now: Date): boolean {
  const part = dayPart(now)
  return part !== null && rt.greetingDay === dayKey(now) && rt.greetingParts.includes(part)
}

/** 用户回到活跃：复位 idle 标记，下一段空闲可以再发 */
export function resetIdleFired(rt: BubbleRuntimeState): BubbleRuntimeState {
  return rt.idleFired ? { ...rt, idleFired: false } : rt
}

/** 从 app 配置读判定输入（只做字段投影，判定在 decideBubble，便于单测） */
export function configBubbleSettings(config: AppConfig['pet']): {
  level: BubbleLevel
  dndStartMin: number | null
  dndEndMin: number | null
  idleMs: number
} {
  return {
    level: config.bubbleLevel,
    dndStartMin: parseClock(config.bubbleDndStart),
    dndEndMin: parseClock(config.bubbleDndEnd),
    idleMs: config.bubbleIdleMin * 60_000
  }
}
