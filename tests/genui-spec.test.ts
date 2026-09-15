// genui 规格层单测（genui 适配）：JSON 解析 / 白名单 / 节点预算 / 流式半截识别 /
// 数值解析（千分位/万亿/百分号）/ delta 着色 / 表达式求值器（受限 DSL，防注入面）。

import { describe, expect, it } from 'vitest'
import { deltaVar, parseGenuiDoc, parseNum, repairJsonText } from '../src/renderer/chat/genui/spec'
import { evalExpr } from '../src/renderer/chat/genui/expr'

describe('parseGenuiDoc（genui 围栏 JSON → 文档）', () => {
  it('合法文档：items 数组 + 已知 type 通过', () => {
    const r = parseGenuiDoc(
      '{"title":"T","items":[{"type":"text","content":"hi"},{"type":"divider"}]}'
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.doc.title).toBe('T')
      expect(r.doc.items).toHaveLength(2)
    }
  })

  it('JSON 半截（流式生成中）→ reason=__json__（渲染层据此显示占位而非报错）', () => {
    const r = parseGenuiDoc('{"items":[{"type":"text","cont')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('__json__')
  })

  it('未知 type 拒绝并点名（模型可自纠）', () => {
    const r = parseGenuiDoc('{"items":[{"type":"hacker"}]}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('hacker')
  })

  it('缺 items / 根不是对象 → 拒绝', () => {
    expect(parseGenuiDoc('{"title":"x"}').ok).toBe(false)
    expect(parseGenuiDoc('[1,2]').ok).toBe(false)
    expect(parseGenuiDoc('"str"').ok).toBe(false)
  })

  it('嵌套容器（row>card>list）递归校验；tabs[].items 也查', () => {
    const deep =
      '{"items":[{"type":"row","items":[{"type":"card","items":[{"type":"chart","kind":"bars","data":[{"label":"a","value":1}]}]}]}]}'
    expect(parseGenuiDoc(deep).ok).toBe(true)
    const badTab = '{"items":[{"type":"tabs","tabs":[{"label":"t","items":[{"type":"evil"}]}]}]}'
    expect(parseGenuiDoc(badTab).ok).toBe(false)
  })

  it('节点预算：超限拒绝（防巨型树拖死渲染）', () => {
    const items = Array.from({ length: 300 }, () => '{"type":"divider"}').join(',')
    expect(parseGenuiDoc(`{"items":[${items}]}`).ok).toBe(false)
  })

  it('深度预算：嵌套超 12 层拒绝', () => {
    let node = '{"type":"divider"}'
    for (let i = 0; i < 15; i++) node = `{"type":"card","items":[${node}]}`
    expect(parseGenuiDoc(`{"items":[${node}]}`).ok).toBe(false)
  })

  it('list 的纯字符串项合法（非节点不查 type）', () => {
    expect(parseGenuiDoc('{"items":[{"type":"list","items":["a","b"]}]}').ok).toBe(true)
  })

  it('★ 回归：list {title,desc} / timeline {title,time} / accordion {title,items} 数据条目不带 type 合法', () => {
    expect(
      parseGenuiDoc('{"items":[{"type":"list","items":[{"title":"带标题","desc":"带描述"}]}]}').ok
    ).toBe(true)
    expect(
      parseGenuiDoc(
        '{"items":[{"type":"timeline","items":[{"title":"节点","time":"9/8","desc":"d"}]}]}'
      ).ok
    ).toBe(true)
    expect(
      parseGenuiDoc(
        '{"items":[{"type":"accordion","items":[{"title":"t","items":[{"type":"text","content":"x"}]}]}]}'
      ).ok
    ).toBe(true)
    // 但 accordion 条目里的 items 子节点仍是组件，未知 type 照拒
    expect(
      parseGenuiDoc(
        '{"items":[{"type":"accordion","items":[{"title":"t","items":[{"type":"evil"}]}]}]}'
      ).ok
    ).toBe(false)
  })

  it('★ 回归：file-tree 的 {name,type:"dir"/"file",children} 不误杀（type 是数据标记非组件类型）', () => {
    const tree =
      '{"items":[{"type":"file-tree","items":[{"name":"复习材料","type":"dir","children":[{"name":"高数公式表.md","type":"file"}]},{"name":"模拟卷.pdf","type":"file"}]}]}'
    expect(parseGenuiDoc(tree).ok).toBe(true)
  })

  it('★ 回归：grid>card>steps + row>progress(ring) + card>list 混合条目全通过', () => {
    const f2 =
      '{"title":"本周计划","gap":14,"items":[{"type":"grid","cols":2,"gap":12,"items":[{"type":"card","title":"冲刺路线与完成度","span":2,"items":[{"type":"steps","current":1,"steps":[{"title":"梳理考纲","desc":"d"},{"title":"刷错题","desc":"d"},{"title":"真题模拟","desc":"d"},{"title":"考前查询","desc":"d"}]},{"type":"row","gap":16,"wrap":true,"items":[{"type":"progress","label":"数学分析","value":62,"valueLabel":"62%"},{"type":"progress","label":"大学物理","value":45,"variant":"ring","valueLabel":"45%"}]}]},{"type":"card","title":"今日待办","items":[{"type":"list","items":["纯字符串条目",{"title":"带标题与描述","desc":"d"},{"type":"badge","label":"嵌套 badge 节点","tone":"warn","icon":"⚠"}]}]}]}]}'
    expect(parseGenuiDoc(f2).ok).toBe(true)
  })

  it('顶层 items 必须是带合法 type 的组件（无 type 的裸对象拒绝）', () => {
    expect(parseGenuiDoc('{"items":[{"title":"x","desc":"y"}]}').ok).toBe(false)
  })

  it('★ 回归：component+data 包裹方言被归一救回', () => {
    // 她当时的输出：{"component":"table","data":{"columns":[{key,label}],"rows":[{...}]}}
    // 根上没有 items/type → 此前判「缺少 items 数组」，整栏降级成代码块
    const payload = JSON.stringify({
      component: 'table',
      data: {
        columns: [
          { key: 'id', label: '#' },
          { key: 'task', label: '测试任务' },
          { key: 'tools', label: '预期走的工具链' }
        ],
        rows: [
          { id: 'T1', task: '算一下 8765 的精確值', tools: 'run_js' },
          { id: 'T2', task: '2026考研数学一真题', tools: 'web_search → fetch_url' }
        ]
      }
    })
    const r = parseGenuiDoc('{"items":[' + payload + ']}')
    expect(r.ok).toBe(true)
    if (r.ok) {
      const table = r.doc.items[0] as Record<string, unknown>
      expect(table['type']).toBe('table')
      expect(table['columns']).toEqual(['#', '测试任务', '预期走的工具链'])
      expect(table['rows']).toEqual([
        ['T1', '算一下 8765 的精確值', 'run_js'],
        ['T2', '2026考研数学一真题', 'web_search → fetch_url']
      ])
      expect(table['data']).toBeUndefined() // data 已摊平
    }
  })

  it('★ 回归：字符串内裸引号 / 尾随逗号被修复', () => {
    // 她自述的翻车：字符串里直接写了英文引号 → 整块 JSON 解析失败
    const broken = '{"items":[{"type":"callout","content":"公司处于"发展初期"阶段",},]}'
    const r = parseGenuiDoc(broken)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect((r.doc.items[0] as Record<string, unknown>)['content']).toBe('公司处于"发展初期"阶段')
    }
  })

  it('repairJsonText：只修笔误、不破坏合法 JSON', () => {
    expect(repairJsonText('{"a":1,}')).toBe('{"a":1}')
    expect(repairJsonText('{"items":[1,2,],}')).toBe('{"items":[1,2]}')
    // 字符串内的裸引号被转义；字符串结尾的引号不动
    expect(repairJsonText('{"a":"他说"你好""}')).toBe('{"a":"他说\\"你好\\""}')
    // 合法 JSON 原样返回（数字/嵌套/转义序列都不受影响）
    const ok = '{"a":[1,2,{"b":"x\\"y"}],"c":true}'
    expect(repairJsonText(ok)).toBe(ok)
  })

  it('★ 回归：section+children+text 的 React 先验输出被归一救回', () => {
    // 她当时的输出：根 {type:"section",children:[...]}，text 节点用 "text" 字段，
    // 表格里 columns/rows 本来就是对的——此前整栏误杀降级成代码块
    const r = parseGenuiDoc(
      '{"type":"section","children":[{"type":"text","text":"条件概率闪卡 · 10 张（周三 9/16 小测）"},' +
        '{"type":"table","columns":["知识点","覆盖内容"],"rows":[["条件概率定义与性质","“定义式与 P(A)>0”"]]}]}'
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      // 根带 type:section + children → children 直接当顶层 items（section 包裹隐式拆掉），
      // text 节点的 "text" 字段归一成渲染层读的 "content"
      expect(r.doc.items).toHaveLength(2)
      const kids = r.doc.items as Array<Record<string, unknown>>
      expect(kids[0]['content']).toBe('条件概率闪卡 · 10 张（周三 9/16 小测）')
      expect(kids[1]['type']).toBe('table')
    }
  })

  it('归一化：根 items 缺失接 children；column/container→col、columns→row', () => {
    const r = parseGenuiDoc(
      '{"children":[{"type":"column","children":[{"type":"container","children":[{"type":"divider"}]}]},{"type":"columns","children":[{"type":"spacer"}]}]}'
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      const first = r.doc.items[0] as Record<string, unknown>
      expect(first['type']).toBe('col')
      const inner = (first['items'] as Array<Record<string, unknown>>)[0]
      expect(inner['type']).toBe('col')
      expect((r.doc.items[1] as Record<string, unknown>)['type']).toBe('row')
    }
  })

  it('归一化不误伤：真未知 type 仍拒绝；file-tree 的 children 数据子树原样保留', () => {
    expect(parseGenuiDoc('{"children":[{"type":"hacker","children":[]}]}').ok).toBe(false)
    const ft = parseGenuiDoc(
      '{"items":[{"type":"file-tree","items":[{"name":"src","type":"dir","children":[{"name":"a.ts","type":"file"}]}]}]}'
    )
    expect(ft.ok).toBe(true)
    if (ft.ok) {
      const tree = ft.doc.items[0] as Record<string, unknown>
      const entry = (tree['items'] as Array<Record<string, unknown>>)[0]
      expect(Array.isArray(entry['children'])).toBe(true) // 数据字段没被改名成 items
      expect(entry['items']).toBeUndefined()
    }
  })
})

describe('parseNum（表格排序/着色的数值感知）', () => {
  it('千分位 / 负号 / 小数', () => {
    expect(parseNum('1,234')).toBeCloseTo(1234)
    expect(parseNum('-3')).toBeCloseTo(-3)
    expect(parseNum('2.5')).toBeCloseTo(2.5)
  })
  it('单位后缀：万/亿/k/m/b/%/货币符', () => {
    expect(parseNum('1.2万')).toBeCloseTo(12000)
    expect(parseNum('3亿')).toBeCloseTo(3e8)
    expect(parseNum('2.5k')).toBeCloseTo(2500)
    expect(parseNum('80%')).toBeCloseTo(80)
    expect(parseNum('¥1,000')).toBeCloseTo(1000)
  })
  it('非数值 → null（纯文本列按字典序）', () => {
    expect(parseNum('hello')).toBeNull()
    expect(parseNum('')).toBeNull()
  })
})

describe('deltaVar（涨跌着色：中国惯例红涨绿跌）', () => {
  it('+开头 → 红（--genui-up）；-开头且数值 → 绿', () => {
    expect(deltaVar('+12.4%')).toBe('var(--genui-up)')
    expect(deltaVar('-3')).toBe('var(--genui-down)')
  })
  it('普通文本不着色', () => {
    expect(deltaVar('持平')).toBeNull()
    expect(deltaVar('-')).toBeNull()
  })
})

describe('evalExpr（plot 的受限数学 DSL）', () => {
  it('四则 + 优先级 + 括号 + 一元负', () => {
    expect(evalExpr('1+2*3', {})).toBe(7)
    expect(evalExpr('(1+2)*3', {})).toBe(9)
    expect(evalExpr('-2^2', {})).toBe(-4) // 一元负优先于 ^（与数学惯例一致）
  })
  it('函数与常量', () => {
    expect(evalExpr('sin(0)', {})).toBe(0)
    expect(evalExpr('max(2,3,4)', {})).toBe(4)
    expect(evalExpr('pi', {})).toBeCloseTo(Math.PI)
    expect(evalExpr('sqrt(16)', {})).toBe(4)
    expect(evalExpr('pow(2,10)', {})).toBe(1024)
  })
  it('变量作用域（x 与参数）', () => {
    expect(evalExpr('a*sin(b*x)', { a: 2, b: 1, x: Math.PI / 2 })).toBeCloseTo(2)
  })
  it('非法输入抛错（渲染层 catch 后跳过该点，绝不执行任意代码）', () => {
    expect(() => evalExpr('alert(1)', {})).toThrow()
    expect(() => evalExpr('1+', {})).toThrow()
    expect(() => evalExpr('x(', { x: 1 })).toThrow()
  })
})
