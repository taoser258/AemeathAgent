// 气泡文案池单测（P9-T5）：每种事件任何时候都必须拿到非空短句；
// 注入确定的 randomFn 保证边界（首/尾选择）可验。

import { describe, expect, it } from 'vitest'
import { pickBubbleLine } from '../src/main/pet/bubble-lines'
import type { BubbleKind } from '../src/main/pet/bubble-policy'

const ALL_KINDS: BubbleKind[] = [
  'startup',
  'greeting',
  'pet_tap',
  'pet_drag',
  'minimize',
  'idle',
  'task_done',
  'task_fail',
  'reminder'
]

describe('pickBubbleLine', () => {
  it('每种事件都返回非空短句（注入 random=0/0.99 取首/尾）', () => {
    for (const kind of ALL_KINDS) {
      const now = new Date(2026, 8, 18, 10, 0)
      const first = pickBubbleLine(kind, now, () => 0)
      const last = pickBubbleLine(kind, now, () => 0.999)
      expect(first.length).toBeGreaterThan(0)
      expect(last.length).toBeGreaterThan(0)
    }
  })

  it('greeting 按时段给对应文案', () => {
    const morning = pickBubbleLine('greeting', new Date(2026, 8, 18, 8, 0), () => 0)
    const noon = pickBubbleLine('greeting', new Date(2026, 8, 18, 12, 0), () => 0)
    const evening = pickBubbleLine('greeting', new Date(2026, 8, 18, 19, 0), () => 0)
    expect(morning).toContain('早')
    expect(noon).toMatch(/饭|午/)
    expect(evening).toContain('晚')
  })

  it('非问候时段触发 greeting（防御）→ 回落而非崩', () => {
    const line = pickBubbleLine('greeting', new Date(2026, 8, 18, 15, 0), () => 0)
    expect(line.length).toBeGreaterThan(0)
  })
})
