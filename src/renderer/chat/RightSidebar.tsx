// 右侧边栏（学 成熟实现better-sidebar 的工作台）：文件树浏览 + 文件预览。
//
// 定位：主窗内右侧的可开关面板，与聊天区并排。文件卡片点击 → 打开这里预览该文件。
// 设计取舍：
// · tab 式（文件树 / 预览各一个 tab）——对齐 成熟实现侧栏的标签页工作台观感；
// · 文件树懒加载（点目录才拉其子项）——大工程不卡；
// · 预览走主进程 IPC（WORKSPACE_READ），渲染层拿不到任意路径读能力（安全边界在主进程）；
// · 宽度可拖（与左栏同一套 pointer 方案），localStorage 记忆。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  OfficeBlock,
  OfficePreview,
  WorkspaceGitResult,
  WorkspaceReadResult,
  WorkspaceTreeEntry
} from '@shared/types'
import { useChatStore, type RightPanelTab } from './store'
import { injectLightCanvas } from './html-canvas'
import Markdown from './Markdown'
import { terminalSession, coalesceRuns } from './terminal-session'

/** 文件类型图标（按扩展名，给树和预览头部用） */
function fileIcon(name: string): string {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico'].includes(ext)) return '🖼'
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return '📜'
  if (['.md', '.markdown', '.txt'].includes(ext)) return '📝'
  if (['.json', '.yaml', '.yml', '.toml'].includes(ext)) return '⚙️'
  if (['.html', '.htm', '.css', '.scss'].includes(ext)) return '🌐'
  if (['.pdf'].includes(ext)) return '📕'
  if (['.docx', '.doc'].includes(ext)) return '📘'
  if (['.xlsx', '.xls', '.csv'].includes(ext)) return '📗'
  if (['.pptx', '.ppt'].includes(ext)) return '📙'
  return '📄'
}

/** 可"渲染视图"的文本文档（md 用 Markdown，html/htm/svg 用 Blob iframe） */
function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith('.md')
}

function isRenderableDoc(name: string): boolean {
  const e = name.toLowerCase()
  return e.endsWith('.md') || e.endsWith('.html') || e.endsWith('.htm') || e.endsWith('.svg')
}

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

/** 单个目录节点：展开时才拉子项（懒加载） */
function DirNode({
  entry,
  depth,
  activePath,
  onOpenFile
}: {
  entry: WorkspaceTreeEntry
  depth: number
  activePath: string | null
  onOpenFile: (rel: string, name: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<WorkspaceTreeEntry[] | null>(null)
  const [err, setErr] = useState('')

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next && children === null) {
      void window.petAPI.workspaceTree(entry.rel).then((res) => {
        if (res.ok) setChildren(res.entries)
        else setErr(res.error)
      })
    }
  }

  return (
    <>
      <button
        type="button"
        className="ws-node is-dir"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={toggle}
        title={entry.rel}
      >
        <span className="ws-node-caret">{open ? '▾' : '▸'}</span>
        <span className="ws-node-icon">📁</span>
        <span className="ws-node-name">{entry.name}</span>
      </button>
      {open &&
        (err !== '' ? (
          <div className="ws-node-err" style={{ paddingLeft: `${22 + depth * 14}px` }}>
            {err}
          </div>
        ) : (children ?? []).length === 0 ? (
          <div className="ws-node-empty" style={{ paddingLeft: `${22 + depth * 14}px` }}>
            空目录
          </div>
        ) : (
          (children ?? []).map((child) =>
            child.kind === 'dir' ? (
              <DirNode
                key={child.rel}
                entry={child}
                depth={depth + 1}
                activePath={activePath}
                onOpenFile={onOpenFile}
              />
            ) : (
              <button
                key={child.rel}
                type="button"
                className={activePath === child.rel ? 'ws-node is-file active' : 'ws-node is-file'}
                style={{ paddingLeft: `${22 + depth * 14}px` }}
                onClick={() => onOpenFile(child.rel, child.name)}
                title={`${child.rel}（${fmtSize(child.size)}）`}
              >
                <span className="ws-node-icon">{fileIcon(child.name)}</span>
                <span className="ws-node-name">{child.name}</span>
                <span className="ws-node-size">{fmtSize(child.size)}</span>
              </button>
            )
          )
        ))}
    </>
  )
}

/** Git 面板（v15）：工作区仓库只读概览——分支/变更/最近提交（对齐 成熟实现-better-sidebar 的源代码管理）。 */
function GitPanel({
  onOpenFile
}: {
  onOpenFile: (rel: string, name: string) => void
}): React.JSX.Element {
  const [data, setData] = useState<WorkspaceGitResult | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback((): void => {
    void Promise.resolve()
      .then(() => {
        setLoading(true)
        return window.petAPI.workspaceGit()
      })
      .then((res) => {
        setData(res)
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (loading)
    return (
      <div className="rs-body">
        <div className="rs-hint">读取中…</div>
      </div>
    )
  if (data === null || data.isRepo === false) {
    return (
      <div className="rs-body">
        <div className="rs-hint">{data?.hint ?? '当前工作区不是 git 仓库'}</div>
      </div>
    )
  }
  const changes = data.changes ?? []
  const log = data.log ?? []
  return (
    <div className="rs-body">
      <div className="rs-root-row">
        <span className="rs-branch">⎇ {data.branch}</span>
        {data.aheadBehind !== undefined && <span className="rs-ab">{data.aheadBehind}</span>}
        <button type="button" className="rs-refresh" title="刷新" onClick={load}>
          ⟳
        </button>
      </div>
      {changes.length === 0 ? (
        <div className="rs-hint">工作区干净，没有未提交的改动。</div>
      ) : (
        <>
          <div className="rs-section-title">变更（{changes.length}）</div>
          {changes.map((ch) => (
            <button
              key={`${ch.code}:${ch.rel}`}
              type="button"
              className="ws-node is-file"
              style={{ paddingLeft: '14px' }}
              onClick={() => onOpenFile(ch.rel, ch.rel.split('/').pop() ?? ch.rel)}
              title={`${ch.rel}（${ch.code}）——点击在预览打开`}
            >
              <span className={`rs-git-badge rs-git-${ch.code[0] ?? '?'}`}>
                {ch.code.trim() === '' ? '?' : ch.code.trim()}
              </span>
              <span className="ws-node-name">{ch.rel}</span>
            </button>
          ))}
        </>
      )}
      {log.length > 0 && (
        <>
          <div className="rs-section-title">最近提交</div>
          {log.map((c) => (
            <div key={c.hash} className="rs-commit" title={c.subject}>
              <span className="rs-commit-hash">{c.hash}</span>
              <span className="rs-commit-subject">{c.subject}</span>
              <span className="rs-commit-date">{c.date}</span>
            </div>
          ))}
        </>
      )}
    </div>
  )
}

/** 终端面板（v15）：简易版——每回车执行一条命令（工作区根），增量显示输出。
 * Windows 控制台输出是 GBK，主进程已按 gbk 解码。真 PTY（node-pty）等拍板后 v2 升级。 */
/**
 * 终端面板 v2：node-pty 常驻会话 + 自研 ANSI 渲染。
 *
 * 交互模型借鉴真终端：整个输出区是一个可聚焦容器（tabIndex），按键直接映射成
 * 原始字节写进 PTY——cd 跨命令保持、python REPL 可交互、Ctrl+C 发 \x03 中断。
 * 没有输入框：shell 自己的回显（ConPTY 发回来）就是输入行，避免双份回显错位。
 */
function TerminalPanel({ rootName }: { rootName: string }): React.JSX.Element {
  const [, force] = useState(0)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [started, setStarted] = useState(terminalSession.isStarted())
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const compoRef = useRef(false) // 输入法组合中：不逐字发送，等 compositionend

  // 字符单元尺寸估算（measure span）→ 由容器像素算 cols/rows
  const cellRef = useRef<{ w: number; h: number }>({ w: 7.6, h: 17 })
  const sizeOf = (): { cols: number; rows: number } => {
    const el = bodyRef.current
    if (el === null) return { cols: 80, rows: 24 }
    const cols = Math.max(20, Math.floor(el.clientWidth / cellRef.current.w))
    const rows = Math.max(6, Math.floor(el.clientHeight / cellRef.current.h))
    return { cols, rows }
  }

  // 订阅会话重绘（节流在 session 内部做）
  useEffect(() => terminalSession.subscribe(() => force((n) => n + 1)), [])

  // 挂载：未启动则按当前尺寸开 shell；尺寸变化 resize 之
  useEffect(() => {
    // 同步 setState 会触发 cascading renders（项目 lint 硬规则）→ 包进微任务
    void Promise.resolve().then(() => {
      if (terminalSession.isStarted()) return
      setStarting(true)
      const { cols, rows } = sizeOf()
      return terminalSession.start(cols, rows).then((res) => {
        setStarting(false)
        if (res.ok === false) setError(res.error ?? '终端启动失败')
        else {
          setError('')
          setStarted(true)
        }
      })
    })
    const host = hostRef.current
    if (host === null) return
    const ro = new ResizeObserver(() => {
      const { cols, rows } = sizeOf()
      terminalSession.resize(cols, rows)
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [])

  // 键盘 → 原始字节（真终端语义）
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!started || compoRef.current) return
    const k = e.key
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const letter = k.toUpperCase()
      if (letter.length === 1 && letter >= 'A' && letter <= 'Z') {
        terminalSession.write(String.fromCharCode(letter.charCodeAt(0) - 64)) // Ctrl+C=\x03
        e.preventDefault()
      }
      return
    }
    const seq: Record<string, string> = {
      Enter: '\r',
      Backspace: '\x7f',
      Tab: '\t',
      Escape: '\x1b',
      ArrowUp: '\x1b[A',
      ArrowDown: '\x1b[B',
      ArrowRight: '\x1b[C',
      ArrowLeft: '\x1b[D',
      Home: '\x1b[H',
      End: '\x1b[F',
      PageUp: '\x1b[5~',
      PageDown: '\x1b[6~',
      Delete: '\x1b[3~'
    }
    if (k in seq) {
      terminalSession.write(seq[k])
      e.preventDefault()
    } else if (k.length === 1 && !e.altKey && !e.metaKey) {
      terminalSession.write(k)
      e.preventDefault()
    }
  }

  const lines = terminalSession.lines()
  const stick = (): void => {
    const el = bodyRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }
  useEffect(stick, [lines.length, starting, error])

  return (
    <div className="rs-body rs-term" ref={hostRef}>
      <div className="rs-root-row">
        <span title="shell 常驻会话——cd 状态跨命令保持，Ctrl+C 中断当前命令">
          ▸ {rootName} · 真 PTY
        </span>
        <span className="rs-term-hint">点输出区即可输入 · Ctrl+C 中断</span>
        <button
          type="button"
          className="rs-refresh"
          title="清屏（只清显示，不杀会话）"
          onClick={() => terminalSession.clear()}
        >
          ⌫
        </button>
        <button
          type="button"
          className="rs-refresh"
          title="重开一个 shell 会话（杀掉当前进程树）"
          onClick={() => {
            const { cols, rows } = sizeOf()
            void terminalSession.restart(cols, rows).then((res) => {
              setError(res.ok === false ? (res.error ?? '启动失败') : '')
            })
          }}
        >
          ↻
        </button>
      </div>
      {error !== '' && <div className="rs-hint">{error}</div>}
      {starting && <div className="rs-hint">正在启动 shell…</div>}
      <div
        className="rs-term-out rs-term-live"
        ref={bodyRef}
        tabIndex={0}
        role="textbox"
        aria-label="终端"
        onKeyDown={onKeyDown}
        onCompositionStart={() => {
          compoRef.current = true
        }}
        onCompositionEnd={(e) => {
          compoRef.current = false
          terminalSession.write(e.data) // 中文整串上屏后一次写入
        }}
        onPaste={(e) => {
          e.preventDefault()
          terminalSession.write(e.clipboardData.getData('text'))
        }}
      >
        {lines.map((line, i) => (
          <div key={i} className="rs-term-line">
            {coalesceRuns(line).map((run, j) => (
              <span
                key={j}
                className={
                  run.cls === ''
                    ? undefined
                    : run.cls
                        .split(' ')
                        .filter(Boolean)
                        .map((t) => `ansi-${t}`)
                        .join(' ')
                }
              >
                {run.text}
              </span>
            ))}
            {i === lines.length - 1 && started && <span className="rs-term-cursor" />}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Office 文本级预览渲染：把主进程 parseOffice 的块序列铺成轻量 DOM。
 * 只还原结构（标题层级/段落/表格/工作表/幻灯片分隔），不还原排版——排版走系统应用。 */
function OfficePreviewView({ preview }: { preview: OfficePreview }): React.JSX.Element {
  // xlsx 是「每行一个 table 块」——把连续的 table 块合并成一张表，避免碎成 N 个单行表
  const merged: OfficeBlock[] = []
  for (const b of preview.blocks) {
    const last = merged[merged.length - 1]
    if (b.type === 'table' && last !== undefined && last.type === 'table') {
      merged[merged.length - 1] = { type: 'table', rows: [...last.rows, ...b.rows] }
    } else {
      merged.push(b)
    }
  }
  return (
    <div className="rs-preview-office">
      <div className="rs-office-meta">
        {preview.format.toUpperCase()} 文本预览 · {preview.blocks.length} 块 · {preview.chars} 字
        {preview.truncated ? ' ·（内容过大，已截断，完整请用系统应用打开）' : ''}
      </div>
      {merged.map((b, i) => {
        if (b.type === 'heading') {
          const Tag = `h${Math.min(6, Math.max(1, b.level))}` as keyof React.JSX.IntrinsicElements
          return (
            <Tag key={i} className="rs-office-h">
              {b.text}
            </Tag>
          )
        }
        if (b.type === 'para')
          return (
            <p key={i} className="rs-office-p">
              {b.text}
            </p>
          )
        if (b.type === 'sheet')
          return (
            <div key={i} className="rs-office-sheet">
              工作表：{b.name}
            </div>
          )
        if (b.type === 'slide')
          return (
            <div key={i} className="rs-office-slide">
              第 {b.index} 页
            </div>
          )
        // table：xlsx 每行一个 table 块（rows 只有一行），docx/pptx 整表一个块
        return (
          <table key={i} className="rs-office-table">
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )
      })}
    </div>
  )
}

/** 搜索面板：工作区全文检索——输入关键词，命中行点击直接跳预览。
 * 内核与爱弥斯的 search_content 工具共用（扫描式，千文件级 <1s）。 */
function SearchPanel({
  onOpenFile
}: {
  onOpenFile: (rel: string, name: string) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<
    Array<{ rel: string; name: string; line: number; snippet: string }>
  >([])
  const [meta, setMeta] = useState('')
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)

  const run = (): void => {
    const t = query.trim()
    if (t === '' || searching) return
    setSearching(true)
    void Promise.resolve()
      .then(() => window.petAPI.searchContent(t, 30))
      .then((res) => {
        setHits(res.error !== undefined ? [] : res.hits)
        setMeta(
          res.error !== undefined
            ? res.error
            : `命中 ${res.hits.length} 行（扫描 ${res.scanned} 个文件${res.truncated ? '，已达上限' : ''}）`
        )
        setSearched(true)
        setSearching(false)
      })
  }

  return (
    <div className="rs-body rs-search">
      <div className="rs-browser-bar">
        <input
          type="text"
          className="rs-browser-url"
          value={query}
          placeholder="搜索工作区文件内容，回车执行"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') run()
          }}
        />
        <button type="button" className="rs-refresh" title="搜索" onClick={run}>
          🔍
        </button>
      </div>
      {searching && <div className="rs-hint">搜索中…</div>}
      {!searching && searched && (
        <>
          <div className="rs-hint">{meta}</div>
          {hits.map((h) => (
            <button
              key={`${h.rel}:${h.line}`}
              type="button"
              className="ws-node is-file"
              onClick={() => onOpenFile(h.rel, h.name)}
              title={`${h.rel} L${h.line}——点击在预览打开`}
            >
              <span className="rs-search-line">L{h.line}</span>
              <span className="ws-node-name">{h.snippet}</span>
              <span className="rs-search-file">{h.name}</span>
            </button>
          ))}
        </>
      )}
      {!searching && !searched && (
        <div className="rs-hint">输入关键词回车，在工作区全部文本文件的内容里查找。</div>
      )}
    </div>
  )
}

/** 浏览器面板（v17 重做）：**主进程 WebContentsView** 方案，渲染层只画地址栏 + 占位。
 * 为什么不用 <webview> 标签：实测 guest 视口高度永远卡死在默认 150px（CSS/autosize/
 * 内联样式全部无效， 连续两轮"浏览器挤在最上面"），WebContentsView 的 bounds
 * 由本组件在每次布局变化时显式上报——同步问题从根上消失。 */
function BrowserPanel(): React.JSX.Element {
  const [url, setUrl] = useState('https://www.bing.com')
  const [address, setAddress] = useState('https://www.bing.com')
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const holderRef = useRef<HTMLDivElement | null>(null)

  // 状态回推（导航/loading/前进后退可用性全部以主进程 guest 为准）
  useEffect(
    () =>
      window.petAPI.onBrowserState((st) => {
        setUrl(st.url)
        setAddress(st.url)
        setLoading(st.loading)
        setCanBack(st.canBack)
        setCanForward(st.canForward)
      }),
    []
  )

  // bounds 上报：占位元素的 rect 就是 WebContentsView 的 bounds（frame:false 坐标系一致）。
  // ResizeObserver 覆盖：开栏/切 tab/拖宽/放大/窗口缩放——每次都全量上报，主进程 setBounds。
  useEffect(() => {
    const holder = holderRef.current
    if (holder === null) return
    const report = (): void => {
      const r = holder.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) {
        window.petAPI.browserSetBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
      }
    }
    // 首帧与布局稳定后各报一次（挂载过渡期 rect 可能还没定）
    report()
    const t1 = window.setTimeout(report, 60)
    const t2 = window.setTimeout(report, 260)
    const ro = new ResizeObserver(report)
    ro.observe(holder)
    // 窗口缩放/滚动不影响 holder 自身尺寸的情况（放大态切换）也要跟上
    window.addEventListener('resize', report)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
      ro.disconnect()
      window.removeEventListener('resize', report)
      // 卸载（切 tab/收侧栏）→ 主进程把 view 从视图树摘下（会话保留）
      window.petAPI.browserSetBounds(null)
    }
  }, [])

  const navigate = (raw: string): void => {
    const t = raw.trim()
    if (t === '') return
    setLoading(true)
    window.petAPI.browserNavigate(t)
  }

  return (
    <div className="rs-body rs-browser">
      <div className="rs-browser-bar">
        <button
          type="button"
          className="rs-refresh"
          title="后退"
          disabled={!canBack}
          onClick={() => window.petAPI.browserGoBack()}
        >
          ‹
        </button>
        <button
          type="button"
          className="rs-refresh"
          title="前进"
          disabled={!canForward}
          onClick={() => window.petAPI.browserGoForward()}
        >
          ›
        </button>
        <button
          type="button"
          className="rs-refresh"
          title="刷新"
          onClick={() => {
            setLoading(true)
            window.petAPI.browserReload()
          }}
        >
          ⟳
        </button>
        <input
          type="text"
          className="rs-browser-url"
          value={address}
          placeholder="输入网址或搜索词，回车打开"
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigate(address)
          }}
        />
        <button
          type="button"
          className="rs-refresh"
          title="在系统浏览器打开"
          onClick={() => void window.petAPI.openExternal(url)}
        >
          ↗
        </button>
      </div>
      {/* 占位：WebContentsView 的 bounds 跟随它的 rect（原生层盖在渲染内容之上） */}
      <div className="rs-browser-view" ref={holderRef} />
      {loading && <div className="rs-browser-loading">加载中…</div>}
    </div>
  )
}

function RightSidebar({ width }: { width: number }): React.JSX.Element {
  // 状态全在 store（文件卡片/文件树/开关按钮都能改它——避免层层传 props）
  const tab: RightPanelTab = useChatStore((s) => s.rightTab)
  const activeRel = useChatStore((s) => s.rightActiveRel)
  const openFiles = useChatStore((s) => s.rightFiles)
  const onTab = useChatStore((s) => s.setRightTab)
  const onOpenFile = useChatStore((s) => s.openRightFile)
  const closeFile = useChatStore((s) => s.closeRightFile)
  const expanded = useChatStore((s) => s.rightExpanded)
  const toggleExpanded = useChatStore((s) => s.toggleRightExpanded)
  const onClose = (): void => {
    const st = useChatStore.getState()
    // 放大态下收起侧栏要一并退出放大——否则聊天区还藏着，主窗一片空白
    if (st.rightExpanded) st.toggleRightExpanded()
    st.setRightOpen(false)
  }
  // 当前激活的文件对象（tab 条渲染 + 内容加载都靠它）
  const activeFile = useMemo(
    () => openFiles.find((f) => f.rel === activeRel) ?? null,
    [openFiles, activeRel]
  )
  // 根目录树（'' = 工作区根）
  const [root, setRoot] = useState<string>('')
  const [entries, setEntries] = useState<WorkspaceTreeEntry[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  // 预览内容 + 按文件缓存（多标签切换不重复拉取；关闭标签时顺手清缓存）
  const [preview, setPreview] = useState<WorkspaceReadResult | null>(null)
  const previewCache = useRef(new Map<string, WorkspaceReadResult>())
  // md 默认**渲染视图**；可切回源码
  const [sourceView, setSourceView] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  // html/htm/svg 的 Blob URL（渲染视图用；每次内容/切换变化重建，旧的立即 revoke）
  const docBlobUrl = useMemo(() => {
    if (
      preview === null ||
      preview.ok !== true ||
      preview.kind !== 'text' ||
      sourceView ||
      activeFile === null
    ) {
      return null
    }
    const e = activeFile.name.toLowerCase()
    if (e.endsWith('.svg')) {
      return URL.createObjectURL(new Blob([preview.text], { type: 'image/svg+xml' }))
    }
    if (!e.endsWith('.html') && !e.endsWith('.htm')) return null
    // 深色模式可读性兜底：很多自生成的 HTML
    // 只写了深色文字没声明背景/color-scheme，深色主题下 Chromium 画布转深 → 深字压深底。
    // 注入一条**最先**的 light color-scheme 兜底默认画布；文档若自己后声明了配色
    // （如显式 color-scheme:dark 或设了 background），级联在后、优先级更高，照常生效。
    return URL.createObjectURL(new Blob([injectLightCanvas(preview.text)], { type: 'text/html' }))
  }, [preview, sourceView, activeFile])
  const prevBlobRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevBlobRef.current
    if (prev !== null && prev !== docBlobUrl) URL.revokeObjectURL(prev)
    prevBlobRef.current = docBlobUrl
  }, [docBlobUrl])
  // PDF 的 dataUrl 转 Blob URL（iframe 直接吃 data:application/pdf 也能渲染，但 Blob 内存更省）
  const pdfBlobUrl = useMemo(() => {
    if (preview === null || preview.ok !== true || preview.kind !== 'pdf') return null
    const base64 = preview.dataUrl.slice(preview.dataUrl.indexOf(',') + 1)
    // ★ 渲染层没有 Node 的 Buffer（nodeIntegration 刻意关闭）——用浏览器原生 atob 解码。
    // 直接塞 base64 字符串进 Blob 会存成文本字节（PDF 损坏），必须还原成二进制。
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
  }, [preview])
  const prevPdfRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevPdfRef.current
    if (prev !== null && prev !== pdfBlobUrl) URL.revokeObjectURL(prev)
    prevPdfRef.current = pdfBlobUrl
  }, [pdfBlobUrl])

  const loadRoot = useCallback((): void => {
    // 用微任务起头：避免在 effect 同步调用栈里立刻 setState（会触发级联渲染告警）
    void Promise.resolve()
      .then(() => {
        setLoading(true)
        return window.petAPI.workspaceTree('')
      })
      .then((res) => {
        if (res.ok) {
          setRoot(res.root)
          setEntries(res.entries)
          setError('')
        } else {
          setEntries([])
          setError(res.error)
        }
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    loadRoot()
  }, [loadRoot])

  // 页签栏横向滚动：7 个页签在窄侧栏会溢出，「浏览」被裁到看不见。
  // ① 滚轮在页签栏上时把纵向滚动转成横向滚动，无需精确对准细滚动条；
  // 用原生非 passive 监听——React 的 onWheel 是 passive 的，preventDefault 无效；
  // ② 切换/激活页签时自动把它滚入视野（否则点了「搜索」结果「浏览」仍藏在右侧）。
  const tabsRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = tabsRef.current
    if (el === null) return
    const onWheel = (e: WheelEvent): void => {
      if (el.scrollWidth <= el.clientWidth) return // 无横向溢出就不拦
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX
      if (delta === 0) return
      el.scrollLeft += delta
      e.preventDefault() // 阻止同时滚动聊天区
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  useEffect(() => {
    const el = tabsRef.current
    if (el === null) return
    const active = el.querySelector<HTMLElement>('.rs-tab.active')
    active?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [tab])

  // 激活文件变化 → 取内容（有缓存直接用，多标签切换零等待）
  useEffect(() => {
    if (activeFile === null) return
    const cached = previewCache.current.get(activeFile.rel)
    if (cached !== undefined) {
      setPreview(cached)
      setPreviewLoading(false)
      return
    }
    let alive = true
    void Promise.resolve()
      .then(() => {
        if (alive) {
          // 换文件回到渲染视图（md 默认可读），并同步进加载态
          setSourceView(false)
          setPreviewLoading(true)
        }
        return window.petAPI.workspaceRead(activeFile.rel)
      })
      .then((res) => {
        if (!alive) return
        previewCache.current.set(activeFile.rel, res)
        setPreview(res)
        setPreviewLoading(false)
      })
    return () => {
      alive = false
    }
  }, [activeFile])

  // 关闭标签 → 清对应缓存（下次打开重新拉最新内容）
  const handleCloseTab = (rel: string): void => {
    previewCache.current.delete(rel)
    closeFile(rel)
  }

  const rootName = useMemo(() => {
    if (root === '') return '工作区'
    const parts = root
      .replace(/\\/g, '/')
      .split('/')
      .filter((p) => p !== '')
    return parts[parts.length - 1] ?? root
  }, [root])

  return (
    <aside
      className={expanded ? 'right-sidebar is-expanded' : 'right-sidebar'}
      style={expanded ? undefined : { width }}
    >
      <div className="rs-head">
        <div className="rs-tabs" ref={tabsRef}>
          <button
            type="button"
            className={tab === 'files' ? 'rs-tab active' : 'rs-tab'}
            onClick={() => onTab('files')}
          >
            文件
          </button>
          <button
            type="button"
            className={tab === 'preview' ? 'rs-tab active' : 'rs-tab'}
            onClick={() => onTab('preview')}
            disabled={activeFile === null}
            title={activeFile === null ? '先从文件树或聊天里的文件卡片选一个文件' : activeFile.rel}
          >
            预览{openFiles.length > 0 ? ` ${openFiles.length}` : ''}
          </button>
          <button
            type="button"
            className={tab === 'git' ? 'rs-tab active' : 'rs-tab'}
            onClick={() => onTab('git')}
            title="工作区 Git 概览"
          >
            Git
          </button>
          <button
            type="button"
            className={tab === 'terminal' ? 'rs-tab active' : 'rs-tab'}
            onClick={() => onTab('terminal')}
            title="简易终端（在工作区根执行命令）"
          >
            终端
          </button>
          <button
            type="button"
            className={tab === 'search' ? 'rs-tab active' : 'rs-tab'}
            onClick={() => onTab('search')}
            title="工作区全文搜索"
          >
            搜索
          </button>
          <button
            type="button"
            className={tab === 'browser' ? 'rs-tab active' : 'rs-tab'}
            onClick={() => onTab('browser')}
            title="内嵌浏览器"
          >
            浏览
          </button>
        </div>
        <button
          type="button"
          className="rs-expand"
          title={expanded ? '还原侧栏' : '放大至整个主窗'}
          onClick={toggleExpanded}
        >
          {expanded ? '⤡' : '⤢'}
        </button>
        <button type="button" className="rs-close" title="收起侧栏" onClick={onClose}>
          ×
        </button>
      </div>

      {tab === 'search' ? (
        <SearchPanel onOpenFile={onOpenFile} />
      ) : tab === 'browser' ? (
        <BrowserPanel />
      ) : tab === 'git' ? (
        <GitPanel onOpenFile={onOpenFile} />
      ) : tab === 'terminal' ? (
        <TerminalPanel rootName={rootName} />
      ) : tab === 'files' ? (
        <div className="rs-body">
          <div className="rs-root-row" title={root}>
            <span className="rs-root-icon">🗂</span>
            <span className="rs-root-name">{rootName}</span>
            <button type="button" className="rs-refresh" title="刷新" onClick={loadRoot}>
              ⟳
            </button>
          </div>
          {loading ? (
            <div className="rs-hint">读取中…</div>
          ) : error !== '' ? (
            <div className="rs-hint rs-hint-warn">{error}</div>
          ) : entries.length === 0 ? (
            <div className="rs-hint">工作区是空的（她写文件后会出现在这里）</div>
          ) : (
            entries.map((e) =>
              e.kind === 'dir' ? (
                <DirNode
                  key={e.rel}
                  entry={e}
                  depth={0}
                  activePath={activeFile?.rel ?? null}
                  onOpenFile={onOpenFile}
                />
              ) : (
                <button
                  key={e.rel}
                  type="button"
                  className={
                    activeFile?.rel === e.rel ? 'ws-node is-file active' : 'ws-node is-file'
                  }
                  style={{ paddingLeft: '22px' }}
                  onClick={() => onOpenFile(e.rel, e.name)}
                  title={`${e.rel}（${fmtSize(e.size)}）`}
                >
                  <span className="ws-node-icon">{fileIcon(e.name)}</span>
                  <span className="ws-node-name">{e.name}</span>
                  <span className="ws-node-size">{fmtSize(e.size)}</span>
                </button>
              )
            )
          )}
        </div>
      ) : (
        <div className="rs-body">
          {/* 多文件标签条 */}
          {openFiles.length > 0 && (
            <div className="rs-file-tabs">
              {openFiles.map((f) => (
                <span
                  key={f.rel}
                  className={f.rel === activeRel ? 'rs-file-tab active' : 'rs-file-tab'}
                  title={f.rel}
                >
                  <button
                    type="button"
                    className="rs-file-tab-name"
                    onClick={() => onOpenFile(f.rel, f.name)}
                  >
                    {fileIcon(f.name)} {f.name}
                  </button>
                  <button
                    type="button"
                    className="rs-file-tab-close"
                    aria-label={`关闭 ${f.name}`}
                    title="关闭"
                    onClick={() => handleCloseTab(f.rel)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {activeFile === null ? (
            <div className="rs-hint">还没有选文件——从「文件」标签或聊天里点文件卡片打开</div>
          ) : preview === null || previewLoading ? (
            <div className="rs-hint">读取中…</div>
          ) : preview.ok === false ? (
            <>
              <div className="rs-hint rs-hint-warn">{preview.error}</div>
              {/* 预览不了的格式（pptx/超大文件等）给出口：资源管理器 / 系统应用打开 */}
              <div className="rs-hint-actions">
                <button
                  type="button"
                  className="rs-action-btn"
                  onClick={() => void window.petAPI.workspaceReveal(activeFile.rel)}
                >
                  ⊞ 在资源管理器中显示
                </button>
                <button
                  type="button"
                  className="rs-action-btn"
                  onClick={() => void window.petAPI.workspaceOpenPath(activeFile.rel)}
                >
                  ↗ 用系统应用打开
                </button>
              </div>
            </>
          ) : preview.rel !== activeFile.rel ? (
            /* 旧内容还没换上（切换文件瞬间）——继续显示读取中，避免闪错文件 */
            <div className="rs-hint">读取中…</div>
          ) : (
            <>
              <div className="rs-file-head">
                <span className="rs-file-icon">{fileIcon(activeFile.name)}</span>
                <span className="rs-file-name" title={activeFile.rel}>
                  {activeFile.name}
                </span>
                <span className="rs-file-size">{fmtSize(preview.size)}</span>
                <button
                  type="button"
                  className="rs-refresh"
                  title="在资源管理器中显示"
                  onClick={() => void window.petAPI.workspaceReveal(activeFile.rel)}
                >
                  ⊞
                </button>
              </div>
              <div className="rs-file-path" title={activeFile.rel}>
                {activeFile.rel}
                {isRenderableDoc(activeFile.name) && (
                  <button
                    type="button"
                    className="rs-view-toggle"
                    onClick={() => setSourceView((v) => !v)}
                  >
                    {sourceView ? '渲染视图' : '查看源码'}
                  </button>
                )}
              </div>
              {preview.kind === 'image' ? (
                <div className="rs-preview-image">
                  <img src={preview.dataUrl} alt={activeFile.name} />
                </div>
              ) : preview.kind === 'media' ? (
                preview.mime.startsWith('video/') ? (
                  <video className="rs-preview-media" src={preview.dataUrl} controls />
                ) : (
                  <audio className="rs-preview-audio" src={preview.dataUrl} controls />
                )
              ) : preview.kind === 'pdf' ? (
                <iframe
                  className="rs-preview-frame"
                  src={pdfBlobUrl ?? undefined}
                  title={activeFile.name}
                />
              ) : preview.kind === 'office' ? (
                <OfficePreviewView preview={preview.preview} />
              ) : preview.kind === 'binary' ? (
                <div className="rs-hint">
                  二进制文件（{fmtSize(preview.size)}），无法按文本预览。
                </div>
              ) : preview.kind === 'text' && isRenderableDoc(activeFile.name) && !sourceView ? (
                isMarkdown(activeFile.name) ? (
                  <div className="rs-preview-md">
                    <Markdown content={preview.text} />
                  </div>
                ) : (
                  /* html/htm/svg：Blob URL 渲染。不加 sandbox——blob 继承主窗 origin，
                     沙箱会让 opaque origin 反而拦掉加载；内容是用户工作区自己的文件，
                     与双击用浏览器打开同级别。 */
                  <iframe
                    className="rs-preview-frame"
                    src={docBlobUrl ?? undefined}
                    title={activeFile.name}
                  />
                )
              ) : (
                <pre className="rs-preview-text">{preview.text}</pre>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  )
}

export default RightSidebar
