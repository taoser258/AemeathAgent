// 复习调度单测：阶梯推进 / 答错重来 / 掌握度估算 / 到期判定 /
// 落盘往返 / 汇总。时钟全部注入，不依赖真实时间。

import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  estimateMastery,
  gradeAndSave,
  gradeCard,
  isDue,
  pruneReview,
  readReview,
  REVIEW_AGAIN_MINUTES,
  REVIEW_INTERVALS_DAYS,
  setReviewBase,
  summarize,
  writeReview,
  type ReviewState
} from '../src/main/agent/tools/review-store'

const DAY = 24 * 60 * 60 * 1000
const MIN = 60 * 1000
const T0 = 1_700_000_000_000

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aemeath-review-'))
  setReviewBase(root)
})

afterEach(() => {
  setReviewBase('')
})

describe('review-store 调度算法（纯函数）', () => {
  it('good 逐档推进：1 → 3 → 7 → 16 → 35 天，到顶不再涨', () => {
    let st: ReviewState | undefined
    const expected = REVIEW_INTERVALS_DAYS
    for (let i = 0; i < expected.length; i += 1) {
      st = gradeCard(st, 'good', T0)
      expect(st.level).toBe(i)
      expect(st.due).toBe(T0 + expected[i] * DAY)
      expect(st.reps).toBe(i + 1)
    }
    const capped = gradeCard(st, 'good', T0)
    expect(capped.level).toBe(expected.length - 1) // 满档后不再涨
  })

  it('easy 跳两档（已经熟了别浪费时间）：新卡 → 档1（跳过 1 天档），已起步再跳', () => {
    // 新卡档位是 -1，"进两档" = 档 1（3 天），跳过"1 天"那一档
    const fromNew = gradeCard(undefined, 'easy', T0)
    expect(fromNew.level).toBe(1)
    expect(fromNew.due).toBe(T0 + REVIEW_INTERVALS_DAYS[1] * DAY)
    // 已练过一轮（档 0）再点 easy → 档 2（7 天）
    const lv0: ReviewState = { level: 0, due: 0, reps: 1, lapses: 0, lastAt: 0 }
    const fromLv0 = gradeCard(lv0, 'easy', T0)
    expect(fromLv0.level).toBe(2)
    expect(fromLv0.due).toBe(T0 + REVIEW_INTERVALS_DAYS[2] * DAY)
  })

  it('★ again 回到 0 档、10 分钟后再练，并记一次 lapse', () => {
    const first = gradeCard(undefined, 'good', T0) // level 0
    const second = gradeCard(first, 'good', T0) // level 1
    const third = gradeCard(second, 'good', T0) // level 2
    const again = gradeCard(third, 'again', T0)
    expect(again.level).toBe(0)
    expect(again.due).toBe(T0 + REVIEW_AGAIN_MINUTES * MIN)
    expect(again.lapses).toBe(1)
    expect(again.reps).toBe(4)
  })

  it('isDue：没有档（新卡）立即可练；到期/未到期判定', () => {
    expect(isDue(undefined, T0)).toBe(true)
    const st = gradeCard(undefined, 'good', T0) // 1 天后到期
    expect(isDue(st, T0)).toBe(false)
    expect(isDue(st, T0 + DAY)).toBe(true)
    expect(isDue(st, T0 + DAY + 1)).toBe(true)
  })

  it('estimateMastery：档位给底分、lapse 打折、有地板', () => {
    expect(estimateMastery(undefined)).toBe(0)
    expect(estimateMastery({ level: 0, due: 0, reps: 1, lapses: 0, lastAt: 0 })).toBe(20)
    expect(estimateMastery({ level: 4, due: 0, reps: 5, lapses: 0, lastAt: 0 })).toBe(100)
    // 满档但错得多也要掉下来；地板 0（不会出现负数）
    expect(estimateMastery({ level: 4, due: 0, reps: 9, lapses: 3, lastAt: 0 })).toBe(64)
    expect(estimateMastery({ level: 0, due: 0, reps: 9, lapses: 5, lastAt: 0 })).toBe(0)
  })

  it('summarize：新卡计入 due、统计已练/已掌握/平均掌握度', () => {
    const cards: Record<string, ReviewState> = {
      a: { level: 0, due: T0 - 1, reps: 1, lapses: 0, lastAt: 0 }, // 已到期
      b: { level: 4, due: T0 + DAY, reps: 5, lapses: 0, lastAt: 0 }, // 已掌握、未到期
      c: { level: 1, due: T0 + DAY, reps: 2, lapses: 0, lastAt: 0 } // 未到期
    }
    const s = summarize(5, cards, T0) // 5 张卡，其中 2 张是没练过的新卡
    expect(s.total).toBe(5)
    expect(s.due).toBe(3) // 1 张到期 + 2 张新卡
    expect(s.started).toBe(3)
    expect(s.mature).toBe(1)
    expect(s.mastery).toBe(Math.round((20 + 100 + 40) / 3))
  })
})

describe('review-store 落盘与容错', () => {
  it('gradeAndSave 往返：写后能读回，summary 同步更新', () => {
    const r1 = gradeAndSave('s1', 'card-1', 'good', T0, 1)
    expect(r1.state.level).toBe(0)
    expect(r1.summary.started).toBe(1)
    const db = readReview('s1')
    expect(db.cards['card-1'].level).toBe(0)
    expect(db.cards['card-1'].reps).toBe(1)
  })

  it('会话隔离：不同 sessionId 互不影响', () => {
    gradeAndSave('s1', 'c1', 'good', T0, 1)
    expect(Object.keys(readReview('s2').cards)).toEqual([])
    expect(Object.keys(readReview('s1').cards)).toEqual(['c1'])
  })

  it('损坏文件/脏字段 → 空档或跳过（不抛错，用户最多重新练）', () => {
    writeReview('bad', { cards: {}, updatedAt: 0 })
    expect(readReview('bad').cards).toEqual({})
    expect(readReview('nope-does-not-exist').cards).toEqual({})
  })

  it('pruneReview：丢掉已不存在卡片的档，保留有效的', () => {
    gradeAndSave('s1', 'keep', 'good', T0, 2)
    gradeAndSave('s1', 'drop', 'good', T0, 2)
    const dropped = pruneReview('s1', ['keep'])
    expect(dropped).toBe(1)
    expect(Object.keys(readReview('s1').cards)).toEqual(['keep'])
  })

  it('未注入根目录时读为空档、写为无副作用（不抛错）', () => {
    setReviewBase('')
    expect(readReview('s1').cards).toEqual({})
    expect(() => writeReview('s1', { cards: {}, updatedAt: 0 })).not.toThrow()
    expect(() => gradeAndSave('s1', 'c1', 'good', T0, 1)).not.toThrow()
  })
})
describe('★ 首次评分时目录还不存在', () => {
  // 病根：review-store 早期版本不建目录 → 用户第一次点「想起来了」时
  // userData/review/ 尚不存在，writeFileSync 抛 ENOENT，评分全打不出去。
  it('setReviewBase 指向不存在的子目录也能直接写入（自动 mkdir）', () => {
    const fresh = join(root, 'not-created-yet', 'deeper')
    setReviewBase(fresh)
    expect(() => gradeAndSave('sess-first', 'c1', 'good', T0, 1)).not.toThrow()
    expect(readReview('sess-first').cards['c1'].level).toBe(0)
  })

  it('pruneReview / writeReview 同样不依赖目录预存在', () => {
    const fresh = join(root, 'fresh-prune')
    setReviewBase(fresh)
    expect(() => writeReview('s', { cards: {}, updatedAt: 0 })).not.toThrow()
    expect(pruneReview('s', [])).toBe(0)
  })
})
