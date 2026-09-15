// genui 渲染器（genui 适配 v1）：把 ```genui 围栏的 JSON 文档画成真实组件。
// 零依赖（CSP script-src 'self' + 锁依赖，不引 ECharts/mermaid），图表全走手写 SVG。
// 配色一律 CSS 变量（--genui-* 浅深两套 + 派生色 var(--bg-panel)/var(--text-*)），
// 切主题即时跟随，无需 JS 读色。交互回传复用 ChatInput 同款决策：
// 运行中走 nudge（插话注入）、空闲走 send；本地可完成的（判卷/排序/折叠/复制）零往返。

import { Fragment, useMemo, useRef, useState } from 'react'
import { useChatStore, selectStreamingActive } from '../store'
import {
  arrOf,
  bOf,
  deltaVar,
  fmtNum,
  kidsOf,
  nOf,
  parseGenuiDoc,
  parseNum,
  paletteOf,
  sOf,
  toneVar,
  type GenuiDoc as GenuiDocData,
  type GenuiNode
} from './spec'
import { evalExpr } from './expr'

/** 交互动作回传给模型：运行中 nudge、空闲 send（与 ChatInput.doSend 同口径） */
function useGenuiAction(): (payload: Record<string, unknown>) => void {
  const streaming = useChatStore(selectStreamingActive)
  const send = useChatStore((s) => s.send)
  const nudge = useChatStore((s) => s.nudge)
  return (payload) => {
    const text = `[genui-action] ${JSON.stringify(payload)}`
    if (streaming) {
      void nudge(text)
    } else {
      send(text)
    }
  }
}

// ── 主分发 ────────────────────────────────────────────────────────────────

function Node({ node, ctx }: { node: GenuiNode; ctx: RenderCtx }): React.JSX.Element | null {
  switch (node.type) {
    case 'text':
      return <Text n={node} />
    case 'row':
      return <Box n={node} dir="row" ctx={ctx} />
    case 'col':
      return <Box n={node} dir="col" ctx={ctx} />
    case 'grid':
      return <Grid n={node} ctx={ctx} />
    case 'card':
      return <Card n={node} ctx={ctx} />
    case 'hero':
      return <Hero n={node} />
    case 'divider':
      return <hr className="genui-divider" />
    case 'spacer':
      return <div className="genui-spacer" />
    case 'stat':
      return <Stat n={node} />
    case 'badge':
      return <Badge n={node} />
    case 'progress':
      return <Progress n={node} />
    case 'list':
      return <List n={node} ctx={ctx} />
    case 'table':
      return <Table n={node} />
    case 'keyvalue':
      return <KeyValue n={node} />
    case 'avatar':
      return <Avatar n={node} />
    case 'timeline':
      return <Timeline n={node} />
    case 'file-tree':
      return <FileTree n={node} />
    case 'breadcrumb':
      return <Breadcrumb n={node} />
    case 'diff':
      return <Diff n={node} />
    case 'json':
      return <JsonView n={node} />
    case 'code':
      return <CodeView n={node} />
    case 'callout':
      return <Callout n={node} />
    case 'steps':
      return <Steps n={node} />
    case 'chart':
      return <Chart n={node} />
    case 'plot':
      return <Plot n={node} />
    case 'echart':
      return <EChart n={node} />
    case 'button':
      return <Button n={node} ctx={ctx} />
    case 'input':
      return <Input n={node} ctx={ctx} />
    case 'textarea':
      return <Textarea n={node} ctx={ctx} />
    case 'select':
      return <Select n={node} ctx={ctx} />
    case 'checkbox':
      return <Checkbox n={node} ctx={ctx} />
    case 'radio':
      return <Radio n={node} ctx={ctx} />
    case 'slider':
      return <Slider n={node} ctx={ctx} />
    case 'switch':
      return <Switch n={node} ctx={ctx} />
    case 'tabs':
      return <Tabs n={node} ctx={ctx} />
    case 'accordion':
      return <Accordion n={node} ctx={ctx} />
    case 'copy':
      return <Copy n={node} />
    case 'link':
      return <Link n={node} />
    case 'submit':
      return <Submit n={node} ctx={ctx} />
    default:
      return null
  }
}

interface RenderCtx {
  dispatch: (payload: Record<string, unknown>) => void
  // 表单域收集：id → 当前值（submit 时聚合）
  fields: Map<string, { value: unknown }>
  // radio/checkbox 分组：group → { 选中值, 是否已选 }
  groups: Map<string, { values: unknown[]; answered: boolean }>
}

function Children({
  items,
  ctx
}: {
  items: GenuiNode[]
  ctx: RenderCtx
}): React.JSX.Element | null {
  return (
    <>
      {items.map((k, i) => (
        <Node key={i} node={k} ctx={ctx} />
      ))}
    </>
  )
}

// ── 布局 ──────────────────────────────────────────────────────────────────

function Text({ n }: { n: GenuiNode }): React.JSX.Element {
  const size = sOf(n, 'size') ?? 'body'
  const cls = `genui-text genui-t-${size}${bOf(n, 'center') ? ' genui-center' : ''}`
  return <div className={cls}>{sOf(n, 'content') ?? ''}</div>
}

function Box({
  n,
  dir,
  ctx
}: {
  n: GenuiNode
  dir: 'row' | 'col'
  ctx: RenderCtx
}): React.JSX.Element {
  const style = { gap: nOf(n, 'gap') ?? (dir === 'row' ? 10 : 10) }
  const cls = `genui-box genui-${dir}${bOf(n, 'wrap') ? ' genui-wrap' : ''}${bOf(n, 'spacer') ? ' genui-spacer-row' : ''}`
  return (
    <div className={cls} style={style}>
      <Children items={kidsOf(n)} ctx={ctx} />
    </div>
  )
}

function Grid({ n, ctx }: { n: GenuiNode; ctx: RenderCtx }): React.JSX.Element {
  const cols = Math.max(1, Math.min(8, nOf(n, 'cols') ?? 2))
  return (
    <div className="genui-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {kidsOf(n).map((k, i) => (
        <div key={i} className="genui-grid-cell" style={spanStyle(k)}>
          <Node node={k} ctx={ctx} />
        </div>
      ))}
    </div>
  )
}

function spanStyle(n: GenuiNode): React.CSSProperties {
  const span = nOf(n, 'span')
  if (span && span > 1) return { gridColumn: `span ${Math.min(8, span)}` }
  return {}
}

function Card({ n, ctx }: { n: GenuiNode; ctx: RenderCtx }): React.JSX.Element {
  const accent = sOf(n, 'accent')
  const tone = sOf(n, 'tone')
  return (
    <div
      className={`genui-card${tone ? ` genui-tone-${tone}` : ''}`}
      style={accent ? { borderColor: accent } : undefined}
    >
      {sOf(n, 'title') ? (
        <div className="genui-card-title" style={accent ? { color: accent } : undefined}>
          {sOf(n, 'title')}
        </div>
      ) : null}
      <Children items={kidsOf(n)} ctx={ctx} />
    </div>
  )
}

function Hero({ n }: { n: GenuiNode }): React.JSX.Element {
  const tone = sOf(n, 'tone') ?? 'accent'
  return (
    <div className={`genui-hero genui-tone-${tone}`}>
      {sOf(n, 'label') ? <div className="genui-hero-eyebrow">{sOf(n, 'label')}</div> : null}
      {sOf(n, 'value') ? <div className="genui-hero-value">{sOf(n, 'value')}</div> : null}
      {sOf(n, 'title') ? <div className="genui-hero-title">{sOf(n, 'title')}</div> : null}
      {sOf(n, 'subtitle') ? <div className="genui-hero-sub">{sOf(n, 'subtitle')}</div> : null}
      {sOf(n, 'delta') ? (
        <div
          className="genui-hero-delta"
          style={{ color: deltaVar(sOf(n, 'delta') ?? '') ?? undefined }}
        >
          {sOf(n, 'delta')}
        </div>
      ) : null}
    </div>
  )
}

// ── 展示 ──────────────────────────────────────────────────────────────────

function Stat({ n }: { n: GenuiNode }): React.JSX.Element {
  const delta = sOf(n, 'delta')
  const spark = arrOf(n, 'spark').filter((x): x is number => typeof x === 'number')
  return (
    <div className="genui-stat">
      <div className="genui-stat-label">{sOf(n, 'label') ?? ''}</div>
      <div className={`genui-stat-value${sOf(n, 'size') === 'hero' ? ' genui-hero-num' : ''}`}>
        {sOf(n, 'value') ?? ''}
      </div>
      {delta ? (
        <div className="genui-stat-delta" style={{ color: deltaVar(delta) ?? undefined }}>
          {delta}
        </div>
      ) : null}
      {spark.length >= 2 ? <Spark values={spark} /> : null}
    </div>
  )
}

function Spark({ values }: { values: number[] }): React.JSX.Element {
  const w = 120
  const h = 30
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / span) * (h - 4) - 2}`)
    .join(' ')
  return (
    <svg className="genui-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden>
      <polyline points={pts} fill="none" style={{ stroke: 'var(--accent)' }} strokeWidth={1.6} />
    </svg>
  )
}

function Badge({ n }: { n: GenuiNode }): React.JSX.Element {
  const tone = sOf(n, 'tone') ?? 'accent'
  return (
    <span className="genui-badge" style={{ color: toneVar(tone), borderColor: toneVar(tone) }}>
      {sOf(n, 'icon') ? `${sOf(n, 'icon')} ` : ''}
      {sOf(n, 'label') ?? ''}
    </span>
  )
}

function Progress({ n }: { n: GenuiNode }): React.JSX.Element {
  const v = Math.max(0, Math.min(100, nOf(n, 'value') ?? 0))
  const label = sOf(n, 'valueLabel') ?? `${Math.round(v)}%`
  if (sOf(n, 'variant') === 'ring') {
    const r = 26
    const c = 2 * Math.PI * r
    return (
      <div className="genui-ring">
        <svg viewBox="0 0 64 64" width={64} height={64} aria-hidden>
          <circle
            cx={32}
            cy={32}
            r={r}
            fill="none"
            style={{ stroke: 'var(--line)' }}
            strokeWidth={6}
          />
          <circle
            cx={32}
            cy={32}
            r={r}
            fill="none"
            style={{ stroke: 'var(--accent)' }}
            strokeWidth={6}
            strokeDasharray={`${(v / 100) * c} ${c}`}
            strokeLinecap="round"
            transform="rotate(-90 32 32)"
          />
          <text x={32} y={36} textAnchor="middle" className="genui-ring-text">
            {label}
          </text>
        </svg>
        {sOf(n, 'label') ? <div className="genui-ring-label">{sOf(n, 'label')}</div> : null}
      </div>
    )
  }
  return (
    <div className="genui-progress">
      {sOf(n, 'label') ? (
        <div className="genui-progress-label">
          <span>{sOf(n, 'label')}</span>
          <span>{label}</span>
        </div>
      ) : null}
      <div className="genui-progress-track">
        <div className="genui-progress-fill" style={{ width: `${v}%` }} />
      </div>
    </div>
  )
}

function List({ n, ctx }: { n: GenuiNode; ctx: RenderCtx }): React.JSX.Element {
  return (
    <ul className="genui-list">
      {arrOf(n, 'items').map((it, i) => {
        if (typeof it === 'object' && it !== null && 'type' in (it as object)) {
          // 嵌套节点（badge 等）或 {title,desc}
          const node = it as GenuiNode
          if (node.type) {
            return (
              <li key={i} className="genui-list-item genui-list-node">
                <Node node={node} ctx={ctx} />
              </li>
            )
          }
          return (
            <li key={i} className="genui-list-item">
              <div className="genui-list-title">
                {typeof node.title === 'string' ? node.title : ''}
              </div>
              {typeof node.desc === 'string' ? (
                <div className="genui-list-desc">{node.desc}</div>
              ) : null}
            </li>
          )
        }
        return (
          <li key={i} className="genui-list-item">
            {String(it)}
          </li>
        )
      })}
    </ul>
  )
}

function KeyValue({ n }: { n: GenuiNode }): React.JSX.Element {
  return (
    <dl className="genui-kv">
      {arrOf(n, 'pairs').map((p, i) => {
        const o = (p ?? {}) as Record<string, unknown>
        return (
          <div key={i} className="genui-kv-row">
            <dt>{typeof o.key === 'string' ? o.key : ''}</dt>
            <dd>{typeof o.value === 'string' ? o.value : String(o.value ?? '')}</dd>
          </div>
        )
      })}
    </dl>
  )
}

function Avatar({ n }: { n: GenuiNode }): React.JSX.Element {
  const name = sOf(n, 'name') ?? '?'
  const ch = name.slice(0, 1)
  return (
    <span
      className="genui-avatar"
      style={sOf(n, 'color') ? { background: sOf(n, 'color') } : undefined}
    >
      {ch}
    </span>
  )
}

function Timeline({ n }: { n: GenuiNode }): React.JSX.Element {
  return (
    <ol className="genui-timeline">
      {arrOf(n, 'items').map((it, i) => {
        const o = (it ?? {}) as Record<string, unknown>
        return (
          <li key={i} className="genui-tl-item">
            <span className="genui-tl-dot" />
            <div>
              <div className="genui-tl-title">{typeof o.title === 'string' ? o.title : ''}</div>
              {typeof o.desc === 'string' ? <div className="genui-tl-desc">{o.desc}</div> : null}
              {typeof o.time === 'string' ? <div className="genui-tl-time">{o.time}</div> : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function Breadcrumb({ n }: { n: GenuiNode }): React.JSX.Element {
  const items = arrOf(n, 'items').map((x) => String(x))
  return (
    <nav className="genui-crumb">
      {items.map((x, i) => (
        <span key={i} className="genui-crumb-item">
          {i > 0 ? <span className="genui-crumb-sep">/</span> : null}
          {i === items.length - 1 ? <b>{x}</b> : x}
        </span>
      ))}
    </nav>
  )
}

function Steps({ n }: { n: GenuiNode }): React.JSX.Element {
  const cur = nOf(n, 'current') ?? 0
  return (
    <ol className="genui-steps">
      {arrOf(n, 'steps').map((it, i) => {
        const o = (it ?? {}) as Record<string, unknown>
        const state = i < cur ? 'done' : i === cur ? 'now' : 'todo'
        return (
          <li key={i} className={`genui-step genui-step-${state}`}>
            <span className="genui-step-mark">{state === 'done' ? '✓' : i + 1}</span>
            <div>
              <div className="genui-step-title">{typeof o.title === 'string' ? o.title : ''}</div>
              {typeof o.desc === 'string' ? <div className="genui-step-desc">{o.desc}</div> : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function Callout({ n }: { n: GenuiNode }): React.JSX.Element {
  const tone = sOf(n, 'tone') ?? 'info'
  return (
    <div className={`genui-callout genui-tone-${tone}`} style={{ borderLeftColor: toneVar(tone) }}>
      {sOf(n, 'title') ? (
        <div className="genui-callout-title" style={{ color: toneVar(tone) }}>
          {sOf(n, 'title')}
        </div>
      ) : null}
      <div className="genui-callout-body">{sOf(n, 'content') ?? ''}</div>
    </div>
  )
}

function CodeView({ n }: { n: GenuiNode }): React.JSX.Element {
  return (
    <pre className="genui-code" data-lang={sOf(n, 'lang') ?? ''}>
      <code>{sOf(n, 'code') ?? ''}</code>
    </pre>
  )
}

/** JSON 树查看器：对象/数组节点可折叠（默认展开 2 层），值按类型着色。
 * 复测反馈：此前只是 JSON.stringify 倒进代码块——配不上"可视化"，升级成树。 */
function JsonView({ n }: { n: GenuiNode }): React.JSX.Element {
  return (
    <div className="genui-json">
      <JsonNode value={n.value} name={null} depth={0} />
    </div>
  )
}

function JsonNode({
  value,
  name,
  depth
}: {
  value: unknown
  name: string | null
  depth: number
}): React.JSX.Element {
  const isBranch = typeof value === 'object' && value !== null
  const [open, setOpen] = useState(depth < 2)
  const label = name !== null ? <span className="genui-jk">{name}</span> : null
  // 子行渲染在父 div 内，缩进按层继承——每层只需固定 14px，不用绝对 depth
  const indent = depth === 0 ? 0 : 14
  if (!isBranch) {
    return (
      <div className="genui-jrow" style={{ paddingLeft: indent }}>
        {label}
        <span
          className={
            typeof value === 'string'
              ? 'genui-js'
              : typeof value === 'number'
                ? 'genui-jn'
                : value === null
                  ? 'genui-jnull'
                  : 'genui-jb'
          }
        >
          {typeof value === 'string' ? `"${value}"` : String(value)}
        </span>
      </div>
    )
  }
  const isArr = Array.isArray(value)
  const entries: [string, unknown][] = isArr
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>)
  return (
    <div className="genui-jrow" style={{ paddingLeft: indent }}>
      <button
        type="button"
        className="genui-jtoggle"
        onClick={() => setOpen((v) => !v)}
        aria-label="展开/折叠"
      >
        {open ? '▾' : '▸'}
      </button>
      {label}
      <span className="genui-jpunct">
        {isArr ? (open ? '[' : `[${entries.length}]`) : open ? '{' : `{${entries.length}}`}
      </span>
      {open && (
        <>
          {entries.map(([k, v]) => (
            <JsonNode key={k} value={v} name={isArr ? null : k} depth={depth + 1} />
          ))}
          <div className="genui-jclose">
            <span className="genui-jpunct">{isArr ? ']' : '}'}</span>
          </div>
        </>
      )}
    </div>
  )
}

function Diff({ n }: { n: GenuiNode }): React.JSX.Element {
  return (
    <div className="genui-diff">
      {arrOf(n, 'diffs').map((d, i) => {
        const o = (d ?? {}) as Record<string, unknown>
        const oldT = typeof o.oldText === 'string' ? o.oldText : null
        const newT = typeof o.newText === 'string' ? o.newText : null
        return (
          <div key={i} className="genui-diff-file">
            {typeof o.path === 'string' ? <div className="genui-diff-path">{o.path}</div> : null}
            {oldT
              ? oldT.split('\n').map((l, j) => (
                  <div key={`o${j}`} className="genui-diff-line del">
                    - {l}
                  </div>
                ))
              : null}
            {newT
              ? newT.split('\n').map((l, j) => (
                  <div key={`n${j}`} className="genui-diff-line add">
                    + {l}
                  </div>
                ))
              : null}
          </div>
        )
      })}
    </div>
  )
}

function FileTree({ n }: { n: GenuiNode }): React.JSX.Element {
  return <div className="genui-tree">{renderTree(arrOf(n, 'items'))}</div>
}

function renderTree(items: unknown[], depth = 0): React.ReactNode {
  return items.map((raw, i) => {
    const o = (raw ?? {}) as Record<string, unknown>
    const isDir = o.type === 'dir'
    // 子树字段容错：技能示例与多数模型写 children，也有模型按容器惯例写 items——都认
    const children = Array.isArray(o.children)
      ? (o.children as unknown[])
      : Array.isArray(o.items)
        ? (o.items as unknown[])
        : []
    return (
      <TreeRow key={i} name={String(o.name ?? '')} isDir={isDir} depth={depth} entries={children} />
    )
  })
}

function TreeRow({
  name,
  isDir,
  depth,
  entries
}: {
  name: string
  isDir: boolean
  depth: number
  entries: unknown[]
}): React.JSX.Element {
  const [open, setOpen] = useState(depth < 2)
  if (!isDir || entries.length === 0) {
    return (
      <div className="genui-tree-row" style={{ paddingLeft: depth * 14 }}>
        <span className="genui-tree-icon">{isDir ? '📂' : '📄'}</span>
        <span>{name}</span>
      </div>
    )
  }
  return (
    <>
      <div
        className="genui-tree-row genui-tree-dir"
        style={{ paddingLeft: depth * 14 }}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="genui-tree-caret">{open ? '▾' : '▸'}</span>
        <span className="genui-tree-icon">{open ? '📂' : '📁'}</span>
        <span>{name}</span>
      </div>
      {open ? renderTree(entries, depth + 1) : null}
    </>
  )
}

// ── 表格（排序/过滤/展开明细/delta 着色/合计/导出）────────────────────────

function Table({ n }: { n: GenuiNode }): React.JSX.Element {
  const columns = arrOf(n, 'columns').map((c) => String(c))
  const rawRows = arrOf(n, 'rows').map((r) => (Array.isArray(r) ? r.map((c) => String(c)) : []))
  const types = arrOf(n, 'types').map((t) => String(t))
  const details = arrOf(n, 'details')
  const [sort, setSort] = useState<{ col: number; dir: 0 | 1 | -1 }>({ col: -1, dir: 0 })
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  const rows = useMemo(() => {
    let r = rawRows.map((row, idx) => ({ row, idx }))
    if (filter.trim()) {
      const q = filter.trim().toLowerCase()
      r = r.filter(({ row }) => row.some((c) => c.toLowerCase().includes(q)))
    }
    if (sort.col >= 0 && sort.dir !== 0) {
      const { col, dir } = sort
      r = [...r].sort((a, b) => {
        const av = a.row[col] ?? ''
        const bv = b.row[col] ?? ''
        const an = parseNum(av)
        const bn = parseNum(bv)
        if (an !== null && bn !== null) return (an - bn) * dir
        return av.localeCompare(bv) * dir
      })
    }
    return r
  }, [rawRows, filter, sort])

  const numericRightAligned = columns.map(
    (_, c) =>
      rows.length > 0 && rows.every(({ row }) => row[c] === undefined || parseNum(row[c]) !== null)
  )

  const total = bOf(n, 'total')
  const totals = useMemo(() => {
    if (!total) return null
    return columns.map((_, c) => {
      const cells = rows.map(({ row }) => row[c] ?? '')
      const nums = cells.map((t) => parseNum(t)).filter((x): x is number => x !== null)
      if (nums.length === 0 || nums.length < rows.length) return ''
      // ★ 修：百分比列求和出 484% 这种无意义数字——
      // 整列都带 % 时合计行改为「平均」
      const isPct = cells.every((t) => /[％%]\s*$/.test(t.trim()))
      if (isPct)
        return `${fmtNum(Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10)}%`
      return fmtNum(nums.reduce((a, b) => a + b, 0))
    })
  }, [total, columns, rows])

  const exportMd = (): string =>
    `| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n${rawRows.map((r) => `| ${r.join(' | ')} |`).join('\n')}`
  const exportCsv = (): string =>
    [columns, ...rawRows]
      .map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(','))
      .join('\n')

  const clickHead = (c: number): void =>
    setSort((s) =>
      s.col !== c ? { col: c, dir: 1 } : { col: c, dir: s.dir === 1 ? -1 : s.dir === -1 ? 0 : 1 }
    )

  return (
    <div className="genui-table-wrap">
      {bOf(n, 'export') ? (
        <div className="genui-table-tools">
          <button
            type="button"
            className="genui-mini-btn"
            onClick={() => void navigator.clipboard.writeText(exportMd())}
          >
            复制 Markdown
          </button>
          <button
            type="button"
            className="genui-mini-btn"
            onClick={() => void navigator.clipboard.writeText(exportCsv())}
          >
            复制 CSV
          </button>
        </div>
      ) : null}
      {sOf(n, 'filter') === '__inline__' || bOf(n, 'filter') ? (
        <input
          className="genui-table-filter"
          placeholder="输入以筛选…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      ) : null}
      <table className="genui-table">
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th
                key={i}
                onClick={() => clickHead(i)}
                className={numericRightAligned[i] ? 'genui-num' : ''}
              >
                {c}
                {sort.col === i && sort.dir !== 0 ? (
                  <span className="genui-sort">{sort.dir === 1 ? '▲' : '▼'}</span>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ row, idx }) =>
            // ★ 修：group 列此前只有样式无合并逻辑。
            // 规范语义：types[0]==='group' 且整行只有首格有内容 → 渲染成跨列分组小标题行。
            types[0] === 'group' &&
            row.length > 1 &&
            row.slice(1).every((c) => c === '' || c === undefined) ? (
              <tr key={idx} className="genui-group-row">
                <td colSpan={columns.length} className="genui-cell-group">
                  {row[0]}
                </td>
              </tr>
            ) : (
              <Fragment key={idx}>
                <tr>
                  {row.map((cell, c) => {
                    const t = types[c]
                    const hasDetail = details[idx] != null
                    return (
                      <td
                        key={c}
                        className={numericRightAligned[c] || t === 'num' ? 'genui-num' : ''}
                      >
                        {c === 0 && hasDetail ? (
                          <button
                            type="button"
                            className="genui-expand"
                            onClick={() =>
                              setExpanded((s) => {
                                const x = new Set(s)
                                if (x.has(idx)) x.delete(idx)
                                else x.add(idx)
                                return x
                              })
                            }
                          >
                            {expanded.has(idx) ? '▾' : '▸'}
                          </button>
                        ) : null}
                        <Cell type={t} text={cell} />
                      </td>
                    )
                  })}
                </tr>
                {expanded.has(idx) && details[idx] != null ? (
                  <tr className="genui-detail-row">
                    <td colSpan={columns.length}>
                      <DetailCell value={details[idx]} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            )
          )}
          {totals ? (
            <tr className="genui-total-row">
              {columns.map((_, c) => (
                <td key={c} className={numericRightAligned[c] ? 'genui-num' : ''}>
                  {c === 0 ? '合计' : totals[c]}
                </td>
              ))}
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}

function Cell({ type, text }: { type: string | undefined; text: string }): React.JSX.Element {
  if (type === 'bar') {
    const v = Math.max(0, Math.min(100, parseNum(text) ?? 0))
    return (
      <span className="genui-cell-bar">
        <span className="genui-cell-bar-fill" style={{ width: `${v}%` }} />
        {text}
      </span>
    )
  }
  if (type === 'badge') return <Badge n={{ type: 'badge', label: text, tone: 'accent' }} />
  if (type === 'delta') return <span style={{ color: deltaVar(text) ?? undefined }}>{text}</span>
  if (type === 'spark') {
    const vals = text
      .split(',')
      .map((x) => Number.parseFloat(x))
      .filter((x) => Number.isFinite(x))
    return vals.length >= 2 ? <Spark values={vals} /> : <>{text}</>
  }
  if (type === 'group') return <span className="genui-cell-group">{text}</span>
  const dv = deltaVar(text)
  return <span style={dv ? { color: dv } : undefined}>{text}</span>
}

function DetailCell({ value }: { value: unknown }): React.JSX.Element {
  if (typeof value === 'object' && value !== null && 'type' in (value as object)) {
    return <Node node={value as GenuiNode} ctx={EMPTY_CTX} />
  }
  return <>{String(value ?? '')}</>
}

const EMPTY_CTX: RenderCtx = { dispatch: () => {}, fields: new Map(), groups: new Map() }

// ── 图表（手写 SVG，配色走 --genui-* 自动跟随主题）─────────────────────────

interface Datum {
  label: string
  value: number
  color?: string
}
function dataOf(n: GenuiNode): Datum[] {
  return arrOf(n, 'data')
    .map((d) => {
      const o = (d ?? {}) as Record<string, unknown>
      return {
        label: String(o.label ?? ''),
        value: typeof o.value === 'number' ? o.value : 0,
        color: typeof o.color === 'string' ? o.color : undefined
      }
    })
    .filter((d) => Number.isFinite(d.value))
}

function Chart({ n }: { n: GenuiNode }): React.JSX.Element {
  const kind = sOf(n, 'kind') ?? 'bars'
  const palette = paletteOf(n)
  const data = dataOf(n)
  interface SeriesEntry {
    label: string
    data: number[]
    color: string
    // 单序列时逐数据点的 color（data[].color）优先于序列色
    colors?: (string | undefined)[]
  }
  const series: SeriesEntry[] = arrOf(n, 'series').map((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>
    const vals = Array.isArray(o.data)
      ? (o.data as unknown[]).map((x) => (typeof x === 'number' ? x : Number(x) || 0))
      : data.map((d) => d.value)
    return {
      label: String(o.label ?? `序列${i + 1}`),
      data: vals,
      color: palette[i % palette.length]
    }
  })
  // ★ 修（SSR 冒烟测试抓到）：只有 data 没有 series 的单序列图，此前 series=[] 导致
  // 柱子/折线分支不产出任何图形——这里合成单序列，并把逐点 color 带进去
  const eff =
    series.length > 0
      ? series
      : data.length > 0
        ? [
            {
              label: '',
              data: data.map((d) => d.value),
              color: palette[0],
              colors: data.map((d) => d.color)
            }
          ]
        : []
  const cats =
    data.length > 0 ? data.map((d) => d.label) : (eff[0]?.data.map((_, i) => String(i)) ?? [])
  if (kind === 'donut') return <Donut data={data} palette={palette} title={sOf(n, 'title')} />
  // ★ 修：horizontal:true 此前只隐藏了竖排标签、柱子仍竖画——
  // 补真正的横向柱状图（排行/长标签场景）。line/donut 不适用横向。
  if (kind !== 'line' && bOf(n, 'horizontal'))
    return <HBars series={eff} cats={cats} stacked={bOf(n, 'stacked')} title={sOf(n, 'title')} />
  return (
    <BarsLine
      series={eff}
      cats={cats}
      horizontal={bOf(n, 'horizontal')}
      stacked={bOf(n, 'stacked')}
      title={sOf(n, 'title')}
      line={kind === 'line'}
    />
  )
}

function BarsLine({
  series,
  cats,
  horizontal,
  stacked,
  title,
  line
}: {
  series: { label: string; data: number[]; color: string; colors?: (string | undefined)[] }[]
  cats: string[]
  horizontal: boolean
  stacked: boolean
  title?: string
  line: boolean
}): React.JSX.Element {
  const W = 480
  const H = 240
  const padL = 44
  const padB = 28
  const padT = 12
  const padR = 12
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const allVals = series.flatMap((s) => s.data)
  const maxV = Math.max(0, ...allVals)
  const minV = Math.min(0, ...allVals)
  const span = maxV - minV || 1
  const y = (v: number): number => padT + plotH - ((v - minV) / span) * plotH
  const zeroY = y(0)
  const nCats = Math.max(1, cats.length)
  const band = plotW / nCats
  const grid = ticks(minV, maxV)
  return (
    <div className="genui-chart">
      {title ? <div className="genui-chart-title">{title}</div> : null}
      <svg viewBox={`0 0 ${W} ${H}`} className="genui-svg" role="img">
        {grid.map((g, i) => (
          <g key={i}>
            <line
              x1={padL}
              y1={y(g)}
              x2={W - padR}
              y2={y(g)}
              style={{ stroke: 'var(--line)' }}
              strokeWidth={1}
            />
            <text x={padL - 6} y={y(g) + 3} textAnchor="end" className="genui-axis">
              {shortNum(g)}
            </text>
          </g>
        ))}
        <line
          x1={padL}
          y1={zeroY}
          x2={W - padR}
          y2={zeroY}
          style={{ stroke: 'var(--line-strong)' }}
          strokeWidth={1}
        />
        {horizontal
          ? null
          : cats.map((c, i) => (
              <text
                key={i}
                x={padL + band * (i + 0.5)}
                y={H - 8}
                textAnchor="middle"
                className="genui-axis"
              >
                {clip(c)}
              </text>
            ))}
        {line
          ? series.map((s, si) => (
              <polyline
                key={si}
                fill="none"
                style={{ stroke: s.color }}
                strokeWidth={2}
                points={s.data.map((v, i) => `${padL + band * (i + 0.5)},${y(v)}`).join(' ')}
              />
            ))
          : series.map((s, si) =>
              s.data.map((v, i) => {
                const bw = stacked ? band * 0.6 : (band * 0.6) / series.length
                const x = padL + band * i + band * 0.2 + (stacked ? 0 : si * bw)
                const top = y(v)
                const h = Math.abs(zeroY - top)
                return (
                  <rect
                    key={`${si}-${i}`}
                    x={x}
                    y={Math.min(top, zeroY)}
                    width={bw}
                    height={h}
                    style={{ fill: s.colors?.[i] ?? s.color }}
                    rx={2}
                  />
                )
              })
            )}
      </svg>
      {series.length > 1 ? <Legend series={series} /> : null}
    </div>
  )
}

/** 横向柱状图（排行/长标签）：分类在纵轴、数值在横轴；支持分组与堆叠 */
function HBars({
  series,
  cats,
  stacked,
  title
}: {
  series: { label: string; data: number[]; color: string; colors?: (string | undefined)[] }[]
  cats: string[]
  stacked: boolean
  title?: string
}): React.JSX.Element {
  const W = 480
  const rowH = 30
  const padT = 10
  const padB = 22
  const padL = 96
  const padR = 44
  const H = padT + padB + Math.max(1, cats.length) * rowH
  const plotW = W - padL - padR
  const allVals = series.flatMap((s) => s.data)
  const maxV = Math.max(0, ...allVals)
  const minV = Math.min(0, ...allVals)
  const span = maxV - minV || 1
  const x = (v: number): number => padL + ((v - minV) / span) * plotW
  const zeroX = x(0)
  const grid = ticks(minV, maxV)
  return (
    <div className="genui-chart">
      {title ? <div className="genui-chart-title">{title}</div> : null}
      <svg viewBox={`0 0 ${W} ${H}`} className="genui-svg" role="img">
        {grid.map((g, i) => (
          <g key={i}>
            <line
              x1={x(g)}
              y1={padT}
              x2={x(g)}
              y2={H - padB}
              style={{ stroke: 'var(--line)' }}
              strokeWidth={1}
            />
            <text x={x(g)} y={H - padB + 14} textAnchor="middle" className="genui-axis">
              {shortNum(g)}
            </text>
          </g>
        ))}
        <line
          x1={zeroX}
          y1={padT}
          x2={zeroX}
          y2={H - padB}
          style={{ stroke: 'var(--line-strong)' }}
          strokeWidth={1}
        />
        {cats.map((c, i) => {
          const bandY = padT + i * rowH
          const barH = stacked ? rowH * 0.6 : (rowH * 0.6) / series.length
          const baseY = bandY + rowH * 0.2 + (stacked ? 0 : 0)
          let accX = zeroX // 堆叠时段的起点累加
          return (
            <g key={i}>
              <text x={padL - 8} y={bandY + rowH / 2 + 3} textAnchor="end" className="genui-axis">
                {c.length > 10 ? `${c.slice(0, 10)}…` : c}
              </text>
              {series.map((s, si) => {
                const v = s.data[i] ?? 0
                const w = Math.abs(x(v) - zeroX)
                if (stacked) {
                  const x0 = accX
                  accX += x(v) - zeroX
                  return (
                    <rect
                      key={`${si}-${i}`}
                      x={Math.min(x0, accX)}
                      y={baseY}
                      width={w}
                      height={barH}
                      style={{ fill: s.color }}
                      rx={2}
                    />
                  )
                }
                const y0 = bandY + rowH * 0.2 + si * barH
                return (
                  <rect
                    key={`${si}-${i}`}
                    x={Math.min(zeroX, x(v))}
                    y={y0}
                    width={w}
                    height={barH}
                    style={{ fill: s.colors?.[i] ?? s.color }}
                    rx={2}
                  />
                )
              })}
              {/* 单序列：条尾标数值（排行场景读图不用再瞄轴） */}
              {series.length === 1
                ? (() => {
                    const v = series[0]?.data[i] ?? 0
                    return (
                      <text
                        x={x(v) + 5}
                        y={baseY + rowH * 0.3}
                        className="genui-axis"
                        textAnchor="start"
                      >
                        {shortNum(v)}
                      </text>
                    )
                  })()
                : null}
            </g>
          )
        })}
      </svg>
      {series.length > 1 ? <Legend series={series} /> : null}
    </div>
  )
}

function Donut({
  data,
  palette,
  title
}: {
  data: Datum[]
  palette: string[]
  title?: string
}): React.JSX.Element {
  const total = data.reduce((a, b) => a + b.value, 0) || 1
  // 纯函数式算扇区起止（渲染期不用可变累加器，React Compiler 规则）：
  // start_i = 前 i 项占比之和，end_i = 前 i+1 项占比之和
  const cum = data.reduce<number[]>(
    (accList, d, i) => [...accList, (accList[i - 1] ?? 0) + d.value / total],
    []
  )
  const segs = data.map((d, i) => ({
    d,
    start: i === 0 ? 0 : (cum[i - 1] ?? 0),
    end: cum[i] ?? 1,
    color: d.color ?? palette[i % palette.length]
  }))
  return (
    <div className="genui-chart">
      {title ? <div className="genui-chart-title">{title}</div> : null}
      <div className="genui-donut-row">
        <svg viewBox="0 0 120 120" width={130} height={130} className="genui-svg">
          {segs.map((s, i) => (
            <path key={i} d={arc(60, 60, 50, 30, s.start, s.end)} style={{ fill: s.color }} />
          ))}
        </svg>
        <ul className="genui-legend">
          {segs.map((s, i) => (
            <li key={i}>
              <span className="genui-legend-dot" style={{ background: s.color }} />
              {s.d.label} <b>{Math.round((s.d.value / total) * 100)}%</b>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function arc(cx: number, cy: number, rO: number, rI: number, a0: number, a1: number): string {
  const pol = (r: number, a: number): [number, number] => {
    const t = a * 2 * Math.PI - Math.PI / 2
    return [cx + r * Math.cos(t), cy + r * Math.sin(t)]
  }
  const large = a1 - a0 > 0.5 ? 1 : 0
  const [x0, y0] = pol(rO, a0)
  const [x1, y1] = pol(rO, a1)
  const [x2, y2] = pol(rI, a1)
  const [x3, y3] = pol(rI, a0)
  return `M${x0} ${y0} A${rO} ${rO} 0 ${large} 1 ${x1} ${y1} L${x2} ${y2} A${rI} ${rI} 0 ${large} 0 ${x3} ${y3} Z`
}

function Legend({ series }: { series: { label: string; color: string }[] }): React.JSX.Element {
  return (
    <ul className="genui-legend genui-legend-h">
      {series.map((s, i) => (
        <li key={i}>
          <span className="genui-legend-dot" style={{ background: s.color }} />
          {s.label}
        </li>
      ))}
    </ul>
  )
}

function ticks(min: number, max: number): number[] {
  if (max === min) return [min]
  const step = niceStep((max - min) / 4)
  const start = Math.ceil(min / step) * step
  const out: number[] = []
  for (let v = start; v <= max + 1e-9 && out.length < 8; v += step)
    out.push(Math.round(v * 1000) / 1000)
  return out
}
function niceStep(raw: number): number {
  const mag = 10 ** Math.floor(Math.log10(raw || 1))
  const norm = raw / mag
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
}
function shortNum(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e8) return `${(v / 1e8).toFixed(1)}亿`
  if (a >= 1e4) return `${(v / 1e4).toFixed(1)}万`
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`
  return String(Math.round(v * 100) / 100)
}
function clip(s: string): string {
  return s.length > 6 ? `${s.slice(0, 6)}…` : s
}

// ── echart：无 ECharts 引擎，preset 映射到内置图表，full option 降级提示 ──

function EChart({ n }: { n: GenuiNode }): React.JSX.Element {
  const preset = sOf(n, 'preset')
  if (n.option !== undefined) {
    return (
      <Callout
        n={{
          type: 'callout',
          tone: 'warning',
          title: 'ECharts 完整配置暂不支持',
          content:
            '当前渲染器无 ECharts 引擎（离线 + 锁依赖）。请改用 chart/plot 组件或 echart 的 preset 模式。'
        }}
      />
    )
  }
  const map: Record<string, string> = {
    bar: 'bars',
    line: 'line',
    area: 'line',
    pie: 'donut',
    scatter: 'bars',
    funnel: 'donut',
    treemap: 'donut'
  }
  const kind = preset ? (map[preset] ?? 'bars') : 'bars'
  return <Chart n={{ type: 'chart', kind, data: n.data, series: n.series, title: n.title }} />
}

// ── plot：函数图 + 参数滑块（本地重绘，零往返）──────────────────────────────

function Plot({ n }: { n: GenuiNode }): React.JSX.Element {
  const palette = paletteOf(n)
  const series = arrOf(n, 'series').map((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>
    const params = Array.isArray(o.params)
      ? (o.params as unknown[]).map((p) => {
          const po = (p ?? {}) as Record<string, unknown>
          return {
            name: String(po.name ?? 'p'),
            value: typeof po.value === 'number' ? po.value : 1,
            min: typeof po.min === 'number' ? po.min : 0,
            max: typeof po.max === 'number' ? po.max : 5
          }
        })
      : []
    return {
      expr: String(o.expr ?? 'x'),
      label: String(o.label ?? `y${i + 1}`),
      color: typeof o.color === 'string' ? o.color : palette[i % palette.length],
      params
    }
  })
  const xMin = nOf(n, 'xMin') ?? -6.28
  const xMax = nOf(n, 'xMax') ?? 6.28
  const [pvals, setPvals] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {}
    series.forEach((s, si) =>
      s.params.forEach((p) => {
        init[`${si}:${p.name}`] = p.value
      })
    )
    return init
  })
  const W = 480
  const H = 240
  const padL = 40
  const padB = 24
  const padT = 10
  const padR = 10
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const N = 160
  const evalSeries = (s: (typeof series)[number], si: number): { xs: number; ys: number }[] => {
    const scope: Record<string, number> = {}
    s.params.forEach((p) => {
      scope[p.name] = pvals[`${si}:${p.name}`] ?? p.value
    })
    const pts: { xs: number; ys: number }[] = []
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i <= N; i++) {
      const x = xMin + ((xMax - xMin) * i) / N
      scope.x = x
      const y = evalExpr(s.expr, scope)
      if (Number.isFinite(y)) {
        pts.push({ xs: x, ys: y })
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    void minY
    void maxY
    return pts
  }
  const allPts = series.map((s, si) => evalSeries(s, si))
  const ys = allPts.flat().map((p) => p.ys)
  const yMin = ys.length ? Math.min(...ys) : -1
  const yMax = ys.length ? Math.max(...ys) : 1
  const ySpan = yMax - yMin || 1
  const px = (x: number): number => padL + ((x - xMin) / (xMax - xMin || 1)) * plotW
  const py = (v: number): number => padT + plotH - ((v - yMin) / ySpan) * plotH
  return (
    <div className="genui-chart">
      {sOf(n, 'title') ? <div className="genui-chart-title">{sOf(n, 'title')}</div> : null}
      <svg viewBox={`0 0 ${W} ${H}`} className="genui-svg">
        {ticks(yMin, yMax).map((g, i) => (
          <g key={i}>
            <line x1={padL} y1={py(g)} x2={W - padR} y2={py(g)} style={{ stroke: 'var(--line)' }} />
            <text x={padL - 5} y={py(g) + 3} textAnchor="end" className="genui-axis">
              {shortNum(g)}
            </text>
          </g>
        ))}
        {yMin < 0 && yMax > 0 ? (
          <line
            x1={padL}
            y1={py(0)}
            x2={W - padR}
            y2={py(0)}
            style={{ stroke: 'var(--line-strong)' }}
          />
        ) : null}
        {allPts.map((pts, si) => (
          <polyline
            key={si}
            fill="none"
            style={{ stroke: series[si]?.color ?? 'var(--accent)' }}
            strokeWidth={2}
            points={pts.map((p) => `${px(p.xs)},${py(p.ys)}`).join(' ')}
          />
        ))}
      </svg>
      {series.map((s, si) =>
        s.params.map((p) => {
          const key = `${si}:${p.name}`
          return (
            <label key={key} className="genui-param">
              <span>{p.name}</span>
              <input
                type="range"
                min={p.min}
                max={p.max}
                step={(p.max - p.min) / 100}
                value={pvals[key] ?? p.value}
                onChange={(e) => setPvals((m) => ({ ...m, [key]: Number(e.target.value) }))}
              />
              <code>{(pvals[key] ?? p.value).toFixed(2)}</code>
            </label>
          )
        })
      )}
    </div>
  )
}

// ── 交互组件（本地优先；回传走 dispatch）───────────────────────────────────

function Button({ n, ctx }: { n: GenuiNode; ctx: RenderCtx }): React.JSX.Element {
  const action = sOf(n, 'action')
  const [fired, setFired] = useState(false)
  const tone = sOf(n, 'tone') ?? 'primary'
  const disabled = !action
  return (
    <button
      type="button"
      disabled={disabled}
      className={`genui-btn genui-btn-${tone}${bOf(n, 'full') ? ' genui-btn-full' : ''}${bOf(n, 'small') ? ' genui-btn-sm' : ''}`}
      onClick={() => {
        if (action) {
          setFired(true)
          ctx.dispatch({ action, label: sOf(n, 'label') ?? '' })
        }
      }}
    >
      {sOf(n, 'icon') ? `${sOf(n, 'icon')} ` : ''}
      {sOf(n, 'label') ?? ''}
      {fired && !disabled ? <span className="genui-fired">· 已触发</span> : null}
    </button>
  )
}

function Link({ n }: { n: GenuiNode }): React.JSX.Element {
  const href = sOf(n, 'href')
  const safe = href && /^https?:|^mailto:/i.test(href) ? href : undefined
  if (!safe) return <span className="genui-link-plain">{sOf(n, 'label') ?? ''}</span>
  return (
    <a
      className="genui-link"
      href={safe}
      onClick={(e) => {
        e.preventDefault()
        void window.petAPI.openExternal(safe)
      }}
    >
      {sOf(n, 'label') ?? safe}
    </a>
  )
}

function Copy({ n }: { n: GenuiNode }): React.JSX.Element {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="genui-mini-btn"
      onClick={() => {
        void navigator.clipboard.writeText(sOf(n, 'text') ?? '')
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? '已复制' : (sOf(n, 'label') ?? '复制')}
    </button>
  )
}

function Input({ n, ctx }: { n: GenuiNode; ctx: RenderCtx }): React.JSX.Element {
  const id = sOf(n, 'id')
  const action = sOf(n, 'action')
  const [v, setV] = useState(sOf(n, 'value') ?? '')
  const lastSent = useRef(sOf(n, 'value') ?? '')
  if (id) ctx.fields.set(id, { value: v })
  const fire = (submit: boolean): void => {
    if (action && (submit || v !== lastSent.current)) {
      ctx.dispatch({ action, value: v, id, submit })
      lastSent.current = v
    }
  }
  return (
    <label className="genui-field">
      {sOf(n, 'label') ? <span className="genui-field-label">{sOf(n, 'label')}</span> : null}
      <input
        type={sOf(n, 'inputType') ?? 'text'}
        placeholder={sOf(n, 'placeholder') ?? ''}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => fire(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') fire(true)
        }}
      />
    </label>
  )
}

function Textarea({ n, ctx }: { n: GenuiNode; ctx: RenderCtx }): React.JSX.Element {
  const id = sOf(n, 'id')
  const action = sOf(n, 'action')
  const [v, setV] = useState(sOf(n, 'value') ?? '')
  const last = useRef(sOf(n, 'value') ?? '')
  if (id) ctx.fields.set(id, { value: v })
  const fire = (submit: boolean): void => {
    if (action && (submit || v !== last.current)) {
      ctx.dispatch({ action, value: v, id })
      last.current = v
    }
  }
  return (
    <label className="genui-field">
      {sOf(n, 'label') ? <span className="genui-field-label">{sOf(n, 'label')}</span> : null}
      <textarea
        rows={nOf(n, 'rows') ?? 4}
        placeholder={sOf(n, 'placeholder') ?? ''}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => fire(false)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') fire(true)
        }}
      />
    </label>
  )
}

function Select({ n, ctx }: { n: GenuiNode; ctx: RenderCtx }): React.JSX.Element {
  const id = sOf(n, 'id')
  const action = sOf(n, 'action')
  const options = arrOf(n, 'options').map((o) => String(o))
  const [sel, setSel] = useState<number>(() => {
    const s = nOf(n, 'selected')
    return s ?? -1
  })
  if (id) ctx.fields.set(id, { value: sel >= 0 ? options[sel] : '' })
  return (
    <label className="genui-field">
      {sOf(n, 'label') ? <span className="genui-field-label">{sOf(n, 'label')}</span> : null}
      <select
        value={sel}
        onChange={(e) => {
          const i = Number(e.target.value)
          setSel(i)
          if (id) ctx.fields.set(id, { value: options[i] })
          if (action) ctx.dispatch({ action, value: options[i], id })
        }}
      >
        <option value={-1} disabled>
          请选择…
        </option>
        {options.map((o, i) => (
          <option key={i} value={i}>
            {o}
          </option>
        ))}
      </select>
    </label>
  )
}

function Slider({ n, ctx }: { n: GenuiNode; ctx: RenderCtx }): React.JSX.Element {
  const min = nOf(n, 'min') ?? 0
  const max = nOf(n, 'max') ?? 100
  const id = sOf(n, 'id')
  const action = sOf(n, 'action')
  const [v, setV] = useState(nOf(n, 'value') ?? min)
  if (id) ctx.fields.set(id, { value: v })
  return (
    <label className="genui-field genui-slider">
      {sOf(n, 'label') ? (
        <span className="genui-field-label">
          {sOf(n, 'label')} <b>{v}</b>
        </span>
      ) : null}
      <input
        type="range"
        min={min}
        max={max}
        step={nOf(n, 'step') ?? 1}
        value={v}
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={() => {
          if (action) ctx.dispatch({ action, value: v, id })
        }}
      />
    </label>
  )
}

function Switch({ n, ctx }: { n: GenuiNode; ctx: RenderCtx }): React.JSX.Element {
  const action = sOf(n, 'action')
  const [on, setOn] = useState(bOf(n, 'checked'))
  return (
    <label className="genui-switch">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => {
          const val = e.target.checked
          setOn(val)
          if (action) ctx.dispatch({ action, value: val, label: sOf(n, 'label') })
        }}
      />
      <span className="genui-switch-track">
        <span className="genui-switch-thumb" />
      </span>
      <span>{sOf(n, 'label') ?? ''}</span>
    </label>
  )
}

function Checkbox({ n, ctx }: { n: GenuiNode; ctx: RenderCtx }): React.JSX.Element {
  const group = sOf(n, 'group')
  const action = sOf(n, 'action')
  const label = sOf(n, 'label') ?? ''
  const [on, setOn] = useState(bOf(n, 'checked'))
  // 分组模式：渲染期累积注册（同组多个 checkbox 按渲染顺序汇入同一 group），
  // 这样每次重渲染生成的新 ctx 都能被重新填满，submit 点击时读到最新勾选集。
  if (group) {
    const g = ctx.groups.get(group) ?? { values: [], answered: false }
    if (on && !g.values.includes(label)) g.values.push(label)
    if (!on) g.values = g.values.filter((x) => x !== label)
    g.answered = g.values.length > 0
    ctx.groups.set(group, g)
  }
  const toggle = (val: boolean): void => {
    setOn(val)
    if (!group && action) ctx.dispatch({ action, value: val, label })
  }
  return (
    <label className="genui-check">
      <input type="checkbox" checked={on} onChange={(e) => toggle(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

function Radio({ n, ctx }: { n: GenuiNode; ctx: RenderCtx }): React.JSX.Element {
  const group = sOf(n, 'group')
  const options = arrOf(n, 'options').map((o) => String(o))
  const action = sOf(n, 'action')
  const [sel, setSel] = useState(-1)
  const answer = answerIdx(n, options)
  const explanation = sOf(n, 'explanation')
  // 分组模式：渲染期注册当前选择（同上，保证新 ctx 被重新填满）
  if (group) ctx.groups.set(group, { values: sel >= 0 ? [options[sel]] : [], answered: sel >= 0 })
  const pick = (i: number): void => {
    setSel(i)
    if (!group && action) ctx.dispatch({ action, value: options[i], label: sOf(n, 'label') })
  }
  const showGrade = !group && answer !== null && sel >= 0
  return (
    <div className="genui-radio">
      {sOf(n, 'label') ? <div className="genui-field-label">{sOf(n, 'label')}</div> : null}
      {options.map((o, i) => (
        <label
          key={i}
          className={`genui-radio-opt${showGrade ? (i === answer ? ' genui-correct' : sel === i ? ' genui-wrong' : '') : ''}`}
        >
          <input type="radio" checked={sel === i} onChange={() => pick(i)} />
          <span>{o}</span>
        </label>
      ))}
      {showGrade ? (
        <div className="genui-grade">
          {sel === answer ? '✓ 正确' : '✗ 错误'}
          {explanation ? <span className="genui-explain">｜{explanation}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

function answerIdx(n: GenuiNode, options: string[]): number | null {
  const a = n['answer']
  if (typeof a === 'number') return a
  if (typeof a === 'string') {
    const i = options.indexOf(a)
    return i >= 0 ? i : null
  }
  return null
}

// submit：聚合 radio/checkbox 分组的答案 + 表单域，一次 dispatch 回传模型。
// 注意：ready 不能渲染期算——子组件在父之后才渲染注册进 ctx.groups，
// 渲染期永远是空。改为点击时读最新值校验，缺题给本地提示（零往返）。
function Submit({ n, ctx }: { n: GenuiNode; ctx: RenderCtx }): React.JSX.Element {
  const groups = arrOf(n, 'groups').map((g) => String(g))
  const [sent, setSent] = useState(false)
  const [hint, setHint] = useState('')
  const onClick = (): void => {
    if (sent) return
    const answers: Record<string, unknown> = {}
    const missing: string[] = []
    groups.forEach((g) => {
      const entry = ctx.groups.get(g)
      if (entry?.answered === true && entry.values.length > 0) {
        answers[g] = entry.values.length === 1 ? entry.values[0] : entry.values
      } else {
        missing.push(g)
      }
    })
    if (missing.length > 0) {
      setHint(`还有 ${missing.length} 组未作答`)
      return
    }
    const fields: Record<string, unknown> = {}
    ctx.fields.forEach((v, k) => {
      fields[k] = v.value
    })
    setSent(true)
    setHint('')
    ctx.dispatch({
      action: sOf(n, 'action') ?? 'submit',
      answers,
      fields,
      total: groups.length,
      answered: groups.length
    })
  }
  return (
    <div className="genui-submit">
      <button
        type="button"
        className="genui-btn genui-btn-primary"
        disabled={sent}
        onClick={onClick}
      >
        {sOf(n, 'label') ?? '交卷'}
      </button>
      {sent ? (
        <span className="genui-submit-hint">已提交（{groups.length} 项）</span>
      ) : hint ? (
        <span className="genui-submit-hint">{hint}</span>
      ) : null}
    </div>
  )
}

function Tabs({ n, ctx }: { n: GenuiNode; ctx: RenderCtx }): React.JSX.Element {
  const tabs = arrOf(n, 'tabs').map((t) => {
    const o = (t ?? {}) as Record<string, unknown>
    return {
      label: String(o.label ?? ''),
      items: Array.isArray(o.items) ? (o.items as GenuiNode[]) : []
    }
  })
  const [i, setI] = useState(0)
  return (
    <div className="genui-tabs">
      <div className="genui-tabs-bar">
        {tabs.map((t, k) => (
          <button
            key={k}
            type="button"
            className={`genui-tab${k === i ? ' genui-tab-on' : ''}`}
            onClick={() => setI(k)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="genui-tabs-panel">
        {tabs[i] ? tabs[i]?.items.map((it, j) => <Node key={j} node={it} ctx={ctx} />) : null}
      </div>
    </div>
  )
}

function Accordion({ n, ctx }: { n: GenuiNode; ctx: RenderCtx }): React.JSX.Element {
  const items = arrOf(n, 'items').map((it) => {
    const o = (it ?? {}) as Record<string, unknown>
    return {
      title: String(o.title ?? ''),
      items: Array.isArray(o.items) ? (o.items as GenuiNode[]) : []
    }
  })
  const [open, setOpen] = useState<Set<number>>(new Set([0]))
  return (
    <div className="genui-accordion">
      {items.map((it, i) => (
        <div key={i} className="genui-acc-item">
          <button
            type="button"
            className="genui-acc-head"
            onClick={() =>
              setOpen((s) => {
                const x = new Set(s)
                if (x.has(i)) x.delete(i)
                else x.add(i)
                return x
              })
            }
          >
            <span className="genui-acc-caret">{open.has(i) ? '▾' : '▸'}</span>
            {it.title}
          </button>
          {open.has(i) ? (
            <div className="genui-acc-body">
              {it.items.map((k, j) => (
                <Node key={j} node={k} ctx={ctx} />
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}

export { Node }
export type { RenderCtx }

// ── 顶层入口 ──────────────────────────────────────────────────────────────

/** 一次渲染一个 genui 文档：创建本轮 ctx（表单域/分组收集），渲染 items。 */
function DocView({ doc }: { doc: GenuiDocData }): React.JSX.Element {
  const dispatch = useGenuiAction()
  const ctx = useMemo<RenderCtx>(
    () => ({ dispatch, fields: new Map(), groups: new Map() }),
    [dispatch]
  )
  return (
    <div className="genui-root" style={doc.gap ? { gap: doc.gap } : undefined}>
      {doc.title ? <div className="genui-doc-title">{doc.title}</div> : null}
      {doc.items.map((item, i) => (
        <Node key={i} node={item} ctx={ctx} />
      ))}
    </div>
  )
}

/** Markdown 代码块拦截入口：language=genui 的围栏走这里。
 * 流式期间 JSON 多半半截 → 显示"生成中"占位（不闪错误降级），闭合后自动切换渲染；
 * JSON 完整但校验失败 → 降级为普通代码块（用户仍能看到原文，模型可自纠）。 */
export function GenuiBlock({
  code,
  streaming
}: {
  code: string
  streaming: boolean
}): React.JSX.Element {
  const parsed = useMemo(() => parseGenuiDoc(code), [code])
  if (parsed.ok) return <DocView doc={parsed.doc} />
  if (parsed.reason === '__json__') {
    return (
      <div className="genui-pending">
        <span className="genui-pending-dot" />
        {streaming ? '界面组件生成中…' : '界面数据不完整（JSON 未闭合），已按代码显示'}
      </div>
    )
  }
  return (
    <div className="genui-invalid">
      <div className="genui-invalid-reason">genui 规格校验失败：{parsed.reason}（按代码显示）</div>
      <pre className="genui-code">
        <code>{code}</code>
      </pre>
    </div>
  )
}
