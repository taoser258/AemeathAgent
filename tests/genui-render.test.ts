// genui 渲染器冒烟测试（SSR renderToStaticMarkup，零依赖不引 jsdom）：
// 三态不崩（合法→组件树 / 半截→生成中占位 / 校验失败→降级代码块）+ 关键结构断言。
// 交互/图表的像素级验证走 CDP 实测，这里只保证"渲染不抛、DOM 形状对"。

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GenuiBlock } from '../src/renderer/chat/genui/GenuiView'

const doc = (items: string): string => `{"items":${items}}`

describe('GenuiBlock（SSR 冒烟）', () => {
  it('合法文档 → 渲染组件树（含标题、stat、chart 容器）', () => {
    const html = renderToStaticMarkup(
      createElement(GenuiBlock, {
        code: doc(
          '[{"type":"text","content":"你好"},{"type":"stat","label":"营收","value":"1.2万","delta":"+8%"}]'
        ),
        streaming: false
      })
    )
    expect(html).toContain('genui-root')
    expect(html).toContain('你好')
    expect(html).toContain('营收')
    // delta +开头 → 涨（红）：着色走 style 内联 CSS 变量
    expect(html).toContain('--genui-up')
  })

  it('chart 组件 → SVG 柱子走 style 注入 var() 色板（属性写法不生效的坑）', () => {
    const html = renderToStaticMarkup(
      createElement(GenuiBlock, {
        code: doc(
          '[{"type":"chart","kind":"bars","data":[{"label":"a","value":5},{"label":"b","value":3}]}]'
        ),
        streaming: false
      })
    )
    expect(html).toContain('<svg')
    expect(html).toContain('<rect')
    // 关键：fill 必须走 style（var() 在 presentation attribute 上不解析）
    expect(html).toMatch(/style="[^"]*--genui-c1/)
    expect(html).not.toMatch(/fill="var\(/)
  })

  it('半截 JSON（流式）→ 生成中占位，不崩', () => {
    const html = renderToStaticMarkup(
      createElement(GenuiBlock, { code: '{"items":[{"type":"te', streaming: true })
    )
    expect(html).toContain('genui-pending')
    expect(html).toContain('生成中')
  })

  it('校验失败（未知 type）→ 降级代码块 + 原因，不崩', () => {
    const html = renderToStaticMarkup(
      createElement(GenuiBlock, { code: doc('[{"type":"nope"}]'), streaming: false })
    )
    expect(html).toContain('genui-invalid')
    expect(html).toContain('nope')
    expect(html).toContain('nope') // 原文仍在（降级为代码）
  })

  it('table：delta 列着色 + 合计行 + 排序表头存在', () => {
    const html = renderToStaticMarkup(
      createElement(GenuiBlock, {
        code: doc(
          '[{"type":"table","columns":["名","环比"],"rows":[["A","+5%"],["B","-3%"]],"types":["text","delta"],"total":true}]'
        ),
        streaming: false
      })
    )
    expect(html).toContain('genui-table')
    expect(html).toContain('--genui-up') // +5% 红
    expect(html).toContain('--genui-down') // -3% 绿
    expect(html).toContain('合计')
  })

  it('plot：表达式滑块 + polyline 曲线渲染（求值器 SSR 期跑通）', () => {
    const html = renderToStaticMarkup(
      createElement(GenuiBlock, {
        code: doc(
          '[{"type":"plot","series":[{"expr":"a*sin(x)","params":[{"name":"a","value":2,"min":0,"max":5}]}],"xMin":0,"xMax":6}]'
        ),
        streaming: false
      })
    )
    expect(html).toContain('<polyline')
    expect(html).toContain('type="range"') // 参数滑块
  })

  it('★ 回归：horizontal:true → 真横向柱（宽>高 的条 + 条尾数值）', () => {
    const html = renderToStaticMarkup(
      createElement(GenuiBlock, {
        code: doc(
          '[{"type":"chart","kind":"bars","horizontal":true,"data":[{"label":"第一章","value":14},{"label":"第二章","value":11}]}]'
        ),
        streaming: false
      })
    )
    // 横向柱：rect 的 width 随数值变化且远大于 height（竖柱是 height 变化）
    const widths = [...html.matchAll(/width="([\d.]+)"/g)].map((m) => Number(m[1]))
    const heights = [...html.matchAll(/height="([\d.]+)"/g)].map((m) => Number(m[1]))
    expect(Math.max(...widths)).toBeGreaterThan(Math.max(...heights))
    expect(html).toContain('genui-chart')
  })

  it('★ 回归：total 遇百分比列 → 合计行给平均而非求和（不出 484%）', () => {
    const html = renderToStaticMarkup(
      createElement(GenuiBlock, {
        code: doc(
          '[{"type":"table","columns":["科目","得分率"],"rows":[["高数","92%"],["线代","88%"]],"types":["text","num"],"total":true}]'
        ),
        streaming: false
      })
    )
    expect(html).toContain('genui-total-row')
    expect(html).toContain('90%') // (92+88)/2 平均
    expect(html).not.toContain('180%') // 不是求和
  })

  it('★ 回归：total 纯数值列照常求和', () => {
    const html = renderToStaticMarkup(
      createElement(GenuiBlock, {
        code: doc(
          '[{"type":"table","columns":["项","数"],"rows":[["A","30"],["B","20"]],"types":["text","num"],"total":true}]'
        ),
        streaming: false
      })
    )
    expect(html).toContain('50')
  })

  it('★ json 组件是树查看器（折叠按钮+逐行 key/value），非整坨 JSON.stringify 代码块', () => {
    const html = renderToStaticMarkup(
      createElement(GenuiBlock, {
        code: doc(
          '[{"type":"json","value":{"plan":{"subject":"高数","blocks":[{"topic":"级数","minutes":50,"priority":"high"}]},"streak":12}}]'
        ),
        streaming: false
      })
    )
    expect(html).toContain('genui-json')
    expect(html).toContain('genui-jtoggle') // 折叠三角
    expect(html).toContain('genui-jk') // key 节点
    expect(html).toContain('streak')
    expect(html).toContain('>12<') // number 值着色节点
    // 折叠计数：深度≥2 的分支默认收起，数组显示 [n] 计数而非展开
    expect(html).toContain('[1]') // blocks 数组（1 项）在 depth=2 收起 → [1]
  })

  it('★ 回归：types[0]=group 且整行只有首格 → 跨列分组标题行', () => {
    const html = renderToStaticMarkup(
      createElement(GenuiBlock, {
        code: doc(
          '[{"type":"table","columns":["科目","作业","得分率"],"rows":[["高数","",""],["第1次","作业A","92%"]],"types":["group","text","num"]}]'
        ),
        streaming: false
      })
    )
    expect(html).toContain('genui-group-row')
    expect(html).toContain('colSpan="3"') // React SSR 输出驼峰属性
  })
})
