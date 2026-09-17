// 最大化目标框单测（main/windows/maximize-bounds.ts）。
//
// 守护 owner 实测问题：任务栏「自动隐藏」时 workArea == 显示器全幅，窗口铺满后
// 被 Windows shell 当成全屏应用、抑制任务栏贴底弹出。底部留 1px 打破该判定。

import { describe, expect, it } from 'vitest'
import { MAXIMIZE_BOTTOM_GAP, maximizedBounds } from '../src/main/windows/maximize-bounds'

const DISPLAY = { x: 0, y: 0, width: 1920, height: 1080 }

describe('maximizedBounds · 最大化目标框', () => {
  it('★ 任务栏自动隐藏（workArea == 显示器全幅）→ 底部留 1px，不再完全覆盖屏幕', () => {
    const r = maximizedBounds({
      bounds: DISPLAY,
      workArea: { ...DISPLAY } // 自动隐藏：任务栏不占位
    })
    expect(r).toEqual({ x: 0, y: 0, width: 1920, height: 1080 - MAXIMIZE_BOTTOM_GAP })
    expect(r.height).toBeLessThan(DISPLAY.height) // 关键：不等于显示器高度
  })

  it('任务栏常显（workArea 已扣任务栏）→ 原样使用，不额外留缝', () => {
    const r = maximizedBounds({
      bounds: DISPLAY,
      workArea: { x: 0, y: 0, width: 1920, height: 1080 - 48 }
    })
    expect(r).toEqual({ x: 0, y: 0, width: 1920, height: 1080 - 48 })
  })

  it('副屏（有偏移）与任务栏在顶部：沿用 workArea 的 x/y', () => {
    const r = maximizedBounds({
      bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
      workArea: { x: 1920, y: 40, width: 1920, height: 1040 }
    })
    expect(r).toEqual({ x: 1920, y: 40, width: 1920, height: 1040 })
  })

  it('异常输入不返回非法尺寸（高度至少 1px）', () => {
    const r = maximizedBounds({
      bounds: { x: 0, y: 0, width: 100, height: 1 },
      workArea: { x: 0, y: 0, width: 100, height: 1 }
    })
    expect(r.height).toBeGreaterThanOrEqual(1)
  })
})
