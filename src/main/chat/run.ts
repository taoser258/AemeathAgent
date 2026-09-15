// 聊天管线：chat:send → 组 system prompt → LLM 流式 → chat:stream 逐 token 推送。
// 契约：渲染层 chatSend(sessionId, text, attachments)；主进程生成 runId；
// 中断 chat:cancel(runId)；done/error 后该 runId 关闭。
// 会话历史 T5 起持久化（main/sessions/session-store.ts，每会话一个 JSON 原子写）；
// 本轮 user/assistant 消息在流结束（含中断/出错保留部分）时落盘，发送时从盘上重建上下文。

import { BrowserWindow, dialog, ipcMain } from 'electron'
import { statSync } from 'fs'
import { join } from 'path'
import {
  CHAT_ANSWER,
  CHAT_APPROVE,
  CHAT_CANCEL,
  CHAT_SEND,
  CHAT_NUDGE,
  CHAT_STREAM,
  CHECKPOINT_DISCARD,
  CHECKPOINT_GET,
  CHECKPOINT_RESUME,
  NOTES_EXPORT,
  NOTES_GET,
  PROGRESS_GET,
  REVIEW_DUE,
  REVIEW_GRADE,
  TODO_GET
} from '@shared/ipc-channels'
import type {
  ApprovalDecision,
  AskAnswer,
  AskQuestion,
  RunNoticeData,
  StreamEvent,
  ToolApprovalRequestData,
  ToolAskRequestData,
  ToolCallEventData,
  ToolCallResultEventData
} from '@shared/protocol'
import { RESUME_NUDGE_TEXT } from '@shared/types'
import type { ChatMode } from '@shared/types'
import { boundWorkspace, checkWorkspace } from '@shared/workspace'
import type {
  ChatAttachmentPayload,
  ChatSendResult,
  ModelProfile,
  PersistedMessage,
  SessionStats,
  TokenUsage
} from '@shared/types'
import { checkpointDir, configDir, logsDir, personasDir, sessionsDir } from '../paths'
import { clearCheckpointMarker, readCheckpointMarker, saveCheckpointMarker } from '../checkpoint'
import { readAppConfig } from '../settings/app-config'
import { readProfileKey } from '../llm/secrets'
import {
  streamChat,
  turnTextLength,
  type ChatContentPart,
  type ChatTurn,
  type StreamChatResult,
  type ToolCallDraft
} from '../llm/client'
import { classifyLlmError } from '../llm/errors'
import { buildSystemPrompt } from '../agent/prompt'
import { loadPersona } from '../agent/persona'
import { executeToolCall, getLlmTools, getToolPathBase } from '../agent/tools/registry'
import { getSubLlmTools, handleSpawnTool } from '../agent/spawn'
import { handleAskTool } from './ask'
import { writeAgentLog } from '../agent/agent-log'
import { appendUsage } from '../usage/usage-log'
import { resolveProducedFile } from './produced-file'
import { fileRefFromCall, stripRunJsMarker } from '@shared/produced-file'
import { pickForInjection } from '@shared/memory'
import {
  bumpHits as bumpMemoryHits,
  readEntries as readMemoryEntries
} from '../memory/memory-store'
import { distillMemory } from '../memory/distill'
import { listEnabledSkills } from '../agent/skills'
import { readTodos } from '../agent/tools/todo-store'
import { readNotes } from '../agent/tools/note-store'
import { setMeasured, readProgress, daysLeft } from '../agent/tools/progress-store'
import {
  estimateMastery,
  gradeAndSave,
  isDue,
  readReview,
  REVIEW_DAILY_NEW_LIMIT,
  summarize,
  type DueSummary,
  type ReviewState
} from '../agent/tools/review-store'
import { buildApprovalDetail } from '../agent/tools/diff'
import { appendDebugLog } from '../log'
import { runToolLoop } from './loop'
import { TodoNudges } from './todo-nudge'
import { createToolGate, clearSessionAllowedTools } from './permission'
import {
  attachmentNote,
  llmTurnsToPersisted,
  projectPersistedHistory,
  trimHistoryForRequest
} from './history'
import {
  accumulateStats,
  appendSessionTurns,
  isSessionRegistered,
  loadSessionMessages,
  newPersistedId
} from '../sessions/session-store'

/**
 * harness 单次任务的轮次预算。
 * 改成「分段」：单段 20 轮，撞到预算若模型还在做工就自动续跑一段（最多 3 次，硬顶 80 轮），
 * 只有续跑额度用完才停下留断点。依据见 loop.ts 头注释（成熟 Agent 实现 的「步数不是错误」）。
 */
const TOOL_LOOP_LIMITS = { roundsPerSegment: 20, maxAutoContinues: 3 }

/** 瞬时错误自动重试（对齐 成熟实现retry.max-retries=3 / backoff-base-ms=500） */
const LLM_RETRY_MAX = 3
const LLM_RETRY_BASE_MS = 800
/** 值得重试的错误类：网络抖动 / 限流 / 服务端 5xx。Key 错、模型名错重试没用，直接报 */
const RETRYABLE_LLM_KINDS = new Set(['network', 'rate', 'server'])

/** 可中断的等待（重试退避用）：abort 时立刻返回，不拖住「停止」按钮 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

/**
 * 审批等待器：approvalId → 决策回调。主进程发出 tool_approval_request 后
 * 在此挂起，渲染层经 chat:approve 带回决策；运行中断（停止按钮）时由 abort 监听兜底 resolve('deny')。
 * 无超时：审批可以无限期等待，用户随时可点停止掐断整个循环。
 */
const approvalWaiters = new Map<string, (decision: ApprovalDecision) => void>()

/**
 * 提问等待器：askId → 答案回调。与审批同款挂起-唤醒机制，
 * 区别只在回传的是结构化答案数组。运行中断（停止）时 abort 兜底 resolve([])——
 * 空答案 = 用户没答，工具结果里如实说明，让模型知道提问被掐断而非答了空。
 */
const askWaiters = new Map<string, (answers: AskAnswer[]) => void>()

/** 发送结果：invoke 直接返回；流式过程经 CHAT_STREAM 事件异步推送。
 * 契约以 shared/types.ts 为唯一来源——此处曾有一份本地副本，加字段时容易只改一边而悄悄分叉。
 * 保留同名再导出，外部引用路径不变。 */
export type { ChatSendResult }

interface RunState {
  controller: AbortController
  sessionId: string
}

const runs = new Map<string, RunState>()
/** sessionId → runId：防止同一会话并发两路流 */
const activeBySession = new Map<string, string>()

/**
 * 工作中插话队列（steering 机制）：任务运行中用户发来的消息，
 * 在**下一轮 LLM 调用前**注入上下文（同款语义：steering 不打断当前步，
 * 而是让模型带着新信息继续）。
 */
const nudgesBySession = new Map<string, string[]>()

/** 送给 LLM 的历史条数上限（不含 system 与本轮 user）：约束上下文体积 */
const HISTORY_LIMIT = 40

function nextRunId(): string {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function emit(sender: Electron.WebContents, event: StreamEvent): void {
  if (!sender.isDestroyed()) sender.send(CHAT_STREAM, event)
}

/**
 * 流式文本节流器：把逐 chunk 的 IPC 推送合并成每 120ms 一批。
 * 实测事故：DeepSeek 思考 4.1 万字、chunk 高频到达 → 每个 chunk 一次 IPC + 渲染层
 * setState + 4 万字 DOM 更新，主线程被打满到"点哪都没反应"（一两分钟后思考结束才恢复）。
 * 节流后渲染频率上限 ≈ 8 次/秒，观感无差别（人眼分辨不出 120ms 的流式差异）。
 * 统计口径不受影响：pushStats 仍在原回调里逐 chunk 记。
 */
class TextThrottle {
  private buf = ''
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly sender: Electron.WebContents,
    private readonly makeEvent: (text: string) => StreamEvent,
    private readonly interval = 120
  ) {}

  push(chunk: string): void {
    this.buf += chunk
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.interval)
    }
  }

  /** 立即发出缓冲内容（轮次结束/工具执行前/中断前必须调用，否则尾部文本丢失） */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.buf === '') return
    const text = this.buf
    this.buf = ''
    emit(this.sender, this.makeEvent(text))
  }
}

/** 持久化历史投影/步边界落盘的纯函数在 chat/history.ts */

/** 落盘统一入口：注册表校验（防僵尸文件）+ 失败记日志。返回是否成功。 */
function persistTurns(
  sessionId: string,
  turns: PersistedMessage[],
  usage?: TokenUsage,
  statsDelta?: SessionStats
): boolean {
  if (!isSessionRegistered(sessionsDir(), sessionId)) {
    appendDebugLog(logsDir(), `[chat] 跳过落盘：会话 ${sessionId} 已不在注册表（可能已删除）`)
    return false
  }
  try {
    appendSessionTurns(sessionsDir(), sessionId, turns, usage, statsDelta)
    return true
  } catch (err) {
    appendDebugLog(logsDir(), `[chat] 会话 ${sessionId} 落盘失败: ${String(err)}`)
    console.warn('[chat] 会话消息落盘失败:', err)
    return false
  }
}

/**
 * 按档案上下文窗口裁剪消息（粗估 1 token ≈ 1.6 字符的中英混合比例），
 * 预算给 system 与本轮回复留 40% 余量；从最新往旧保留，system 恒在首位。
 * context=0（未设置）时不做字符裁剪，只按条数上限。
 */
function capMessagesByContext(messages: ChatTurn[], context: number): ChatTurn[] {
  if (!(context > 0)) return messages
  const budget = Math.max(2000, Math.floor(context * 1.6 * 0.6))
  let used = turnTextLength(messages[0])
  const keptFromEnd: ChatTurn[] = []
  for (let i = messages.length - 1; i >= 1; i -= 1) {
    const turn = messages[i]
    const len = turnTextLength(turn)
    if (used + len > budget && keptFromEnd.length > 0) break
    used += len
    keptFromEnd.unshift(turn)
  }
  return [messages[0], ...keptFromEnd]
}

/** 附件防御上限：数量 / 名字长度 / 文本内容 / 图片 dataUrl（≈6MB 二进制） */
const ATTACH_LIMITS = { count: 8, name: 120, text: 50_000, dataUrl: 9_000_000, path: 512 }

/** 渲染层传来的附件做防御校验与归一；结构非法整体拒收（返回 null） */
function sanitizeAttachments(raw: unknown): ChatAttachmentPayload[] | null {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) return null
  if (raw.length > ATTACH_LIMITS.count) return null
  const out: ChatAttachmentPayload[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const r = item as Record<string, unknown>
    if (typeof r.name !== 'string' || r.name.trim() === '') return null
    const kind = r.kind
    if (kind !== 'image' && kind !== 'text' && kind !== 'sticker' && kind !== 'file') return null
    const att: ChatAttachmentPayload = {
      name: r.name.trim().slice(0, ATTACH_LIMITS.name),
      kind
    }
    if (typeof r.size === 'number' && Number.isFinite(r.size)) att.size = r.size
    // 本地路径：只作为提示文字交给模型，不作为文件访问授权
    // （读写仍走工作区/权限闸门），所以这里只做长度与去空校验
    if (typeof r.path === 'string' && r.path.trim() !== '') {
      att.path = r.path.trim().slice(0, ATTACH_LIMITS.path)
    }
    if (typeof r.text === 'string' && r.text !== '') {
      att.text = r.text.slice(0, ATTACH_LIMITS.text)
    }
    if (typeof r.dataUrl === 'string' && r.dataUrl !== '') {
      if (!r.dataUrl.startsWith('data:image/') || r.dataUrl.length > ATTACH_LIMITS.dataUrl) {
        return null
      }
      att.dataUrl = r.dataUrl
    }
    out.push(att)
  }
  return out
}

/**
 * 绑定目录是否仍是可用目录（工作区门槛用）。
 * 之所以真去查盘：用户可能把绑定的目录删了/挪了，甚至整个盘符失效——
 * 此时应当提示重绑，而不是让工具在一个不存在的基准上静默失败。
 * 网络盘断开的情况 statSync 会较快返回失败（不是挂起等待）。
 */
function isUsableDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

export function registerChatIpc(): void {
  // 审批决策回执：渲染层按钮 → 这里唤醒挂起的循环；未知/过期 approvalId 静默忽略
  ipcMain.handle(CHAT_APPROVE, (_event, payload: unknown): { ok: boolean } => {
    if (typeof payload !== 'object' || payload === null) return { ok: false }
    const r = payload as { approvalId?: unknown; decision?: unknown }
    if (typeof r.approvalId !== 'string') return { ok: false }
    const waiter = approvalWaiters.get(r.approvalId)
    if (waiter === undefined) return { ok: false }
    if (r.decision !== 'allow' && r.decision !== 'allow-always' && r.decision !== 'deny') {
      return { ok: false }
    }
    // 决策留痕（DoD：审批决策有日志；appendDebugLog 自带节流与失败静默）
    appendDebugLog(logsDir(), `[chat] 审批决策 approvalId=${r.approvalId} decision=${r.decision}`)
    waiter(r.decision)
    return { ok: true }
  })

  // 提问答案回执：渲染层提问卡提交 → 唤醒挂起的 ask_user。未知/过期 askId 静默忽略
  ipcMain.handle(CHAT_ANSWER, (_event, payload: unknown): { ok: boolean } => {
    if (typeof payload !== 'object' || payload === null) return { ok: false }
    const r = payload as { askId?: unknown; answers?: unknown }
    if (typeof r.askId !== 'string' || !Array.isArray(r.answers)) return { ok: false }
    const waiter = askWaiters.get(r.askId)
    if (waiter === undefined) return { ok: false }
    const answers = (r.answers as unknown[]).filter(
      (a): a is AskAnswer =>
        typeof a === 'object' &&
        a !== null &&
        typeof (a as AskAnswer).questionId === 'string' &&
        (typeof (a as AskAnswer).value === 'string' || Array.isArray((a as AskAnswer).value))
    )
    appendDebugLog(logsDir(), `[chat] 提问作答 askId=${r.askId} 共 ${answers.length} 题`)
    waiter(answers)
    return { ok: true }
  })

  const handleChatSend = async (
    _event: Electron.IpcMainInvokeEvent,
    sessionId: unknown,
    text: unknown,
    attachmentsRaw?: unknown,
    modeRaw?: unknown
  ): Promise<ChatSendResult> => {
    // 三模式：chat=纯对话无工具 / work=harness 全工具 / learn=全工具+教学守则；缺省 work 兼容旧调用
    const chatMode: ChatMode = modeRaw === 'chat' || modeRaw === 'learn' ? modeRaw : 'work'
    if (typeof sessionId !== 'string' || sessionId === '') {
      return { ok: false, error: '会话标识无效' }
    }
    const attachments = sanitizeAttachments(attachmentsRaw)
    if (attachments === null) {
      return { ok: false, error: '附件数据无效' }
    }
    if ((typeof text !== 'string' || text.trim() === '') && attachments.length === 0) {
      return { ok: false, error: '消息内容为空' }
    }
    if (activeBySession.has(sessionId)) {
      return { ok: false, error: '当前会话已有进行中的回复，请先停止' }
    }
    const sender = _event.sender

    const config = readAppConfig(configDir())

    // ── 工作区门槛──────────
    // 工作 / 学习模式必须先绑定可用工作目录：它既是文件工具相对路径的基准，也是「标准」
    // 权限模式的免询问边界。渲染层会提前禁用输入并弹目录选择器，这里是**权威兜底**
    // （渲染层状态可能过期：目录被删、设置被别处改动、旧会话被打开）。
    const workspaceGate = checkWorkspace(config.workspace, chatMode, isUsableDirectory)
    if (!workspaceGate.ok) {
      return { ok: false, code: workspaceGate.code, error: workspaceGate.error }
    }

    // T4 多档案：取激活档案；镜像字段兜底（异常情况下 profiles 至少有一条）
    const profile: ModelProfile =
      config.model.profiles.find((p) => p.id === config.model.activeId) ?? config.model.profiles[0]
    if (profile.model === '') {
      return {
        ok: false,
        error: `「${profile.name}」还没填模型名。请在 设置 → 模型 中点该档案的「编辑」，填入模型名后保存。`
      }
    }
    const apiKey = readProfileKey(configDir(), profile.id)
    if (apiKey === null || apiKey === '') {
      return {
        ok: false,
        error: `「${profile.name}」还没有配置 API Key。请打开 设置 → 模型，选中该档案填入密钥并保存（千问 / GLM / DeepSeek / Kimi / 豆包 均可）。`
      }
    }
    const persona = loadPersona(personasDir(), config.persona.active)
    if (persona === null) {
      return {
        ok: false,
        error: `人设「${config.persona.active}」加载失败：personas/${config.persona.active}/ 下需要 soul.md 与 style.md。请到 设置 → 模型 重新选择人设。`
      }
    }

    const runId = nextRunId()
    // 纯附件（如贴纸）时允许 text 非法/为空
    const trimmed = typeof text === 'string' ? text.trim() : ''

    // ── 附件 → 消息内容组装 ────────────────────────────────────────────
    // llmText：给模型看的纯文本说明（文本附件内联、表情包/文件以文字转述）
    let llmText = trimmed
    const imageParts: ChatContentPart[] = []
    for (const att of attachments) {
      if (att.kind === 'image' && att.dataUrl !== undefined) {
        imageParts.push({ type: 'image_url', image_url: { url: att.dataUrl } })
      } else {
        const note = attachmentNote(att)
        if (note !== null) llmText += note
      }
    }
    // 发了图片但没写字：给个占位文本，避免空 text part 被部分端点拒绝
    if (imageParts.length > 0 && llmText.trim() === '') {
      llmText = `（发来了 ${imageParts.length} 张图片）`
    }

    // 图片附件要求档案开启多模态；未开启直接拒绝（错误会写进助手气泡）
    if (imageParts.length > 0 && profile.multimodal !== true) {
      return {
        ok: false,
        error: `「${profile.name}」未开启多模态，无法发送图片附件。可到 设置 → 模型 编辑该档案打开「多模态」，或改用支持视觉的模型。`
      }
    }

    // T5：历史从持久化层重建
    const persisted = loadSessionMessages(sessionsDir(), sessionId)
    const baseStats: SessionStats | undefined = persisted.ok ? persisted.stats : undefined
    const historyTurns: ChatTurn[] = persisted.ok ? projectPersistedHistory(persisted.messages) : []
    const userTurn: ChatTurn =
      imageParts.length > 0
        ? { role: 'user', content: [{ type: 'text', text: llmText }, ...imageParts] }
        : { role: 'user', content: llmText }
    const messages: ChatTurn[] = [
      {
        role: 'system',
        content: buildSystemPrompt(persona, {
          now: new Date(),
          appDir: getToolPathBase(),
          // 记忆开关透传：关闭时附录写明"没有记住的能力"，
          // 与"工具已从注册表移除"两处一致，免得她嘴上说"记住了"
          memoryEnabled: config.privacy.memory === true,
          // 长期记忆注入：开关开启时按本轮用户消息做关键词检索，top-8 注入
          // 并累加 hits；检索/读写任何失败都静默（记忆是锦上添花，绝不阻塞对话）
          memories: (() => {
            if (config.privacy.memory !== true) return undefined
            try {
              const picked = pickForInjection(readMemoryEntries(), llmText)
              if (picked.hitIds.length > 0) bumpMemoryHits(picked.hitIds)
              return picked.memories.length > 0 ? picked.memories : undefined
            } catch {
              return undefined
            }
          })(),
          // 工作区 = 相对路径的基准（门槛已保证 work/learn 下非空）；对话模式无工具，不提
          workspaceDir:
            chatMode === 'chat'
              ? undefined
              : (boundWorkspace(config.workspace, chatMode) ?? undefined),
          learnMode: chatMode === 'learn',
          // 开工方式守则：work/learn 都有工具 → 要求先立任务清单、拿不准先 ask_user
          toolMode: chatMode !== 'chat',
          // 计划模式守则：权限档位 plan 时要求模型先写文字计划再动手
          // （批准卡由权限闸门弹，这里补的是"卡片之前用户先看到计划"）
          planMode: config.tools.permissionMode === 'plan',
          // 用户个人信息（反馈批次④）：让爱弥斯直接知道用户是谁、怎么称呼
          user: { nickname: config.user.nickname, about: config.user.about },
          // 技能清单：已按模式与启用过滤；chat 无工具也就无技能入口
          skills:
            chatMode === 'chat'
              ? undefined
              : listEnabledSkills(chatMode).map((s) => ({
                  name: s.name,
                  description: s.description
                }))
        })
      },
      // 截断后丢弃前导孤立 tool 消息（否则服务端 400：tool 必须跟随 assistant(tool_calls)）
      ...trimHistoryForRequest(historyTurns, HISTORY_LIMIT),
      userTurn
    ]
    // 按档案的上下文窗口裁剪（粗估 1 token ≈ 1.6 字符，给 system 与回复留 40% 余量）
    const capped = capMessagesByContext(messages, profile.context)

    // 用户消息先落盘（进入循环前）：崩溃不丢本轮输入；工具步边界再增量落盘
    persistTurns(sessionId, [
      {
        id: newPersistedId(),
        role: 'user',
        ts: Date.now(),
        text: trimmed,
        attachments: attachments.length > 0 ? attachments : undefined
      }
    ])

    const controller = new AbortController()
    runs.set(runId, { controller, sessionId })
    activeBySession.set(sessionId, runId)

    // harness 循环整体异步：invoke 先把 runId 还给渲染层，事件随后经 CHAT_STREAM 到达
    void (async () => {
      // 首 token/tps 是「本轮」口径（与 loop 最终 acc.ttftMsLast/tpsLast 一致）：
      // 每次发起流式调用前重置，否则多轮任务里监测栏的首 token 永远停在第 1 轮、
      // tps 分母跨轮累积——结束瞬间数值跳变，"感觉不准"的第二个根因。
      let liveFirstAt: number | null = null
      let liveDeltas = 0
      /** 本轮请求起点（每次 call 尝试重置）：ttft 相对它算，而不是整次 run 的 t0 */
      let liveReqAt = 0
      /** 已收尾轮次的 ttft 累计（逐轮结算进此值；当前轮另加）——修复实时快照里
       * ttftMsSum 只显示"持久化+当前轮"、丢掉本次 run 中间轮的问题 */
      let liveTtftSum = 0
      let lastStatsAt = 0
      let tail = '' // 上一个步边界之后新增的文本（中断/出错时落盘，防重复）
      // 实时计数（循环内逐步更新，供监测栏节流快照；最终以 loop 返回值为准）。
      // token 三件套：每轮流结束时从 res.usage 累加——此前监测栏的
      // 输入/输出/缓存要等整次任务收尾才更新，长任务全程显示 0。
      const live = {
        rounds: 0,
        steps: 0,
        toolMs: 0,
        llmMs: 0,
        inputTok: 0,
        outputTok: 0,
        cachedTok: 0,
        cacheKnown: false
      }
      // 流式推送节流（卡死修复，见 TextThrottle 注释）：思考与正文各一个，结束/中断前 flush
      const thinkingT = new TextThrottle(sender, (text) => ({
        sessionId,
        runId,
        type: 'thinking',
        data: { text }
      }))
      const deltaT = new TextThrottle(sender, (text) => ({
        sessionId,
        runId,
        type: 'token',
        data: text
      }))
      const pushStats = (liveTtft: number, force = false): void => {
        const now = Date.now()
        if (!force && now - lastStatsAt < 400) return
        lastStatsAt = now
        const liveTps =
          liveFirstAt !== null && now > liveFirstAt
            ? Math.round(liveDeltas / ((now - liveFirstAt) / 1000))
            : 0
        const snap: SessionStats = {
          rounds: (baseStats?.rounds ?? 0) + live.rounds,
          steps: (baseStats?.steps ?? 0) + live.steps,
          toolMs: (baseStats?.toolMs ?? 0) + live.toolMs,
          inputTok: (baseStats?.inputTok ?? 0) + live.inputTok,
          outputTok: (baseStats?.outputTok ?? 0) + live.outputTok,
          llmMs: (baseStats?.llmMs ?? 0) + live.llmMs,
          cachedTok: (baseStats?.cachedTok ?? 0) + live.cachedTok,
          cacheKnown: live.cacheKnown || (baseStats?.cacheKnown ?? false),
          ttftMsLast: liveTtft,
          ttftMsSum: (baseStats?.ttftMsSum ?? 0) + liveTtftSum + liveTtft,
          tpsLast: liveTps,
          samples: (baseStats?.samples ?? 0) + live.rounds
        }
        emit(sender, { sessionId, runId, type: 'stats', data: snap })
      }
      // ── 审批──
      // 决策逻辑在 chat/permission.ts + chat/approval-policy.ts（纯函数，可单测）。
      // 新语义：只读与 MCP 工具直放；**工作区内的变更也直放**（有快照可撤销）；
      // 只有越界（工作区外）或未绑定工作区时才请示。见 approval-policy.ts 的完整说明。
      const mode = config.tools.permissionMode
      // 工作区绑定：按会话模式取当前绑定；chat 无工具恒 null
      const sessionWorkspace =
        chatMode === 'work'
          ? config.workspace.work
          : chatMode === 'learn'
            ? config.workspace.learn
            : null
      const requestApproval = (
        kind: 'tool' | 'plan',
        calls: ToolCallDraft[],
        reason?: string
      ): Promise<ApprovalDecision> =>
        new Promise<ApprovalDecision>((resolve) => {
          const approvalId = `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
          const data: ToolApprovalRequestData = {
            approvalId,
            kind,
            calls: calls.map((tc) => ({
              toolCallId: tc.id,
              name: tc.name,
              argsPreview: tc.argsJson.slice(0, 120),
              // ：write_file 附 diff（改前/改后）或新建预览；其他工具为空对象不携带（只增不改）
              ...buildApprovalDetail(tc.name, tc.argsJson)
            })),
            ...(reason !== undefined && reason !== '' ? { reason } : {})
          }
          const settle = (decision: ApprovalDecision): void => {
            approvalWaiters.delete(approvalId)
            controller.signal.removeEventListener('abort', onAbort)
            resolve(decision)
          }
          const onAbort = (): void => settle('deny')
          approvalWaiters.set(approvalId, settle)
          controller.signal.addEventListener('abort', onAbort, { once: true })
          emit(sender, { sessionId, runId, type: 'tool_approval_request', data })
        })
      // 结构化提问挂起器：与审批同款——发事件、等 chat:answer 唤醒。
      const requestAsk = (title: string | null, questions: AskQuestion[]): Promise<AskAnswer[]> =>
        new Promise<AskAnswer[]>((resolve) => {
          const askId = `ak-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
          const data: ToolAskRequestData = {
            askId,
            ...(title !== null && title !== '' ? { title } : {}),
            questions
          }
          const settle = (answers: AskAnswer[]): void => {
            askWaiters.delete(askId)
            controller.signal.removeEventListener('abort', onAbort)
            resolve(answers)
          }
          const onAbort = (): void => settle([])
          askWaiters.set(askId, settle)
          controller.signal.addEventListener('abort', onAbort, { once: true })
          emit(sender, { sessionId, runId, type: 'tool_ask_request', data })
        })
      const gate = createToolGate(mode, sessionId, requestApproval, {
        workspace: sessionWorkspace
      })
      // 分身运行时：spawn_agent 在下方 executeTool 包装里拦截转 agent/spawn.ts。
      // 分身 call = 主会话档案 + 分身白名单工具；不接 onDelta——分身过程不进消息流，
      // 折叠为 agent_started/progress/finished 三种事件。
      const subCall = (msgs: ChatTurn[], sig: AbortSignal): Promise<StreamChatResult> =>
        streamChat(
          {
            baseUrl: profile.baseUrl,
            apiKey,
            model: profile.model,
            temperature: config.model.temperature,
            messages: msgs,
            tools: getSubLlmTools(chatMode),
            protocol: profile.protocol,
            reasoningEffort: profile.reasoningEffort
          },
          { signal: sig, onDelta: () => {} } // 分身不流式：过程折叠为事件，不进消息流
        )
      // 分身事件与工具卡的关联：loop 先 onToolStart 再 executeTool（串行），
      // 拦截 spawn_agent 时 liveTcId 即本次调用的 id——渲染层据此把进度挂到那张卡上
      let liveTcId: string | null = null
      /** 最近一次写类工具的变更行数（executeTool 捕获 → onToolResult 取走，串行保证） */
      let lastDiffStat: { added: number; removed: number } | null = null
      /** 最近一次 run_js 的产出文件（相对路径，快照 diff；同款串行交接） */
      let lastJsFiles: string[] = []
      /** 本轮 run 内的派生序号（执行日志文件名用：一次 run 可顺序派多个分身） */
      let spawnSeq = 0
      /**
       * 任务清单催办：提示词层的"每步重提交"实测无效，
       * 约束下沉到 harness。判定逻辑在 chat/todo-nudge.ts（纯逻辑、有单测覆盖）。
       */
      const todoNudges = new TodoNudges(() => readTodos(sessionId))

      try {
        const loopResult = await runToolLoop(
          capped,
          {
            call: async (msgs, signal) => {
              live.rounds += 1 // 进入即计：轮次预算/监测栏即时反映（完成后的耗时随后累加）
              // 瞬时错误自动重试：网络抖动 / 限流 / 5xx 不再把整轮任务打断。
              // 只在「这次尝试一个字都还没吐出来」时重试——已经流到气泡里的文字收不回来，
              // 重试会让正文重复；那种情况宁可如实报错（用户点「继续任务」即可接着跑）。
              for (let attempt = 0; ;) {
                let emitted = false
                // 本轮/本次尝试的计时基准重置（重试=重新计时；与 loop 侧 ttftMsLast 口径一致）
                liveFirstAt = null
                liveDeltas = 0
                liveReqAt = Date.now() // 本轮请求起点：ttft = 首增量 - 此值
                try {
                  const res = await streamChat(
                    {
                      baseUrl: profile.baseUrl,
                      apiKey,
                      model: profile.model,
                      temperature: config.model.temperature,
                      messages: msgs,
                      tools: chatMode === 'chat' ? undefined : getLlmTools(chatMode),
                      protocol: profile.protocol,
                      reasoningEffort: profile.reasoningEffort
                    },
                    {
                      signal,
                      onDelta: (chunk) => {
                        emitted = true
                        tail += chunk
                        liveDeltas += 1
                        if (liveFirstAt === null) liveFirstAt = Date.now()
                        pushStats(liveFirstAt - liveReqAt, liveDeltas === 1)
                        deltaT.push(chunk)
                      },
                      // 思考增量：实时推给渲染层折叠块；持久化只落最终回答。
                      // 计时口径与 onDelta 对齐：思考也是被生成的
                      // token——首 token 时刻与增量数都要算它，否则监测条的首 token/tps
                      // 只反映正文段，思考期间会显示"还没开始"。
                      onThinking: (chunk) => {
                        emitted = true
                        liveDeltas += 1
                        if (liveFirstAt === null) liveFirstAt = Date.now()
                        pushStats(liveFirstAt - liveReqAt, liveDeltas === 1)
                        thinkingT.push(chunk)
                      }
                    }
                  )
                  live.llmMs += res.totalMs
                  // token 实时化：本轮 usage 到手即累计并强推快照——
                  // 否则 27 轮的任务里"输入/输出 tok"要等整次收尾才从 0 跳变。
                  live.inputTok += res.usage?.promptTokens ?? 0
                  live.outputTok += res.usage?.completionTokens ?? 0
                  if (res.cachedTokens !== undefined) {
                    live.cachedTok += res.cachedTokens
                    live.cacheKnown = true
                  }
                  // 本轮 ttft 结算：先以"当前轮"值强推快照（liveTtftSum 尚不含它），
                  // 再把该轮 ttft 并入累计——下一轮起 pushStats 的 sum 才不丢中间轮。
                  const roundTtft = liveFirstAt !== null ? liveFirstAt - liveReqAt : 0
                  pushStats(roundTtft, true)
                  liveTtftSum += roundTtft
                  // 本轮流式结束：立即清缓冲（工具执行前 UI 先同步，思考块不再延迟 120ms）
                  thinkingT.flush()
                  deltaT.flush()
                  return res
                } catch (err) {
                  const kind = classifyLlmError(err).kind
                  if (
                    signal.aborted ||
                    emitted ||
                    attempt >= LLM_RETRY_MAX ||
                    !RETRYABLE_LLM_KINDS.has(kind)
                  ) {
                    throw err
                  }
                  attempt += 1
                  emit(sender, {
                    sessionId,
                    runId,
                    type: 'run_notice',
                    data: {
                      kind: 'retry',
                      attempt,
                      text: `连接中断，正在重试（第 ${attempt}/${LLM_RETRY_MAX} 次）…`
                    } satisfies RunNoticeData
                  })
                  // 指数退避：800ms / 1.6s / 3.2s（默认 500ms 起，这里给慢网多一点余量）
                  await delay(LLM_RETRY_BASE_MS * 2 ** (attempt - 1), signal)
                }
              }
            },
            executeTool: (name, argsJson, signal) => {
              // 结构化提问：ask_user 需要"暂停-等作答-唤醒"运行时能力（registry
              // 静态 execute 不含），在包装层拦截。答案格式化成文本回灌给模型（同款于工具结果）。
              if (name === 'ask_user') {
                return handleAskTool(argsJson, requestAsk)
              }
              // 子任务分身：spawn_agent 的运行时需要 LLM 依赖（registry 的静态
              // execute 不含），在包装层拦截转 agent/spawn.ts；其余工具照旧统一入口。
              // 分身 executeTool 照抄主会话绑定（sessionId/mode/workspace）——账本与
              // 撤销闭环归主会话（关键决策）。
              if (name === 'spawn_agent') {
                spawnSeq += 1
                const seq = spawnSeq
                return handleSpawnTool(argsJson, {
                  call: subCall,
                  executeTool: (n, a, s) =>
                    executeToolCall(n, a, s, sessionId, {
                      mode: chatMode,
                      workspace: sessionWorkspace
                    }),
                  requestApproval,
                  parentMode: mode,
                  workspace: sessionWorkspace,
                  sessionId,
                  parentSignal: signal,
                  emit: (type, data) =>
                    emit(sender, {
                      sessionId,
                      runId,
                      type,
                      // 附带当前工具卡 id：渲染层把分身进度挂到 spawn_agent 那张卡上
                      data: { toolCallId: liveTcId, ...(data as Record<string, unknown>) }
                    })
                }).then((r) => {
                  appendDebugLog(logsDir(), `[chat] 子任务结束 → ${r.result.split('\n')[0] ?? ''}`)
                  // 执行日志：完整消息序列落 userData/logs/agents/，
                  // 滚 20 份——审计「分身到底干了什么」的原始记录；失败静默不影响结果
                  if (r.log !== undefined) {
                    writeAgentLog(join(logsDir(), 'agents'), `${runId}-${seq}`, {
                      runId,
                      seq,
                      sessionId,
                      ts: new Date().toISOString(),
                      objective: r.log.objective,
                      status: r.log.outcome.status,
                      report: r.log.outcome.report,
                      rounds: r.log.outcome.rounds,
                      steps: r.log.outcome.steps,
                      ms: r.log.outcome.ms,
                      inputTok: r.log.outcome.inputTok,
                      outputTok: r.log.outcome.outputTok,
                      messages: r.log.outcome.messages
                    })
                  }
                  return { ok: r.ok, result: r.result }
                })
              }
              const options = {
                mode: chatMode,
                workspace: sessionWorkspace,
                out: {} as { diffStat?: { added: number; removed: number }; files?: string[] }
              }
              return executeToolCall(name, argsJson, signal, sessionId, options).then((result) => {
                lastDiffStat = options.out.diffStat ?? null
                lastJsFiles = options.out.files ?? []
                return result
              })
            },
            onNotice: (notice) => {
              // 引擎侧状态（自动续跑/重试）→ 渲染层在流式气泡下显示一行淡色说明
              emit(sender, {
                sessionId,
                runId,
                type: 'run_notice',
                data: {
                  kind: notice.kind,
                  text: notice.text,
                  attempt: notice.attempt
                } satisfies RunNoticeData
              })
            },
            beforeRound: gate.beforeRound,
            beforeTool: gate.beforeTool,
            onToolStart: (tc) => {
              liveTcId = tc.id // 分身事件的关联锚点（先于 executeTool，串行保证）
              // 过程中文件行（同款口径）：读写类工具开始时就带文件引用，
              // 渲染层把工具卡升级为可点击的文件行——不等回复结束就能点开看
              const fileRef = fileRefFromCall(tc.name, tc.argsJson, sessionWorkspace)
              const data: ToolCallEventData = {
                toolCallId: tc.id,
                name: tc.name,
                argsPreview: tc.argsJson.slice(0, 120),
                ...(fileRef !== null ? { file: fileRef } : {})
              }
              emit(sender, { sessionId, runId, type: 'tool_call_start', data })
            },
            onToolResult: (tc, ok, resultPreview, durationMs, status) => {
              live.steps += 1
              live.toolMs += durationMs
              // 产出文件（同款口径）：写文件类工具成功时附上，
              // 渲染层在回复末尾渲染卡片，点击 → 右侧栏预览（见 produced-file.ts）
              const produced = ok
                ? resolveProducedFile(tc.name, tc.argsJson, sessionWorkspace)
                : null
              // run_js 产出文件走快照 diff（out 槽）：一次可产多个，转成卡片列表
              const jsFiles =
                ok && lastJsFiles.length > 0
                  ? lastJsFiles.map((rel) => ({
                      rel,
                      name:
                        rel
                          .split('/')
                          .filter((p) => p !== '')
                          .pop() ?? rel,
                      action: '已生成'
                    }))
                  : []
              lastJsFiles = []
              // diff 徽标（同款口径）：write_file/edit_file 执行时统计
              const diff = ok ? lastDiffStat : null
              lastDiffStat = null
              const data: ToolCallResultEventData = {
                toolCallId: tc.id,
                ok,
                // run_js 结果开头的系统标记行只供历史重建用，展示前剥掉
                resultPreview: stripRunJsMarker(resultPreview),
                durationMs,
                ...(status !== undefined ? { status } : {}),
                ...(produced !== null ? { file: produced } : {}),
                ...(jsFiles.length > 0 ? { files: jsFiles } : {}),
                ...(diff !== null ? { diff } : {})
              }
              emit(sender, { sessionId, runId, type: 'tool_call_result', data })
              // 工具喂给清单催办状态机：todo_write 视为"已同步"，进展类工具置陈旧
              todoNudges.noteToolResult(tc.name, ok)
              // todo_write 执行成功：推整表快照刷新进度卡
              if (ok && tc.name === 'todo_write') {
                const todos = readTodos(sessionId)
                if (todos !== null) {
                  emit(sender, {
                    sessionId,
                    runId,
                    type: 'todo_updated',
                    data: { sessionId, items: todos.items }
                  })
                }
              }
            },
            // 步末 / 收尾前的清单催办（文案与判定都在 chat/todo-nudge.ts）
            stepReminder: () => todoNudges.stepReminder(),
            finishReminder: () => todoNudges.finishReminder(),
            // 插话消费（steering）：每轮 LLM 调用前把排队的用户消息注入上下文并落盘
            drainNudges: () => {
              const queue = nudgesBySession.get(sessionId)
              if (queue === undefined || queue.length === 0) return []
              nudgesBySession.set(sessionId, [])
              for (const text of queue) {
                persistTurns(sessionId, [
                  { id: newPersistedId(), role: 'user', ts: Date.now(), text }
                ])
              }
              return queue
            },
            onStepBoundary: (turns, stepThinking) => {
              // 步边界落盘：本轮 assistant(+调用清单+本步思考) + 工具结果，崩溃不丢已完成的步
              persistTurns(sessionId, llmTurnsToPersisted(turns, stepThinking))
              tail = ''
              // checkpoint 标记：有已执行步才记"可续跑"
              if (live.steps > 0) {
                saveCheckpointMarker(checkpointDir(), {
                  sessionId,
                  status: 'running',
                  steps: live.steps,
                  updatedAt: Date.now()
                })
              }
            }
          },
          controller.signal,
          TOOL_LOOP_LIMITS
        )
        const delta: SessionStats = {
          rounds: loopResult.rounds,
          steps: loopResult.steps,
          toolMs: loopResult.toolMs,
          inputTok: loopResult.inputTok,
          outputTok: loopResult.outputTok,
          llmMs: loopResult.llmMs,
          cachedTok: loopResult.cachedTok,
          cacheKnown: loopResult.cacheKnown,
          ttftMsLast: loopResult.ttftMsLast,
          ttftMsSum: loopResult.ttftMsSum,
          tpsLast: loopResult.tpsLast,
          samples: loopResult.rounds
        }
        const nextStats = accumulateStats(baseStats, delta)
        // 用量流水：有真实数字才记（错误/中断路径拿不到 usage，跳过）
        if (loopResult.rounds > 0 || loopResult.inputTok > 0 || loopResult.outputTok > 0) {
          appendUsage(sessionsDir(), {
            t: Date.now(),
            model: profile.model,
            inputTok: loopResult.inputTok,
            outputTok: loopResult.outputTok,
            cachedTok: loopResult.cachedTok,
            llmMs: loopResult.llmMs,
            rounds: loopResult.rounds
          })
        }
        // 最终回答落盘（completed 有文本；max-steps / 循环熔断可能无文本 → 仅落统计与用量）
        // 思考内容随最终回答持久化（≤8000 截断在 sanitize；空串不落字段）
        const finalThinking =
          loopResult.finalThinking !== '' ? loopResult.finalThinking.slice(0, 8000) : undefined
        const persisted =
          loopResult.finalText !== ''
            ? persistTurns(
                sessionId,
                [
                  {
                    id: newPersistedId(),
                    role: 'assistant',
                    ts: Date.now(),
                    text: loopResult.finalText,
                    ...(finalThinking !== undefined ? { thinking: finalThinking } : {})
                  }
                ],
                loopResult.usage,
                delta
              )
            : persistTurns(sessionId, [], loopResult.usage, delta)
        // 记忆沉淀：正常完成后异步提炼（fire-and-forget，失败静默）。
        // 开关关闭 → 完全跳过（设计：默认关，设置页打开才生效）。
        if (loopResult.stoppedReason === 'completed' && config.privacy.memory === true) {
          distillMemory(
            {
              baseUrl: profile.baseUrl,
              apiKey,
              model: profile.model,
              protocol: profile.protocol,
              logsDir: () => logsDir()
            },
            llmText,
            loopResult.finalText,
            sessionId
          )
        }
        // checkpoint 生命周期：正常完成销档；步数上限/循环熔断保留为可续跑
        if (loopResult.stoppedReason === 'completed') {
          clearCheckpointMarker(checkpointDir(), sessionId)
        } else if (loopResult.steps > 0) {
          saveCheckpointMarker(checkpointDir(), {
            sessionId,
            status: 'paused',
            steps: loopResult.steps,
            updatedAt: Date.now()
          })
        }
        const note =
          loopResult.stoppedReason === 'max-steps'
            ? `任务还没做完（已执行 ${loopResult.steps} 步${
                loopResult.autoContinues > 0
                  ? `，期间她自动接着跑了 ${loopResult.autoContinues} 次`
                  : ''
              }），先停下来等你——点「继续任务」她就接着做`
            : loopResult.stoppedReason === 'loop-detected'
              ? '检测到重复的工具调用，已中止本轮'
              : loopResult.stoppedReason === 'aborted'
                ? '已中断'
                : ''
        thinkingT.flush()
        deltaT.flush()
        emit(sender, {
          sessionId,
          runId,
          type: 'done',
          data:
            persisted === false
              ? { note, usage: loopResult.usage, stats: nextStats, persisted: false }
              : { note, usage: loopResult.usage, stats: nextStats }
        })
      } catch (err) {
        if (controller.signal.aborted) {
          // 用户主动停止：步边界已落盘；尾部部分文本（最后一个未完轮次）一并保留
          thinkingT.flush()
          deltaT.flush()
          const delta: SessionStats = {
            rounds: live.rounds,
            steps: live.steps,
            toolMs: live.toolMs,
            inputTok: live.inputTok,
            outputTok: live.outputTok,
            llmMs: live.llmMs,
            cachedTok: live.cachedTok,
            cacheKnown: live.cacheKnown || (baseStats?.cacheKnown ?? false),
            ttftMsLast: liveFirstAt !== null ? liveFirstAt - liveReqAt : 0,
            ttftMsSum: liveTtftSum + (liveFirstAt !== null ? liveFirstAt - liveReqAt : 0),
            tpsLast: 0,
            samples: live.rounds
          }
          const nextStats = accumulateStats(baseStats, delta)
          const persisted =
            tail !== ''
              ? persistTurns(
                  sessionId,
                  [{ id: newPersistedId(), role: 'assistant', ts: Date.now(), text: tail }],
                  undefined,
                  delta
                )
              : persistTurns(sessionId, [], undefined, delta)
          if (live.steps > 0) {
            saveCheckpointMarker(checkpointDir(), {
              sessionId,
              status: 'paused',
              steps: live.steps,
              updatedAt: Date.now()
            })
          }
          emit(sender, {
            sessionId,
            runId,
            type: 'done',
            data:
              persisted === false
                ? { note: '已中断', stats: nextStats, persisted: false }
                : { note: '已中断', stats: nextStats }
          })
        } else {
          const info = classifyLlmError(err)
          thinkingT.flush()
          deltaT.flush()
          if (live.steps > 0) {
            saveCheckpointMarker(checkpointDir(), {
              sessionId,
              status: 'paused',
              steps: live.steps,
              updatedAt: Date.now()
            })
          }
          const delta: SessionStats = {
            rounds: live.rounds,
            steps: live.steps,
            toolMs: live.toolMs,
            inputTok: live.inputTok,
            outputTok: live.outputTok,
            llmMs: live.llmMs,
            cachedTok: live.cachedTok,
            cacheKnown: live.cacheKnown || (baseStats?.cacheKnown ?? false),
            ttftMsLast: liveFirstAt !== null ? liveFirstAt - liveReqAt : 0,
            ttftMsSum: liveTtftSum + (liveFirstAt !== null ? liveFirstAt - liveReqAt : 0),
            tpsLast: 0,
            samples: live.rounds
          }
          const nextStats = accumulateStats(baseStats, delta)
          if (tail !== '') {
            persistTurns(
              sessionId,
              [{ id: newPersistedId(), role: 'assistant', ts: Date.now(), text: tail }],
              undefined,
              delta
            )
          } else {
            persistTurns(sessionId, [], undefined, delta)
          }
          emit(sender, { sessionId, runId, type: 'error', data: info.message })
          emit(sender, { sessionId, runId, type: 'stats', data: nextStats })
        }
      } finally {
        nudgesBySession.delete(sessionId)

        runs.delete(runId)
        const current = activeBySession.get(sessionId)
        if (current === runId) activeBySession.delete(sessionId)
      }
    })()

    return { ok: true, runId }
  }

  ipcMain.handle(CHAT_SEND, handleChatSend)

  // 工作中插话：任务运行中入队（渲染层本地已显示用户气泡）；无活跃 run 返回 false，
  // 渲染层据此回退为普通发送（避免消息石沉大海）
  ipcMain.handle(CHAT_NUDGE, (_event, sessionId: unknown, text: unknown): boolean => {
    if (typeof sessionId !== 'string' || typeof text !== 'string') return false
    const trimmed = text.trim()
    if (trimmed === '' || !activeBySession.has(sessionId)) return false
    const queue = nudgesBySession.get(sessionId) ?? []
    queue.push(trimmed)
    nudgesBySession.set(sessionId, queue)
    return true
  })

  // 续跑：校验存档标记存在后，以提示语走完整发送管线（历史投影自动带上已完成步骤）
  ipcMain.handle(
    CHECKPOINT_RESUME,
    async (
      _event: Electron.IpcMainInvokeEvent,
      sessionId: unknown,
      modeRaw?: unknown
    ): Promise<ChatSendResult> => {
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { ok: false, error: '会话标识无效' }
      }
      const marker = readCheckpointMarker(checkpointDir(), sessionId)
      if (marker === null) {
        return { ok: false, error: '该会话没有可续跑的任务' }
      }
      clearCheckpointMarker(checkpointDir(), sessionId) // 旧标记作废，新运行会重新记步
      return handleChatSend(_event, sessionId, RESUME_NUDGE_TEXT, undefined, modeRaw)
    }
  )

  ipcMain.handle(CHECKPOINT_GET, (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    return readCheckpointMarker(checkpointDir(), sessionId)
  })

  ipcMain.handle(CHECKPOINT_DISCARD, (_event, sessionId: unknown): { ok: boolean } => {
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false }
    clearCheckpointMarker(checkpointDir(), sessionId)
    return { ok: true }
  })

  ipcMain.on(CHAT_CANCEL, (_event, runId: unknown) => {
    if (typeof runId !== 'string') return
    runs.get(runId)?.controller.abort()
  })

  // 任务清单读取：切会话/重启后恢复进度卡
  ipcMain.handle(TODO_GET, (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    return readTodos(sessionId)
  })

  // 学习笔记读取：笔记卡展示
  ipcMain.handle(NOTES_GET, (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    return readNotes(sessionId)
  })

  // 复习队列：返回今日到期的卡片（含未练过的新卡）+ 汇总。
  // 新卡不设上限会把一次灌进来的 50 张全推给用户，所以新卡按入档顺序截到 REVIEW_DAILY_NEW_LIMIT。
  ipcMain.handle(REVIEW_DUE, (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    const notes = readNotes(sessionId)
    if (notes === null) return null
    const cards = notes.items.filter((i) => i.kind === 'card')
    const db = readReview(sessionId)
    const now = Date.now()
    const summary = summarize(cards.length, db.cards, now)

    const dueCards: Array<{
      id: string
      title: string
      content: string
      topic: string | null
      isNew: boolean
      level: number
      lapses: number
    }> = []
    let newTaken = 0
    for (const c of cards) {
      const st = db.cards[c.id]
      if (st === undefined) {
        if (newTaken >= REVIEW_DAILY_NEW_LIMIT) continue
        newTaken += 1
      } else if (!isDue(st, now)) {
        continue
      }
      dueCards.push({
        id: c.id,
        title: c.title,
        content: c.content,
        topic: c.topic ?? null,
        isNew: st === undefined,
        level: st?.level ?? -1,
        lapses: st?.lapses ?? 0
      })
    }
    return { cards: dueCards, summary }
  })

  // 复习评分：落盘档位 + 把实测掌握度回流到知识点（有 topic 才回流）。
  // ★ 全程 try/catch 收敛成 { ok:false, error }：本 handler 若抛出去，渲染层的 Promise
  // 会 reject，而 ReviewCard 的 busy 标志只在 then 里复位 → 三个评分按钮永久禁用（
  // 实测「点了一下就什么都点不了」）。失败必须可读地回到 UI，不能把卡打死。
  ipcMain.handle(
    REVIEW_GRADE,
    (
      _event,
      sessionId: unknown,
      cardId: unknown,
      grade: unknown
    ): { ok: boolean; summary?: DueSummary; error?: string } => {
      try {
        if (typeof sessionId !== 'string' || sessionId === '')
          return { ok: false, error: '会话无效' }
        if (typeof cardId !== 'string' || cardId === '') return { ok: false, error: '卡片无效' }
        if (grade !== 'again' && grade !== 'good' && grade !== 'easy') {
          return { ok: false, error: '评分无效' }
        }
        const notes = readNotes(sessionId)
        if (notes === null) return { ok: false, error: '本会话还没有笔记' }
        const card = notes.items.find((i) => i.id === cardId && i.kind === 'card')
        if (card === undefined) return { ok: false, error: '卡片不存在（可能已被清理）' }
        const cardCount = notes.items.filter((i) => i.kind === 'card').length
        const { summary } = gradeAndSave(sessionId, cardId, grade, Date.now(), cardCount)
        // 掌握度回流：该知识点所有卡的实测平均分 → 写回进度档（只在有 topic 且进度档已有该点时）
        if (card.topic !== undefined && card.topic !== '') {
          const db = readReview(sessionId)
          const sameTopic = notes.items.filter((i) => i.kind === 'card' && i.topic === card.topic)
          const scored = sameTopic
            .map((i) => db.cards[i.id])
            .filter((s): s is ReviewState => s !== undefined && s.reps > 0)
          if (scored.length > 0) {
            const avg = Math.round(
              scored.reduce((sum, s) => sum + estimateMastery(s), 0) / scored.length
            )
            setMeasured(sessionId, card.topic, avg)
          }
        }
        return { ok: true, summary }
      } catch (err) {
        return {
          ok: false,
          error: `评分保存失败：${err instanceof Error ? err.message : String(err)}`
        }
      }
    }
  )

  // 学习进度：掌握度 + 学习计划（学习模式进度卡）
  ipcMain.handle(PROGRESS_GET, (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    const db = readProgress(sessionId)
    const notes = readNotes(sessionId)
    const cards = notes === null ? [] : notes.items.filter((i) => i.kind === 'card')
    const reviewDb = readReview(sessionId)
    const now = Date.now()
    // 每个知识点关联多少张卡（展示"这门课有多少张卡在练"）
    const cardCountByTopic: Record<string, number> = {}
    for (const c of cards) {
      if (c.topic === undefined || c.topic === '') continue
      cardCountByTopic[c.topic] = (cardCountByTopic[c.topic] ?? 0) + 1
    }
    return {
      plan: db.plan,
      daysLeft: daysLeft(db.plan.deadline, now),
      topics: db.topics.map((t) => ({
        topic: t.topic,
        score: t.measuredScore ?? t.selfScore,
        measured: t.measuredScore !== null,
        cards: cardCountByTopic[t.topic] ?? 0,
        updatedAt: t.updatedAt
      })),
      review: summarize(cards.length, reviewDb.cards, now),
      noteCount: notes === null ? 0 : notes.items.filter((i) => i.kind === 'note').length
    }
  })

  // 学习笔记导出：另存对话框 → Markdown 文件（可直接复习用）
  ipcMain.handle(
    NOTES_EXPORT,
    async (
      event,
      sessionId: unknown
    ): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> => {
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { ok: false, error: '会话标识无效' }
      }
      const state = readNotes(sessionId)
      if (state === null || state.items.length === 0) {
        return { ok: false, error: '本会话还没有笔记可导出' }
      }
      const win = BrowserWindow.fromWebContents(event.sender)
      const now = new Date()
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
      const result = await dialog.showSaveDialog(win ?? new BrowserWindow({ show: false }), {
        title: '导出学习笔记',
        defaultPath: `学习笔记-${stamp}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (result.canceled || result.filePath === undefined) {
        return { ok: false, canceled: true }
      }
      const notes = state.items.filter((i) => i.kind === 'note')
      const cards = state.items.filter((i) => i.kind === 'card')
      const lines: string[] = [
        '# 爱弥斯学习笔记',
        '',
        `> 会话 ${sessionId} · 导出于 ${now.toLocaleString('zh-CN')} · 共 ${state.items.length} 条（笔记 ${notes.length} / 闪卡 ${cards.length}）`,
        ''
      ]
      if (notes.length > 0) {
        lines.push('## 📝 笔记', '')
        notes.forEach((n, i) => {
          lines.push(`### ${i + 1}. ${n.title}`, '', n.content, '')
        })
      }
      if (cards.length > 0) {
        lines.push('## 🃏 闪卡', '')
        cards.forEach((c, i) => {
          lines.push(`**Q${i + 1}. ${c.title}**`, '', `**A.** ${c.content}`, '')
        })
      }
      try {
        const { writeFileSync } = await import('fs')
        writeFileSync(result.filePath, lines.join('\n'), 'utf8')
        return { ok: true, path: result.filePath }
      } catch (err) {
        return { ok: false, error: `写入失败：${err instanceof Error ? err.message : String(err)}` }
      }
    }
  )
}

/** 应用整体退出时掐断所有在途流（防挂）；历史已即时落盘，无需清理 */
export function cancelAllRuns(): void {
  for (const run of runs.values()) run.controller.abort()
  runs.clear()
  activeBySession.clear()
}

/**
 * 掐断指定会话的在途流：会话被删除时调用。
 * 不继续烧 token；流式收尾会经 isSessionRegistered 校验跳过落盘，不产生僵尸数据文件。
 */
export function abortRunsForSession(sessionId: string): void {
  for (const run of runs.values()) {
    if (run.sessionId === sessionId) run.controller.abort()
  }
  // 会话已删除：其"本会话允许此工具"记忆一并作废（防止同名新会话继承授权）
  clearSessionAllowedTools(sessionId)
}

/** 掐断所有不在 validIds 中的在途流（注册表全量同步时调用，同上） */
export function abortRunsNotInSessions(validIds: string[]): void {
  const valid = new Set(validIds)
  for (const run of runs.values()) {
    if (!valid.has(run.sessionId)) run.controller.abort()
  }
}
