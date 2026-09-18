// 全屏检测纯函数单测（P9-T5）：矩形铺屏判定与矩形解析。
// PowerShell 探针本身不进单测（窗口/进程行为，靠实测），失败 fail-open 已在实现处保证。

import { describe, expect, it } from 'vitest'
import { parseRect, rectCoversDisplay, type SimpleDisplay } from '../src/main/pet/fullscreen'

const displays: SimpleDisplay[] = [
  { x: 0, y: 0, width: 1920, height: 1080 },
  { x: 1920, y: 0, width: 1080, height: 1920 }
]

describe('rectCoversDisplay', () => {
  it('精确铺满主屏（独占全屏）→ true', () => {
    expect(rectCoversDisplay({ left: 0, top: 0, right: 1920, bottom: 1080 }, displays)).toBe(true)
  })

  it('1px 取整误差仍判全屏（容差）', () => {
    expect(rectCoversDisplay({ left: 1, top: 1, right: 1919, bottom: 1079 }, displays)).toBe(true)
  })

  it('最大化窗口（任务栏留 40px）→ false，不会误判', () => {
    expect(rectCoversDisplay({ left: 0, top: 0, right: 1920, bottom: 1040 }, displays)).toBe(false)
  })

  it('铺满第二屏（多屏）→ true', () => {
    expect(rectCoversDisplay({ left: 1920, top: 0, right: 3000, bottom: 1920 }, displays)).toBe(
      true
    )
  })

  it('小窗口 → false', () => {
    expect(rectCoversDisplay({ left: 100, top: 100, right: 900, bottom: 700 }, displays)).toBe(
      false
    )
  })
})

describe('parseRect', () => {
  it('合法 "l,t,r,b" → 矩形（含负数）', () => {
    expect(parseRect('0,0,1920,1080')).toEqual({ left: 0, top: 0, right: 1920, bottom: 1080 })
    expect(parseRect('-8,-8,1920,1080')).toEqual({ left: -8, top: -8, right: 1920, bottom: 1080 })
  })

  it('非法格式 → null', () => {
    expect(parseRect('abc')).toBeNull()
    expect(parseRect('1,2,3')).toBeNull()
    expect(parseRect('')).toBeNull()
  })
})
