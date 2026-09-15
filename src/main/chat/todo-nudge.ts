// 任务清单催办：提示词层的约束对模型无效，改在 harness 层催。
//
// ── 为什么要有这个模块 ─────────────────────────────────────────────────────
// 会话档案铁证：她整轮只交 2 次 todo_write（攒 4 步一起交），收尾还漏掉最后一项——
// 而系统提示与工具描述里"每完成一步立刻重提交""收尾前必须再提交一次"写了两遍也没用。
// 所以：**行为类要求不能只写提示词，要进 harness**。
//
// ── 抽成独立模块的原因（第二次教训） ────────────────────────────────────────
// 上一版把判定写在 run.ts 的闭包里，只有类型检查保底、**没有任何测试覆盖**；
// 结果"进展"口径漏了学习模式的产出（笔记/闪卡/进度），催办一次都没触发，
// 白让 又复测了一轮。判定逻辑必须可单测——这里就是那层。
//
// 本模块无 electron / 无 IO：清单从注入的 read() 取，纯逻辑可测。

import type { TodoState } from '../agent/tools/todo-store'

/**
 * 判定"这一步推进了任务"的工具——**按模式各有一套产出落点**：
 * - 工作模式：产出是文件 → write_file / edit_file / mkdir / run_js / export_pdf …
 * - 学习模式：产出是笔记、闪卡、学习进度 → note_write / study_progress_write
 * （漏了这一组，学习模式里"推进过任务"恒为 false，两个催办全部失效。）
 *
 * 刻意排除三类噪音：
 * - `undo_last_change`：回滚是纠错，不是推进；
 * - `run_shell`：多数是只读诊断（`dir`/`where`），一次只读就催会白烧一整轮上下文；
 * - 搜索/读取类（web_search / fetch_url / read_file / search_files…）：研究阶段是"读"，
 * 每查一次催一遍清单，代价是每轮重发整段对话，不值得。
 */
export const TODO_PROGRESS_TOOLS: ReadonlySet<string> = new Set([
  // 工作模式
  'write_file',
  'edit_file',
  'mkdir',
  'run_js',
  'export_pdf',
  'note_export',
  'download_file',
  // 学习模式
  'note_write',
  'study_progress_write'
])

/** 步末催办文案：她这一步推进了任务，但清单没跟着动 */
const STEP_REMINDER =
  '（系统提示：你这一步推进了任务，但任务清单还停在更新前的状态。' +
  '请立即用 todo_write 提交一次完整清单——把已完成的项改成 done，' +
  '然后继续下一步。清单在界面上实时显示给用户，用户正看着它判断你做到哪了。）'

/**
 * 收尾催办文案：清单还有未勾项却要收尾。
 * 明确允许"确实没做的保持 pending 并说明原因"，免得她为了过关乱打勾。
 */
function finishReminderText(pending: readonly { text: string }[]): string {
  return (
    '（系统提示：任务清单和你的实际进度可能对不上——还有项挂着未完成。' +
    '请在给出最终回复之前先调用一次 todo_write 提交完整清单：做完的标 done；' +
    '确实没做、或改由别的方式完成的，保持 pending 并在回复里说明原因。' +
    `当前未打勾的项：${pending.map((i) => i.text).join('；')}）`
  )
}

/**
 * 清单催办状态机（每个 run 一个实例）。
 *
 * 两个开关的含义要分清（上一版混淆过，导致收尾漏判）：
 * - `dirty` ：**上一次 todo_write 之后又推进了任务** → 步末催她同步；
 * - `touched`：**本轮 run 推进过任务**（不要求"之后没同步"）→ 收尾时只要还有未勾项就催。
 * 那次现场就是：同步完 ①–④ 之后再没动过文件、直接写最终答复，
 * 光看 `dirty` 是 false，会漏掉它。
 */
export class TodoNudges {
  private dirty = false
  private touched = false

  constructor(private readonly read: () => TodoState | null) {}

  /** 工具执行完喂进来（与 run.ts 的 onToolResult 同序，串行保证） */
  noteToolResult(name: string, ok: boolean): void {
    if (!ok) return
    if (name === 'todo_write') {
      this.dirty = false // 清单刚同步过
      return
    }
    if (TODO_PROGRESS_TOOLS.has(name)) {
      this.dirty = true
      this.touched = true
    }
  }

  /** 步末：这一步推进了任务、清单却没同步 → 催她先更新 */
  stepReminder(): string | null {
    if (!this.dirty) return null
    const todo = this.read()
    if (todo === null || todo.items.length === 0) return null
    if (todo.items.every((i) => i.status === 'done')) return null
    return STEP_REMINDER
  }

  /**
   * 收尾前：本轮推进过任务、但清单还有未勾项 → 先不结束，催她对一次账。
   * 用 `touched` 而非 `dirty`：她要收尾时清单本就该反映全部进度，
   * 有没有"之后又动过"不重要（见类注释里 那次现场）。
   */
  finishReminder(): string | null {
    if (!this.touched) return null
    const todo = this.read()
    if (todo === null || todo.items.length === 0) return null
    const pending = todo.items.filter((i) => i.status === 'pending')
    if (pending.length === 0) return null
    return finishReminderText(pending)
  }
}
