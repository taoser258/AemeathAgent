import { describe, expect, it } from 'vitest'
import { petWindowSize, resolvePetPosition } from '../src/main/windows/pet-position'

// 模拟双显示器：主屏 1920x1080（工作区高 1040 留任务栏）+ 右侧竖屏
const displays = [
  { x: 0, y: 0, width: 1920, height: 1040 },
  { x: 1920, y: 0, width: 1080, height: 1920 }
]
const size = { width: 260, height: 316 }
const fallback = { x: 1920 - 260 - 24, y: 1040 - 316 - 24 }

describe('windows/pet-position', () => {
  it('无记忆位置（首次运行）→ 主屏右下角并留边距', () => {
    expect(resolvePetPosition({ x: null, y: null }, size, displays)).toEqual(fallback)
  })

  it('记忆位置仍在显示器内 → 原样恢复', () => {
    expect(resolvePetPosition({ x: 500, y: 300 }, size, displays)).toEqual({ x: 500, y: 300 })
  })

  it('记忆位置落在第二块显示器内（多屏）→ 原样恢复', () => {
    expect(resolvePetPosition({ x: 2200, y: 800 }, size, displays)).toEqual({ x: 2200, y: 800 })
  })

  it('记忆位置完全脱离所有显示器（如拔掉外接屏）→ 回退右下角', () => {
    expect(resolvePetPosition({ x: 5000, y: 3000 }, size, displays)).toEqual(fallback)
  })

  it('记忆位置部分拖出屏幕边缘 → 仍恢复（保留用户拖放意图）', () => {
    const halfOff = { x: 1760, y: 660 }
    expect(resolvePetPosition(halfOff, size, displays)).toEqual(halfOff)
  })
})

describe('windows/petWindowSize', () => {
  it('默认 0.5x 返回最小档尺寸', () => {
    expect(petWindowSize(0.5)).toEqual({ width: 130, height: 158 })
  })

  it('1x 返回基础尺寸；1.5x 按倍率取整', () => {
    expect(petWindowSize(1)).toEqual({ width: 260, height: 316 })
    expect(petWindowSize(1.5)).toEqual({ width: 390, height: 474 })
  })

  it('倍率钳制在 0.5–1.5（越界值夹到上下限）', () => {
    expect(petWindowSize(0)).toEqual({ width: 130, height: 158 })
    expect(petWindowSize(7)).toEqual({ width: 390, height: 474 })
  })
})
