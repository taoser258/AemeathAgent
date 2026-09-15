// CSS 加载顺序守护
//
// 背景（顶栏「不齐」排查实录）：global.css 原先由各入口 JS 直连 import。
// dev 下 Vite 按 import 序注入（global 在前），打包下 rollup 把被多入口共享的
// global.css 拆成**独立 chunk 并排在窗口样式之后** —— 两个环境里同名规则的赢家
// 正好相反。.win-controls 在 global.css / chat.css 各有一份、值不同（top:10/34×26
// vs top:16/32×28），于是装机版窗控图标中心线比侧栏开关低 7px（顶栏"不齐"）；
// 设置窗同类问题让装机版用上 global 的旧卡片样式。
//
// 修法：窗口样式表顶部 `@import` 内联 global —— 顺序由 CSS 语义保证，任何打包策略
// 都改不了。本测试锁死这条不变量：入口 JS 不得再直连 global.css（除单一样式表的
// scale-panel），窗口样式表必须以 @import 开头。

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 剥掉文件开头的注释块，便于判断"第一条语句" */
function firstStatement(src: string): string {
  return src.replace(/^\uFEFF/, '').replace(/^(?:\s*\/\*[\s\S]*?\*\/\s*)+/, '')
}

describe('CSS 加载顺序守护（顶栏不齐根因）', () => {
  it('窗口样式表顶部必须 @import 内联 global.css', () => {
    for (const f of ['src/renderer/chat/chat.css', 'src/renderer/settings/settings.css']) {
      const head = firstStatement(readFileSync(f, 'utf-8'))
      expect(
        head.startsWith("@import '../styles/global.css';"),
        `${f} 顶部必须是 @import '../styles/global.css';（顺序铁律，别改回入口直连）`
      ).toBe(true)
    }
  })

  it('聊天窗/设置窗入口 JS 不得直连 global.css（会被打包成独立 chunk 破坏顺序）', () => {
    for (const f of ['src/renderer/main.tsx', 'src/renderer/settings/main.tsx']) {
      const src = readFileSync(f, 'utf-8')
      const direct = /import\s+['"][^'"]*styles\/global\.css['"]/.test(src)
      expect(direct, `${f} 直连了 global.css——顺序会随打包器漂移，请改由窗口样式表 @import`).toBe(
        false
      )
    }
  })

  it('窗口样式表 @import 必须在所有规则之前（CSS 规范硬约束）', () => {
    for (const f of ['src/renderer/chat/chat.css', 'src/renderer/settings/settings.css']) {
      const src = readFileSync(f, 'utf-8')
      const at = src.indexOf("@import '../styles/global.css';")
      expect(at, `${f} 缺 @import`).toBeGreaterThanOrEqual(0)
      const braceBefore = src.lastIndexOf('{', at)
      // @import 之前不允许出现任何规则块（注释/空白除外）
      const head = src
        .slice(0, at)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim()
      expect(head === '' && braceBefore === -1, `${f} 的 @import 必须位于所有规则之前`).toBe(true)
    }
  })
})
