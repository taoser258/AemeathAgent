// 子任务分身卡的纯 helper：无 React 依赖，可被 vitest 直接单测。
// 视图状态类型在 store.ts（SubAgentView / ToolRunView）——这里只做展示逻辑。

import type { SubAgentView } from './store'

export type SpawnBadgeTone = 'run' | 'ok' | 'bad'

export interface SpawnBadge {
  label: string
  tone: SpawnBadgeTone
}

/** 从工具卡的参数预览里解析 objective（兜底用：正常路径走 agent_started 的完整 objective）。
 * 两级容错：完整 JSON 直接解析；argsPreview 有 120 字符截断而 objective 排最前，
 * 截断态用正则直接捞键值——捞不到才返回 null（调用方回退占位文案）。 */
export function spawnObjectiveFromArgs(argsPreview: string): string | null {
  try {
    const a = JSON.parse(argsPreview) as { objective?: unknown }
    if (typeof a.objective === 'string' && a.objective.trim() !== '') return a.objective
    return null
  } catch {
    const m = argsPreview.match(/"objective"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    if (m !== null && m[1] !== undefined && m[1].trim() !== '') {
      // 捕获值仍带 JSON 转义（\\、\"、\n）——标题展示前做基础还原
      return m[1].replace(/\\(.)/g, (_all, c: string) => (c === 'n' ? '\n' : c))
    }
    return null
  }
}

/** 状态徽标：分身状态优先；无分身视图时按通用工具执行态推导（历史恢复/事件缺失）。 */
export function spawnBadge(
  sub: SubAgentView | undefined,
  ok: boolean | undefined,
  status?: string
): SpawnBadge {
  if (sub !== undefined) {
    switch (sub.status) {
      case 'running':
        return { label: '运行中', tone: 'run' }
      case 'completed':
        return { label: '已完成', tone: 'ok' }
      case 'aborted':
        return { label: '已中止', tone: 'bad' }
      case 'budget-exhausted':
        return { label: '步数用尽', tone: 'bad' }
      default:
        return { label: '失败', tone: 'bad' }
    }
  }
  if (ok === undefined) return { label: '运行中', tone: 'run' }
  if (ok) return { label: '已完成', tone: 'ok' }
  switch (status) {
    case 'denied':
      return { label: '已拒绝', tone: 'bad' }
    case 'timeout':
      return { label: '已超时', tone: 'bad' }
    case 'aborted':
      return { label: '已中止', tone: 'bad' }
    case 'budget-exhausted':
      return { label: '步数用尽', tone: 'bad' }
    default:
      return { label: '失败', tone: 'bad' }
  }
}

/** 从持久化的工具结果文本反推分身状态（历史恢复路径：sub 缺失、ok 也缺省）。
 * 结果首行是 formatSubAgentResult 的固定格式「[分身完成] 状态: …」。 */
export function spawnHistStatusFromResult(resultPreview: string | undefined): string | null {
  if (resultPreview === undefined || resultPreview === '（未执行）') return null
  if (resultPreview.includes('[分身完成]')) return 'completed'
  if (resultPreview.includes('[分身已中止]')) return 'aborted'
  if (resultPreview.includes('[分身步数用尽]')) return 'budget-exhausted'
  if (resultPreview.includes('[分身失败]')) return 'failed'
  return null
}

/** 运行中进度行：轮数 / 步数 / 最近工具。 */
export function spawnProgressText(sub: SubAgentView): string {
  const parts: string[] = []
  if (sub.round !== undefined) parts.push(`第 ${sub.round} 轮`)
  if (sub.step !== undefined) parts.push(`已执行 ${sub.step} 步`)
  if (sub.lastTool !== undefined && sub.lastTool !== '') parts.push(`最近：${sub.lastTool}`)
  return parts.length > 0 ? parts.join(' · ') : '分身启动中…'
}

/** 终态统计行。 */
export function spawnStatsText(sub: SubAgentView): string {
  const sec = sub.ms !== undefined ? `${(sub.ms / 1000).toFixed(1)}s` : null
  const parts: string[] = []
  if (sub.rounds !== undefined) parts.push(`${sub.rounds} 轮`)
  if (sub.steps !== undefined) parts.push(`${sub.steps} 步`)
  if (sec !== null) parts.push(sec)
  return parts.join(' / ')
}
