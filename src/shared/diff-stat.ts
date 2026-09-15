// 变更行数统计（同款口径）。
//
// 两个入口：
// 1. countLineDiff(old, new)：主进程在 write_file/edit_file 执行时用（旧内容在手），
// 结果经 ToolContext.out 带出到 tool_call_result 事件。
// 2. diffFromToolArgs(name, argsJson)：历史会话重建用（旧内容已不可得）——
// edit_file 从 edits 参数精确累加；write_file 只报新增行数（旧行数无从得知，诚实省略）。
//
// 行集合差算法（非序列 diff）：同名行互抵，剩下的就是增/删。对「改了几行」的展示
// 足够准确，且 O(n) 无 LCS 开销；纯重排（行集合不变）报 +0 -0 属可接受近似。

export interface DiffStat {
  added: number
  removed: number
}

/** 按行计数（忽略末尾因换行符产生的空尾行） */
function countLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** 旧行多重集合作差：新增 = 新内容里多出来的行；删除 = 旧内容里消失的行 */
export function countLineDiff(oldText: string | null, newText: string): DiffStat {
  const newLines = countLines(newText)
  if (oldText === null) return { added: newLines.length, removed: 0 }
  const oldLines = countLines(oldText)
  const pool = new Map<string, number>()
  for (const l of oldLines) pool.set(l, (pool.get(l) ?? 0) + 1)
  let added = 0
  for (const l of newLines) {
    const left = pool.get(l) ?? 0
    if (left > 0) {
      pool.set(l, left - 1)
    } else {
      added += 1
    }
  }
  let removed = 0
  for (const n of pool.values()) removed += n
  return { added, removed }
}

/** 历史重建用：从工具参数估算 diff（write_file 无旧内容 → removed 省略为 0） */
export function diffFromToolArgs(toolName: string, argsJson: string): DiffStat | null {
  let args: unknown
  try {
    args = JSON.parse(argsJson)
  } catch {
    return null
  }
  if (typeof args !== 'object' || args === null) return null
  const r = args as Record<string, unknown>
  if (toolName === 'write_file' && typeof r.content === 'string') {
    return { added: countLines(r.content).length, removed: 0 }
  }
  if (toolName === 'edit_file' && Array.isArray(r.edits)) {
    let added = 0
    let removed = 0
    for (const e of r.edits) {
      if (typeof e !== 'object' || e === null) continue
      const o = (e as Record<string, unknown>).old_string
      const n = (e as Record<string, unknown>).new_string
      if (typeof o === 'string') removed += countLines(o).length
      if (typeof n === 'string') added += countLines(n).length
    }
    return { added, removed }
  }
  return null
}
