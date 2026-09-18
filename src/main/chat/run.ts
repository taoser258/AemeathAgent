// 聊天管线：chat:send → 组 system prompt → LLM 流式 → chat:stream 逐 token 推送。
// 契约：渲染层 chatSend(sessionId, text, attachments)；主进程生成 runId；
// 中断 chat:cancel(runId)；done/error 后该 runId 关闭。
// 会话历史 T5 起持久化（main/sessions/session-store.ts，每会话一个 JSON 原子写）；
// 本轮 user/assistant 消息在流结束（含中断/出错保留部分）时落盘，发送时从盘上重建上下文。

import { BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync, statSync } from 'fs'
import { basename, join } from 'path'
import {
  CHAT_ANSWER,
  CHAT_APPROVE,
  CHAT_CANCEL,
  CHAT_COMPACT,
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
  AppConfig,
  ChatAttachmentPayload,
  ChatSendResult,
  ModelProfile,
  PersistedMessage,
  SessionStats,
  TokenUsage
} from '@shared/types'
import { checkpointDir, configDir, logsDir, personasDir, sessionsDir } from '../paths'
import { notifyBubble } from '../pet/bubble-scheduler'
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
import {
  executeToolCall,
  getLlmTools,
  getToolPathBase,
  resolveToolPath
} from '../agent/tools/registry'
import { trashToRecycleBin } from '../agent/tools/trash'
import { planTempCleanup, type LeftoverReason } from '../agent/tools/temp-cleanup'
import { findClaimedButMissing } from './claimed-files'
import { getSubLlmTools, handleSpawnTool } from '../agent/spawn'
import { handleAskTool } from './ask'
import { writeAgentLog } from '../agent/agent-log'
import { appendUsage } from '../usage/usage-log'
import { resolveProducedFile } from './produced-file'
import { fileRefFromCall, stripRunJsMarker, extractProducedPath } from '@shared/produced-file'
import { pickForInjection } from '@shared/memory'
import { estimateTokens } from '@shared/token-estimate'
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
import { CitationGuard } from './citation-guard'
import { TodoNudges } from './todo-nudge'
import { createToolGate, clearSessionAllowedTools } from './permission'
import {
  attachmentNote,
  imageVerificationNote,
  llmTurnsToPersisted,
  projectPersistedHistory,
  trimHistoryForRequest,
  visionFailureNote,
  visionTranscriptionNote
} from './history'
import { describeImage, pickVisionProfile, visionUnavailableHint } from '../llm/vision'
import {
  COMPACT_FALLBACK_NOTE,
  buildCompactedView,
  compactResultNotice,
  estimateTurnTokens,
  estimateViewTokens,
  isContextOverflowError,
  pickCompactCut,
  resolveCompactPolicy,
  shouldCompact
} from './compact'
import { summarizeTurns } from './compact-run'
import { readCompactSummary, writeCompactSummary } from './compact-store'
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

/**
 * 视觉旁路（P8-T3）：当前档案收不了图时，请视觉档案把每张图转述成文字，注入本轮文本。
 *
 * 为什么**不切换主模型**（照 pi-image-fallback 的取舍）：切过去再切回来会打烂两边
 * 的 prompt cache，还会让会话历史里出现"模型换了人"的错乱；一次独立小调用的成本
 * 远低于此。选档与调用都在 llm/vision.ts（纯函数 + 单一 LLM 出口），这里只做胶水。
 *
 * 失败分两种，处理也不同：
 * - **选不出视觉档案**（没配/关掉了/档案被删）→ 回退既有行为：如实说"看不到图"，附指路；
 * - **调用失败**（网络/超时/端点拒绝）→ 注入一句"识图失败"占位，**不阻断本轮对话**
 *   （否则一次烂网络就把用户的话吞了）。
 */
async function transcribeImages(
  config: AppConfig,
  activeProfile: ModelProfile,
  attachments: readonly ChatAttachmentPayload[]
): Promise<{ ok: true; note: string } | { ok: false; error: string }> {
  const images = attachments.filter((a) => a.kind === 'image' && a.dataUrl !== undefined)
  const pick = pickVisionProfile({
    profiles: config.model.profiles,
    activeId: config.model.activeId,
    visionProfileId: config.model.visionProfileId,
    hasKey: (id) => {
      const key = readProfileKey(configDir(), id)
      return key !== null && key !== ''
    }
  })
  if (!pick.ok) {
    return {
      ok: false,
      error: `「${activeProfile.name}」未开启多模态，无法接收图片附件。${visionUnavailableHint(pick.reason)}`
    }
  }
  const apiKey = readProfileKey(configDir(), pick.profile.id) ?? ''
  const notes: string[] = []
  for (const att of images) {
    const res = await describeImage({
      profile: pick.profile,
      apiKey,
      dataUrl: att.dataUrl ?? ''
    })
    notes.push(
      res.ok
        ? visionTranscriptionNote(att.name, pick.profile.name, res.text)
        : visionFailureNote(att.name, res.error)
    )
  }
  if (notes.length === 0) {
    return { ok: false, error: `「${activeProfile.name}」未开启多模态，无法接收图片附件。` }
  }
  return { ok: true, note: notes.join('') }
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

    // ── 图片能不能"看见"（P8-T3 视觉旁路）────────────────────────────
    // 档案开了多模态 → 直接把图发给主模型（维持既有行为 + P7-T4 的核对提示）；
    // 没开 → 不切模型（切了会打烂两边 prompt cache、还断会话），而是让**视觉档案**
    // 做一次独立的小调用，把转述当文字注入本轮。转述必须标来源（见 history.ts）。
    if (imageParts.length > 0) {
      if (profile.multimodal === true) {
        llmText += imageVerificationNote(imageParts.length)
      } else {
        const transcribed = await transcribeImages(config, profile, attachments)
        if (!transcribed.ok) return { ok: false, error: transcribed.error }
        llmText += transcribed.note
        imageParts.length = 0 // 收不了图：一张都不发，避免服务端因图片 part 报 400
      }
    }

    // T5：历史从持久化层重建
    const persisted = loadSessionMessages(sessionsDir(), sessionId)
    const baseStats: SessionStats | undefined = persisted.ok ? persisted.stats : undefined
    /**
     * 上次请求的真实用量（会话存档里留着的）。
     * 用途：**本轮第一轮** loop 还没发过请求、拿不到 usage——没有它就只能数字符，
     * 而字符口径系统性偏低（不含 system/工具清单/工具参数），实测 88.8% 的会话
     * 估出来只有窗口的 1/3 → 该压的时候压不动。有它就按真实值判定。
     */
    const persistedUsage: TokenUsage | null =
      persisted.ok && persisted.usage !== undefined ? persisted.usage : null
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
          // 桌宠气泡档位：让模型对自身形态的认知与 UI 一致（P9-T5）
          bubbleLevel: config.pet.bubbleLevel,
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

    // ── 上下文压缩（P8-T1）：先用上次会话留下的摘要 ─────────────────────
    // 摘要是**上次压缩的产物**，跨 run 复用（否则长会话每发一句都要重做一次摘要）。
    // 摘要在裁剪之后注入，保证它不会被裁掉；它描述的是"比窗口里还早"的内容，
    // 与保住的历史可能有少量重叠——转述轮里已经写明"不是原话"，重叠无害。
    const savedSummary = config.chat.autoCompact ? readCompactSummary(sessionId) : null
    const firstView: ChatTurn[] =
      savedSummary === null ? capped : buildCompactedView(capped, capped.slice(1), savedSummary)
    /** 摘要文本（跨轮累积；本轮压缩出来的新摘要会覆盖它并落盘） */
    let compactSummary: string | null = savedSummary
    /** 溢出自救额度：整次 run 只给一次（防"压缩→还是超→再压缩"的死循环） */
    let overflowRecovered = false
    /** 压缩失败提示只给一次（否则每轮都失败会刷屏） */
    let compactFailNotified = false
    /**
     * 自动压缩的「验收」待办：压缩发生在请求前，此时不知道压缩后真实占用，
     * **不能当场报"省下多少 token"**（owner 实测：固定开销占大头时报了等于骗人）。
     * 记下折叠条数与压缩后视图，等这一轮真实 usage 回来再给结论（见 call 包装）。
     */
    let compactAwait: { droppedCount: number; viewAfter: ChatTurn[] } | null = null

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
      /** 本轮已生成输出的估算 token（正文+思考+工具参数），实时 tps 分子 */
      let liveOutputTokens = 0
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
            ? Math.round(liveOutputTokens / ((now - liveFirstAt) / 1000))
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
            reasoningEffort: profile.reasoningEffort,
            ...(profile.reasoningAdapter !== undefined
              ? { reasoningAdapter: profile.reasoningAdapter }
              : {})
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
      /**
       * 引用护栏（P7-T1）：收尾回复里引用了"工具结果/对话里没出处的链接"→ 催一次。
       * 判定在 chat/citation-guard.ts（纯逻辑、有单测）。种子 = 已落盘的**工具结果与
       * 用户消息**里的链接（assistant 历史不扫——上轮编造的链接混进种子=错误洗白）。
       */
      const citationGuard = new CitationGuard()
      if (persisted.ok) {
        citationGuard.seedFrom(
          persisted.messages
            .filter((m) => m.role === 'tool' || m.role === 'user')
            .map((m) => m.text)
        )
      }
      /** 成功工具结果的**全文**喂给护栏（executeTool 三个出口统一走 .then） */
      const collectCitations = <T extends { ok: boolean; result: string }>(r: T): T => {
        if (r.ok) citationGuard.noteToolResult(true, r.result)
        return r
      }
      /**
       * 收尾催办聚合器（任务书：两路各一次额度、文案拼接，别互相挤占）。
       * 引用护栏的额度在 CitationGuard 内部；清单这路的"只催一次"在循环侧原本靠
       * finishReminded 布尔——现在额度下沉到这里按源管理（真催出去才消耗，
       * 干净收尾不烧额度，与护栏同款口径）。判定逻辑全在两个纯模块，这里只是胶水。
       */
      let todoReminded = false
      const finishReminder = (finalText: string): string | null => {
        const parts: string[] = []
        if (!todoReminded) {
          const t = todoNudges.finishReminder()
          if (t !== null) {
            todoReminded = true
            parts.push(t)
          }
        }
        const c = citationGuard.finishReminder(finalText)
        if (c !== null) parts.push(c)
        return parts.length > 0 ? parts.join('\n') : null
      }

      /**
       * 本次 run 中她自己创建文件的绝对路径轨迹（任务末临时清理用）。
       * 只记 write_file（新建/覆盖）与 run_js 的产出：
       * edit_file 多为改用户已有文件（哪怕名字像 .log 也不该被顺手清掉），
       * export_pdf/note_export/download_file 是明确的产出/下载，都不记。
       */
      const createdFiles = new Set<string>()
      /**
       * 记录"本次新建"的文件。write_file 只在目标**此前不存在**时记入——
       * 覆写用户已有的同名文件（比如更新一个 app.log）绝不能被当临时件清掉。
       * 解析不出路径/基准缺失时按"已存在"处理（宁可漏记，不可错杀）。
       */
      const trackCreated = (
        name: string,
        argsJson: string,
        jsFiles: string[],
        preExisted: boolean
      ): void => {
        if (name === 'write_file') {
          if (preExisted) return
          const raw = extractProducedPath(argsJson)
          if (raw !== null) {
            try {
              createdFiles.add(resolveToolPath(raw, sessionWorkspace))
            } catch {
              // 相对路径基准缺失等：不入轨迹（宁可漏清，不可乱猜）
            }
          }
        } else if (name === 'run_js') {
          for (const rel of jsFiles) {
            try {
              createdFiles.add(resolveToolPath(rel, sessionWorkspace))
            } catch {
              // 同上
            }
          }
        }
      }

      /** write_file 执行前探测目标是否已存在（临时清理轨迹用；任何异常按已存在处理） */
      const targetExistedBefore = (name: string, argsJson: string): boolean => {
        if (name !== 'write_file') return false
        const raw = extractProducedPath(argsJson)
        if (raw === null) return true
        try {
          return existsSync(resolveToolPath(raw, sessionWorkspace))
        } catch {
          return true
        }
      }

      /**
       * 她通过 mark_temp_files 登记的中间产物（per-run 内存态）。
       * **这是自动清理唯一的意图信号**——两次误删事故（目录名 temp 里的成果、
       * 用户要求保留的 旧日志.log）都源于系统拿"猜测"当删除依据，现在改为"她明确登记"。
       */
      const declaredTempFiles = new Set<string>()

      /**
       * 压缩一次（P8-T1，唯一调摘要模型的地方）：判定 → 切点 → 摘要（增量合并）→ 拼视图。
       * 返回 null = 没压（不满足条件 / 摘要失败）：调用方一律回退未压缩视图。
       * `@param force` true = 溢出自救（已确认超限，必须缩小；摘要失败也要丢旧内容保命）。
       */
      const compactOnce = async (
        view: ChatTurn[],
        force: boolean,
        actualTokens: number | null = null
      ): Promise<ChatTurn[] | null> => {
        if (!config.chat.autoCompact && !force) return null
        // 保留区必须按**实际窗口**缩放：32K 窗口下 Pi 的 20K 保留区会把额度吃光
        // → 旧逻辑永不压缩（owner 实测 89.4% 纹丝不动）。见 resolveCompactPolicy。
        const policy = resolveCompactPolicy(profile.context)
        // 切点必须与触发用**同一把尺子**（owner 第二轮实测：真实 29.1K / 字符口径只估 10.8K
        // → 该压却"无可压"，静默不动）。溢出自救时真实值未知，但既然已经超限，
        // 真实占用必定 ≥ 窗口，就用窗口当已知下限。
        const cut = pickCompactCut(view, policy, actualTokens ?? (force ? profile.context : null))
        if (cut === null) return null
        const res = await summarizeTurns({
          profile,
          apiKey,
          previous: compactSummary,
          dropped: cut.dropped
        })
        if (!res.ok) {
          appendDebugLog(logsDir(), `[chat] 会话 ${sessionId} 上下文摘要失败: ${res.error}`)
          // 失败要**说出来**（每次 run 只提示一次）：静默回退会让"88% 却毫无反应"变成无解之谜
          if (!compactFailNotified) {
            compactFailNotified = true
            emit(sender, {
              sessionId,
              runId,
              type: 'run_notice',
              data: {
                kind: 'compact',
                attempt: 0,
                text: `上下文压缩失败（${res.error}）——本轮照常继续，原始记录未动`
              } satisfies RunNoticeData
            })
          }
          if (!force) return null
          // 救急场景：摘要没成但请求确实超限——只能丢旧内容并留一句说明（否则这轮发不出去）
          return buildCompactedView(view, cut.kept, COMPACT_FALLBACK_NOTE)
        }
        const summary = res.text
        compactSummary = summary
        writeCompactSummary(sessionId, summary)
        const compactedView = buildCompactedView(view, cut.kept, summary)
        // 压缩当下只报"做了什么"，**不报省了多少 token**：真实占用要等这次请求的
        // usage 回来才知道，当场折算会把固定开销（人设+工具 schema）也算进"省下"，
        // owner 实测 136 字符的会话被报成省下上万 token。结论气泡等 usage（call 包装）。
        compactAwait = { droppedCount: cut.dropped.length, viewAfter: compactedView }
        emit(sender, {
          sessionId,
          runId,
          type: 'run_notice',
          data: {
            kind: 'compact',
            attempt: 0,
            text: `已把更早的 ${cut.dropped.length} 条对话压成摘要，这次请求起生效（原文不删，回看/搜索仍是原文）`
          } satisfies RunNoticeData
        })
        return compactedView
      }

      try {
        const loopResult = await runToolLoop(
          firstView,
          {
            call: async (msgs, signal) => {
              live.rounds += 1 // 进入即计：轮次预算/监测栏即时反映（完成后的耗时随后累加）
              // 本次调用实际要发的消息：正常 = 循环给的视图；溢出自救后会换成压缩后的视图
              let active = msgs
              // 瞬时错误自动重试：网络抖动 / 限流 / 5xx 不再把整轮任务打断。
              // 只在「这次尝试一个字都还没吐出来」时重试——已经流到气泡里的文字收不回来，
              // 重试会让正文重复；那种情况宁可如实报错（用户点「继续任务」即可接着跑）。
              for (let attempt = 0; ;) {
                let emitted = false
                // 本轮/本次尝试的计时基准重置（重试=重新计时；与 loop 侧 ttftMsLast 口径一致）
                liveFirstAt = null
                liveOutputTokens = 0
                liveReqAt = Date.now() // 本轮请求起点：ttft = 首增量 - 此值
                try {
                  const res = await streamChat(
                    {
                      baseUrl: profile.baseUrl,
                      apiKey,
                      model: profile.model,
                      temperature: config.model.temperature,
                      messages: active,
                      tools: chatMode === 'chat' ? undefined : getLlmTools(chatMode),
                      protocol: profile.protocol,
                      reasoningEffort: profile.reasoningEffort,
                      ...(profile.reasoningAdapter !== undefined
                        ? { reasoningAdapter: profile.reasoningAdapter }
                        : {}),
                      maxOutput: profile.maxOutput
                    },
                    {
                      signal,
                      onDelta: (chunk) => {
                        emitted = true
                        tail += chunk
                        const isFirst = liveFirstAt === null
                        const firstAt = liveFirstAt ?? Date.now()
                        if (isFirst) liveFirstAt = firstAt
                        liveOutputTokens += estimateTokens(chunk)
                        pushStats(firstAt - liveReqAt, isFirst)
                        deltaT.push(chunk)
                      },
                      // 思考增量：实时推给渲染层折叠块；持久化只落最终回答。
                      // 计时口径与 onDelta 对齐：思考也是被生成的
                      // token——首 token 时刻与增量数都要算它，否则监测条的首 token/tps
                      // 只反映正文段，思考期间会显示"还没开始"。
                      onThinking: (chunk) => {
                        emitted = true
                        const isFirst = liveFirstAt === null
                        const firstAt = liveFirstAt ?? Date.now()
                        if (isFirst) liveFirstAt = firstAt
                        liveOutputTokens += estimateTokens(chunk)
                        pushStats(firstAt - liveReqAt, isFirst)
                        thinkingT.push(chunk)
                      },
                      // 工具参数也是 completion_tokens 的一部分：实时估算一并计入，
                      // 否则纯工具轮 tps 偏低、结束用真实 usage 时跳变。
                      onToolDelta: (chunk) => {
                        const isFirst = liveFirstAt === null
                        const firstAt = liveFirstAt ?? Date.now()
                        if (isFirst) liveFirstAt = firstAt
                        liveOutputTokens += estimateTokens(chunk)
                        pushStats(firstAt - liveReqAt, isFirst)
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
                  // 压缩验收（见 compactAwait）：真实 usage 到手后给最终结论。
                  // 压完仍超窗口（owner 实测：136 字符会话也有 17.7K 固定占用）→
                  // 明确解释"什么压不掉 + 怎么办"，不能让用户对着纹丝不动的用量环发懵。
                  if (compactAwait !== null && res.usage !== undefined) {
                    const awaited = compactAwait
                    compactAwait = null
                    const bodyTokens = awaited.viewAfter
                      .slice(1)
                      .reduce((n, t) => n + estimateTurnTokens(t), 0)
                    const note = compactResultNotice({
                      after: res.usage.promptTokens + res.usage.completionTokens,
                      contextWindow: profile.context,
                      bodyTokensAfter: bodyTokens,
                      droppedCount: awaited.droppedCount
                    })
                    if (note !== null) {
                      emit(sender, {
                        sessionId,
                        runId,
                        type: 'run_notice',
                        data: { kind: 'compact', attempt: 0, text: note } satisfies RunNoticeData
                      })
                    }
                  } else if (compactAwait !== null) {
                    // 供应商不报 usage：没法验收，清掉避免跨轮残留（中性气泡已说明压缩生效）
                    compactAwait = null
                  }
                  // 本轮 ttft 结算：先以"当前轮"值强推快照（liveTtftSum 尚不含它），
                  // 再把该轮 ttft 并入累计——下一轮起 pushStats 的 sum 才不丢中间轮。
                  const roundTtft = liveFirstAt !== null ? liveFirstAt - liveReqAt : 0
                  pushStats(roundTtft, true)
                  liveTtftSum += roundTtft
                  // 用量环实时走：每轮真实 usage 到手即推（否则多轮任务中环停在上轮旧值，
                  // 压缩在请求前发生时用户看到「百分比没到就压缩、答完才跳变」）。
                  if (res.usage !== undefined) {
                    emit(sender, { sessionId, runId, type: 'usage', data: res.usage })
                  }
                  // 本轮流式结束：立即清缓冲（工具执行前 UI 先同步，思考块不再延迟 120ms）
                  thinkingT.flush()
                  deltaT.flush()
                  return res
                } catch (err) {
                  // P8-T1 溢出自救：上下文超限（厂商措辞各异，识别见 compact.ts）→
                  // **立刻压缩一次再重试**（整次 run 只给一次，防"压了还超"的死循环）。
                  // 放在重试判断之前：这类错误 kind 是 unknown，不特判就永远不会重试。
                  if (
                    !signal.aborted &&
                    !emitted &&
                    !overflowRecovered &&
                    isContextOverflowError(err)
                  ) {
                    overflowRecovered = true
                    const compacted = await compactOnce(active, true)
                    if (compacted !== null) {
                      active = compacted
                      continue // 用压缩后的视图重试同一轮
                    }
                  }
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
                return handleAskTool(argsJson, requestAsk).then(collectCitations)
              }
              // 登记中间产物：登记表是 per-run 内存态（registry 保持纯静态），
              // 与 ask_user 同款在包装层拦截。只登记意图，不碰文件。
              if (name === 'mark_temp_files') {
                let list: unknown
                try {
                  list = (JSON.parse(argsJson) as { paths?: unknown }).paths
                } catch {
                  return Promise.resolve({
                    ok: false,
                    result: 'mark_temp_files 参数不是合法 JSON。'
                  })
                }
                const paths = Array.isArray(list)
                  ? list.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
                  : []
                if (paths.length === 0) {
                  return Promise.resolve({
                    ok: false,
                    result: 'mark_temp_files 需要 paths 数组（1-10 个要登记的中间产物路径）。'
                  })
                }
                let added = 0
                const names: string[] = []
                for (const raw of paths.slice(0, 10)) {
                  try {
                    const abs = resolveToolPath(raw, sessionWorkspace)
                    if (declaredTempFiles.has(abs)) continue
                    declaredTempFiles.add(abs)
                    added += 1
                    names.push(basename(abs))
                  } catch {
                    // 路径解析不了：跳过（登记失败只是留着文件，不是损失）
                  }
                }
                return Promise.resolve({
                  ok: true,
                  result:
                    added > 0
                      ? `已登记 ${added} 个中间产物（任务正常结束后移入回收站）：${names.join('、')}。`
                      : '这些路径无法登记（可能格式不对），文件保持原样。'
                })
              }
              // 删除文件：回收站调用用了 electron shell（registry 保持无 electron），
              // 与 ask_user 同款在包装层拦截。审批已在 gate 里强制（每次必问，full 除外）。
              if (name === 'delete_file') {
                const raw = extractProducedPath(argsJson)
                if (raw === null) {
                  return Promise.resolve({
                    ok: false,
                    result: 'delete_file 缺少 path 参数（要删除的文件或文件夹路径）。'
                  })
                }
                let abs: string
                try {
                  abs = resolveToolPath(raw, sessionWorkspace)
                } catch (err) {
                  return Promise.resolve({
                    ok: false,
                    result: `删除路径无效：${err instanceof Error ? err.message : String(err)}`
                  })
                }
                return trashToRecycleBin(abs, sessionWorkspace).then((r) => {
                  if (r.ok) {
                    createdFiles.delete(r.path) // 已删，不必再进临时清理候选
                    return { ok: true, result: `已移入回收站（可还原）：${r.path}` }
                  }
                  return { ok: false, result: r.error ?? '移入回收站失败' }
                })
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
                })
                  .then((r) => {
                    appendDebugLog(
                      logsDir(),
                      `[chat] 子任务结束 → ${r.result.split('\n')[0] ?? ''}`
                    )
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
                  .then(collectCitations)
              }
              const options = {
                mode: chatMode,
                workspace: sessionWorkspace,
                out: {} as { diffStat?: { added: number; removed: number }; files?: string[] }
              }
              // write_file 执行前看目标是否已存在（覆写已有文件不进临时清理轨迹）
              const preExisted = targetExistedBefore(name, argsJson)
              return executeToolCall(name, argsJson, signal, sessionId, options)
                .then((result) => {
                  lastDiffStat = options.out.diffStat ?? null
                  lastJsFiles = options.out.files ?? []
                  // 记录新建轨迹（任务末临时清理用；失败不记；覆写不记）
                  if (result.ok) trackCreated(name, argsJson, options.out.files ?? [], preExisted)
                  return result
                })
                .then(collectCitations)
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
            // 上下文压缩（P8-T1）：每轮请求前按**真实 usage**判定是否该压；
            // 压不动/压失败一律原样返回（绝不因压缩中断对话）
            compactView: async (view, info) => {
              const fromUsage =
                info.lastUsage === undefined || info.lastUsage === null
                  ? null
                  : info.lastUsage.promptTokens + info.lastUsage.completionTokens
              // 本轮**第一轮**拿不到 lastUsage（这个 run 还没发过请求）：退到会话存档里
              // 上次请求的真实用量；再没有才用字符估算兜底（估算系统性偏低，只能当最后手段）
              const used =
                fromUsage ??
                (persistedUsage !== null
                  ? persistedUsage.promptTokens + persistedUsage.completionTokens
                  : estimateViewTokens(view))
              if (!shouldCompact({ usedTokens: used, contextWindow: profile.context })) return view
              return (await compactOnce(view, false, used)) ?? view
            },
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
            // 步末清单催办（chat/todo-nudge.ts）；收尾催办 = 清单对账 + 引用护栏聚合
            stepReminder: () => todoNudges.stepReminder(),
            finishReminder,
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
        // 中间产物清理（owner 需求）：只在正常完成、有工具的模式下执行。
        // ★ **删除依据只有"她的显式登记"**（mark_temp_files）——不再猜后缀、更不猜目录名：
        //   两次误删事故（temp 目录里的成果 md、用户要求保留的 旧日志.log）都源于猜测。
        //   planTempCleanup 再过 7 道闸门（登记/不像成果/本轮新建/工作区内/用户没提过/数量/正常收尾），
        //   删除走回收站——即使全错也能还原。任何意外静默，不影响任务结果。
        if (loopResult.stoppedReason === 'completed' && chatMode !== 'chat') {
          try {
            /**
             * 清理结果既推事件、也落盘成一条 notice 消息。
             * 此前只有流式期的临时提示（run_notice 只进内存），刷新/重进会话就消失——
             * 用户看到"她说过要清却没清"时连痕迹都查不到（2026-09-17 实测反馈）。
             * notice 是给用户看的系统通报，projectPersistedHistory 会跳过它，不进 LLM 上下文。
             */
            const emitCleanupNotice = (
              text: string,
              kind: RunNoticeData['kind'] = 'cleanup'
            ): void => {
              const messageId = newPersistedId()
              persistTurns(sessionId, [{ id: messageId, role: 'notice', ts: Date.now(), text }])
              emit(sender, {
                sessionId,
                runId,
                type: 'run_notice',
                data: { kind, attempt: 0, text, messageId } satisfies RunNoticeData
              })
            }
            // 收尾核对：她声称写好的文件是否真的在工作区里（keepme.log 凭空宣称的教训）。
            // **必须在清理之前核对**——登记的中间产物此刻还在，清完再核会误报"找不到"。
            try {
              const todos = readTodos(sessionId)
              const missing = findClaimedButMissing({
                answerText: loopResult.finalText,
                todos: todos?.items ?? [],
                workspace: sessionWorkspace,
                exists: (p) => existsSync(p)
              })
              if (missing.length > 0) {
                emitCleanupNotice(
                  `核对提醒：${missing.map((p) => basename(p)).join('、')} 我这边没在工作区里找到——可能没写成功或已被移走，请你核对一下。`,
                  'verify'
                )
              }
            } catch {
              // 核对是锦上添花：任何意外都静默
            }
            const plan = planTempCleanup({
              declared: [...declaredTempFiles],
              created: [...createdFiles],
              workspace: sessionWorkspace,
              userText: llmText,
              resolveDeclared: (raw) => {
                try {
                  return resolveToolPath(raw, sessionWorkspace)
                } catch {
                  return null
                }
              }
            })
            if (plan.skippedTooMany > 0) {
              emitCleanupNotice(
                `任务结束：登记的中间产物有 ${plan.skippedTooMany} 个，数量偏多没敢自动清理（防误判），都原样保留；确认要清的话告诉我，我逐个删。`
              )
            } else if (plan.files.length > 0 || plan.leftovers.length > 0) {
              const cleaned: string[] = []
              for (const p of plan.files) {
                let isFile = false
                try {
                  isFile = statSync(p).isFile()
                } catch {
                  continue // 已不存在：跳过
                }
                if (!isFile) continue // 目录永不自动删
                const r = await trashToRecycleBin(p, sessionWorkspace)
                if (r.ok) cleaned.push(basename(p))
              }
              const parts: string[] = []
              if (cleaned.length > 0) {
                parts.push(
                  `已把 ${cleaned.length} 个中间产物移入回收站（可还原）：${cleaned.join('、')}`
                )
              }
              if (plan.leftovers.length > 0) {
                // 如实说清"为什么这个还在"——含糊的"未自动清理"会让用户以为清理坏了
                // （2026-09-17 真实反馈：登记了却留在工作区，用户只能自己猜原因）
                const WHY: Record<LeftoverReason, string> = {
                  deliverable: '像是成果类型的文件，没敢动',
                  kept: '你在消息里说要保留它',
                  outside: '在工作区之外'
                }
                const byReason = new Map<LeftoverReason, string[]>()
                for (const item of plan.leftovers) {
                  const names = byReason.get(item.reason) ?? []
                  names.push(basename(item.path))
                  byReason.set(item.reason, names)
                }
                for (const [reason, names] of byReason) {
                  parts.push(`${names.join('、')} 原样保留（${WHY[reason]}）`)
                }
              }
              emitCleanupNotice(`任务结束，${parts.join('；')}。`)
            }
          } catch {
            // 清理是锦上添花：任何意外都静默，不打扰已完成的任务
          }
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
        // 桌宠冒泡：真跑过工具步且正常走完才算"任务完成"（闲聊/max-steps 不算）
        if (loopResult.steps > 0 && loopResult.stoppedReason === 'completed') {
          void notifyBubble('task_done')
        }
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
          // 桌宠冒泡：任务跑到一半失败才提醒（闲聊第一句就报错不算）
          if (live.steps > 0) void notifyBubble('task_fail')
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

  /**
   * 手动压缩（P8-T1）：把该会话"保留窗口之外"的更早对话摘要成一段转述，落盘后
   * **下次请求起生效**（正在跑的那轮不动——中途换视图会让工具配对错乱）。
   * 不做流式推送，直接返回结果文案（一次性动作，UI 用气泡提示即可）。
   */
  ipcMain.handle(
    CHAT_COMPACT,
    async (_event, sessionId: unknown): Promise<{ ok: boolean; message: string }> => {
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { ok: false, message: '会话标识不合法' }
      }
      if (activeBySession.has(sessionId)) {
        return { ok: false, message: '她正在忙这轮任务——等这轮结束后再压缩上下文。' }
      }
      const config = readAppConfig(configDir())
      const profile =
        config.model.profiles.find((p) => p.id === config.model.activeId) ??
        config.model.profiles[0]
      if (profile === undefined || profile.model === '') {
        return { ok: false, message: '当前模型档案还没填模型名，无法生成摘要。' }
      }
      const apiKey = readProfileKey(configDir(), profile.id)
      if (apiKey === null || apiKey === '') {
        return { ok: false, message: `「${profile.name}」还没有配置 API Key，无法生成摘要。` }
      }
      const persisted = loadSessionMessages(sessionsDir(), sessionId)
      if (!persisted.ok) return { ok: false, message: '读不到这个会话的记录。' }
      const view: ChatTurn[] = [
        { role: 'system', content: '' },
        ...trimHistoryForRequest(projectPersistedHistory(persisted.messages), HISTORY_LIMIT)
      ]
      const cut = pickCompactCut(
        view,
        resolveCompactPolicy(profile.context),
        // 手动压缩同样要拿真实用量当尺子：否则"该压"的会话会被字符口径判定成无可压
        persisted.usage === undefined
          ? null
          : persisted.usage.promptTokens + persisted.usage.completionTokens
      )
      if (cut === null) {
        return {
          ok: false,
          message: '这个会话还没有可压缩的内容（更早的部分本来就在保留区内，还没到该压的时候）。'
        }
      }
      const res = await summarizeTurns({
        profile,
        apiKey,
        previous: readCompactSummary(sessionId),
        dropped: cut.dropped
      })
      if (!res.ok) {
        return { ok: false, message: `摘要生成失败：${res.error}` }
      }
      writeCompactSummary(sessionId, res.text)
      // 不报"省下约 N token"：手动压缩发生在请求前，没有压缩后的真实 usage，
      // 折算值在固定开销（人设+工具 schema）占大头时会严重虚高（实测同案）。
      return {
        ok: true,
        message: `已压缩：更早的 ${cut.dropped.length} 条消息折叠成摘要，下次发言起生效；原始记录仍完整保存在会话里。实际占用看压缩后第一次回复的用量环即可。`
      }
    }
  )

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
