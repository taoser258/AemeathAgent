/**
 * 浏览子窗 bounds 钳制单测：子窗永远不许脱出主窗。
 * 背景 bug：frameless 子窗默认可拖边缘 resize，用户拉左右缘把子窗拉出主窗；
 * 修复=resizable:false + 本纯函数兜住一切越界 rect（竞态/异常上报）。
 */
import { describe, expect, it } from 'vitest'
import { clampChildBounds } from '../src/main/browser/browser-ipc'

const P = { x: 100, y: 50, width: 1280, height: 720 }

describe('clampChildBounds', () => {
  it('正常 rect 原样换算（主窗原点 + 相对偏移）', () => {
    expect(clampChildBounds(P, { x: 900, y: 60, width: 350, height: 600 })).toEqual({
      x: 1000,
      y: 110,
      width: 350,
      height: 600
    })
  })

  it('rect 比主窗还宽 → 宽度钳到主窗宽且贴左缘', () => {
    const r = clampChildBounds(P, { x: 900, y: 0, width: 2000, height: 600 })
    expect(r.width).toBe(1280)
    expect(r.x).toBe(100) // 无空间可右移，贴主窗左
  })

  it('rect 右缘超出主窗 → 整体左移贴右缘（不裁位置只缩宽）', () => {
    const r = clampChildBounds(P, { x: 1100, y: 0, width: 400, height: 600 })
    expect(r.width).toBe(400)
    expect(r.x + r.width).toBe(100 + 1280) // 恰好贴主窗右缘
  })

  it('负偏移（rect 越左/上界）→ 钳回主窗原点', () => {
    const r = clampChildBounds(P, { x: -50, y: -30, width: 300, height: 400 })
    expect(r.x).toBe(100)
    expect(r.y).toBe(50)
  })

  it('rect 高度超主窗 → 高度钳制', () => {
    const r = clampChildBounds(P, { x: 0, y: 0, width: 300, height: 9999 })
    expect(r.height).toBe(720)
    expect(r.y).toBe(50)
  })
})
