// 聊天状态仓（zustand，仅渲染进程）：会话列表 + 各会话消息 + 流式状态。
// T4 起走真实模型管线（chat:send → chat:stream）；T3 的演示假流已随 T4 接入整体移除。
// T5 阶段会话持久化落地（userData/sessions/*）。
// 消息结构继承 shared/protocol.ts 的 Message 契约；streaming 是渲染层私有 UI 状态，不落盘。

import { create } from 'zustand'
import type {
  Message,
  RunNoticeData,
  TodoUpdatedData,
  ToolApprovalRequestData,
  ToolAskRequestData,
  AskAnswer,
  ToolCallResultEventData,
  ToolExecStatus
} from '@shared/protocol'
import { RESUME_NUDGE_TEXT } from '@shared/types'
import { fileRefFromCall, producedFilesFromCall, stripRunJsMarker } from '@shared/produced-file'
import { diffFromToolArgs } from '@shared/diff-stat'
import type {
  ChatAttachmentPayload,
  ChatMode,
  PersistedMessage,
  SessionMeta,
  SessionStats,
  TokenUsage
} from '@shared/types'

/** 时间线段：
 * 按**发生顺序**记录一条 assistant 消息内的「思考 → 工具 → 思考 → … → 正文」。
 * 此前 thinking 累加成单串、工具堆成数组，渲染时所有思考挤在顶部、工具全在下面，
 * 时序被压平。timeline 让它们按原顺序穿插展示。 */
export type TimelineSegment =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | ({ kind: 'tool' } & ToolRunView)

/** 追加思考增量：末段是思考就并入，否则新开一段（保持"分段"语义，不再全挤一个块） */
function appendThinkingSegment(list: TimelineSegment[], chunk: string): TimelineSegment[] {
  const last = list[list.length - 1]
  if (last !== undefined && last.kind === 'thinking') {
    const text = last.text + chunk
    return [
      ...list.slice(0, -1),
      { kind: 'thinking', text: text.length > 30_000 ? text.slice(-30_000) : text }
    ]
  }
  return [...list, { kind: 'thinking', text: chunk }]
}

/** 追加正文增量：末段是正文就并入，否则新开一段 */
function appendTextSegment(list: TimelineSegment[], chunk: string): TimelineSegment[] {
  const last = list[list.length - 1]
  if (last !== undefined && last.kind === 'text') {
    return [...list.slice(0, -1), { kind: 'text', text: last.text + chunk }]
  }
  return [...list, { kind: 'text', text: chunk }]
}

/** 把时间线里的工具段回填/新增（按 toolCallId 定位；找不到就新建——历史重建用）。
 * patch 只覆盖**显式给出**的字段（undefined 不参与合并），避免结果回填时把
 * 已记下的 name/argsPreview 冲掉。渲染时还会与 message.toolRuns 取最新值兜底。 */
function upsertToolSegment(
  list: TimelineSegment[],
  patch: { toolCallId: string } & Partial<ToolRunView>
): TimelineSegment[] {
  const at = list.findIndex((s) => s.kind === 'tool' && s.toolCallId === patch.toolCallId)
  if (at === -1) {
    return [
      ...list,
      { kind: 'tool', name: patch.name ?? '', argsPreview: patch.argsPreview ?? '', ...patch }
    ]
  }
  const prev = list[at]
  if (prev.kind !== 'tool') return list
  const merged: TimelineSegment = { ...prev }
  const target = merged as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) target[k] = v
  }
  const next = [...list]
  next[at] = merged
  return next
}

/** 工具调用卡片的前端视图（挂在本条 assistant 消息上，按 toolCallId 关联结果） */
export interface ToolRunView {
  toolCallId: string
  name: string
  argsPreview: string
  /** 执行开始时刻（本地时钟；仅实时流有——重启恢复的历史没有，UI 就不显示实时耗时） */
  startedAt?: number
  /** 执行结果（进行中缺省；重启后从盘上恢复的历史只有结果文本，无 ok/耗时） */
  ok?: boolean
  resultPreview?: string
  durationMs?: number
  /** 四态（缺省按 ok 推导）：ok / failed / timeout / denied */
  status?: ToolExecStatus
  /** 涉及的工作区文件（读写类工具）：工具卡升级为文件行，点击在右侧栏预览 */
  file?: { rel: string; name: string; action: string }
  /** 变更行数（write_file/edit_file 完成）：文件行显示「+N -M」 */
  diff?: { added: number; removed: number }
  /** 子任务分身进度：由三种 agent 事件驱动；
   * 历史会话从盘上恢复时没有此字段——工具卡回退为通用渲染（报告文本在 resultPreview 里） */
  sub?: SubAgentView
}

/** 子任务分身卡片的视图状态（MessageBubble 渲染用） */
export interface SubAgentView {
  agentId: string
  objective: string
  status: 'running' | 'completed' | 'failed' | 'aborted' | 'budget-exhausted'
  /** 运行中进度 */
  round?: number
  step?: number
  lastTool?: string
  /** 终态产物 */
  report?: string
  rounds?: number
  steps?: number
  ms?: number
}

export interface ChatMessage extends Message {
  /** 渲染层私有：本条消息是否正在流式输出 */
  streaming?: boolean
  /** 附件的展示信息（不含文件内容；图片带 dataUrl 用于本地回显，表情包走 sticker:// 协议） */
  attachments?: Array<Pick<ChatAttachmentPayload, 'name' | 'kind' | 'dataUrl'>>
  /** 本条 assistant 消息发起的工具调用 */
  toolRuns?: ToolRunView[]
  /** 过程时间线：思考/工具/正文按发生顺序穿插。有值时组件按它渲染，
   * 缺省（更早的历史消息）回退旧布局——思考块在顶 + 工具卡在下 */
  timeline?: TimelineSegment[]
  /** 本轮产出的文件（同款口径）：渲染在气泡末尾，点击 → 右侧栏预览 */
  files?: Array<{ rel: string; name: string; action: string }>
}

/** 对指定消息的时间线做一次变换（列表里其它消息原样返回）——事件处理统一入口。
 * 有 timeline 才改；旧消息（无 timeline）不凭空造，渲染层回退旧布局。 */
function withTimeline(
  list: ChatMessage[],
  messageId: string,
  fn: (tl: TimelineSegment[]) => TimelineSegment[]
): ChatMessage[] {
  return list.map((m) => (m.id === messageId ? { ...m, timeline: fn(m.timeline ?? []) } : m))
}

/** 把一条系统通知并进消息列表（纯函数，可单测）。
 * 同 id 已存在则原样返回——主进程落盘的通报与本地的即时显示是同一条，
 * 从盘上恢复后不会出现两条一样的通报。 */
export function appendNotice(
  list: ChatMessage[],
  notice: { id: string; text: string; ts: number }
): ChatMessage[] {
  if (list.some((m) => m.id === notice.id)) return list
  return [...list, { id: notice.id, role: 'notice', content: notice.text, ts: notice.ts }]
}

/** 持久化消息 → 渲染消息（**纯函数，可单测**）。
 *
 * 按「回合」合并：一轮 = 一条 user 之后的所有
 * assistant/tool 消息。此前一条持久化 assistant 就渲染成一个气泡 → 重进后同一轮
 * 回答被切成 4 个气泡（各带头像）；而实时流式本来就是单气泡。合并后整轮 = 一条消息
 * + 一条时间线，历史与实时观感一致。
 *
 * 时间线按盘上顺序重建：assistant(本步思考 + 调用清单) → tool(结果) → … → 最终
 * assistant(思考 + 正文)，即「思考 → 工具 → 思考 → … → 正文」。
 * 历史里工具必有结果 → 直接落终态（否则卡片永远显示「正在调用」， 截图）。
 */
export function groupPersistedIntoTurns(
  messages: PersistedMessage[],
  workspaceRoot = ''
): ChatMessage[] {
  const toolResults = new Map(
    messages.filter((m) => m.role === 'tool').map((m) => [m.toolCallId ?? '', m.text])
  )
  const out: ChatMessage[] = []
  let turn: ChatMessage | null = null
  const flush = (): void => {
    if (turn !== null) out.push(turn)
    turn = null
  }
  for (const m of messages) {
    if (m.role === 'user') {
      flush()
      out.push({
        id: m.id,
        role: 'user',
        content: m.text,
        ts: m.ts,
        ...(m.attachments !== undefined
          ? {
              attachments: m.attachments.map(({ name, kind, dataUrl }) => ({
                name,
                kind,
                dataUrl
              }))
            }
          : {})
      })
      continue
    }
    if (m.role === 'tool') continue // 结果已进 toolResults（随调用段一起渲染）
    // 系统通知（任务收尾的清理结果）：独立成一行，不并进助手气泡——
    // 它不是她"说的话"，是系统对用户的通报（纯展示，不参与对话）
    if (m.role === 'notice') {
      flush()
      out.push({ id: m.id, role: 'notice', content: m.text, ts: m.ts })
      continue
    }
    // assistant：并入当前回合（回合内多条 = 各步）
    if (turn === null) {
      turn = { id: m.id, role: 'assistant', content: '', ts: m.ts, timeline: [], toolRuns: [] }
    } else {
      turn.id = m.id // 用回合内最后一条 assistant 的 id 作稳定 key
    }
    const segs: TimelineSegment[] = []
    // 顺序 = 模型实际输出顺序：思考 → 正文（过渡句）→ 工具调用
    if (m.thinking !== undefined && m.thinking !== '') {
      segs.push({ kind: 'thinking', text: m.thinking })
    }
    if (m.text !== '') {
      segs.push({ kind: 'text', text: m.text })
      turn.content = turn.content === '' ? m.text : `${turn.content}\n\n${m.text}`
    }
    for (const tc of m.toolCalls ?? []) {
      const result = toolResults.get(tc.id)
      const ref = fileRefFromCall(tc.name, tc.argsJson, workspaceRoot)
      const histDiff = result !== undefined ? diffFromToolArgs(tc.name, tc.argsJson) : null
      const run: ToolRunView = {
        toolCallId: tc.id,
        name: tc.name,
        argsPreview: tc.argsJson.slice(0, 120),
        // 历史里必有结果 → 直接落终态，避免工具卡永远显示「正在调用」
        ok: result !== undefined,
        ...(ref !== null ? { file: ref } : {}),
        ...(histDiff !== null ? { diff: histDiff } : {}),
        ...(result !== undefined ? { resultPreview: stripRunJsMarker(result).slice(0, 2000) } : {})
      }
      segs.push({ kind: 'tool', ...run })
      turn.toolRuns = [...(turn.toolRuns ?? []), run]
      // 历史里也还原产出文件卡片：单路径工具认参数；run_js 认结果末尾的标记行
      const producedList =
        result !== undefined
          ? producedFilesFromCall(tc.name, tc.argsJson, result, workspaceRoot)
          : []
      for (const produced of producedList) {
        if (!(turn.files ?? []).some((f) => f.rel === produced.rel)) {
          turn.files = [...(turn.files ?? []), produced]
        }
      }
    }
    turn.timeline = [...(turn.timeline ?? []), ...segs]
  }
  flush()
  return out
}

/** tool_call_result → 消息的 files 增量合并（file 单产出 + files 多产出，同 rel 去重）。
 * 返回可直接展开进消息的补丁对象；无新增时返回空对象。 */
function mergeProducedCards(
  existing: Array<{ rel: string; name: string; action: string }> | undefined,
  d: ToolCallResultEventData
): { files?: Array<{ rel: string; name: string; action: string }> } {
  const incoming = [...(d.file !== undefined ? [d.file] : []), ...(d.files ?? [])]
  const fresh = incoming.filter((f) => !(existing ?? []).some((x) => x.rel === f.rel))
  return fresh.length > 0 ? { files: [...(existing ?? []), ...fresh] } : {}
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 纯函数：给流式中的消息追加 token（返回新数组，不改入参）——可单测 */
export function appendToken(list: ChatMessage[], messageId: string, chunk: string): ChatMessage[] {
  return list.map((m) => (m.id === messageId ? { ...m, content: m.content + chunk } : m))
}

/** 思考内存态上限（卡死防护 ）：超长思考（实测 4.1 万字）是渲染卡死源头之一。
 * 渲染层只保尾部窗口（见 ThinkingBlock），这里封顶防极端；持久化另有 8000 字截断。 */
export const THINKING_CAP = 30_000

/** 纯函数：给流式中的消息追加思考增量——可单测 */
export function appendThinking(
  list: ChatMessage[],
  messageId: string,
  chunk: string
): ChatMessage[] {
  return list.map((m) => {
    if (m.id !== messageId) return m
    const next = (m.thinking ?? '') + chunk
    // 超上限：保尾部（最新的推理更相关），一次性截断而非逐字丢弃
    return { ...m, thinking: next.length > THINKING_CAP ? next.slice(-THINKING_CAP) : next }
  })
}

/** 纯函数：结束消息的流式态；messageId 缺省时结束所有 streaming 消息（stop 用） */
export function finalize(list: ChatMessage[], messageId?: string): ChatMessage[] {
  return list.map((m) =>
    messageId === undefined || m.id === messageId ? { ...m, streaming: false } : m
  )
}

/**
 * 派生 selector：**当前活动会话**是否正在流式（多会话并行 ：
 * 在途 run 按会话记录在 runningIds——A 会话跑着不影响 B 会话发送；
 * 切回在途会话时条件重新成立，停止按钮照样在）。
 * 返回原始布尔，不产生新引用（zustand selector 规范）。
 */
export function selectStreamingActive(s: {
  runningIds: string[]
  activeId: string | null
}): boolean {
  return s.activeId !== null && s.runningIds.includes(s.activeId)
}

/** 侧栏日期分组的标签与所属会话（sessions 需已按最新在前排序）——纯函数，可单测 */
export interface SessionGroup {
  label: string
  sessions: SessionMeta[]
}

export function groupSessionsByDate(sessions: SessionMeta[], now = Date.now()): SessionGroup[] {
  const dayStart = (ts: number): number => {
    const d = new Date(ts)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  // 置顶分组：置顶会话独立成组且永远在最前，组内 updatedAt 倒序
  const pinned = sessions.filter((s) => s.pinned === true).sort((a, b) => b.updatedAt - a.updatedAt)
  const rest = sessions.filter((s) => s.pinned !== true)
  const today = dayStart(now)
  const yesterday = today - 86_400_000
  const buckets: Record<string, SessionMeta[]> = { 今天: [], 昨天: [], 更早: [] }
  for (const s of rest) {
    const t = dayStart(s.updatedAt)
    if (t === today) buckets['今天'].push(s)
    else if (t === yesterday) buckets['昨天'].push(s)
    else buckets['更早'].push(s)
  }
  const dateGroups = ['今天', '昨天', '更早']
    .filter((label) => buckets[label].length > 0)
    .map((label) => ({
      label,
      sessions: [...buckets[label]].sort((a, b) => b.updatedAt - a.updatedAt)
    }))
  if (pinned.length === 0) return dateGroups
  return [{ label: '置顶', sessions: pinned }, ...dateGroups]
}

/**
 * 自动标题：首条用户消息压空白，>30 字截断加…。
 * 不调 LLM：零成本零失败；配合 SessionMeta.titleIsCustom 保护用户手动改名。
 */
export function deriveTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (cleaned === '') return ''
  return cleaned.length > 30 ? `${cleaned.slice(0, 30)}…` : cleaned
}

interface ChatState {
  sessions: SessionMeta[]
  activeId: string | null
  /** sessionId → 消息列表；T5 起会话历史持久化在主进程，切到未加载的会话时经 IPC 拉取 */
  messagesBySession: Record<string, ChatMessage[]>
  /** 正在流式输出的会话 id 集合（多会话并行 ）：控制各会话的 发送/停止 与打断 */
  runningIds: string[]
  /** 会话注册表是否已加载（加载前不自动建会话，避免与持久化列表赛跑） */
  loaded: boolean
  /** 每会话最近一次请求的真实 token 用量 */
  usageBySession: Record<string, TokenUsage>
  /** 每会话遥测累计 */
  statsBySession: Record<string, SessionStats>
  /** 待用户审批的请求；审批卡渲染与决策都消费它 */
  approvalBySession: Record<string, ToolApprovalRequestData>
  /** 待作答的提问：sessionId → 提问请求，渲染层出提问卡 */
  askBySession: Record<string, ToolAskRequestData>
  /** 引擎侧状态提示（自动续跑/重试）：流式气泡下那行淡色说明；done/新 run 时清掉 */
  noticeBySession: Record<string, RunNoticeData>
  /** 每会话未完成任务存档：有值 = 显示"继续任务"横幅 */
  checkpointBySession: Record<string, { steps: number; updatedAt: number }>
  /** 每会话任务清单：todo_updated 推送 + 切会话恢复 */
  todosBySession: Record<string, TodoUpdatedData['items']>
  /** 学习闭环刷新信号：复习评分成功后自增。
   * 复习卡与进度卡是同一份 review/progress 数据的两个视图——此前只在切会话/流式结束时
   * 各自重读，评分不触发，导致「复习卡说已练、进度卡还写已练 0」。两卡都依赖这个 tick，
   * 评分后一起刷新，不再各刷各的。 */
  learnTick: number
  /** 三模式：chat=纯对话无工具 / work=harness 全工具 / learn=教学守则+笔记；localStorage 记忆 */
  chatMode: ChatMode
  /** 右侧边栏（学 成熟实现better-sidebar）：开合 / 当前 tab / 正在预览的文件。
   * 放 store 里是因为触发方跨组件——文件树、聊天里的文件卡片、侧栏开关按钮都要能开它。 */
  rightOpen: boolean
  rightTab: RightPanelTab
  /** 右侧栏打开的文件标签 */
  rightFiles: Array<{ rel: string; name: string }>
  /** 当前激活的文件标签（rel）；关掉激活 tab 时自动切到相邻 */
  rightActiveRel: string | null
  /** 当前工作区根（历史重建时把绝对路径产出换算成相对路径；'' = 未绑定） */
  workspaceRoot: string
  /** 右侧栏放大至整个主窗 */
  rightExpanded: boolean
  /** 内置浏览器待打开的 URL（聊天外链写入，BrowserPanel 挂载时取走） */
  browserPendingUrl: string | null
  setChatMode: (mode: ChatMode) => void
  /** 工作中插话（steering）：任务运行中把消息注入下一轮上下文并本地显示用户气泡。
   * 返回 false = 没有活跃任务（调用方回退普通发送）。 */
  nudge: (text: string) => Promise<boolean>
  setRightOpen: (open: boolean) => void
  /** 记录当前工作区根（App 启动/配置变更时同步；历史重建依赖它换算绝对路径产出） */
  setWorkspaceRoot: (root: string) => void
  /** 切换右侧栏放大态（放大时聊天区隐藏、侧栏占满主窗） */
  toggleRightExpanded: () => void
  setRightTab: (tab: RightPanelTab) => void
  /** 打开右侧栏并预览指定文件（文件树条目与聊天文件卡片共用入口）；
   * 已打开则激活，未打开则追加新标签（上限见 RIGHT_FILES_MAX） */
  openRightFile: (rel: string, name: string) => void
  /** 聊天里点外链：在右侧栏内置浏览器打开（而不是让主窗跳走） */
  openRightLink: (url: string) => void
  /** 浏览器面板挂载时取走待打开的 URL（取一次即清，避免切 tab 重复导航） */
  consumeBrowserPendingUrl: () => string | null
  /** 关闭一个文件标签；关的是激活项时自动切到相邻标签 */
  closeRightFile: (rel: string) => void

  createSession: () => void
  selectSession: (id: string) => void
  deleteSession: (id: string) => void
  renameSession: (id: string, title: string) => void
  /** 隐藏会话：从侧栏消失，可在 设置 → 会话 中恢复 */
  hideSession: (id: string) => void
  /** 置顶 / 取消置顶：侧栏"置顶"分组优先展示；不动 updatedAt（不改变日期分组归属） */
  togglePin: (id: string) => void
  /** 勾选/取消任务清单项：乐观更新 + 失败回滚 */
  toggleTodo: (todoId: string) => void
  /** 学习闭环刷新：复习评分成功后调用，驱动复习卡/进度卡一起重读 */
  bumpLearnTick: () => void
  /** 从注册表加载会话列表（应用启动 + 注册表变更广播时调用） */
  loadFromRegistry: () => Promise<void>
  /** 拉取指定会话的持久化消息（懒加载，每会话只拉一次） */
  loadMessages: (id: string) => Promise<void>
  send: (text: string, attachments?: ChatAttachmentPayload[], opts?: { resume?: boolean }) => void
  stop: (sessionId?: string) => void
  /** 审批决策：回执主进程并清掉本会话的审批卡 */
  respondApproval: (
    approvalId: string,
    decision: 'allow' | 'allow-always' | 'deny'
  ) => Promise<void>
  /** 提问作答：回执主进程唤醒挂起的 ask_user，并清掉本会话提问卡 */
  respondAsk: (askId: string, answers: AskAnswer[]) => Promise<void>
  /** 续跑未完成任务：以提示语走完整发送管线 */
  resumeTask: () => void
}

let sessionSeq = 0
/** 已从持久化层拉取过消息的会话（进程内缓存标记；新会话直接标记跳过拉取） */
const messagesLoaded = new Set<string>()

/** 真实路径的进行中一跳：runId ↔ 本地 assistant 消息的关联 + 事件解绑函数 */
interface ActiveRun {
  /** 主进程尚未返回 runId 时为 null（事件先缓冲，见 buffered） */
  runId: string | null
  sessionId: string
  messageId: string
  unsubscribe: () => void
  buffered: Array<{ type: string; data: unknown }>
}
/** 各会话的在途 run（多会话并行 ）：sessionId → run；无 run 的会话可自由发送 */
const runsBySession = new Map<string, ActiveRun>()

/**
 * 指定会话当前流式气泡的本地 id（动态读该会话的 run）。
 * **工作中插话**后气泡会切到新的——事件处理必须动态取，
 * 否则插话后的 token 还会写进旧气泡，视觉顺序错乱。
 */
function currentBubbleId(sessionId: string): string {
  return runsBySession.get(sessionId)?.messageId ?? ''
}
/** 注册表变更广播的解绑函数（loadFromRegistry 首次调用时订阅一次） */
/** 三模式持久化键：chat=纯对话 / work=工作 / learn=学习 */
/** 右侧栏文件标签上限：再多挤掉最旧的（防标签条挤爆；成熟实现better-sidebar 同款约束思路） */
/** 右侧栏面板页（v15 对齐 成熟实现-better-sidebar：文件/预览/任务/Git/终端） */
export type RightPanelTab =
  'files' | 'preview' | 'tasks' | 'git' | 'terminal' | 'browser' | 'search'

const RIGHT_FILES_MAX = 8
/** 右侧栏当前 tab 的持久化键 */
const RIGHT_TAB_KEY = 'aemeath.right-tab'

function readStoredRightTab(): RightPanelTab {
  try {
    const raw = localStorage.getItem(RIGHT_TAB_KEY)
    if (
      raw === 'files' ||
      raw === 'preview' ||
      raw === 'git' ||
      raw === 'terminal' ||
      raw === 'browser' ||
      raw === 'search'
    ) {
      return raw
    }
  } catch {
    // localStorage 不可用：回默认
  }
  return 'files'
}

const MODE_KEY = 'aemeath.chat-mode'

function readStoredMode(): ChatMode {
  try {
    const raw = localStorage.getItem(MODE_KEY)
    return raw === 'chat' || raw === 'learn' ? raw : 'work'
  } catch {
    return 'work'
  }
}

let registryUnsub: (() => void) | null = null

/** 变更后全量同步到主进程注册表（落盘 + 广播；node 测试环境无 window 时跳过） */
function syncRegistry(list: SessionMeta[]): void {
  if (typeof window === 'undefined') return
  window.petAPI.sessionsSync(list)
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeId: null,
  messagesBySession: {},
  runningIds: [],
  loaded: false,
  usageBySession: {},
  statsBySession: {},
  approvalBySession: {},
  askBySession: {},
  noticeBySession: {},
  todosBySession: {},
  checkpointBySession: {},
  learnTick: 0,
  chatMode: readStoredMode(),
  rightOpen: false,
  rightTab: readStoredRightTab(),
  browserPendingUrl: null,
  rightExpanded: false,
  rightFiles: [],
  rightActiveRel: null,
  workspaceRoot: '',

  loadFromRegistry: async () => {
    if (typeof window === 'undefined') return
    // 订阅注册表变更广播（设置页恢复/删除 → 这里重新加载跟随）；只订一次
    if (registryUnsub === null) {
      registryUnsub = window.petAPI.onSessionsChanged(() => {
        void useChatStore.getState().loadFromRegistry()
      })
    }
    const list = await window.petAPI.sessionsList()
    set((state) => {
      // 注册表没有的会话（别处被永久删除）同步清掉本地消息缓存标记与内存消息
      const messages = { ...state.messagesBySession }
      const usage = { ...state.usageBySession }
      const stats = { ...state.statsBySession }
      for (const id of Object.keys(messages)) {
        if (!list.some((s) => s.id === id)) {
          delete messages[id]
          delete usage[id]
          delete stats[id]
          messagesLoaded.delete(id)
        }
      }
      let activeId = state.activeId
      if (activeId === null || !list.some((s) => s.id === activeId && s.hidden !== true)) {
        activeId = list.find((s) => s.hidden !== true)?.id ?? null
      }
      return {
        sessions: list,
        messagesBySession: messages,
        usageBySession: usage,
        statsBySession: stats,
        activeId,
        loaded: true
      }
    })
    // 当前激活会话的消息正文懒加载
    const current = get().activeId
    if (current !== null) {
      // 胶囊跟随活动会话的模式（会话是模式权威， 扩展）
      const activeMeta = get().sessions.find((x) => x.id === current)
      if (activeMeta !== undefined) set({ chatMode: activeMeta.mode ?? 'work' })
      void get().loadMessages(current)
    }
  },

  nudge: async (text) => {
    const sessionId = get().activeId
    const run = sessionId === null ? undefined : runsBySession.get(sessionId)
    if (run === undefined || sessionId === null) return false
    const accepted = await window.petAPI.chatNudge(sessionId, text.trim())
    if (!accepted) return false

    // 本地视觉切换：结束当前气泡 → 用户气泡 → 新的流式气泡（后续 token 写新气泡）
    set((state) => {
      const list = state.messagesBySession[sessionId] ?? []
      const closed = finalize(list, run.messageId)
      const userMsg: ChatMessage = {
        id: newId('u'),
        role: 'user',
        content: text.trim(),
        ts: Date.now()
      }
      const nextAssistant: ChatMessage = {
        id: newId('a'),
        role: 'assistant',
        content: '',
        ts: Date.now() + 1,
        streaming: true
      }
      run.messageId = nextAssistant.id
      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: [...closed, userMsg, nextAssistant]
        }
      }
    })
    return true
  },

  setWorkspaceRoot: (root) => {
    set({ workspaceRoot: root })
  },

  setRightOpen: (open) => {
    // 收起侧栏时一并退出放大态（放大模式点顶栏收起按钮主窗空白——
    // 聊天区被 rightExpanded 藏着，只关 rightOpen 就什么都不剩）。所有收起入口统一走这里。
    if (open === false) {
      set({ rightOpen: false, rightExpanded: false })
      return
    }
    set({ rightOpen: true })
  },

  toggleRightExpanded: () => {
    set((state) => ({ rightExpanded: !state.rightExpanded }))
  },

  setRightTab: (tab) => {
    try {
      localStorage.setItem(RIGHT_TAB_KEY, tab)
    } catch {
      // 隐私模式等 localStorage 不可用：仅内存生效
    }
    set({ rightTab: tab })
  },

  openRightFile: (rel, name) => {
    // 多文件标签（同款口径）：已开 → 激活；没开 → 追加（超上限挤掉最旧）
    const cur = get().rightFiles
    const exists = cur.some((f) => f.rel === rel)
    const next = exists ? cur : [...cur, { rel, name }].slice(-RIGHT_FILES_MAX)
    set({
      rightOpen: true,
      rightTab: 'preview',
      rightFiles: next,
      rightActiveRel: rel
    })
  },

  closeRightFile: (rel) => {
    const cur = get().rightFiles
    const at = cur.findIndex((f) => f.rel === rel)
    if (at === -1) return
    const next = cur.filter((f) => f.rel !== rel)
    const active = get().rightActiveRel
    // 关的是激活项 → 切到相邻（右邻优先，没有就左邻）；全关了清激活
    const nextActive = active === rel ? ((next[at] ?? next[at - 1])?.rel ?? null) : active
    set({ rightFiles: next, rightActiveRel: nextActive })
  },

  openRightLink: (url) => {
    const t = url.trim()
    // 只接 http(s)；其余 scheme（mailto:/文件链接）交系统处理
    if (!/^https?:\/\//i.test(t)) {
      void window.petAPI.openExternal(t)
      return
    }
    get().setRightTab('browser')
    set({ rightOpen: true, rightExpanded: false, browserPendingUrl: t })
  },

  consumeBrowserPendingUrl: () => {
    const url = get().browserPendingUrl
    if (url !== null) set({ browserPendingUrl: null })
    return url
  },

  setChatMode: (mode) => {
    try {
      localStorage.setItem(MODE_KEY, mode)
    } catch {
      // 隐私模式等 localStorage 不可用：仅内存生效
    }
    // 同款：切模式 = 切换该模式的会话列表；当前会话不属于新模式时，
    // 自动切到该模式最近一条（sessions 按 updatedAt 倒序，首个匹配即最新），没有则回欢迎页
    const state = get()
    const activeMeta =
      state.activeId === null ? undefined : state.sessions.find((x) => x.id === state.activeId)
    if (activeMeta !== undefined && (activeMeta.mode ?? 'work') === mode) {
      set({ chatMode: mode })
      return
    }
    const latest = state.sessions.find((x) => x.hidden !== true && (x.mode ?? 'work') === mode)
    set({ chatMode: mode, activeId: latest?.id ?? null })
    if (latest !== undefined) void get().loadMessages(latest.id)
  },

  createSession: () => {
    sessionSeq += 1
    const now = Date.now()
    const session: SessionMeta = {
      id: newId('s'),
      title: `新会话 ${sessionSeq}`,
      createdAt: now,
      updatedAt: now,
      mode: get().chatMode // 会话绑定创建时的模式
    }
    messagesLoaded.add(session.id) // 新会话无历史，跳过持久化拉取
    set((state) => {
      const sessions = [session, ...state.sessions]
      syncRegistry(sessions)
      return {
        sessions,
        activeId: session.id,
        messagesBySession: { ...state.messagesBySession, [session.id]: [] },
        todosBySession: { ...state.todosBySession, [session.id]: [] }
      }
    })
  },

  selectSession: (id) => {
    set({ activeId: id })
    // 胶囊跟随会话自身模式
    const meta = get().sessions.find((x) => x.id === id)
    if (meta !== undefined) set({ chatMode: meta.mode ?? 'work' })
    void get().loadMessages(id)
    // 恢复该会话的任务清单：无清单时清空本地进度卡
    void window.petAPI.todoGet(id).then((todos) => {
      set((state) => ({
        todosBySession: { ...state.todosBySession, [id]: todos?.items ?? [] }
      }))
    })
  },

  loadMessages: async (id) => {
    if (typeof window === 'undefined' || id === '') return
    if (messagesLoaded.has(id)) return
    // 正在流式输出的会话以本地状态为准（主进程落盘在流结束时才发生）
    if (runsBySession.has(id)) return
    messagesLoaded.add(id)
    const res = await window.petAPI.sessionMessages(id).catch(() => null)
    if (res === null || res.corrupted) return
    set((state) => {
      const next: Partial<ChatState> = {}
      // 真实用量/遥测独立于消息列表，始终跟随持久化值刷新
      if (res.usage !== undefined) {
        next.usageBySession = { ...state.usageBySession, [id]: res.usage }
      }
      if (res.stats !== undefined) {
        next.statsBySession = { ...state.statsBySession, [id]: res.stats }
      }
      // 任务清单恢复：与消息同生命周期（首次进入会话时拉取）
      void window.petAPI.todoGet(id).then((todos) => {
        set((state) => ({
          todosBySession: { ...state.todosBySession, [id]: todos?.items ?? [] }
        }))
      })
      // 任务存档标记：有未完成任务则显示续跑横幅
      void window.petAPI.checkpointGet(id).then((marker) => {
        set((state) => {
          const next: Record<string, { steps: number; updatedAt: number }> = {
            ...state.checkpointBySession
          }
          if (marker !== null) next[id] = { steps: marker.steps, updatedAt: marker.updatedAt }
          else delete next[id]
          return { checkpointBySession: next }
        })
      })
      // 本地已有内容（例如刚流式完的会话）不覆盖消息，避免竞态回退
      const current = state.messagesBySession[id]
      if (current === undefined || current.length === 0) {
        // 按回合合并重建（纯函数，见 groupPersistedIntoTurns）——整轮一条气泡 + 一条时间线
        next.messagesBySession = {
          ...state.messagesBySession,
          [id]: groupPersistedIntoTurns(res.messages, get().workspaceRoot)
        }
      }
      return next
    })
  },

  hideSession: (id) => {
    const now = Date.now()
    set((state) => {
      const sessions = state.sessions.map((s) =>
        s.id === id ? { ...s, hidden: true, updatedAt: now } : s
      )
      syncRegistry(sessions)
      const activeStillVisible = sessions.some(
        (s) => s.id === state.activeId && s.hidden !== true && (s.mode ?? 'work') === state.chatMode
      )
      return {
        sessions,
        // 隐藏当前会话时切到"当前模式下"的下一个可见会话
        activeId: activeStillVisible
          ? state.activeId
          : (sessions.find((s) => s.hidden !== true && (s.mode ?? 'work') === state.chatMode)?.id ??
            null)
      }
    })
  },

  togglePin: (id) => {
    set((state) => {
      const sessions = state.sessions.map((s) =>
        s.id === id ? { ...s, pinned: s.pinned !== true } : s
      )
      syncRegistry(sessions)
      return { sessions }
    })
  },

  toggleTodo: (todoId) => {
    // 任务侧轨勾选：乐观翻转先落 UI，失败回滚——勾选手感要即时。
    // 落盘走主进程 workspace:todo-toggle（复用 agent 的 todo-store，与工具侧同一份数据）。
    const sessionId = get().activeId
    if (sessionId === null) return
    const before = get().todosBySession[sessionId] ?? []
    const flip = (list: TodoUpdatedData['items']): TodoUpdatedData['items'] =>
      list.map((it) =>
        it.id === todoId ? { ...it, status: it.status === 'done' ? 'pending' : 'done' } : it
      )
    set((state) => ({
      todosBySession: {
        ...state.todosBySession,
        [sessionId]: flip(state.todosBySession[sessionId] ?? [])
      }
    }))
    void window.petAPI.workspaceTodoToggle(sessionId, todoId).then((res) => {
      if (res.ok === false) {
        set((state) => ({ todosBySession: { ...state.todosBySession, [sessionId]: before } }))
      }
    })
  },

  bumpLearnTick: () => {
    // 学习闭环刷新：复习评分成功后自增，复习卡/进度卡各自 effect 依赖它重读。
    set((state) => ({ learnTick: state.learnTick + 1 }))
  },

  renameSession: (id, title) => {
    const trimmed = title.trim()
    if (trimmed === '') return
    set((state) => {
      const sessions = state.sessions.map((s) =>
        s.id === id ? { ...s, title: trimmed, titleIsCustom: true, updatedAt: Date.now() } : s
      )
      syncRegistry(sessions)
      return { sessions }
    })
  },

  deleteSession: (id) => {
    // 删除正在流式输出的会话先打断它（多会话并行：只停这一个，不碰别的会话的 run）
    if (runsBySession.has(id)) get().stop(id)
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id)
      const messagesBySession = { ...state.messagesBySession }
      delete messagesBySession[id]
      const usageBySession = { ...state.usageBySession }
      delete usageBySession[id]
      const statsBySession = { ...state.statsBySession }
      delete statsBySession[id]
      const approvalBySession = { ...state.approvalBySession }
      delete approvalBySession[id]
      const askBySession = { ...state.askBySession }
      delete askBySession[id]
      const noticeBySession = { ...state.noticeBySession }
      delete noticeBySession[id]
      const checkpointBySession = { ...state.checkpointBySession }
      delete checkpointBySession[id]
      messagesLoaded.delete(id)
      syncRegistry(sessions)
      return {
        sessions,
        messagesBySession,
        usageBySession,
        statsBySession,
        approvalBySession,
        askBySession,
        noticeBySession,
        checkpointBySession,
        // 删除可见会话时切到"当前模式下"的下一个可见会话（跳过已隐藏/其它模式——
        // 此前跨模式兜底会让工作侧栏空着却显示其它模式的空会话视图）
        activeId:
          state.activeId === id
            ? (sessions.find((s) => s.hidden !== true && (s.mode ?? 'work') === state.chatMode)
                ?.id ?? null)
            : state.activeId
      }
    })
  },

  send: (raw, attachments, opts) => {
    const text = raw.trim()
    const atts = attachments ?? []
    const resume = opts?.resume === true
    if (text === '' && atts.length === 0 && !resume) return

    let sessionId = get().activeId
    if (sessionId === null) {
      get().createSession()
      sessionId = get().activeId
    }
    if (sessionId === null) return // 防御：不应发生
    // 同会话串行（不同会话互不影响）：本会话已有在途 run 就不重复发
    if (runsBySession.has(sessionId)) return

    // ── 真实路径：chat:send → chat:stream──
    const userMsg: ChatMessage = {
      id: newId('m'),
      role: 'user',
      content: text,
      ts: Date.now(),
      attachments:
        atts.length > 0
          ? atts.map(({ name, kind, dataUrl }) => ({ name, kind, dataUrl }))
          : undefined
    }
    const assistantMsg: ChatMessage = {
      id: newId('m'),
      role: 'assistant',
      content: '',
      ts: Date.now(),
      streaming: true
    }
    // 本轮 run 先建档（finishRun/handleEvent 闭包引用它；unsubscribe 订阅后回填）。
    // 气泡 id 用本轮新建的 assistantMsg.id——currentBubbleId(sessionId) 动态读 run.messageId，
    // 插话 steering 的气泡重指向在 nudge 动作里做（run.messageId=新气泡）。
    const run: ActiveRun = {
      runId: null,
      sessionId,
      messageId: assistantMsg.id,
      unsubscribe: () => {},
      buffered: []
    }
    runsBySession.set(sessionId, run)
    set((state) => {
      const list = [...(state.messagesBySession[sessionId] ?? []), userMsg, assistantMsg]
      // 元信息更新：活动时间 + 自动标题（首条非空用户消息；手动改名后永久失效）
      let sessions = state.sessions.map((s) =>
        s.id === sessionId ? { ...s, updatedAt: Date.now() } : s
      )
      const meta = sessions.find((s) => s.id === sessionId)
      if (meta !== undefined && meta.titleIsCustom !== true) {
        const firstUser = list.find((m) => m.role === 'user' && m.content.trim() !== '')
        if (firstUser !== undefined) {
          const derived = deriveTitle(firstUser.content)
          if (derived !== '' && derived !== meta.title) {
            sessions = sessions.map((s) => (s.id === sessionId ? { ...s, title: derived } : s))
          }
        }
      }
      syncRegistry(sessions)
      return {
        sessions,
        runningIds: state.runningIds.includes(sessionId)
          ? state.runningIds
          : [...state.runningIds, sessionId],
        messagesBySession: { ...state.messagesBySession, [sessionId]: list }
      }
    })

    const finishRun = (): void => {
      // 先抓气泡 id 再清 run——清掉后 currentBubbleId(sessionId) 返回 ''，
      // finalize(list,'') 一条都收不了尾（空气泡「…」永挂的根因）
      const bubbleId = run.messageId
      run.unsubscribe()
      runsBySession.delete(sessionId)
      // 运行收尾后刷新存档标记（completed 清档横幅消失 / paused 留档横幅出现）
      void window.petAPI.checkpointGet(sessionId).then((marker) => {
        set((state) => {
          const next: Record<string, { steps: number; updatedAt: number }> = {
            ...state.checkpointBySession
          }
          if (marker !== null)
            next[sessionId] = { steps: marker.steps, updatedAt: marker.updatedAt }
          else delete next[sessionId]
          return { checkpointBySession: next }
        })
      })
      set((state) => {
        // 结束时清掉未决审批卡（中断/出错时主进程不会再来 done 前的清理）
        const approvalBySession = { ...state.approvalBySession }
        delete approvalBySession[sessionId]
        const askBySession = { ...state.askBySession }
        delete askBySession[sessionId]
        const noticeBySession = { ...state.noticeBySession }
        delete noticeBySession[sessionId]
        return {
          runningIds: state.runningIds.filter((x) => x !== sessionId),
          approvalBySession,
          askBySession,
          noticeBySession,
          messagesBySession: {
            ...state.messagesBySession,
            [sessionId]: finalize(state.messagesBySession[sessionId] ?? [], bubbleId)
          }
        }
      })
    }

    // done 载荷自 T6 起为 { note, usage, stats }；T6.5 追加 persisted（落盘失败警示）；兼容旧纯字符串
    const applyDonePayload = (data: unknown): void => {
      if (typeof data === 'object' && data !== null) {
        const payload = data as {
          note?: string
          usage?: TokenUsage
          stats?: SessionStats
          persisted?: boolean
        }
        // 需要追加到气泡尾部的系统说明：note（max-steps/循环熔断/中断）+ 未落盘警示。
        // 正常 completed 时 note='' 不追加。
        const appends: string[] = []
        if (typeof payload.note === 'string' && payload.note.trim() !== '') {
          appends.push(payload.note.trim())
        }
        if (payload.persisted === false) {
          // 本轮没写进磁盘（重启会丢）：直接在气泡里明示，不再静默
          appends.push('⚠️ 本轮未保存到磁盘，重启后将丢失')
        }
        set((state) => {
          const next: Partial<ChatState> = {}
          if (payload.usage !== undefined) {
            next.usageBySession = { ...state.usageBySession, [sessionId]: payload.usage }
          }
          if (payload.stats !== undefined) {
            next.statsBySession = { ...state.statsBySession, [sessionId]: payload.stats }
          }
          if (appends.length > 0) {
            const bubbleId = currentBubbleId(sessionId)
            const tail = appends.join('\n\n')
            next.messagesBySession = {
              ...state.messagesBySession,
              [sessionId]: (state.messagesBySession[sessionId] ?? []).map((m) => {
                if (m.id !== bubbleId) return m
                // 去重：同一条警示不重复追加（重放缓冲事件时可能二次进入）
                if (m.content.includes(tail)) return m
                return { ...m, content: m.content === '' ? tail : `${m.content}\n\n${tail}` }
              })
            }
          }
          return next
        })
      }
    }

    // 流事件的统一处理（live 订阅与 invoke 前缓冲回放共用一套分支）
    const handleEvent = (ev: { type: string; data: unknown }): void => {
      if (ev.type === 'token' && typeof ev.data === 'string') {
        const chunk = ev.data
        set((state) => ({
          messagesBySession: {
            ...state.messagesBySession,
            [sessionId]: withTimeline(
              appendToken(
                state.messagesBySession[sessionId] ?? [],
                currentBubbleId(sessionId),
                chunk
              ),
              currentBubbleId(sessionId),
              (tl) => appendTextSegment(tl, chunk)
            )
          }
        }))
      } else if (ev.type === 'thinking' && typeof ev.data === 'object' && ev.data !== null) {
        // 思考增量：累积进本条 assistant 消息的 thinking，折叠块实时跟随
        const d = ev.data as { text?: unknown }
        if (typeof d.text === 'string' && d.text !== '') {
          set((state) => ({
            messagesBySession: {
              ...state.messagesBySession,
              [sessionId]: withTimeline(
                appendThinking(
                  state.messagesBySession[sessionId] ?? [],
                  currentBubbleId(sessionId),
                  d.text as string
                ),
                currentBubbleId(sessionId),
                (tl) => appendThinkingSegment(tl, d.text as string)
              )
            }
          }))
        }
      } else if (ev.type === 'error' && typeof ev.data === 'string') {
        // 可读错误写进消息正文（空消息直接替换，已有内容则追加）
        const message = ev.data
        set((state) => ({
          messagesBySession: {
            ...state.messagesBySession,
            [sessionId]: (state.messagesBySession[sessionId] ?? []).map((m) =>
              m.id === currentBubbleId(sessionId)
                ? {
                    ...m,
                    content: m.content === '' ? `⚠️ ${message}` : `${m.content}\n\n⚠️ ${message}`
                  }
                : m
            )
          }
        }))
        finishRun()
      } else if (ev.type === 'stats') {
        // 监测栏实时快照（主进程节流推送）
        if (typeof ev.data === 'object' && ev.data !== null) {
          const snap = ev.data as SessionStats
          set((state) => ({ statsBySession: { ...state.statsBySession, [sessionId]: snap } }))
        }
      } else if (ev.type === 'usage') {
        // 每轮真实 usage：用量环随轮次实时走（done 时会以最终值再覆盖一次，口径一致）
        if (typeof ev.data === 'object' && ev.data !== null) {
          const u = ev.data as TokenUsage
          set((state) => ({ usageBySession: { ...state.usageBySession, [sessionId]: u } }))
        }
      } else if (ev.type === 'tool_call_start' && typeof ev.data === 'object' && ev.data !== null) {
        const d = ev.data as {
          toolCallId: string
          name: string
          argsPreview: string
          file?: { rel: string; name: string; action: string }
        }
        set((state) => ({
          messagesBySession: {
            ...state.messagesBySession,
            [sessionId]: withTimeline(
              (state.messagesBySession[sessionId] ?? []).map((m) =>
                m.id === currentBubbleId(sessionId)
                  ? {
                      ...m,
                      toolRuns: [
                        ...(m.toolRuns ?? []),
                        {
                          toolCallId: d.toolCallId,
                          name: d.name,
                          argsPreview: d.argsPreview,
                          startedAt: Date.now(),
                          ...(d.file !== undefined ? { file: d.file } : {})
                        }
                      ]
                    }
                  : m
              ),
              currentBubbleId(sessionId),
              (tl) =>
                upsertToolSegment(tl, {
                  toolCallId: d.toolCallId,
                  name: d.name,
                  argsPreview: d.argsPreview,
                  startedAt: Date.now(),
                  ...(d.file !== undefined ? { file: d.file } : {})
                })
            )
          }
        }))
      } else if (
        ev.type === 'tool_call_result' &&
        typeof ev.data === 'object' &&
        ev.data !== null
      ) {
        const d = ev.data as ToolCallResultEventData
        set((state) => ({
          messagesBySession: {
            ...state.messagesBySession,
            [sessionId]: withTimeline(
              (state.messagesBySession[sessionId] ?? []).map((m) =>
                m.id === currentBubbleId(sessionId)
                  ? {
                      ...m,
                      toolRuns: (m.toolRuns ?? []).map((r) =>
                        r.toolCallId === d.toolCallId
                          ? {
                              ...r,
                              ok: d.ok,
                              status: d.status,
                              resultPreview: d.resultPreview,
                              durationMs: d.durationMs,
                              ...(d.diff !== undefined ? { diff: d.diff } : {})
                            }
                          : r
                      ),
                      // 产出文件卡片（同一路径只追加一次）：
                      // file = 单产出（write_file 等）；files = 多产出（run_js 快照 diff）
                      ...mergeProducedCards(m.files, d)
                    }
                  : m
              ),
              currentBubbleId(sessionId),
              (tl) =>
                // 结果回填到时间线里同一工具段（保持它所在的位置，不改顺序）
                upsertToolSegment(tl, {
                  toolCallId: d.toolCallId,
                  ok: d.ok,
                  ...(d.status !== undefined ? { status: d.status } : {}),
                  resultPreview: d.resultPreview,
                  durationMs: d.durationMs,
                  ...(d.diff !== undefined ? { diff: d.diff } : {})
                })
            )
          }
        }))
      } else if (ev.type === 'run_notice' && typeof ev.data === 'object' && ev.data !== null) {
        // 引擎侧状态（自动续跑 / 连接重试 / 压缩中）：流式气泡下显示一行淡色说明
        const notice = ev.data as RunNoticeData
        const cleanupId = notice.messageId
        if (cleanupId !== undefined) {
          // 收尾通报（清理结果 / 核对提醒）是**事实通报**，且主进程已把它落盘：
          // 直接作为一条 notice 消息进消息流，而不是只挂在流式气泡下的临时提示——
          // 刷新/重进会话后它还在（此前会消失）。
          // 与落盘那条同 id → 之后从盘上恢复时不会出现两条一样的通报。
          set((state) => ({
            messagesBySession: {
              ...state.messagesBySession,
              [sessionId]: appendNotice(state.messagesBySession[sessionId] ?? [], {
                id: cleanupId,
                text: notice.text,
                ts: Date.now()
              })
            }
          }))
        } else {
          set((state) => ({
            noticeBySession: { ...state.noticeBySession, [sessionId]: notice }
          }))
        }
      } else if (
        ev.type === 'tool_approval_request' &&
        typeof ev.data === 'object' &&
        ev.data !== null
      ) {
        // 审批请求：挂起等待用户点击
        const req = ev.data as ToolApprovalRequestData
        set((state) => ({
          approvalBySession: { ...state.approvalBySession, [sessionId]: req }
        }))
      } else if (
        ev.type === 'tool_ask_request' &&
        typeof ev.data === 'object' &&
        ev.data !== null
      ) {
        // 提问请求：挂起等待用户在提问卡上作答
        const req = ev.data as ToolAskRequestData
        set((state) => ({
          askBySession: { ...state.askBySession, [sessionId]: req }
        }))
      } else if (ev.type === 'todo_updated' && typeof ev.data === 'object' && ev.data !== null) {
        // 任务清单实时刷新：主进程在 todo_write 成功后一直推本事件
        // （整表快照），但渲染层此前**没有消费分支**——清单只在切会话时靠 todoGet 恢复，
        // 表现为「新建清单要重进会话才出现、模型勾掉完成项也要重进才刷新」。补上即两处都好。
        // 直接落快照：主进程读的是 todo-store 落盘值（权威源）；与 toggleTodo 的乐观更新
        // 若短暂冲突，以本事件为准（模型改了清单，用户那条勾选本就该被覆盖）。
        const d = ev.data as TodoUpdatedData
        set((state) => ({
          todosBySession: { ...state.todosBySession, [sessionId]: d.items }
        }))
      } else if (ev.type === 'agent_started' && typeof ev.data === 'object' && ev.data !== null) {
        // 子任务分身开始：把分身状态挂到 spawn_agent 那张工具卡上
        const d = ev.data as { agentId: string; objective: string; toolCallId?: string }
        if (d.toolCallId !== undefined) {
          set((state) => ({
            messagesBySession: {
              ...state.messagesBySession,
              [sessionId]: (state.messagesBySession[sessionId] ?? []).map((m) =>
                m.id === currentBubbleId(sessionId)
                  ? {
                      ...m,
                      toolRuns: (m.toolRuns ?? []).map((r) =>
                        r.toolCallId === d.toolCallId
                          ? {
                              ...r,
                              sub: { agentId: d.agentId, objective: d.objective, status: 'running' }
                            }
                          : r
                      )
                    }
                  : m
              )
            }
          }))
        }
      } else if (ev.type === 'agent_progress' && typeof ev.data === 'object' && ev.data !== null) {
        const d = ev.data as {
          agentId: string
          round: number
          step: number
          lastTool?: string
          toolCallId?: string
        }
        if (d.toolCallId !== undefined) {
          set((state) => ({
            messagesBySession: {
              ...state.messagesBySession,
              [sessionId]: (state.messagesBySession[sessionId] ?? []).map((m) =>
                m.id === currentBubbleId(sessionId)
                  ? {
                      ...m,
                      toolRuns: (m.toolRuns ?? []).map((r) =>
                        r.toolCallId === d.toolCallId && r.sub !== undefined
                          ? {
                              ...r,
                              sub: {
                                ...r.sub,
                                round: d.round,
                                step: d.step,
                                lastTool: d.lastTool
                              }
                            }
                          : r
                      )
                    }
                  : m
              )
            }
          }))
        }
      } else if (ev.type === 'agent_finished' && typeof ev.data === 'object' && ev.data !== null) {
        const d = ev.data as {
          agentId: string
          status: 'completed' | 'failed' | 'aborted' | 'budget-exhausted'
          report: string
          rounds: number
          steps: number
          ms: number
          toolCallId?: string
        }
        if (d.toolCallId !== undefined) {
          set((state) => ({
            messagesBySession: {
              ...state.messagesBySession,
              [sessionId]: (state.messagesBySession[sessionId] ?? []).map((m) =>
                m.id === currentBubbleId(sessionId)
                  ? {
                      ...m,
                      toolRuns: (m.toolRuns ?? []).map((r) =>
                        r.toolCallId === d.toolCallId && r.sub !== undefined
                          ? {
                              ...r,
                              sub: {
                                ...r.sub,
                                status: d.status,
                                report: d.report,
                                rounds: d.rounds,
                                steps: d.steps,
                                ms: d.ms
                              }
                            }
                          : r
                      )
                    }
                  : m
              )
            }
          }))
        }
      } else if (ev.type === 'done') {
        applyDonePayload(ev.data)
        finishRun()
      }
    }

    const unsubscribe = window.petAPI.onChatStream((ev) => {
      // 多会话并行：全局通道所有会话的事件都会进来，按本 run 的 runId 过滤。
      // runId 还没从 invoke 返回时先缓冲事件（本地 IPC 快于网络，理论到不了，防御竞态）
      if (run.runId === null) {
        run.buffered.push({ type: ev.type, data: ev.data })
        return
      }
      if (ev.runId !== run.runId) return
      handleEvent(ev)
    })
    run.unsubscribe = unsubscribe

    // 会话绑定模式：发送按会话自身模式走，与胶囊位置无关
    const sessionMode = get().sessions.find((x) => x.id === sessionId)?.mode ?? 'work'
    const invoke = resume
      ? window.petAPI.checkpointResume(sessionId, sessionMode)
      : window.petAPI.chatSend(
          sessionId,
          text,
          atts.length > 0
            ? atts.map(({ name, kind, size, dataUrl, text: fileText, path }) => ({
                name,
                kind,
                size,
                dataUrl,
                text: fileText,
                path
              }))
            : undefined,
          sessionMode
        )
    void invoke.then((result) => {
      if (runsBySession.get(sessionId) !== run) return // 期间被 stop() 清场
      if (!result.ok || result.runId === undefined) {
        const message = result.error ?? '发送失败'
        set((state) => ({
          messagesBySession: {
            ...state.messagesBySession,
            [sessionId]: (state.messagesBySession[sessionId] ?? []).map((m) =>
              m.id === currentBubbleId(sessionId) ? { ...m, content: `⚠️ ${message}` } : m
            )
          }
        }))
        finishRun()
        return
      }
      run.runId = result.runId
      const buffered = run.buffered
      run.buffered = []
      for (const ev of buffered) handleEvent(ev)
    })
  },

  resumeTask: () => {
    const id = get().activeId
    if (id === null || runsBySession.has(id)) return
    if (get().checkpointBySession[id] === undefined) return
    // 走 send 管线：本地冒泡同文用户消息，invoke 走 checkpoint:resume（主进程持久化同文）
    get().send(RESUME_NUDGE_TEXT, undefined, { resume: true })
  },

  stop: (target) => {
    // 真实路径：通知主进程 abort（保留已生成部分），并立即本地收尾。
    // 多会话并行：只停目标会话（缺省当前会话），别的会话的 run 不受影响
    const id = target ?? get().activeId
    if (id === null) return
    const run = runsBySession.get(id)
    if (run !== undefined) {
      if (run.runId !== null) window.petAPI.chatCancel(run.runId)
      run.unsubscribe()
      runsBySession.delete(id)
    }
    set((state) => ({
      runningIds: state.runningIds.filter((x) => x !== id),
      approvalBySession:
        id === null
          ? state.approvalBySession
          : Object.fromEntries(Object.entries(state.approvalBySession).filter(([k]) => k !== id)),
      // 提问卡同样清掉（停止后不能留一张可提交的空卡在界面上）
      askBySession:
        id === null
          ? state.askBySession
          : Object.fromEntries(Object.entries(state.askBySession).filter(([k]) => k !== id)),
      // 引擎侧状态提示同样清掉（停止后那行"自动接着做"不能留在界面上）
      noticeBySession:
        id === null
          ? state.noticeBySession
          : Object.fromEntries(Object.entries(state.noticeBySession).filter(([k]) => k !== id)),
      messagesBySession:
        id === null
          ? state.messagesBySession
          : { ...state.messagesBySession, [id]: finalize(state.messagesBySession[id] ?? []) }
    }))
  },

  respondApproval: async (approvalId, decision) => {
    // 先回执主进程（唤醒挂起的循环），再清掉本会话的审批卡
    await window.petAPI.approve(approvalId, decision)
    set((state) => ({
      approvalBySession: Object.fromEntries(
        Object.entries(state.approvalBySession).filter(([, v]) => v.approvalId !== approvalId)
      )
    }))
  },

  respondAsk: async (askId, answers) => {
    // 先回执主进程（唤醒挂起的 ask_user），再清掉本会话的提问卡
    await window.petAPI.answer(askId, answers)
    set((state) => ({
      askBySession: Object.fromEntries(
        Object.entries(state.askBySession).filter(([, v]) => v.askId !== askId)
      )
    }))
  }
}))
