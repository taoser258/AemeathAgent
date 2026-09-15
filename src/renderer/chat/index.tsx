// 聊天页（成熟版式）：左导航栏 + 中央白色圆角工作台 + 顶部四模式胶囊。
// 欢迎态：贴图 + 欢迎语 + 居中输入台；对话态：消息流 + 停靠输入台。
// 透明窗体：窗口边缘的樱粉底与装饰由 chat-page 承载，工作台是浮在其中的白色圆角面板。

import { useEffect, useRef, useState } from 'react'
import ChatErrorBoundary from './ErrorBoundary'
import { useChatStore } from './store'
import WindowControls from '../WindowControls'
import { startWindowDrag, toggleWindowMaximize } from '../window-drag'
import SessionSidebar, { type SidePanel } from './SessionSidebar'
import RightSidebar from './RightSidebar'
import TaskRail from './TaskRail'
import MessageList from './MessageList'
import NotesCard from './NotesCard'
import ReviewCard from './ReviewCard'
import ProgressCard from './ProgressCard'
import ToolsPanel from './ToolsPanel'
import SkillsPanel from './SkillsPanel'
import ChatInput from './ChatInput'
import ApprovalPanel from './ApprovalPanel'
import AskPanel from './AskPanel'
import { StatusPill } from './MessageList'
import CheckpointBanner from './CheckpointBanner'
import stickerHello from '../assets/aemeath-sticker-hello.webp'
import { boundWorkspace } from '@shared/workspace'

/** 空消息列表的稳定引用：selector 里现场 [] 会让 useSyncExternalStore 无限循环（主窗卡死隐形） */
const NO_MESSAGES: never[] = []

// 自研边缘缩放：八向缩放区（透明窗不支持系统边缘缩放）
type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const RESIZE_EDGES: ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
const MIN_W = 940
const MIN_H = 640

// 侧栏宽度：拖把手调整，localStorage 记忆（默认值 = 最窄）
const SIDEBAR_WIDTH_KEY = 'aemeath.sidebar-width'
/** 用户是否亲手拖过宽度。挂载即把默认值写进 localStorage 的旧实现会让"新默认值"
 * 永远被旧默认值顶掉（老装机里躺着 200）——用这个标记区分"用户选的值"与"默认值"。 */
const SIDEBAR_WIDTH_TOUCHED_KEY = 'aemeath.sidebar-width-touched'
const SIDEBAR_MIN = 140 // 180 → 140
const SIDEBAR_MAX = 420
// 侧栏整体收起；独立于宽度记忆
const SIDEBAR_COLLAPSED_KEY = 'aemeath.sidebar-collapsed'
// 右侧边栏（学 成熟实现better-sidebar）：宽度独立记忆
const RIGHT_WIDTH_KEY = 'aemeath.right-width'
const RIGHT_MIN = 240
const RIGHT_MAX = 560

function readRightWidth(): number {
  const raw = Number(localStorage.getItem(RIGHT_WIDTH_KEY))
  if (Number.isFinite(raw) && raw >= RIGHT_MIN && raw <= RIGHT_MAX) return Math.round(raw)
  return 320
}

function readSidebarCollapsed(): boolean {
  return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
}
/** 默认最窄——140 仍能显示标题与导航 */
const SIDEBAR_DEFAULT = SIDEBAR_MIN

function readSidebarWidth(): number {
  // 只认"用户亲手拖过"的值；否则一律用新默认（老装机里被上一次挂载写下的 200 作废）
  if (localStorage.getItem(SIDEBAR_WIDTH_TOUCHED_KEY) !== '1') return SIDEBAR_DEFAULT
  const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
  if (Number.isFinite(raw) && raw >= SIDEBAR_MIN && raw <= SIDEBAR_MAX) return Math.round(raw)
  return SIDEBAR_DEFAULT
}

/** 顶部三模式胶囊：chat=纯对话无工具 / work=harness 全工具 / learn=教学守则+笔记 */
function ModePill(): React.JSX.Element {
  const chatMode = useChatStore((s) => s.chatMode)
  const setChatMode = useChatStore((s) => s.setChatMode)
  const items: Array<{
    id: 'chat' | 'work' | 'learn'
    icon: string
    label: string
    title: string
  }> = [
    { id: 'chat', icon: '💬', label: '对话', title: '对话模式：纯聊天，不带任何工具' },
    {
      id: 'work',
      icon: '🧰',
      label: '工作',
      title: '工作模式：任务 / 技能 / Code 三合一，全部工具可用'
    },
    { id: 'learn', icon: '📚', label: '学习', title: '学习模式：讲解 / 追问 / 笔记闪卡沉淀' }
  ]
  return (
    <div className="mode-pill">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={chatMode === item.id ? 'mode-pill-item active' : 'mode-pill-item'}
          title={item.title}
          onClick={() => setChatMode(item.id)}
        >
          {item.icon} {item.label}
        </button>
      ))}
    </div>
  )
}

/** 工具/技能入口胶囊（从侧栏挪到顶栏蓝圈位——左上角，
 * 与模式胶囊同 top 同高 → y 轴中心线对齐）。点击切换面板，再点收起。 */
function PanelPill({
  panel,
  onToggle,
  left
}: {
  panel: SidePanel | null
  onToggle: (next: SidePanel) => void
  left: number
}): React.JSX.Element {
  const items: Array<{ id: SidePanel; icon: string; label: string; note: string }> = [
    { id: 'tools', icon: '🧰', label: '工具', note: '管理各模式可用的工具' },
    { id: 'skills', icon: '⚡', label: '技能', note: '技能能力包（T2 接入）' }
  ]
  return (
    <div className="panel-pill" style={{ left }}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={panel === item.id ? 'mode-pill-item active' : 'mode-pill-item'}
          title={item.note}
          onClick={() => onToggle(item.id)}
        >
          {item.icon} {item.label}
        </button>
      ))}
    </div>
  )
}

/** 工作台内的樱花装饰（浅色版：虚线圆环 / 光斑 / 星芒） */
function Decorations(): React.JSX.Element {
  return (
    <div className="deco-layer" aria-hidden="true">
      <div className="deco-grid" />
      <div className="deco-horizon" />
      <div className="deco-hud tl" style={{ top: 14, left: 14 }} />
      <div className="deco-hud br" style={{ bottom: 14, right: 14 }} />
      <div
        className="deco-dotted-ring"
        style={{ width: 460, height: 460, top: '6%', left: '50%', marginLeft: -230 }}
      />
      <div
        className="deco-soft-blob"
        style={{ width: 420, height: 420, top: '-12%', left: '34%' }}
      />
      <div
        className="deco-soft-blob"
        style={{ width: 300, height: 300, bottom: '-8%', right: '4%', opacity: 0.8 }}
      />
      <span className="deco-sparkle" style={{ top: '16%', left: '38%', fontSize: 15 }}>
        ✦
      </span>
      <span
        className="deco-sparkle pink"
        style={{ top: '58%', left: '76%', fontSize: 12, animationDelay: '1.1s' }}
      >
        ✦
      </span>
      <span
        className="deco-sparkle"
        style={{ top: '34%', left: '12%', fontSize: 11, animationDelay: '2s' }}
      >
        ✦
      </span>
      <span
        className="deco-sparkle pink"
        style={{ bottom: '16%', left: '30%', fontSize: 13, animationDelay: '0.6s' }}
      >
        ✦
      </span>
      <div className="deco-caption">AEMEATH // HOLO-CONSOLE · 电子幽灵在线</div>
    </div>
  )
}

// 自研边缘缩放：八向缩放区（透明窗不支持系统边缘缩放）

function startResize(event: React.PointerEvent<HTMLDivElement>, edge: ResizeEdge): void {
  event.preventDefault()
  ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
  const startX = event.screenX
  const startY = event.screenY
  const start = {
    x: window.screenX,
    y: window.screenY,
    width: window.outerWidth,
    height: window.outerHeight
  }
  const onMove = (move: PointerEvent): void => {
    const dx = move.screenX - startX
    const dy = move.screenY - startY
    let { x, y, width, height } = start
    if (edge.includes('e')) width = start.width + dx
    if (edge.includes('w')) {
      width = start.width - dx
      x = start.x + dx
    }
    if (edge.includes('s')) height = start.height + dy
    if (edge.includes('n')) {
      height = start.height - dy
      y = start.y + dy
    }
    if (width < MIN_W) {
      if (edge.includes('w')) x -= MIN_W - width
      width = MIN_W
    }
    if (height < MIN_H) {
      if (edge.includes('n')) y -= MIN_H - height
      height = MIN_H
    }
    window.petAPI.windowSetBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height)
    })
  }
  const onUp = (): void => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

function ChatPage(): React.JSX.Element {
  const loaded = useChatStore((s) => s.loaded)
  const hasSession = useChatStore((s) => s.sessions.some((s) => s.hidden !== true))
  const activeMessages = useChatStore((s) =>
    s.activeId === null ? NO_MESSAGES : (s.messagesBySession[s.activeId] ?? NO_MESSAGES)
  )
  const createSession = useChatStore((s) => s.createSession)
  const loadFromRegistry = useChatStore((s) => s.loadFromRegistry)
  // 欢迎页的模式徽标与顶部胶囊同源（chat / work / learn）
  const chatMode = useChatStore((s) => s.chatMode)

  // 侧栏宽度：拖 .sidebar-resizer 调整，localStorage 记忆（只在用户真拖过之后才落盘——
  // 否则挂载即写入默认值，日后改默认就不生效；见 readSidebarWidth 的 touched 说明）
  const [sidebarWidth, setSidebarWidth] = useState<number>(readSidebarWidth)
  const sidebarTouched = useRef(localStorage.getItem(SIDEBAR_WIDTH_TOUCHED_KEY) === '1')
  useEffect(() => {
    if (!sidebarTouched.current) return
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
  }, [sidebarWidth])

  // 右侧边栏：开合 / 宽度（store 管开合与预览目标，宽度是纯 UI 就放本地）
  const rightOpen = useChatStore((s) => s.rightOpen)
  const rightExpanded = useChatStore((s) => s.rightExpanded)
  const setRightOpen = useChatStore((s) => s.setRightOpen)
  const [rightWidth, setRightWidth] = useState<number>(readRightWidth)
  useEffect(() => {
    localStorage.setItem(RIGHT_WIDTH_KEY, String(rightWidth))
  }, [rightWidth])

  const startRightResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startWidth = rightWidth
    const onMove = (move: PointerEvent): void => {
      // 往左拖变宽（右侧栏方向相反）
      const next = Math.round(startWidth - (move.clientX - startX))
      setRightWidth(Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, next)))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // 侧栏收起：左上角按钮切换，localStorage 记忆（重开保持）
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(readSidebarCollapsed)
  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0')
  }, [sidebarCollapsed])

  // 主窗内功能面板（同款）：工具/技能在聊天区原位切换；再点同一入口或选会话即收起
  const [panel, setPanel] = useState<SidePanel | null>(null)
  // 学习笔记卡开关（设置→目录页，默认关）
  const [notesCardOn, setNotesCardOn] = useState(false)
  const togglePanel = (next: SidePanel): void => {
    setPanel((cur) => (cur === next ? null : next))
  }

  const startSidebarResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    // 抓住指针：快速拖动也不会丢事件
    event.currentTarget.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startWidth = sidebarWidth
    let latest = startWidth
    let moved = false
    const onMove = (move: PointerEvent): void => {
      const next = Math.round(startWidth + move.clientX - startX)
      latest = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, next))
      if (latest !== startWidth) moved = true
      setSidebarWidth(latest)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      // 真正拖动了才算"用户选定的宽度"（原地点一下不改语义，默认值保持可更新）
      if (moved) {
        sidebarTouched.current = true
        localStorage.setItem(SIDEBAR_WIDTH_TOUCHED_KEY, '1')
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(latest))
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // 首次进入：先从会话注册表加载（跨窗口持久化），加载完仍无可见会话才自动新建
  useEffect(() => {
    void loadFromRegistry()
  }, [loadFromRegistry])

  // 同步当前工作区根到 store（历史重建时把绝对路径产出换算成相对路径 → 文件卡片可点）。
  // 跟随 SETTINGS_CHANGED 广播刷新：设置页换了工作区，卡片解析基准也要跟着变。
  // 同一趟顺带取「学习笔记卡」开关。
  useEffect(() => {
    const sync = (): void => {
      void window.petAPI.getConfig().then((config) => {
        const root =
          boundWorkspace(config.workspace, 'work') ??
          boundWorkspace(config.workspace, 'learn') ??
          ''
        useChatStore.getState().setWorkspaceRoot(root)
        setNotesCardOn(config.ui?.notesCard === true)
      })
    }
    sync()
    return window.petAPI.onSettingsChanged(sync)
  }, [])
  useEffect(() => {
    if (loaded && !hasSession) createSession()
  }, [loaded, hasSession, createSession])

  const isWelcome = activeMessages.length === 0

  return (
    <ChatErrorBoundary>
      <div className="chat-page">
        {/* 顶条手动拖拽（不再用 app-region:drag——原生 drag 区会吞掉叠在上面的
            顶部/左上/右上缩放区，且无边框窗拖顶条不会还原最大化，两个 bug 的根因）。
            单击无操作、拖动超阈值才还原跟随（防误触）、双击切换最大化 */}
        <div
          className="drag-strip"
          onPointerDown={startWindowDrag}
          onDoubleClick={toggleWindowMaximize}
        />
        {/* 收起/展开侧栏（左上角；no-drag 才能在拖拽条上点到） */}
        <button
          type="button"
          className="sidebar-toggle"
          title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
          onClick={() => setSidebarCollapsed((v) => !v)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect
              x="1.7"
              y="2.7"
              width="12.6"
              height="10.6"
              rx="2.6"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <line x1="5.6" y1="2.7" x2="5.6" y2="13.3" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        </button>
        {!sidebarCollapsed && !rightExpanded && (
          <>
            <SessionSidebar width={sidebarWidth} activePanel={panel} onTogglePanel={togglePanel} />
            <div
              className="sidebar-resizer"
              title="拖动调整侧栏宽度"
              onPointerDown={startSidebarResize}
            />
          </>
        )}
        {/* 右侧栏放大态：聊天区整体让位，侧栏占满主窗 */}
        <div className={rightExpanded ? 'chat-workspace is-hidden-for-right' : 'chat-workspace'}>
          <Decorations />
          {panel === 'tools' ? (
            <ToolsPanel />
          ) : panel === 'skills' ? (
            <SkillsPanel />
          ) : isWelcome ? (
            <>
              {/* 学习闭环卡在空会话也要在：学习模式刚进来往往是新会话，
                  而"今天该复习什么"恰恰是这时候最该看见的；此前它们只挂在有消息的分支里，
                  等于学习模式第一眼看不到入口。卡片各自内部判空，没数据就不占位。 */}
              <ReviewCard />
              <ProgressCard />
              <div className="chat-welcome">
                <div className="chat-welcome-hero">
                  <img
                    className="chat-welcome-art"
                    src={stickerHello}
                    alt="爱弥斯"
                    draggable={false}
                  />
                  {/* 模式徽标随胶囊联动：chat / work / learn */}
                  <span className="chat-welcome-badge">{chatMode}</span>
                  <div className="chat-welcome-line">
                    <b>爱弥斯</b>已上线，要来聊会天吗？
                  </div>
                </div>
                <ChatInput />
              </div>
            </>
          ) : (
            <>
              {notesCardOn && <NotesCard />}
              {/* 复习卡与进度卡不受「笔记卡」开关约束：有卡/有目标就显示（各自内部判空），
                  它们是学习闭环的主入口，藏在设置项后面等于没有 */}
              <ReviewCard />
              <ProgressCard />
              <MessageList />
              <ApprovalPanel />
              <AskPanel />
              <CheckpointBanner />
              <ChatInput />
            </>
          )}
        </div>
        {/* 任务清单侧轨：flex 兄弟节点 → 聊天区让位而不是被盖住；右栏展开时整体隐藏 */}
        {!rightExpanded && <TaskRail last={!rightOpen} />}
        {rightOpen && (
          <>
            <div
              className="right-resizer"
              title="拖动调整右侧栏宽度"
              onPointerDown={startRightResize}
            />
            <RightSidebar width={rightWidth} />
          </>
        )}
        {/* ModePill 自带 .mode-pill 定位（此前外面又包了一层同名 div，双层 absolute 嵌套导致胶囊整体下坠、与状态胶囊错位） */}
        <ModePill />
        {/* 工具/技能入口：同款胶囊贴顶栏左侧，
            与模式胶囊同 top 同款内衬 → y 轴中心线自然对齐；left 跟侧栏宽度联动
             */}
        <PanelPill
          panel={panel}
          onToggle={togglePanel}
          left={sidebarCollapsed || rightExpanded ? 84 : sidebarWidth + 48}
        />
        {!isWelcome ? <StatusPill /> : null}
        <button
          type="button"
          className="right-toggle"
          title={rightOpen ? '收起侧栏' : '展开侧栏（文件 / 预览）'}
          onClick={() => setRightOpen(!rightOpen)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect
              x="1.7"
              y="2.7"
              width="12.6"
              height="10.6"
              rx="2.6"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <line x1="10.4" y1="2.7" x2="10.4" y2="13.3" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        </button>
        <WindowControls />
        {RESIZE_EDGES.map((edge) => (
          <div
            key={edge}
            className={`resize-zone ${edge}`}
            onPointerDown={(event) => startResize(event, edge)}
          />
        ))}
      </div>
    </ChatErrorBoundary>
  )
}

export default ChatPage
