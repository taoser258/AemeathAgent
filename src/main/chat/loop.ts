// harness 主循环：LLM ←→ 工具的"递纸条循环"。
// 设计要点：依赖注入无 electron 依赖（vitest 可直接单测）、轮次预算防失控、
// 同签名连打熔断防死循环、abort 贯穿全循环、步边界回调供落盘（checkpoint 打底）。
// P5 补丁：轮次预算分「段」——撞到段预算且模型还在做工时
// 自动续跑（对齐 成熟实现的「步数不是错误」），只有续跑额度用完才停并留断点。
// 市面同款骨架（成熟 Agent / Codex CLI）：
// 推理 → 响应含工具调用？→ 是：执行→结果回灌→再推理（≤maxSteps）／否：最终回答。

import type { ChatTurn, StreamChatResult, ToolCallDraft } from '../llm/client'
import { pruneToolResults } from './history'
import type { ToolExecStatus } from '@shared/protocol'
import type { TokenUsage } from '@shared/types'

/** 工具结果回灌给 LLM 的最大长度（超出截断加标记，防止一口吃穿上下文预算） */
const TOOL_RESULT_MAX_CHARS = 8000
/** 同一签名（工具名+参数）连续出现的熔断阈值 */
const SAME_CALL_BREAKER = 3
/** 输出被 max_tokens 截断时最多续写几次（截断不算完成，接着说） */
const MAX_LENGTH_CONTINUES = 3

/**
 * 轮次预算。
 *
 * 对齐 成熟 Agent 实现 的做法：
 * - 成熟实现的核心 ReactLoopAgent 本身**没有 maxSteps**，「步数用完」不是错误而是「模型还欠一个
 * 回复」的协议信号（step() 返回 null = tools 跑完了但模型还要接着说）；
 * - 轮次上限在配置层（goal: max-rounds 15 / max-steps-per-round 10），
 * 且社区插件（loop-continue）专门在回合被中断时自动续跑同一回合。
 *
 * 所以这里把「硬上限」拆成两层：
 * ① roundsPerSegment：单段预算。撞到不中断——若模型确实在做工（本轮有工具调用），
 * 注入一条内部续跑提示，开始新一段接着干（用户无感，只看到一行淡色说明）；
 * ② maxAutoContinues：自动续跑段数上限。用完才真的停下并留断点（硬顶 = 20×4 = 80 轮）。
 */
export interface ToolLoopLimits {
  roundsPerSegment: number
  maxAutoContinues: number
}

export const DEFAULT_TOOL_LOOP_LIMITS: ToolLoopLimits = {
  roundsPerSegment: 20,
  maxAutoContinues: 3
}

/**
 * 预算参数。给数字 = **老口径的硬轮次上限**（不分段、不续跑，单测与子代理沿用：
 * 第 N 轮的工具不再执行）；给对象 = 分段 + 自动续跑。
 */
export type ToolLoopBudget = number | ToolLoopLimits

/** 续跑提示（内部 turn，不进 onStepBoundary → UI 不会冒出假的用户气泡） */
const CONTINUE_HINT =
  '（系统提示：本轮步数预算用完了，但任务还没结束。请接着上一步继续推进——' +
  '不要重述已完成的部分、不要重新开始，全部做完后再给用户最终汇报。）'
/** 截断续写提示（对齐 成熟实现：max-tokens 先于「完成」判定，半截回答不算完成） */
const LENGTH_HINT =
  '（系统提示：你上一条回复因长度上限被截断了。请紧接着没写完的地方继续写，' +
  '不要重复已经写过的内容，也不要重新开头。）'

export interface ToolLoopDeps {
  /** 一次 LLM 流式调用（client.streamChat 的包装，含 tools 参数） */
  call: (messages: ChatTurn[], signal: AbortSignal) => Promise<StreamChatResult>
  /** 执行一个工具调用（registry.executeToolCall 的包装，永不抛异常） */
  executeTool: (
    name: string,
    argsJson: string,
    signal: AbortSignal
  ) => Promise<{ ok: boolean; result: string }>
  /**
   * 轮级审批钩子：本轮全部工具调用执行前询问一次。
   * 'go' = 本轮放行；'block' = 本轮全部拒绝（逐个回灌"用户未批准"结果，不执行）。
   * 缺省 = 不启用轮级审批。
   */
  beforeRound?: (calls: ToolCallDraft[]) => Promise<'go' | 'block'>
  /**
   * 步级审批钩子：单个工具执行前询问。
   * 'deny' 时该调用不执行，回灌"用户拒绝"结果。缺省 = 不启用步级审批。
   */
  beforeTool?: (tc: ToolCallDraft) => Promise<'allow' | 'deny'>
  /**
   * 步末临时提醒（**不落盘**，只进下一次请求）：返回非空则作为内部 user turn 注入。
   * 用途：任务清单陈旧时催她"先更新清单再做下一步"。
   * 提示词层约束实测无效（她攒到最后一起交），只能在 harness 层催。
   */
  stepReminder?: () => string | null
  /**
   * 收尾前临时提醒（**不落盘**）：返回非空则**不结束本轮**，注入后继续——每次 run 只给一次。
   * 用途：清单还有做完却没打勾的项就收尾时，催她先同步清单再汇报。
   */
  finishReminder?: () => string | null
  /** 事件：即将执行工具 */
  onToolStart: (tc: ToolCallDraft) => void
  /** 事件：工具执行完毕（resultPreview 仅展示用，已截断）；status 缺省按 ok 推导 */
  onToolResult: (
    tc: ToolCallDraft,
    ok: boolean,
    resultPreview: string,
    durationMs: number,
    status?: ToolExecStatus
  ) => void
  /**
   * 工作中插话（steering）：取走并清空排队的用户消息（调用方负责落盘）。
   * 每轮 LLM 调用前消费——不打断当前步，让模型带着新信息继续。
   */
  drainNudges?: () => string[]
  /**
   * 引擎侧状态提示：自动续跑 / 连接重试这类「引擎自己在做事」的说明。
   * 渲染层在流式气泡下显示一行淡色文字——：不要光闪图标，说清正在干嘛。
   */
  onNotice?: (notice: { kind: 'auto-continue' | 'retry'; text: string; attempt: number }) => void
  /** 步边界：本轮 assistant(+toolCalls) 与全部 tool 结果 turns 已就绪，调用方可落盘。
   * thinking = 本步模型的思考全文。
   * 此前只有最终步的思考被持久化，中间步思考全丢——历史回看时只剩堆叠的工具卡。 */
  onStepBoundary: (turns: ChatTurn[], thinking: string) => void
}

export type ToolLoopStopReason = 'completed' | 'max-steps' | 'loop-detected' | 'aborted'

export interface ToolLoopResult {
  /** 最后一轮的模型文本（completed 时即最终回答；其余情况可能为空） */
  finalText: string
  /** LLM 调用次数 */
  rounds: number
  /** 工具执行次数 */
  steps: number
  /** 工具累计耗时 ms */
  toolMs: number
  /** LLM 请求累计耗时 ms */
  llmMs: number
  /** token 用量累计（跨多轮求和） */
  inputTok: number
  outputTok: number
  ttftMsLast: number
  ttftMsSum: number
  tpsLast: number
  cachedTok: number
  cacheKnown: boolean
  /** 最后一次调用的 usage */
  usage?: TokenUsage
  /** 最终回答轮的模型思考 */
  finalThinking: string
  stoppedReason: ToolLoopStopReason
  /** 自动续跑次数 */
  autoContinues: number
  /** 循环结束后的完整消息序列（含新增 assistant / tool turns） */
  messages: ChatTurn[]
}

/**
 * 跑一次工具循环。messages 会被原位追加（assistant / tool turns），
 * 返回后的序列可直接用于下一次调用或持久化投影。
 */
export async function runToolLoop(
  messages: ChatTurn[],
  deps: ToolLoopDeps,
  signal: AbortSignal,
  budget: ToolLoopBudget = DEFAULT_TOOL_LOOP_LIMITS
): Promise<ToolLoopResult> {
  // 老口径（数字）= 一段就是全部且不续跑，行为与此前完全一致（单测/子代理依赖）
  const limits: ToolLoopLimits =
    typeof budget === 'number' ? { roundsPerSegment: budget, maxAutoContinues: 0 } : budget
  const generous = limits.maxAutoContinues > 0
  const acc = {
    rounds: 0,
    steps: 0,
    toolMs: 0,
    llmMs: 0,
    inputTok: 0,
    outputTok: 0,
    ttftMsLast: 0,
    ttftMsSum: 0,
    tpsLast: 0,
    cachedTok: 0,
    cacheKnown: false
  }
  let usage: TokenUsage | undefined
  let finalText = ''
  let finalThinking = ''
  let stopped: ToolLoopStopReason = 'completed'
  // 死循环熔断：记录上一轮的工具签名串，连续 SAME_CALL_BREAKER 轮相同则中止
  let lastRoundSig = ''
  let sigRepeat = 0
  // 空收尾重试：有些模型交完工具后只吐思考、正文为空 → 用户看不到汇报。
  // 检测到「有工具动作但正文空」时，注入一条内部催办 user turn 再要一次汇报（仅一次）。
  let emptyRetried = false
  // 收尾前清单催办：清单陈旧（做完没打勾）就再要一轮，仅一次
  let finishReminded = false
  // 分段预算：段起点轮次 + 已用续跑段数 + 截断续写次数
  let segmentStart = 0
  let autoContinues = 0
  let lengthContinues = 0

  while (true) {
    // 每轮开始前消费插话（steering）：作为 user turn 注入，模型下一轮就能看到
    const pendingNudges = deps.drainNudges?.() ?? []
    for (const text of pendingNudges) {
      messages.push({ role: 'user', content: text })
    }

    // 工具结果裁剪（result-pruner 同款）：请求侧投影，落盘仍是全文——
    // messages 原位累积不动，这里只把超长 tool 结果裁成头+尾再发给模型
    const res = await deps.call(pruneToolResults(messages), signal)
    acc.rounds += 1
    acc.llmMs += res.totalMs
    acc.ttftMsLast = res.ttftMs
    acc.ttftMsSum += res.ttftMs
    acc.tpsLast = res.tokPerS
    acc.inputTok += res.usage?.promptTokens ?? 0
    acc.outputTok += res.usage?.completionTokens ?? 0
    if (res.cachedTokens !== undefined) {
      acc.cachedTok += res.cachedTokens
      acc.cacheKnown = true
    }
    usage = res.usage ?? usage

    // 没有工具调用 = 模型认为任务完成（或被中断掐断）。
    // 但若此刻有插话排队：不算完成——注入插话后继续循环，让她回应插话（steering 语义）。
    if (res.toolCalls.length === 0 || signal.aborted) {
      const lateNudges = signal.aborted ? [] : (deps.drainNudges?.() ?? [])
      if (lateNudges.length > 0) {
        for (const text of lateNudges) {
          messages.push({ role: 'user', content: text })
        }
        continue
      }
      // 输出被 max_tokens 截断（对齐 成熟实现：max-tokens 判定先于「完成」）：
      // 半截回答不算完成——把她已写的内容作为 assistant turn 入列（免得重复写一遍），
      // 再要一次续写。这条路径不进 onStepBoundary，UI 里是同一条气泡接着往后写。
      if (
        !signal.aborted &&
        res.finishReason === 'length' &&
        res.text.trim() !== '' &&
        lengthContinues < MAX_LENGTH_CONTINUES
      ) {
        lengthContinues += 1
        messages.push({ role: 'assistant', content: res.text })
        messages.push({ role: 'user', content: LENGTH_HINT })
        deps.onNotice?.({
          kind: 'auto-continue',
          attempt: lengthContinues,
          text: '回答被长度上限截断，正在接着往下写…'
        })
        continue
      }
      // 空收尾：非中断、正文空、但这轮之前确实做过工具（steps>0）、且还没催过 →
      // 注入一条内部催办 user turn 再要一次汇报。这条 user turn 不进 onStepBoundary
      // 的落盘批次，故不会在 UI 里冒出一个假的用户气泡。
      if (
        !signal.aborted &&
        res.text.trim() === '' &&
        acc.steps > 0 &&
        !emptyRetried &&
        acc.rounds < limits.roundsPerSegment * (limits.maxAutoContinues + 1)
      ) {
        emptyRetried = true
        messages.push({
          role: 'user',
          content:
            '（系统提示：你刚才执行了操作但没留下给用户的正文回复。请用一到三句话，' +
            '用爱弥斯的口吻把已完成的工作和结果简要汇报给用户，不要再调用工具。）'
        })
        continue
      }
      // 收尾前的清单催办：清单与进度对不上却要收尾时，先催她同步。
      // 与上面两条一样是"内部 user turn"，不进 onStepBoundary 的落盘批次，
      // 所以 UI 里不会冒出假的用户气泡。只给一次，避免与模型来回拉扯。
      if (!signal.aborted && !finishReminded) {
        const note = deps.finishReminder?.() ?? null
        if (note !== null && note !== '') {
          finishReminded = true
          messages.push({ role: 'user', content: note })
          continue
        }
      }
      finalText = res.text
      finalThinking = res.thinking ?? ''
      stopped = signal.aborted ? 'aborted' : 'completed'
      break
    }

    // 本轮 assistant 消息（正文可能为空：模型只发起工具不说话）
    const assistantTurn: ChatTurn = {
      role: 'assistant',
      content: res.text === '' ? null : res.text,
      tool_calls: res.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.argsJson }
      }))
    }
    messages.push(assistantTurn)

    // 死循环熔断：连续多轮完全相同的调用签名
    const roundSig = res.toolCalls.map((tc) => `${tc.name}:${tc.argsJson}`).join('|')
    sigRepeat = roundSig === lastRoundSig ? sigRepeat + 1 : 1
    lastRoundSig = roundSig
    if (sigRepeat >= SAME_CALL_BREAKER) {
      stopped = 'loop-detected'
      break
    }
    // 步数上限（老口径 maxAutoContinues=0：段起点即硬上限，本轮工具不再执行；
    // 单测与子代理沿用此行为）。分段模式不在这里掐——见本轮工具执行后的续跑判定。
    if (!generous && acc.rounds - segmentStart >= limits.roundsPerSegment) {
      stopped = 'max-steps'
      break
    }

    // 轮级审批（计划模式）：整批调用一次询问；'block' = 全部拒绝不执行
    if (deps.beforeRound !== undefined) {
      const verdict = await deps.beforeRound(res.toolCalls)
      if (verdict === 'block') {
        const boundaryTurns: ChatTurn[] = [assistantTurn]
        for (const tc of res.toolCalls) {
          const toolTurn: ChatTurn = {
            role: 'tool',
            tool_call_id: tc.id,
            content: '用户未批准本轮执行计划：请不要调用工具，直接基于已有信息回答用户。'
          }
          messages.push(toolTurn)
          boundaryTurns.push(toolTurn)
        }
        deps.onStepBoundary(boundaryTurns, res.thinking ?? '')
        if (signal.aborted) {
          stopped = 'aborted'
          finalText = res.text
          break
        }
        continue
      }
    }

    // 逐个执行本轮工具（串行：只读工具都是毫秒级，串行简单可调试）
    const boundaryTurns: ChatTurn[] = [assistantTurn]
    for (const tc of res.toolCalls) {
      if (signal.aborted) break
      // 步级审批（确认模式）：单次调用前询问；拒绝则回灌结果让模型调整
      if (deps.beforeTool !== undefined) {
        const verdict = await deps.beforeTool(tc)
        if (verdict === 'deny') {
          const toolTurn: ChatTurn = {
            role: 'tool',
            tool_call_id: tc.id,
            content: '用户拒绝了这次工具调用：请尊重用户的决定，换别的方式或直接回答。'
          }
          messages.push(toolTurn)
          boundaryTurns.push(toolTurn)
          // ：拒绝也产生结果事件（denied 态），工具卡片有完整生命周期
          deps.onToolResult(tc, false, '用户拒绝了这次调用', 0, 'denied')
          continue
        }
      }
      deps.onToolStart(tc)
      const started = Date.now()
      const r = await deps.executeTool(tc.name, tc.argsJson, signal)
      const durationMs = Date.now() - started
      acc.steps += 1
      acc.toolMs += durationMs
      const truncated =
        r.result.length > TOOL_RESULT_MAX_CHARS
          ? `${r.result.slice(0, TOOL_RESULT_MAX_CHARS)}\n…[结果过长已截断]`
          : r.result
      deps.onToolResult(tc, r.ok, truncated.slice(0, 200), durationMs)
      const toolTurn: ChatTurn = { role: 'tool', tool_call_id: tc.id, content: truncated }
      messages.push(toolTurn)
      boundaryTurns.push(toolTurn)
    }
    deps.onStepBoundary(boundaryTurns, res.thinking ?? '')

    // 步末清单提醒：这一步推进了任务但清单还停在旧状态 →
    // 注入内部提示，催她先 todo_write 一次再继续。清单在界面上实时显示，用户正盯着它看。
    const stepNote = deps.stepReminder?.() ?? null
    if (stepNote !== null && stepNote !== '') {
      messages.push({ role: 'user', content: stepNote })
    }

    if (signal.aborted) {
      stopped = 'aborted'
      finalText = res.text
      break
    }

    // 分段预算：本轮工具已全部执行、消息序列合法（assistant+tool 成对），
    // 此时才判段预算——撞到就自动续跑一段（注入内部提示后 continue），而不是把用户
    // 晾在「未完成的任务」横幅前。续跑额度用完才真的停（留断点，可手动接着跑）。
    if (generous && acc.rounds - segmentStart >= limits.roundsPerSegment) {
      if (autoContinues < limits.maxAutoContinues) {
        autoContinues += 1
        segmentStart = acc.rounds
        deps.onNotice?.({
          kind: 'auto-continue',
          attempt: autoContinues,
          text: `已完成 ${acc.steps} 步，任务还没结束——正在自动接着做（第 ${autoContinues + 1} 段）`
        })
        messages.push({ role: 'user', content: CONTINUE_HINT })
        continue
      }
      stopped = 'max-steps'
      break
    }
  }

  return {
    finalText,
    finalThinking,
    rounds: acc.rounds,
    steps: acc.steps,
    toolMs: acc.toolMs,
    llmMs: acc.llmMs,
    inputTok: acc.inputTok,
    outputTok: acc.outputTok,
    ttftMsLast: acc.ttftMsLast,
    ttftMsSum: acc.ttftMsSum,
    tpsLast: acc.tpsLast,
    cachedTok: acc.cachedTok,
    cacheKnown: acc.cacheKnown,
    usage,
    stoppedReason: stopped,
    autoContinues,
    messages
  }
}
