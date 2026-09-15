// 学习进度存储单测：计划设置 / 知识点掌握度 / 实测优先 / 剩余天数 / 容错。

import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  daysLeft,
  effectiveScore,
  PROGRESS_MAX_TOPICS,
  readProgress,
  setMeasured,
  setPlan,
  setProgressBase,
  upsertTopic,
  writeProgress
} from '../src/main/agent/tools/progress-store'

const DAY = 24 * 60 * 60 * 1000
const T0 = 1_700_000_000_000

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aemeath-progress-'))
  setProgressBase(root)
})

afterEach(() => {
  setProgressBase('')
})

describe('progress-store 学习计划', () => {
  it('设置目标与截止日（YYYY-MM-DD 字符串也收）', () => {
    const db = setPlan('s1', { goal: '两周学完线代前三章', deadline: '2026-10-01' })
    expect(db.plan.goal).toBe('两周学完线代前三章')
    expect(db.plan.deadline).toBe(Date.parse('2026-10-01'))
    expect(readProgress('s1').plan.goal).toBe('两周学完线代前三章')
  })

  it('只传 goal 不改 deadline（局部更新）', () => {
    setPlan('s1', { goal: 'A', deadline: '2026-10-01' })
    const after = setPlan('s1', { goal: 'B' })
    expect(after.plan.goal).toBe('B')
    expect(after.plan.deadline).toBe(Date.parse('2026-10-01'))
  })

  it('daysLeft：未设截止日 → null；剩 1.5 天向上取整为 2；已过期为负', () => {
    expect(daysLeft(0, T0)).toBeNull()
    expect(daysLeft(T0 + 1.5 * DAY, T0)).toBe(2)
    expect(daysLeft(T0 - 5 * DAY, T0)).toBe(-5)
  })
})

describe('progress-store 知识点掌握度', () => {
  it('同名覆盖、不同名追加；自评值夹到 0-100', () => {
    upsertTopic('s1', '泰勒展开', 40)
    upsertTopic('s1', '泰勒展开', 75)
    upsertTopic('s1', '洛必达', 120)
    const db = readProgress('s1')
    expect(db.topics).toHaveLength(2)
    expect(db.topics[0].selfScore).toBe(75)
    expect(db.topics[1].selfScore).toBe(100) // 夹到上限
  })

  it('★ 实测优先于自评：setMeasured 写入后 effectiveScore 用实测值', () => {
    upsertTopic('s1', '泰勒展开', 90) // 模型自评 90（乐观）
    setMeasured('s1', '泰勒展开', 35) // 复习实测 35（真实）
    const t = readProgress('s1').topics[0]
    expect(t.selfScore).toBe(90)
    expect(t.measuredScore).toBe(35)
    expect(effectiveScore(t)).toBe(35) // 展示以实测为准
  })

  it('setMeasured 对不存在的知识点不生效（不在进度里的点不凭空出现）', () => {
    setMeasured('s1', '没记过的点', 50)
    expect(readProgress('s1').topics).toHaveLength(0)
  })

  it('upsertTopic 重复调用不覆盖既有实测值', () => {
    upsertTopic('s1', 'X', 50)
    setMeasured('s1', 'X', 30)
    upsertTopic('s1', 'X', 80) // 模型又自评一次
    const t = readProgress('s1').topics[0]
    expect(t.selfScore).toBe(80)
    expect(t.measuredScore).toBe(30) // 实测留着
  })

  it('知识点超过上限丢最早的（防单会话无限增长）', () => {
    for (let i = 0; i < PROGRESS_MAX_TOPICS + 5; i += 1) upsertTopic('s1', `点${i}`, 10)
    const db = readProgress('s1')
    expect(db.topics).toHaveLength(PROGRESS_MAX_TOPICS)
    expect(db.topics[0].topic).toBe('点5') // 前 5 个被丢掉
  })
})

describe('progress-store 容错', () => {
  it('未注入/无档/损坏 → 空档，不抛错', () => {
    expect(readProgress('nope').topics).toEqual([])
    expect(readProgress('nope').plan.goal).toBe('')
    writeProgress('bad', {
      plan: { goal: 'x', deadline: 0, notes: '' },
      topics: [
        { topic: '', selfScore: 10, measuredScore: null, updatedAt: 0 }, // 空名跳过
        { topic: '好点', selfScore: 60, measuredScore: null, updatedAt: 0 }
      ],
      updatedAt: 0
    })
    const db = readProgress('bad')
    expect(db.topics).toHaveLength(1)
    expect(db.topics[0].topic).toBe('好点')
    setProgressBase('')
    expect(readProgress('bad').topics).toEqual([])
  })
})
describe('★ 首次写进度时目录还不存在（同 review-store 的回归）', () => {
  it('setPlan / upsertTopic 在不存在的目录下自动建目录', () => {
    const fresh = join(root, 'no-such-dir', 'nested')
    setProgressBase(fresh)
    expect(() => setPlan('s', { goal: '两周内学完线代' })).not.toThrow()
    expect(readProgress('s').plan.goal).toBe('两周内学完线代')
    expect(() => upsertTopic('s', '泰勒展开', 40)).not.toThrow()
    expect(readProgress('s').topics).toHaveLength(1)
  })
})
