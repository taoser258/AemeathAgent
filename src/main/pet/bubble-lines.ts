// 气泡文案池（P9-T5）：纯数据 + 纯函数选择，单测保证每种事件都拿得到短句。
// 口径：模板池兜底——零成本、可控、永不失败（LLM 生成是以后可选的事）。
// 风格对齐 personas/aemeath/style.md：短句、别客服腔、不滥用波浪号。

import { dayPart, type BubbleKind } from './bubble-policy'

/** 各事件的候选文案；上线后可直接往这里加，无需动调度器 */
const LINES: Record<Exclude<BubbleKind, 'greeting'>, string[]> = {
  startup: ['我在。', '嗯，来了。', '今天也在。'],
  pet_tap: ['嗯？', '怎么了？', '我在。', '在听。'],
  pet_drag: ['哎——', '放这儿？', '好，就这儿。'],
  minimize: ['我在外面守着。', '窗口收起来了，我还在。', '嗯，随时叫我。'],
  idle: ['还在吗？', '需要搭把手就说一声。', '我在。', '（安静陪着）'],
  task_done: ['弄好了。', '成了，你看看。', '搞定。'],
  task_fail: ['这次没成。', '出了点状况。', '没弄好，要不再看看？'],
  reminder: ['有到期的复习，要不要过一遍？']
}

const GREETING_LINES: Record<'morning' | 'noon' | 'evening', string[]> = {
  morning: ['早。', '早啊。', '早上好，今天慢慢来。'],
  noon: ['中午了，记得吃饭。', '午安。'],
  evening: ['晚上好。', '忙了一天，歇会儿。', '晚上好，今天辛苦了。']
}

/**
 * 选一句。randomFn 默认 Math.random（生产），单测注入确定值。
 * greeting 按时段选；非问候时段回落 startup 池（防御，正常调度器不会在这时段触发）。
 */
export function pickBubbleLine(
  kind: BubbleKind,
  now: Date,
  randomFn: () => number = Math.random
): string {
  if (kind === 'greeting') {
    const part = dayPart(now)
    if (part !== null) return pickOne(GREETING_LINES[part], randomFn)
    return pickOne(LINES.startup, randomFn)
  }
  return pickOne(LINES[kind], randomFn)
}

function pickOne(pool: string[], randomFn: () => number): string {
  if (pool.length === 0) return '我在。'
  const idx = Math.min(pool.length - 1, Math.floor(randomFn() * pool.length))
  return pool[idx] ?? '我在。'
}
