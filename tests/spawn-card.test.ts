// 子任务分身卡纯 helper 单测。spawnCard.ts 无 React 依赖，直接测展示逻辑。

import { describe, expect, it } from 'vitest'
import type { SubAgentView } from '../src/renderer/chat/store'
import {
  spawnBadge,
  spawnHistStatusFromResult,
  spawnObjectiveFromArgs,
  spawnProgressText,
  spawnStatsText
} from '../src/renderer/chat/spawnCard'

const sub = (over: Partial<SubAgentView> = {}): SubAgentView => ({
  agentId: 'ag-1',
  objective: '统计文件',
  status: 'running',
  ...over
})

describe('spawnObjectiveFromArgs（args 预览兜底解析）', () => {
  it('合法 JSON 提取 objective；空串/null 返回 null', () => {
    expect(spawnObjectiveFromArgs('{"objective":"整理目录"}')).toBe('整理目录')
    expect(spawnObjectiveFromArgs('{"objective":"  "}')).toBeNull()
    expect(spawnObjectiveFromArgs('{}')).toBeNull()
  })

  it('截断的 JSON（argsPreview 120 字符限制）解析失败返回 null 而非抛异常', () => {
    expect(spawnObjectiveFromArgs('{"objective":"很长的目标被截'))
    expect(spawnObjectiveFromArgs('{"objective":"很长的目标被截')).toBeNull()
  })
})

describe('spawnBadge（分身状态优先，无分身视图按通用执行态推导）', () => {
  it('分身五态映射', () => {
    expect(spawnBadge(sub({ status: 'running' }), undefined)).toEqual({
      label: '运行中',
      tone: 'run'
    })
    expect(spawnBadge(sub({ status: 'completed' }), true)).toEqual({ label: '已完成', tone: 'ok' })
    expect(spawnBadge(sub({ status: 'failed' }), false)).toEqual({ label: '失败', tone: 'bad' })
    expect(spawnBadge(sub({ status: 'aborted' }), false)).toEqual({ label: '已中止', tone: 'bad' })
    expect(spawnBadge(sub({ status: 'budget-exhausted' }), false)).toEqual({
      label: '步数用尽',
      tone: 'bad'
    })
  })

  it('无分身视图：进行中 → run；按 ok/status 推导终态（历史恢复路径）', () => {
    expect(spawnBadge(undefined, undefined)).toEqual({ label: '运行中', tone: 'run' })
    expect(spawnBadge(undefined, true)).toEqual({ label: '已完成', tone: 'ok' })
    expect(spawnBadge(undefined, false, 'denied')).toEqual({ label: '已拒绝', tone: 'bad' })
    expect(spawnBadge(undefined, false, 'timeout')).toEqual({ label: '已超时', tone: 'bad' })
    expect(spawnBadge(undefined, false)).toEqual({ label: '失败', tone: 'bad' })
  })
})

describe('进度与统计文案', () => {
  it('运行中：轮/步/最近工具齐全与缺省两种形状', () => {
    expect(spawnProgressText(sub({ round: 2, step: 5, lastTool: 'read_file' }))).toBe(
      '第 2 轮 · 已执行 5 步 · 最近：read_file'
    )
    expect(spawnProgressText(sub({}))).toBe('分身启动中…')
  })

  it('终态统计：轮/步/耗时；ms 缺省不产 undefined', () => {
    expect(spawnStatsText(sub({ status: 'completed', rounds: 3, steps: 7, ms: 4700 }))).toBe(
      '3 轮 / 7 步 / 4.7s'
    )
    expect(spawnStatsText(sub({ status: 'completed' }))).toBe('')
  })
})

describe('spawnHistStatusFromResult（历史恢复：从持久化结果文本反推状态）', () => {
  it('四种格式化首行都能反推；未执行占位与无匹配返回 null', () => {
    expect(spawnHistStatusFromResult('[分身完成] 状态: completed\n报告: x')).toBe('completed')
    expect(spawnHistStatusFromResult('[分身失败] 状态: failed\n报告: y')).toBe('failed')
    expect(spawnHistStatusFromResult('[分身已中止] 状态: aborted')).toBe('aborted')
    expect(spawnHistStatusFromResult('[分身步数用尽] 状态: budget-exhausted')).toBe(
      'budget-exhausted'
    )
    expect(spawnHistStatusFromResult('（未执行）')).toBeNull()
    expect(spawnHistStatusFromResult('普通工具结果，不是分身')).toBeNull()
    expect(spawnHistStatusFromResult(undefined)).toBeNull()
  })

  it('反推状态喂给徽标：历史卡片不再永远「运行中」', () => {
    const hist = spawnHistStatusFromResult('[分身完成] 状态: completed\n报告: x')
    expect(spawnBadge(undefined, hist === 'completed', hist ?? undefined)).toEqual({
      label: '已完成',
      tone: 'ok'
    })
    const hist2 = spawnHistStatusFromResult('[分身已中止] 状态: aborted')
    expect(spawnBadge(undefined, false, hist2 ?? undefined)).toEqual({
      label: '已中止',
      tone: 'bad'
    })
  })
})

it('截断的 argsPreview 用正则捞 objective（历史卡标题不再「未记录」）', () => {
  // 模拟真实链路：完整 argsJson 经 JSON.stringify，再被 argsPreview 的 120 字符截断切在字符串中间
  const full = JSON.stringify({
    objective: '列出目录「E:/Aemeath工作区」下的全部文件与子目录，并汇报一份完整清单。',
    context: '背景说明'
  })
  const truncated = full.slice(0, 60)
  const obj = spawnObjectiveFromArgs(truncated)
  expect(obj?.startsWith('列出目录「E:/Aemeath工作区」')).toBe(true)
  expect(obj?.endsWith('完整清单。')).toBe(true)
})
