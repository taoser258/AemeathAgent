// 主题 token 完整性守护：深色组必须覆盖浅色组的全部颜色类变量，
// 且不得混入圆角/排版（那些不是主题属性）。直接解析 global.css 文本，纯逻辑可测。
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync('src/renderer/styles/global.css', 'utf-8')

/** 提取某个选择器块内定义的全部 CSS 变量名 */
function varsOf(block: string): Set<string> {
  return new Set([...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
}

const rootBlock = CSS.slice(CSS.indexOf(':root {'), CSS.indexOf("\n:root[data-theme='dark']"))
const darkBlock = CSS.slice(CSS.indexOf("\n:root[data-theme='dark']"))

describe('主题 token 完整性', () => {
  it('深色组已定义', () => {
    expect(darkBlock).toContain("data-theme='dark'")
  })

  it('★ 深色组覆盖浅色组全部颜色类变量（防"深色缺变量"回归）', () => {
    const light = varsOf(rootBlock)
    const dark = varsOf(darkBlock)
    // 圆角/排版不是主题属性（守护测试另一半保证 dark 不含它们），比对时从浅色组剔除
    const colorVars = [...light].filter(
      (v) => !v.startsWith('--radius') && !v.startsWith('--font') && v !== '--ls-base'
    )
    const missing = colorVars.filter((v) => !dark.has(v))
    expect(missing).toEqual([])
    expect(colorVars.length).toBeGreaterThan(30)
  })

  it('★ 深色组不得混入圆角/排版 token（主题只管颜色）', () => {
    const dark = varsOf(darkBlock)
    const offenders = [...dark].filter(
      (v) => v.startsWith('--radius') || v.startsWith('--font') || v === '--ls-base'
    )
    expect(offenders).toEqual([])
  })

  it('两个主题的 data-theme 切换挂点存在（渲染层按 data-theme 生效）', () => {
    expect(CSS).toContain(':root {')
    expect(CSS).toContain(":root[data-theme='dark'] {")
  })
})
