// 气泡策略单测（P9-T5）：重点守护 decideBubble 的门槛顺序，
// 以及展示后运行时（冷却/小时桶/时段问候/idle）的推进。
// 两类事件两套规则（owner 实测反馈后拆分）：
// · 主动型（startup/greeting/idle/任务/reminder）：冷却 4 分钟 + 每小时上限 3 条 + 免打扰 + 全屏；
// · 回应型（戳/拖/主窗收起）：豁免以上全部，只留 2 秒防抖——用户戳她必须马上有反应。

import { describe, expect, it } from 'vitest'
import type { AppConfig } from '../src/shared/types'
import {
  BUBBLE_COOLDOWN_MS,
  BUBBLE_HOURLY_MAX,
  RESPONSE_DEBOUNCE_MS,
  configBubbleSettings,
  createBubbleRuntime,
  dayKey,
  dayPart,
  decideBubble,
  greetingAlreadyFired,
  hourBucketKey,
  isInDnd,
  noteBubbleShown,
  parseClock,
  resetIdleFired,
  type DecideBubbleInput
} from '../src/main/pet/bubble-policy'

const NOW = new Date(2026, 8, 18, 10, 0) // 周五 10:00，属于早上时段

/** 默认按主动型（startup）：绝大多数门槛用例针对主动型；回应型用例显式传 kind */
function baseInput(over: Partial<DecideBubbleInput> = {}): DecideBubbleInput {
  return {
    kind: 'startup',
    level: 'greet',
    now: NOW,
    dndStartMin: 23 * 60,
    dndEndMin: 8 * 60,
    fullscreen: false,
    rt: createBubbleRuntime(NOW),
    ...over
  }
}

describe('decideBubble · 门槛（主动型）', () => {
  it('档位 off：任何事件都不冒泡', () => {
    expect(decideBubble(baseInput({ level: 'off' }))).toEqual({ allow: false, reason: 'level-off' })
    expect(decideBubble(baseInput({ level: 'off', kind: 'pet_tap' }))).toEqual({
      allow: false,
      reason: 'level-off'
    })
  })

  it('greet 档：回应型放行；idle/任务类档低', () => {
    expect(decideBubble(baseInput({ kind: 'pet_tap' })).allow).toBe(true)
    expect(decideBubble(baseInput({ kind: 'idle' }))).toEqual({ allow: false, reason: 'level-low' })
    expect(decideBubble(baseInput({ kind: 'task_done' }))).toEqual({
      allow: false,
      reason: 'level-low'
    })
  })

  it('all 档：idle/任务类放行', () => {
    expect(decideBubble(baseInput({ level: 'all', kind: 'idle' })).allow).toBe(true)
    expect(decideBubble(baseInput({ level: 'all', kind: 'task_fail' })).allow).toBe(true)
  })

  it('免打扰时段：普通主动型（greeting/idle）不冒泡，reminder 放行', () => {
    const night = new Date(2026, 8, 18, 23, 30)
    expect(decideBubble(baseInput({ now: night, kind: 'greeting' }))).toEqual({
      allow: false,
      reason: 'dnd'
    })
    expect(decideBubble(baseInput({ now: night, kind: 'idle', level: 'all' }))).toEqual({
      allow: false,
      reason: 'dnd'
    })
    expect(decideBubble(baseInput({ now: night, kind: 'reminder', level: 'all' })).allow).toBe(true)
  })

  it('★ 免打扰时段启动：startup 仍问候（用户主动打开应用，一声不吭会被当成坏了）', () => {
    const night = new Date(2026, 8, 18, 23, 30)
    expect(decideBubble(baseInput({ now: night, kind: 'startup' })).allow).toBe(true)
    // 但仍受冷却约束：刚冒过泡不会再冒
    const rt = noteBubbleShown(createBubbleRuntime(night), 'startup', night)
    expect(decideBubble(baseInput({ now: night, kind: 'startup', rt }))).toEqual({
      allow: false,
      reason: 'cooldown'
    })
  })

  it('全屏应用：主动型一律不冒泡（含 reminder）', () => {
    expect(decideBubble(baseInput({ fullscreen: true }))).toEqual({
      allow: false,
      reason: 'fullscreen'
    })
    expect(decideBubble(baseInput({ fullscreen: true, kind: 'reminder', level: 'all' }))).toEqual({
      allow: false,
      reason: 'fullscreen'
    })
  })

  it('冷却：距上一条不足 4 分钟不冒泡', () => {
    const rt = noteBubbleShown(createBubbleRuntime(NOW), 'startup', NOW)
    const soon = new Date(NOW.getTime() + BUBBLE_COOLDOWN_MS - 1000)
    expect(decideBubble(baseInput({ now: soon, rt }))).toEqual({ allow: false, reason: 'cooldown' })
    const later = new Date(NOW.getTime() + BUBBLE_COOLDOWN_MS + 1000)
    expect(decideBubble(baseInput({ now: later, rt })).allow).toBe(true)
  })

  it('每小时上限：3 条后不再冒泡；跨小时重新计数', () => {
    let rt = createBubbleRuntime(NOW)
    // 用 5 分钟间隔绕过冷却，连开 3 条
    for (let i = 0; i < BUBBLE_HOURLY_MAX; i++) {
      rt = noteBubbleShown(rt, 'startup', new Date(NOW.getTime() + i * (BUBBLE_COOLDOWN_MS + 1)))
    }
    const t = new Date(NOW.getTime() + 3 * (BUBBLE_COOLDOWN_MS + 1))
    expect(decideBubble(baseInput({ now: t, rt }))).toEqual({
      allow: false,
      reason: 'hourly-cap'
    })
    // 跨小时：桶 key 不同 → 计数视为 0
    const nextHour = new Date(NOW.getTime() + 60 * 60_000)
    const rt2 = { ...rt, lastShownAt: null } // 冷却也已过
    expect(decideBubble(baseInput({ now: nextHour, rt: rt2 })).allow).toBe(true)
  })

  it('门槛顺序：dnd 优先于 cooldown（判定优先级即输出理由）', () => {
    const rt = noteBubbleShown(createBubbleRuntime(NOW), 'startup', NOW)
    const night = new Date(2026, 8, 18, 23, 30)
    expect(decideBubble(baseInput({ now: night, kind: 'greeting', rt }))).toEqual({
      allow: false,
      reason: 'dnd'
    })
  })
})

describe('decideBubble · 回应型豁免（戳/拖/主窗收起）', () => {
  const RESPONSES = ['pet_tap', 'pet_drag', 'minimize'] as const

  it('★ 启动问候刚冒过（4 分钟冷却内），戳她仍要立刻回应', () => {
    const rt = noteBubbleShown(createBubbleRuntime(NOW), 'startup', NOW)
    const justNow = new Date(NOW.getTime() + 5_000) // 5 秒后戳她
    for (const kind of RESPONSES) {
      expect(decideBubble(baseInput({ kind, now: justNow, rt })).allow).toBe(true)
    }
  })

  it('★ 免打扰时段戳她 → 仍回应（用户主动互动，不算打扰）', () => {
    const night = new Date(2026, 8, 18, 23, 30)
    for (const kind of RESPONSES) {
      expect(decideBubble(baseInput({ kind, now: night })).allow).toBe(true)
    }
  })

  it('★ 全屏时戳她 → 仍回应', () => {
    for (const kind of RESPONSES) {
      expect(decideBubble(baseInput({ kind, fullscreen: true })).allow).toBe(true)
    }
  })

  it('★ 每小时上限已满，戳她仍回应（回应不占主动配额）', () => {
    let rt = createBubbleRuntime(NOW)
    for (let i = 0; i < BUBBLE_HOURLY_MAX + 2; i++) {
      rt = noteBubbleShown(rt, 'startup', new Date(NOW.getTime() + i * (BUBBLE_COOLDOWN_MS + 1)))
    }
    const t = new Date(NOW.getTime() + 10 * (BUBBLE_COOLDOWN_MS + 1))
    expect(decideBubble(baseInput({ kind: 'pet_tap', now: t, rt })).allow).toBe(true)
    // 而主动型此时仍被上限拦住
    expect(decideBubble(baseInput({ kind: 'startup', now: t, rt }))).toEqual({
      allow: false,
      reason: 'hourly-cap'
    })
  })

  it('2 秒防抖：连点不刷屏；超出即恢复', () => {
    const rt = noteBubbleShown(createBubbleRuntime(NOW), 'pet_tap', NOW)
    const within = new Date(NOW.getTime() + RESPONSE_DEBOUNCE_MS - 100)
    expect(decideBubble(baseInput({ kind: 'pet_tap', now: within, rt }))).toEqual({
      allow: false,
      reason: 'cooldown'
    })
    const beyond = new Date(NOW.getTime() + RESPONSE_DEBOUNCE_MS + 100)
    expect(decideBubble(baseInput({ kind: 'pet_tap', now: beyond, rt })).allow).toBe(true)
  })

  it('回应型也要求档位达标：off 全关', () => {
    expect(decideBubble(baseInput({ kind: 'pet_tap', level: 'off' })).allow).toBe(false)
  })
})

describe('noteBubbleShown · 运行时推进', () => {
  it('主动型：写回冷却时间戳与小时桶计数', () => {
    const rt = noteBubbleShown(createBubbleRuntime(NOW), 'startup', NOW)
    expect(rt.lastShownAt).toBe(NOW.getTime())
    expect(rt.hourBucket).toEqual({ key: hourBucketKey(NOW), count: 1 })
  })

  it('★ 回应型：写冷却时间戳但不占小时配额', () => {
    let rt = createBubbleRuntime(NOW)
    rt = noteBubbleShown(rt, 'pet_tap', NOW)
    rt = noteBubbleShown(rt, 'pet_drag', new Date(NOW.getTime() + 5_000))
    rt = noteBubbleShown(rt, 'minimize', new Date(NOW.getTime() + 10_000))
    expect(rt.lastShownAt).toBe(NOW.getTime() + 10_000)
    expect(rt.hourBucket.count).toBe(0)
  })

  it('greeting：同一时段当天只记一次', () => {
    let rt = noteBubbleShown(createBubbleRuntime(NOW), 'greeting', NOW)
    expect(rt.greetingDay).toBe(dayKey(NOW))
    expect(rt.greetingParts).toEqual(['morning'])
    // 再记一次同同时段：不重复 push
    rt = noteBubbleShown(rt, 'greeting', NOW)
    expect(rt.greetingParts).toEqual(['morning'])
    expect(greetingAlreadyFired(rt, NOW)).toBe(true)
  })

  it('greetingAlreadyFired：换天 / 换时段都为 false', () => {
    const rt = noteBubbleShown(createBubbleRuntime(NOW), 'greeting', NOW)
    const noon = new Date(2026, 8, 18, 12, 0)
    expect(greetingAlreadyFired(rt, noon)).toBe(false)
    const nextDay = new Date(2026, 8, 19, 10, 0)
    expect(greetingAlreadyFired(rt, nextDay)).toBe(false)
  })

  it('idle：标记后复位（用户回到活跃）', () => {
    let rt = noteBubbleShown(createBubbleRuntime(NOW), 'idle', NOW)
    expect(rt.idleFired).toBe(true)
    rt = resetIdleFired(rt)
    expect(rt.idleFired).toBe(false)
    // 未标记时复位返回同一引用（无多余拷贝）
    expect(resetIdleFired(rt)).toBe(rt)
  })
})

describe('时钟与时段', () => {
  it('parseClock：HH:MM → 分钟；非法值 null', () => {
    expect(parseClock('23:00')).toBe(1380)
    expect(parseClock('08:30')).toBe(510)
    expect(parseClock('24:00')).toBeNull()
    expect(parseClock('12:60')).toBeNull()
    expect(parseClock('abc')).toBeNull()
  })

  it('dayPart：早/午/晚与空档', () => {
    expect(dayPart(new Date(2026, 8, 18, 6, 0))).toBe('morning')
    expect(dayPart(new Date(2026, 8, 18, 12, 0))).toBe('noon')
    expect(dayPart(new Date(2026, 8, 18, 20, 0))).toBe('evening')
    expect(dayPart(new Date(2026, 8, 18, 15, 0))).toBeNull()
  })

  it('isInDnd：跨午夜 / 不跨 / 不启用', () => {
    // 23:00–08:00 跨午夜
    expect(isInDnd(new Date(2026, 8, 18, 23, 30), 1380, 480)).toBe(true)
    expect(isInDnd(new Date(2026, 8, 18, 7, 0), 1380, 480)).toBe(true)
    expect(isInDnd(new Date(2026, 8, 18, 12, 0), 1380, 480)).toBe(false)
    // 13:00–14:00 不跨午夜
    expect(isInDnd(new Date(2026, 8, 18, 13, 30), 780, 840)).toBe(true)
    expect(isInDnd(new Date(2026, 8, 18, 12, 0), 780, 840)).toBe(false)
    // 两端相同/非法 = 不启用
    expect(isInDnd(NOW, 600, 600)).toBe(false)
    expect(isInDnd(NOW, null, 480)).toBe(false)
  })
})

describe('configBubbleSettings · 配置投影', () => {
  it('字段映射与空闲毫秒换算', () => {
    const pet: AppConfig['pet'] = {
      x: null,
      y: null,
      clickThrough: false,
      scale: 0.5,
      bubbleLevel: 'all',
      bubbleDndStart: '23:00',
      bubbleDndEnd: '08:00',
      bubbleIdleMin: 15,
      layoutV2: true
    }
    expect(configBubbleSettings(pet)).toEqual({
      level: 'all',
      dndStartMin: 1380,
      dndEndMin: 480,
      idleMs: 15 * 60_000
    })
  })
})
