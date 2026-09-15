// 审批 diff：write_file 审批卡片的"改前/改后"预览。
// 自研逐行 LCS unified diff；纯函数可单测。
// buildApprovalDetail 依赖 registry.resolveToolPath（同目录，无循环依赖），
// 全程防御：任何失败返回空对象——diff 生成失败绝不挡审批流程本身。

import { existsSync, readFileSync, statSync } from 'fs'
import { resolveToolPath } from './registry'

/** diff 输入单侧行数上限（超过直接放弃精细 diff，给简化提示） */
const MAX_DIFF_LINES = 2000
/** 新建文件预览的最大字符数 */
export const PREVIEW_MAX_CHARS = 2000

/**
 * 逐行 LCS 统一 diff：返回 hunk 文本（' '上下文 / '-'删除 / '+'新增），
 * 两文本完全相同返回 ''。contextLines = 变更块前后保留的上下文行数。
 */
export function unifiedDiff(oldText: string, newText: string, contextLines = 2): string {
  if (oldText === newText) return ''
  const a = oldText.split('\n')
  const b = newText.split('\n')
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return `（文件超过 ${MAX_DIFF_LINES} 行，diff 省略；请用 read_file 对比确认）`
  }
  if (a[a.length - 1] === '') a.pop()
  if (b[b.length - 1] === '') b.pop()

  // LCS 长度表（行滚动数组还原路径：记录方向）
  const n = a.length
  const m = b.length
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度；用 (n+1)*(m+1) 平铺数组
  const width = m + 1
  const dp = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }
  // 回溯出编辑脚本（顺序 op 序列）
  const ops: Array<{ op: ' ' | '-' | '+'; line: string; aIdx: number; bIdx: number }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: ' ', line: a[i], aIdx: i, bIdx: j })
      i += 1
      j += 1
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ op: '-', line: a[i], aIdx: i, bIdx: j })
      i += 1
    } else {
      ops.push({ op: '+', line: b[j], aIdx: i, bIdx: j })
      j += 1
    }
  }
  while (i < n) {
    ops.push({ op: '-', line: a[i], aIdx: i, bIdx: j })
    i += 1
  }
  while (j < m) {
    ops.push({ op: '+', line: b[j], aIdx: i, bIdx: j })
    j += 1
  }

  // 折叠长段未变更行为 hunk（保留 contextLines 上下文）
  const hunks: string[] = []
  let k = 0
  while (k < ops.length) {
    if (ops[k].op === ' ') {
      k += 1
      continue
    }
    // 变更块起点：向前扩 contextLines
    const start = Math.max(0, k - contextLines)
    // 向后找连续变更结束点（中间隔 ≤2*contextLines 的未变更行也算同一 hunk）
    let end = k
    let gap = 0
    for (let x = k; x < ops.length; x += 1) {
      if (ops[x].op === ' ') {
        gap += 1
        if (gap > contextLines * 2) break
      } else {
        gap = 0
        end = x
      }
    }
    const hunkEnd = Math.min(ops.length, end + 1 + contextLines)
    const aStart = ops[start].aIdx + 1
    const bStart = ops[start].bIdx + 1
    let aCount = 0
    let bCount = 0
    const body: string[] = []
    for (let x = start; x < hunkEnd; x += 1) {
      body.push(`${ops[x].op} ${ops[x].line}`)
      if (ops[x].op !== '+') aCount += 1
      if (ops[x].op !== '-') bCount += 1
    }
    hunks.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@\n${body.join('\n')}`)
    k = hunkEnd
  }
  return hunks.join('\n')
}

export interface ApprovalDetail {
  /** 统一 diff（改既有文件时；内容无变化则为空） */
  diff?: string
  /** 新建文件全文预览（≤PREVIEW_MAX_CHARS 截断） */
  preview?: string
}

/**
 * 构造审批载荷的增强详情：目前仅 write_file 有可视化 diff/预览，
 * 其他工具返回空对象（载荷保持旧结构，只增不改）。
 * 任何异常都吞掉返回 {}——详情生成失败不能挡审批。
 */
export function buildApprovalDetail(name: string, argsJson: string): ApprovalDetail {
  try {
    if (name !== 'write_file') return {}
    const args = JSON.parse(argsJson) as { path?: unknown; content?: unknown }
    if (typeof args.path !== 'string' || typeof args.content !== 'string') return {}
    const abs = resolveToolPath(args.path)
    if (existsSync(abs)) {
      const info = statSync(abs)
      if (!info.isFile()) return {}
      if (info.size > 2 * 1024 * 1024) return { diff: '（原文件超过 2MB，diff 省略；请谨慎确认）' }
      const diff = unifiedDiff(readFileSync(abs, 'utf8'), args.content)
      return diff === '' ? {} : { diff }
    }
    const trimmed =
      args.content.length > PREVIEW_MAX_CHARS
        ? `${args.content.slice(0, PREVIEW_MAX_CHARS)}\n…[预览已截断，共 ${args.content.length} 字符]`
        : args.content
    return { preview: trimmed }
  } catch {
    return {}
  }
}
