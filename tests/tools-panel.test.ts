// 工具面板清单守护：
// ToolsPanel 的展示清单是硬编码的（要配中文说明），历史上漏过新工具。
// 本测试把 registry 的 TOOLS 表与面板清单做双向 diff——新增工具没进面板即挂。

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

describe('ToolsPanel 清单与 registry 同步（漂移守护）', () => {
  const registrySrc = readFileSync(
    join(__dirname, '..', 'src/main/agent/tools/registry.ts'),
    'utf8'
  )
  const panelSrc = readFileSync(join(__dirname, '..', 'src/renderer/chat/ToolsPanel.tsx'), 'utf8')

  // registry 里工具定义形状固定为两空格缩进的 ` name: 'xxx',`
  const toolNames = [...registrySrc.matchAll(/^ {2}name: '([a-z_]+)',$/gm)].map((m) => m[1])
  const panelNames = [...panelSrc.matchAll(/name: '([a-z_]+)',/g)].map((m) => m[1])

  it('registry 工具数符合预期下限（防正则失效导致假绿）', () => {
    expect(toolNames.length).toBeGreaterThanOrEqual(26)
  })

  it('★ registry 每个工具都在面板清单里（新增忘补即挂）', () => {
    const missing = toolNames.filter((n) => !panelNames.includes(n))
    expect(missing).toEqual([])
  })

  it('★ 面板不列 registry 已删的工具（清理同步）', () => {
    const stale = panelNames.filter((n) => !toolNames.includes(n))
    expect(stale).toEqual([])
  })

  it('面板每项都有中文 label 与 desc（不许裸英文/空说明）', () => {
    // 条目有单行与多行两种排版，统一用「name 后跟 label/desc」的宽松匹配
    const entries = [
      ...panelSrc.matchAll(
        /name: '([a-z_]+)',[\s\S]{0,120}?label: '([^']+)'[\s\S]{0,400}?desc: '([^']+)'/g
      )
    ]
    const nameSet = new Set(entries.map((e) => e[1]))
    for (const n of panelNames) {
      expect(nameSet.has(n), `面板项 ${n} 缺 label/desc 或格式不符`).toBe(true)
    }
    for (const e of entries) {
      expect(e[2].length).toBeGreaterThan(0)
      expect(e[3].length).toBeGreaterThan(0)
    }
  })
})
