// 更新角标口径测试（纯逻辑）：只测「什么状态该不该挂角标、提示什么」，
// 不管 DOM——角标是否真的渲染出来由 CDP 探针实测（见 AGENTS.md 测试约定）。

import { describe, expect, it } from 'vitest'
import { updateBadge } from '../src/shared/update-badge'

describe('shared/update-badge', () => {
  it('发现新版本：挂角标 + 提示带版本号', () => {
    const badge = updateBadge({ state: 'available', version: '0.4.0' })
    expect(badge.show).toBe(true)
    expect(badge.ready).toBe(false)
    expect(badge.hint).toContain('v0.4.0')
  })

  it('已下载待安装：挂角标但停脉动（ready）', () => {
    const badge = updateBadge({ state: 'downloaded', version: '0.4.0' })
    expect(badge.show).toBe(true)
    expect(badge.ready).toBe(true)
    expect(badge.hint).toContain('重启')
  })

  it('★ 无版本号的状态一律不打扰（idle/checking/not-available/error 都不提示）', () => {
    for (const state of ['idle', 'checking', 'not-available', 'error'] as const) {
      expect(updateBadge({ state }).show, `${state} 不该挂角标`).toBe(false)
    }
  })

  it('★ 记着版本号但状态是 downloading：也不挂角标（进度在关于页看即可）', () => {
    const badge = updateBadge({ state: 'downloading', version: '0.4.0', percent: 42 })
    expect(badge.show).toBe(false)
    expect(badge.hint).toBeNull()
  })

  it('不挂角标时不残留提示文案（避免 hover 到过期信息）', () => {
    expect(updateBadge({ state: 'idle', version: '0.4.0' }).hint).toBeNull()
  })
})
