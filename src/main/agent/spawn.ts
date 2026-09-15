// 子 Agent 运行时。
//
// 形态：spawn_agent 工具派生一个「短命、一次性」的第二 agent 实例（独立 runToolLoop），
// 主循环同步等它干完，把最终报告作为工具结果回灌。关键洞察：主会话本就串行
// （流式期间用户不能发消息），同步阻塞对交互零冲击——无需后台队列/通知/会话切换。
//
// 安全语义（全部宿主侧硬编码，模型不可谈判）：
// - 工具白名单：分身只拿批量活需要的内置工具 + MCP（按主会话模式过滤）；禁嵌套 /
// 禁 undo（撤销权只在用户）/ 禁 skill / 禁屏幕感知；执行期双保险拦截。
// - 门禁完整继承：confirm 按工作区边界；plan → confirm（spawn 随计划获批 ≠ 分身内部
// 写入已获批——审批者只见过 objective 一句话），逐项弹卡并标注「来自子任务」；full 直放。
// - 账本/审批归属主会话：executeTool 由 run.ts 以主会话 sessionId 构建——快照/撤销
// 闭环不被分身破坏，用户在主会话可一键回滚分身的写入。
// - abort 级联：主会话「停止」→ 分身 signal 中止 → 回灌「已中止」。
// - 并发 1：同一时刻全应用最多一个活分身。
//
// 本模块零 electron 依赖（deps 全注入），vitest 直接单测。

import type { ApprovalDecision } from '@shared/protocol'
import type { ChatMode } from '@shared/types'
import { runToolLoop } from '../chat/loop'
import { createToolGate, type PermissionMode } from '../chat/permission'
import type { ChatTurn, LlmTool, StreamChatResult, ToolCallDraft } from '../llm/client'
import { getLlmTools } from './tools/registry'

/** 分身步数上限（主循环 8；分身要干批量活，略宽） */
export const SUB_AGENT_MAX_STEPS = 12

/** 分身可用的内置工具白名单（宿主侧硬编码）。刻意排除：spawn_agent（禁嵌套）、
 * undo_last_change（撤销权只在用户）、skill_use（v1 不给分身技能）、active_window
 * （屏幕感知与分身无关且隐私默认关）。todo_write 会写主会话的任务清单——分身的
 * 执行计划因此直接可见于主会话进度卡（副作用即特性，T3c 实测后复议）。 */
const SUB_BUILTIN_ALLOW: ReadonlySet<string> = new Set([
  'current_time',
  'read_file',
  'list_dir',
  'write_file',
  'edit_file',
  'search_files',
  'fetch_url',
  'search_history',
  'web_search',
  'mkdir',
  'todo_write',
  'note_write',
  'note_read'
])

/** 分身工具放行判定（执行期双保险：清单已过滤，这里拦"模型越权点名"）。
 * MCP 工具已由 getLlmTools 按主会话模式过滤，前缀放行。 */
export function isSubAllowedTool(name: string): boolean {
  if (name.startsWith('mcp__')) return true
  return SUB_BUILTIN_ALLOW.has(name)
}

/** 从任意工具清单（getLlmTools 的产物形状）过滤出分身可用集。 */
export function filterSubTools<T extends { function: { name: string } }>(tools: T[]): T[] {
  return tools.filter((t) => isSubAllowedTool(t.function.name))
}

/** 分身 LLM 工具清单：主会话模式的全量清单 ∩ 分身白名单。 */
export function getSubLlmTools(mode: ChatMode): LlmTool[] {
  return filterSubTools(getLlmTools(mode))
}

/** plan 模式映射：spawn 随计划获批 ≠ 分身内部写入已获批——
 * 分身内部按 confirm 逐项把关（工作区内直放、越界弹卡），卡片标注「来自子任务」。 */
export function effectiveSubMode(mode: PermissionMode): PermissionMode {
  return mode === 'plan' ? 'confirm' : mode
}

export type SubAgentStatus = 'completed' | 'failed' | 'aborted' | 'budget-exhausted'

export interface SubAgentOutcome {
  agentId: string
  status: SubAgentStatus
  report: string
  rounds: number
  steps: number
  ms: number
  inputTok: number
  outputTok: number
  /** 完整消息序列 */
  messages?: ChatTurn[]
}

/** 分身事件类型（protocol.ts StreamEventType 只增的三种） */
export type SubAgentEventType = 'agent_started' | 'agent_progress' | 'agent_finished'

export interface SubAgentDeps {
  /** 分身专属 LLM 调用（run.ts 构建：主会话档案 + getSubLlmTools 工具集，不流式） */
  call: (messages: ChatTurn[], signal: AbortSignal) => Promise<StreamChatResult>
  /** 工具执行（run.ts 构建：已绑主会话 sessionId + mode + workspace——账本归主会话） */
  executeTool: (
    name: string,
    argsJson: string,
    signal: AbortSignal
  ) => Promise<{ ok: boolean; result: string }>
  /** 主会话审批入口（本模块包装 reason 前缀「来自子任务」） */
  requestApproval: (
    kind: 'tool' | 'plan',
    calls: ToolCallDraft[],
    reason?: string
  ) => Promise<ApprovalDecision>
  /** 主会话权限模式（内部经 effectiveSubMode 映射） */
  parentMode: PermissionMode
  /** 主会话绑定工作区（门禁边界；null = 未绑定） */
  workspace: string | null
  /** 主会话 id（门禁会话记忆归属；账本归属由 executeTool 的绑定保证） */
  sessionId: string
  /** 主循环 signal：分身 signal 由它派生，主会话停止即级联中止 */
  parentSignal: AbortSignal
  /** 事件上报（run.ts 包装成 CHAT_STREAM 推送；T3b 渲染子任务卡） */
  emit: (type: SubAgentEventType, data: unknown) => void
}

/** 分身系统提示 + 任务消息。objective 必须自包含（分身看不到主会话）。 */
export function buildSubAgentMessages(
  objective: string,
  opts: { context?: string; reportFocus?: string; workspace?: string | null } = {}
): ChatTurn[] {
  const { workspace } = opts
  const sys: string[] = [
    '你是主对话派出的任务分身：一次性执行者，独立完成交办的任务。',
    '你的对话过程用户看不到，用户只会读你的【最终报告】。',
    '报告要求：结论先行，随后给关键证据（文件路径/数据）；报告可能被截断，重要信息必须放在最前面；没完成的要点要明确说「未完成」。',
    '边界：你没有 spawn_agent（分身不能再派分身）、没有撤销工具（撤销权在用户手里）、没有屏幕感知与技能系统。',
    '只做任务要求的事：不要为了「验证」而做额外的写入或探测（例如写探针文件测可写性）——任务没让你改的东西一个字节都不要动；无法完成时在报告里说明原因即可。',
    workspace !== null && workspace !== undefined
      ? `相对路径以当前工作区「${workspace}」为基准。`
      : '当前没有绑定工作区：相对路径以应用目录为基准；工作区外的写入会弹审批。'
  ]
  const user: string[] = [`任务目标：${objective}`]
  if (opts.context !== undefined) user.push(`背景与约束：${opts.context}`)
  if (opts.reportFocus !== undefined) user.push(`报告侧重：${opts.reportFocus}`)
  return [
    { role: 'system', content: sys.join('\n') },
    { role: 'user', content: user.join('\n') }
  ]
}

const STATUS_LABEL: Record<SubAgentStatus, string> = {
  completed: '完成',
  failed: '失败',
  aborted: '已中止',
  'budget-exhausted': '步数用尽'
}

/** 工具结果文本（回灌主循环；报告由主循环既有 8000 字符管线截断）。 */
export function formatSubAgentResult(o: SubAgentOutcome): string {
  return [
    `[分身${STATUS_LABEL[o.status]}] 状态: ${o.status}`,
    `报告: ${o.report}`,
    `统计: ${o.rounds} 轮 / ${o.steps} 步 / ${(o.ms / 1000).toFixed(1)}s`
  ].join('\n')
}

function fallbackReport(status: SubAgentStatus, errText?: string): string {
  if (errText !== undefined) return errText
  switch (status) {
    case 'aborted':
      return '分身已被用户中止。'
    case 'budget-exhausted':
      return '分身在步数上限内未完成目标，也没有产出最终报告。'
    default:
      return '分身结束了任务，但没有留下文字报告。'
  }
}

/** 并发 1：全应用同一时刻最多一个活分身。 */
let liveSubAgents = 0

function nextAgentId(): string {
  return `ag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 跑一个分身到终态。永不抛异常（一切失败都折叠成 outcome）。 */
export async function runSubAgent(
  objective: string,
  opts: { context?: string; reportFocus?: string },
  deps: SubAgentDeps
): Promise<SubAgentOutcome> {
  const agentId = nextAgentId()
  const t0 = Date.now()
  const zero = { rounds: 0, steps: 0, inputTok: 0, outputTok: 0 }
  if (liveSubAgents >= 1) {
    // 并发守卫：不是排队，是明确拒绝——主 agent 应等当前分身结束后再派新任务
    return {
      agentId,
      status: 'failed',
      report: '已有分身运行中，本次派生未执行；请等当前分身结束后再派新任务。',
      ms: 0,
      ...zero
    }
  }
  liveSubAgents += 1
  deps.emit('agent_started', { agentId, objective })
  const controller = new AbortController()
  const onParentAbort = (): void => controller.abort()
  if (deps.parentSignal.aborted) controller.abort()
  else deps.parentSignal.addEventListener('abort', onParentAbort, { once: true })
  try {
    // 审批包装：所有来自分身的审批卡都标注「来自子任务」
    const tag = `来自子任务「${objective.slice(0, 40)}」`
    const requestApproval = (
      kind: 'tool' | 'plan',
      calls: ToolCallDraft[],
      reason?: string
    ): Promise<ApprovalDecision> =>
      deps.requestApproval(kind, calls, reason === undefined ? tag : `${tag} ${reason}`)
    const gate = createToolGate(
      effectiveSubMode(deps.parentMode),
      deps.sessionId,
      requestApproval,
      {
        workspace: deps.workspace
      }
    )
    // 执行期白名单守卫（双保险）：喂给分身的清单已过滤，这里拦"模型越权点名"
    const guardedExec = async (
      name: string,
      argsJson: string,
      signal: AbortSignal
    ): Promise<{ ok: boolean; result: string }> => {
      if (!isSubAllowedTool(name)) {
        return {
          ok: false,
          result: `分身不可用工具 ${name}（不在分身白名单内，请改用其它方式达成目标）。`
        }
      }
      return deps.executeTool(name, argsJson, signal)
    }

    let round = 0
    let step = 0
    let lastTool: string | undefined
    const emitProgress = (): void => {
      deps.emit('agent_progress', { agentId, round, step, lastTool })
    }
    const messages = buildSubAgentMessages(objective, { ...opts, workspace: deps.workspace })
    const res = await runToolLoop(
      messages,
      {
        call: deps.call,
        executeTool: guardedExec,
        beforeTool: gate.beforeTool,
        onToolStart: () => {},
        onToolResult: (tc) => {
          step += 1
          lastTool = tc.name
          emitProgress()
        },
        onStepBoundary: () => {
          round += 1
          emitProgress()
        }
      },
      controller.signal,
      SUB_AGENT_MAX_STEPS
    )
    const status: SubAgentStatus =
      res.stoppedReason === 'completed'
        ? 'completed'
        : res.stoppedReason === 'aborted'
          ? 'aborted'
          : 'budget-exhausted' // max-steps / loop-detected 都是资源上限语义
    const outcome: SubAgentOutcome = {
      agentId,
      status,
      report: res.finalText !== '' ? res.finalText : fallbackReport(status),
      rounds: res.rounds,
      steps: res.steps,
      ms: Date.now() - t0,
      inputTok: res.inputTok,
      outputTok: res.outputTok,
      messages: res.messages // ：执行日志落盘用（run.ts 取走，不进渲染层）
    }
    deps.emit('agent_finished', { ...outcome })
    return outcome
  } catch (err) {
    // 主路径的 abort 常以异常形态冒出（streamChat 的 fetch AbortError 等）——按中止归类
    const aborted = controller.signal.aborted
    const outcome: SubAgentOutcome = {
      agentId,
      status: aborted ? 'aborted' : 'failed',
      report: aborted
        ? fallbackReport('aborted')
        : fallbackReport(
            'failed',
            `分身执行失败：${err instanceof Error ? err.message : String(err)}`
          ),
      ms: Date.now() - t0,
      ...zero
    }
    deps.emit('agent_finished', { ...outcome })
    return outcome
  } finally {
    liveSubAgents -= 1
    deps.parentSignal.removeEventListener('abort', onParentAbort)
  }
}

/** handleSpawnTool 的返回：loop 只消费 ok/result；log 供 run.ts 落执行日志 */
export interface SpawnToolResult {
  ok: boolean
  result: string
  log?: { objective: string; outcome: SubAgentOutcome }
}

/** run.ts 的 executeTool 拦截入口：解析参数 → 跑分身 → 组装回灌文本。永不抛异常。 */
export async function handleSpawnTool(
  argsJson: string,
  deps: SubAgentDeps
): Promise<SpawnToolResult> {
  let args: { objective?: unknown; context?: unknown; report_focus?: unknown }
  try {
    args = JSON.parse(argsJson) as typeof args
  } catch {
    return { ok: false, result: 'spawn_agent 参数不是合法 JSON。' }
  }
  const objective = typeof args.objective === 'string' ? args.objective.trim() : ''
  if (objective === '') {
    return { ok: false, result: 'spawn_agent 缺少必填的 objective（一句话任务目标）。' }
  }
  const context =
    typeof args.context === 'string' && args.context.trim() !== '' ? args.context.trim() : undefined
  const reportFocus =
    typeof args.report_focus === 'string' && args.report_focus.trim() !== ''
      ? args.report_focus.trim()
      : undefined
  const outcome = await runSubAgent(objective, { context, reportFocus }, deps)
  return {
    ok: outcome.status === 'completed',
    result: formatSubAgentResult(outcome),
    // 执行日志载荷：run.ts 取走落 userData/logs/agents/；loop 只读 ok/result
    log: { objective, outcome }
  }
}
