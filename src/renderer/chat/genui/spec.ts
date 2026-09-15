// genui 规格解析与校验（genui 适配 v1）。
// 模型在正文里输出 ```genui 围栏（原 成熟实现-ui 围栏改名，避免 成熟实现品牌残留），
// 内含 JSON 文档：{ title?, gap?, items:[{type:...}] }。
// 本模块是纯函数层：解析 + 白名单校验 + 节点预算（模型输出不可信，防御式处理），
// 校验失败由 GenuiView 降级为代码块展示，绝不抛穿渲染树。

export interface GenuiNode {
  type: string
  [key: string]: unknown
}

export interface GenuiDoc {
  title?: string
  gap?: number
  items: GenuiNode[]
}

/** 组件类型白名单（渲染器有实现的才进；未列出的 type 校验期即拒绝→整体降级） */
export const ALLOWED_TYPES = new Set([
  // 布局
  'text',
  'row',
  'col',
  'grid',
  'card',
  'divider',
  'spacer',
  'hero',
  // 展示
  'stat',
  'badge',
  'progress',
  'list',
  'table',
  'keyvalue',
  'avatar',
  'timeline',
  'file-tree',
  'breadcrumb',
  'diff',
  'json',
  'code',
  'callout',
  'steps',
  // 图表
  'chart',
  'plot',
  'echart',
  // 交互
  'button',
  'input',
  'select',
  'checkbox',
  'radio',
  'slider',
  'switch',
  'textarea',
  'tabs',
  'accordion',
  'copy',
  'link',
  'submit'
])

/** 节点预算：防模型一次吐巨型树拖死渲染（超限→整体降级为代码块） */
export const MAX_NODES = 250
export const MAX_DEPTH = 12

export type ParseResult = { ok: true; doc: GenuiDoc } | { ok: false; reason: string }

// ── 宽容归一化─────────────────────────────────────
// 模型输出围栏时带着 React/HTML 先验：section/column 当容器、children 当子节点数组、
// text 当文本字段——与 genui 的 col/items/content 一墙之隔，此前整栏误杀降级成代码块
// （她 10 张闪卡分组那次的翻车现场）。归一化把高频别名映射进正规词汇，校验只拒"真未知"。
// 边界：file-tree 的 children 是**树数据**（条目嵌套），不能改名；其子树整体不动。

const LAYOUT_ALIASES: Record<string, string> = {
  section: 'col',
  column: 'col',
  container: 'col',
  stack: 'col',
  vbox: 'col',
  columns: 'row',
  hbox: 'row',
  flex: 'row',
  div: 'col'
}

function normalizeNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeNode)
  if (typeof node !== 'object' || node === null) return node
  const src = node as Record<string, unknown>
  const out: Record<string, unknown> = { ...src }
  // `{component:"table", data:{…}}` 包裹式方言（ 实测：模型按别家 UI DSL
  // 输出，整栏判「缺少 items 数组」降级）——component→type，data 里的字段摊平到节点上。
  if (typeof out['component'] === 'string' && typeof out['type'] !== 'string') {
    out['type'] = out['component']
  }
  delete out['component']
  const data = out['data']
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (out[k] === undefined) out[k] = v
    }
    delete out['data']
  }
  const type = typeof src['type'] === 'string' ? src['type'] : String(out['type'] ?? '')
  // file-tree 整棵子树是数据（items 根数组 + 条目 children 嵌套），渲染层自处理，不碰
  if (type === 'file-tree') return out
  const alias = LAYOUT_ALIASES[type]
  if (alias !== undefined) out['type'] = alias
  if (Array.isArray(out['children']) && !Array.isArray(out['items'])) {
    out['items'] = out['children']
    delete out['children']
  }
  // text 节点：模型爱写 "text" 字段（渲染层读 content）
  if (typeof out['content'] !== 'string' && typeof out['text'] === 'string') {
    out['content'] = out['text']
  }
  // table：列既可能是字符串也可能是 {key,label}；行既可能是数组也可能是对象（按列取值）
  if (out['type'] === 'table') {
    const rawCols = out['columns']
    const cols = Array.isArray(rawCols)
      ? rawCols.map((c) =>
          typeof c === 'object' && c !== null
            ? String(
                (c as Record<string, unknown>)['label'] ??
                  (c as Record<string, unknown>)['key'] ??
                  ''
              )
            : String(c)
        )
      : []
    if (cols.length > 0) out['columns'] = cols
    const rawRows = out['rows']
    if (Array.isArray(rawRows) && cols.length > 0) {
      const keys = Array.isArray(rawCols)
        ? rawCols.map((c) =>
            typeof c === 'object' && c !== null
              ? String((c as Record<string, unknown>)['key'] ?? '')
              : ''
          )
        : []
      out['rows'] = rawRows.map((r) => {
        if (Array.isArray(r)) return r
        if (typeof r === 'object' && r !== null) {
          const o = r as Record<string, unknown>
          // 有 key 映射就按列顺序取值，否则按对象自身值顺序
          return keys.some((k) => k !== '') ? keys.map((k) => o[k] ?? '') : Object.values(o)
        }
        return [String(r)]
      })
    }
  }
  if (Array.isArray(out['items'])) out['items'] = normalizeNode(out['items'])
  if (Array.isArray(out['tabs'])) {
    out['tabs'] = (out['tabs'] as unknown[]).map((tab) => {
      if (typeof tab !== 'object' || tab === null) return tab
      const t = { ...(tab as Record<string, unknown>) }
      if (Array.isArray(t['children']) && !Array.isArray(t['items'])) {
        t['items'] = t['children']
        delete t['children']
      }
      if (Array.isArray(t['items'])) t['items'] = normalizeNode(t['items'])
      return t
    })
  }
  return out
}

/** 根对象归一：items 缺失时接住 children；根直接是数组也接住 */
function normalizeRoot(data: unknown): unknown {
  if (Array.isArray(data)) return { items: normalizeNode(data) }
  if (typeof data !== 'object' || data === null) return data
  const out: Record<string, unknown> = { ...(data as Record<string, unknown>) }
  if (!Array.isArray(out['items']) && Array.isArray(out['children'])) {
    out['items'] = out['children']
  }
  if (Array.isArray(out['items'])) out['items'] = normalizeNode(out['items'])
  return out
}

/**
 * JSON 容错修复」——实际是她自己在
 * 字符串里写了没转义的英文引号，如 `"label":"是"发展初期""`，整块解析失败降级成代码块）。
 * 只在**首次 parse 失败**时兜底，两步都无副作用地修常见笔误：
 * ① 尾随逗号（`,"}` / `,]}`——模型从列表改写时高频残留）；
 * ② 字符串内的裸双引号：逐字符扫描，遇到引号先向前看——若其后第一个非空白字符是
 * `:` `,` `}` `]` 或到末尾，视为字符串结束；否则判为内容里的引号并转义。
 * 修完仍解析失败才认输（返回 __json__，渲染层显示占位/降级）。
 */
export function repairJsonText(src: string): string {
  let out = ''
  let inStr = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '\\') {
      out += ch + (src[i + 1] ?? '')
      i++
      continue
    }
    if (ch !== '"') {
      out += ch
      continue
    }
    if (!inStr) {
      inStr = true
      out += ch
      continue
    }
    let j = i + 1
    while (j < src.length && /\s/.test(src[j] ?? '')) j++
    const next = src[j]
    if (next === undefined || next === ':' || next === ',' || next === '}' || next === ']') {
      inStr = false
      out += ch
    } else {
      out += '\\"'
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

/** 解析 + 校验。JSON 半截（流式中）与校验失败分开报：前者渲染"生成中"占位 */
export function parseGenuiDoc(raw: string): ParseResult {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    // 二次尝试：修常见笔误后再解析（流式半截的输入同样会失败 → 仍走占位分支）
    try {
      data = JSON.parse(repairJsonText(raw))
    } catch {
      return { ok: false, reason: '__json__' } // 特殊值：JSON 未闭合（多半是流式生成中）
    }
  }
  // 先宽容归一（React 先验别名 → genui 正规词汇），再进白名单校验
  data = normalizeRoot(data)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: '根节点必须是对象 {items:[…]}' }
  }
  const d = data as Record<string, unknown>
  if (!Array.isArray(d['items'])) return { ok: false, reason: '缺少 items 数组' }
  const items = d['items'] as unknown[]
  let count = 0
  const walk = (node: unknown, depth: number): string | null => {
    if (depth > MAX_DEPTH) return `嵌套超过 ${MAX_DEPTH} 层`
    if (typeof node !== 'object' || node === null) return null // list 等允许纯字符串项
    count += 1
    if (count > MAX_NODES) return `节点数超过上限 ${MAX_NODES}`
    const n = node as Record<string, unknown>
    const t = n['type']
    if (t === undefined) {
      // ★ 修：list 的 {title,desc}、timeline 的 {title,time}、
      // accordion 的 {title,items} 都是合法**数据条目**（规范明确允许不带 type）——
      // 此前一律要求 type 导致整围栏误杀降级。数据条目自身放行；若它带 items
      // （accordion 条目），其中的子节点仍按组件校验。
      const dataKids = n['items']
      if (Array.isArray(dataKids)) {
        for (const k of dataKids) {
          const err = walk(k, depth + 1)
          if (err !== null) return err
        }
      }
      return null
    }
    if (typeof t !== 'string') return '子节点 type 必须是字符串'
    if (!ALLOWED_TYPES.has(t)) return `未知组件类型：${t.slice(0, 40)}`
    // file-tree 的 items/children 是 {name,type:'file'|'dir'} 数据条目（type 是数据结构
    // 标记不是组件类型）——不递归校验，树形渲染层自己处理。
    if (t === 'file-tree') return null
    // 容器字段递归：items（row/col/grid/card/list…）与 tabs[].items
    const kids = n['items']
    if (Array.isArray(kids)) {
      for (const k of kids) {
        const err = walk(k, depth + 1)
        if (err !== null) return err
      }
    }
    const tabs = n['tabs']
    if (Array.isArray(tabs)) {
      for (const tab of tabs) {
        if (typeof tab === 'object' && tab !== null && Array.isArray((tab as GenuiNode)['items'])) {
          for (const k of (tab as GenuiNode)['items'] as unknown[]) {
            const err = walk(k, depth + 1)
            if (err !== null) return err
          }
        }
      }
    }
    return null
  }
  // 顶层 items 必须是组件（带合法 type）；嵌套层允许 list/timeline/accordion 的数据条目
  for (const item of items) {
    if (typeof item !== 'object' || item === null)
      return { ok: false, reason: '顶层 items 必须是组件对象' }
    const t = (item as Record<string, unknown>)['type']
    if (typeof t !== 'string' || !ALLOWED_TYPES.has(t)) {
      return { ok: false, reason: `顶层组件缺少合法 type：${String(t).slice(0, 40) || '(无)'}` }
    }
    const err = walk(item, 1)
    if (err !== null) return { ok: false, reason: err }
  }
  return {
    ok: true,
    doc: {
      title: typeof d['title'] === 'string' ? d['title'] : undefined,
      gap: typeof d['gap'] === 'number' ? d['gap'] : undefined,
      items: items as GenuiNode[]
    }
  }
}

// ── 取值助手（模型输出字段类型不可靠，全部防御式读取）────────────────────

export const sOf = (n: GenuiNode, k: string): string | undefined =>
  typeof n[k] === 'string' ? (n[k] as string) : undefined
export const nOf = (n: GenuiNode, k: string): number | undefined =>
  typeof n[k] === 'number' && Number.isFinite(n[k]) ? (n[k] as number) : undefined
export const bOf = (n: GenuiNode, k: string): boolean => n[k] === true
export const arrOf = (n: GenuiNode, k: string): unknown[] =>
  Array.isArray(n[k]) ? (n[k] as unknown[]) : []
export const kidsOf = (n: GenuiNode): GenuiNode[] =>
  arrOf(n, 'items').filter((x): x is GenuiNode => typeof x === 'object' && x !== null)

/** 默认分类色板：8 支 CSS 变量（浅深两套定义在 global.css，SVG fill 直接可用） */
export const DEFAULT_PALETTE = [
  'var(--genui-c1)',
  'var(--genui-c2)',
  'var(--genui-c3)',
  'var(--genui-c4)',
  'var(--genui-c5)',
  'var(--genui-c6)',
  'var(--genui-c7)',
  'var(--genui-c8)'
] as const

/** 语义 tone → CSS 变量（badge/callout/progress/hero 共用） */
export function toneVar(tone: string | undefined): string {
  switch (tone) {
    case 'success':
      return 'var(--genui-success)'
    case 'warning':
    case 'warn':
      return 'var(--genui-warning)'
    case 'danger':
    case 'error':
      return 'var(--genui-danger)'
    case 'info':
      return 'var(--genui-info)'
    case 'accent':
      return 'var(--accent)'
    default:
      return 'var(--text-secondary)'
  }
}

/** 色板：palette 字段覆盖（仅收字符串数组），否则默认主题色板 */
export function paletteOf(n: GenuiNode): string[] {
  const p = n['palette']
  if (Array.isArray(p) && p.length > 0 && p.every((x) => typeof x === 'string')) {
    return p as string[]
  }
  return [...DEFAULT_PALETTE]
}

// ── 数值格式化与解析 ───────────────────────────────────────────────────────

/** 展示格式化：千分位 + 最多 2 位小数（整数不带小数点） */
export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return String(v)
  const fixed = Math.abs(v) < 1e21 ? v : v
  const [int, dec] = String(Math.abs(fixed)).split('.')
  const thousands = (int ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const sign = fixed < 0 ? '-' : ''
  return dec ? `${sign}${thousands}.${dec.slice(0, 2)}` : `${sign}${thousands}`
}

/** 表格排序用：从字符串提取可比较数值（千分位/百分号/货币/k·m·b/万·亿 都认） */
export function parseNum(text: string): number | null {
  let t = text
    .trim()
    .replace(/[,，\s]/g, '')
    .replace(/[¥$€￥]/g, '')
  let mult = 1
  const suffix = t.match(/([kmb万亿%％])([+-]?\d*)$/i)
  if (suffix) {
    const unit = suffix[1]?.toLowerCase() ?? ''
    mult =
      unit === 'k'
        ? 1e3
        : unit === 'm'
          ? 1e6
          : unit === 'b'
            ? 1e9
            : unit === '万'
              ? 1e4
              : unit === '亿'
                ? 1e8
                : 1
    t = t.slice(0, t.length - suffix[0].length)
  }
  const v = Number.parseFloat(t)
  return Number.isFinite(v) ? v * mult : null
}

/** delta 语义着色：+开头=涨（中文惯例红），-开头=跌（绿）。返回 CSS 变量或 null */
export function deltaVar(text: string): string | null {
  const t = text.trim()
  if (/^[+＋]/.test(t)) return 'var(--genui-up)'
  if (/^[-－−]/.test(t) && t.length > 1 && parseNum(t) !== null) return 'var(--genui-down)'
  return null
}
