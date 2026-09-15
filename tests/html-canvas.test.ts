// 预览画布注入测试：深色模式兜底 + 尊重作者已声明的配色。

import { describe, expect, it } from 'vitest'
import { injectLightCanvas } from '../src/renderer/chat/html-canvas'

describe('injectLightCanvas（深色模式预览兜底）', () => {
  it('未声明配色的文档：head 最前注入 light + 白底', () => {
    const src = '<!DOCTYPE html><html><head><title>t</title></head><body>hi</body></html>'
    const out = injectLightCanvas(src)
    expect(out).toContain('<head><style>:root{color-scheme:light;background:#fff}</style>')
    expect(out).toContain('<title>t</title>') // 原文不动
  })

  it('作者已声明 color-scheme（哪怕 dark）：原样返回不干预', () => {
    const dark = '<html><head><style>:root{color-scheme:dark}</style></head><body>x</body></html>'
    expect(injectLightCanvas(dark)).toBe(dark)
    const light = '<html><head><style>body{color-scheme: light }</style></head></html>'
    expect(injectLightCanvas(light)).toBe(light)
  })

  it('注入放最前：文档后写的 background 照常级联覆盖', () => {
    const src = '<html><head><style>body{background:#fdf2f6}</style></head></html>'
    const out = injectLightCanvas(src)
    const guardAt = out.indexOf('color-scheme:light')
    const ownAt = out.indexOf('#fdf2f6')
    expect(guardAt).toBeGreaterThan(-1)
    expect(ownAt).toBeGreaterThan(guardAt) // 自己的样式在后 → 生效
  })

  it('无 head 的片段：补一个 head 包住注入；裸片段直接前置', () => {
    const noHead = '<html lang="zh"><body>hi</body></html>'
    const out = injectLightCanvas(noHead)
    expect(out).toContain('<head><style>:root{color-scheme:light;background:#fff}</style></head>')
    expect(injectLightCanvas('<div>x</div>')).toMatch(/^<style>/)
  })
})
