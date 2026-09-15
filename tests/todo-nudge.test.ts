// 清单催办判定单测（chat/todo-nudge.ts）。
//
// ★ 这个文件的存在本身就是一次教训：上一版判定写在 run.ts 闭包里、没有测试覆盖，
// 结果"进展"口径漏了学习模式的产出（笔记/闪卡/进度），催办一次都没触发，
// 又白让 复测了一轮（现场：学习模式任务收尾 2/5，而 8 张闪卡与学习进度都写好了）。

import { describe, expect, it } from 'vitest'
import { TODO_PROGRESS_TOOLS, TodoNudges } from '../src/main/chat/todo-nudge'
import type { TodoState } from '../src/main/agent/tools/todo-store'

const list = (...statuses: Array<'pending' | 'done'>): TodoState => ({
  items: statuses.map((s, i) => ({ id: `t${i}`, text: `步骤${i + 1}`, status: s })),
  updatedAt: 0
})

describe('清单催办 · 进展口径', () => {
  it('★ 回归：学习模式的产出（笔记 / 闪卡 / 学习进度）也算"推进了任务"', () => {
    const n = new TodoNudges(() => list('pending', 'pending'))
    n.noteToolResult('note_write', true) // 写闪卡
    expect(n.stepReminder()).not.toBeNull() // 从前这里恒为 null（名单漏了它）
    n.noteToolResult('todo_write', true) // 同步 → 干净
    expect(n.stepReminder()).toBeNull()
    n.noteToolResult('study_progress_write', true) // 更新学习进度
    expect(n.stepReminder()).not.toBeNull()
  })

  it('只读 / 研究类不算进展：不打扰（省下一轮上下文）', () => {
    const readOnly = [
      'web_search',
      'fetch_url',
      'read_file',
      'list_dir',
      'search_files',
      'search_content',
      'note_read',
      'study_progress_read',
      'memory_search',
      'run_shell', // 多为只读诊断（dir/where）
      'undo_last_change' // 回滚是纠错，不是推进
    ]
    for (const name of readOnly) {
      const n = new TodoNudges(() => list('pending'))
      n.noteToolResult(name, true)
      expect(n.stepReminder(), name).toBeNull()
      expect(n.finishReminder(), name).toBeNull()
    }
  })

  it('工具执行失败（ok=false）不算进展', () => {
    const n = new TodoNudges(() => list('pending'))
    n.noteToolResult('write_file', false)
    expect(n.stepReminder()).toBeNull()
  })

  it('名单守护：学习模式的写入工具在内，只读/研究类不在', () => {
    expect(TODO_PROGRESS_TOOLS.has('note_write')).toBe(true)
    expect(TODO_PROGRESS_TOOLS.has('study_progress_write')).toBe(true)
    for (const name of ['run_shell', 'web_search', 'fetch_url', 'read_file', 'undo_last_change']) {
      expect(TODO_PROGRESS_TOOLS.has(name), name).toBe(false)
    }
  })
})

describe('清单催办 · 何时不该出声', () => {
  it('没有清单 / 空清单 → 不催', () => {
    const none = new TodoNudges(() => null)
    none.noteToolResult('write_file', true)
    expect(none.stepReminder()).toBeNull()
    expect(none.finishReminder()).toBeNull()

    const empty = new TodoNudges(() => list())
    empty.noteToolResult('write_file', true)
    expect(empty.stepReminder()).toBeNull()
    expect(empty.finishReminder()).toBeNull()
  })

  it('全部完成 → 两个催办都不出声', () => {
    const n = new TodoNudges(() => list('done', 'done'))
    n.noteToolResult('write_file', true)
    expect(n.stepReminder()).toBeNull()
    expect(n.finishReminder()).toBeNull()
  })

  it('本轮没推进过任务（纯聊天 / 只读）→ 收尾也不催', () => {
    const n = new TodoNudges(() => list('pending', 'pending'))
    n.noteToolResult('web_search', true)
    expect(n.finishReminder()).toBeNull()
  })
})

describe('清单催办 · 步末与收尾的判据不同', () => {
  it('★ 同步过也照样要收尾提醒：只要本轮推进过、且还有未勾项', () => {
    // 那次现场：她同步完 ①–④（④ 之后没再动过文件）就写了最终答复，
    // 而 ⑤「输出完成清单」的产物正是那份答复 → 只看"陈旧"会漏掉它。
    const n = new TodoNudges(() => list('done', 'done', 'done', 'done', 'pending'))
    n.noteToolResult('write_file', true) // 本轮推进过任务
    n.noteToolResult('todo_write', true) // 之后又同步过（步末判据已清）
    expect(n.stepReminder()).toBeNull() // 步末不再骚扰
    expect(n.finishReminder()).not.toBeNull() // 收尾仍然对一次账
  })

  it('收尾文案带上未勾项，方便她对照；并明确允许"没做就保持 pending 说明原因"', () => {
    const n = new TodoNudges(() => list('pending', 'done'))
    n.noteToolResult('note_write', true)
    const text = n.finishReminder() ?? ''
    expect(text).toContain('步骤1')
    expect(text).toContain('保持 pending')
  })
})
