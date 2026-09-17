// 权限门禁。
//
// ── 语义───────────────────────────────────
// 权限管"变更前要不要请示"，不管"读取"——只读工具在任何模式下直接放行。
// 变更类工具**不再一律逐次询问**，而是按「是否越出工作区」判定（详见 approval-policy.ts
// 里对 成熟实现沙箱模型的完整说明）：
//
// confirm（标准）：只读直放；**工作区内的变更直接执行**（变更前有快照可撤销）；
// 越界（工作区外）或未绑定工作区时才弹卡。
// plan（计划） ：本轮出现变更类调用时先出计划，确认后本任务内放开（比 confirm 更严：
// 连工作区内的改动也要先给你看计划）。
// full（完全） ：不挂任何钩子，全部直接执行。
//
// MCP 工具完全不进门禁：接入即信任，边界由该 server 负责。
//
// 依赖注入 requestApproval，无 electron 依赖，vitest 可直接单测。

import {
  approvalTargetPath,
  classifyShellCommand,
  isApprovalExempt,
  isMutatingTool
} from '../agent/tools/registry'
import { decideToolApproval, type ApprovalNeed } from './approval-policy'
import type { ApprovalDecision } from '@shared/protocol'
import type { ToolCallDraft } from '../llm/client'

export type PermissionMode = 'confirm' | 'plan' | 'full'

/**
 * 审批询问入口（run.ts 注入：发 tool_approval_request 事件并挂起等决策）。
 * `reason` 是"为什么问我"，渲染层会展示给用户看。
 */
export type RequestApproval = (
  kind: 'tool' | 'plan',
  calls: ToolCallDraft[],
  reason?: string
) => Promise<ApprovalDecision>

/** 门禁运行所需的会话上下文 */
export interface GateContext {
  /** 会话绑定的工作区绝对路径；null = 未绑定（此时变更类一律询问，fail-closed） */
  workspace: string | null
}

/** "本会话允许此工具"记忆（allow-always）：sessionId → 工具名集合；进程生命周期内有效 */
const sessionAllowedTools = new Map<string, Set<string>>()

/** run_shell 的"本会话允许此命令"记忆（allow-always 收窄：只记命令原文，不是放行任意命令） */
const sessionAllowedCommands = new Map<string, Set<string>>()

/**
 * 当前权限模式。
 *
 * 原实现把模式**在 run 开始时固化**进 gate——用户看到弹卡后切到「完全访问」，
 * 本次 run 里剩下的调用照样被拦，观感就是"这个开关没用"。现在改成**运行期实时取值**：
 * 生产由 index.ts 启动、settings-ipc 保存时同步（与 setScreenEnabled / setMemoryEnabled 同款口径），
 * 判定时现取，运行中切换立即生效。
 *
 * 单测不设值 → 回落 createToolGate 的入参（保持纯函数可测）。
 */
let liveMode: PermissionMode | null = null

export function setPermissionMode(mode: PermissionMode): void {
  liveMode = mode
}

/** 取当前模式；未由生产接线时用 fallback（单测路径） */
export function currentPermissionMode(fallback: PermissionMode): PermissionMode {
  return liveMode ?? fallback
}

/**
 * 算出一次调用的审批需求（门禁与单测共用，避免口径漂移）。
 */
export function approvalNeedOf(tc: ToolCallDraft, ctx: GateContext): ApprovalNeed {
  return decideToolApproval({
    toolName: tc.name,
    mutating: isMutatingTool(tc.name),
    targetPath: approvalTargetPath(tc.name, tc.argsJson, ctx.workspace),
    workspace: ctx.workspace,
    exempt: isApprovalExempt(tc.name)
  })
}

/** 会话级记忆命中？（confirm 模式免问放行的依据；按工具名精确匹配） */
export function isSessionToolAllowed(sessionId: string, toolName: string): boolean {
  return sessionAllowedTools.get(sessionId)?.has(toolName) === true
}

/** 记入会话级允许（allow-always 决策时调用） */
export function allowSessionTool(sessionId: string, toolName: string): void {
  let allowed = sessionAllowedTools.get(sessionId)
  if (allowed === undefined) {
    allowed = new Set<string>()
    sessionAllowedTools.set(sessionId, allowed)
  }
  allowed.add(toolName)
}

/** 清理会话级记忆：会话删除时调用；不传 sessionId 清全部（测试重置用） */
export function clearSessionAllowedTools(sessionId?: string): void {
  if (sessionId === undefined) {
    sessionAllowedTools.clear()
    sessionAllowedCommands.clear()
  } else {
    sessionAllowedTools.delete(sessionId)
    sessionAllowedCommands.delete(sessionId)
  }
}

/** 从 run_shell 调用参数里取命令原文（解析失败返回 null，交由上层 fail-closed） */
function shellCommandOf(argsJson: string): string | null {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>
    return typeof args.command === 'string' && args.command.trim() !== ''
      ? args.command.trim()
      : null
  } catch {
    return null
  }
}

export interface ToolGate {
  /** 计划模式轮级钩子；非 plan 模式为 undefined（循环侧不启用） */
  beforeRound?: (calls: ToolCallDraft[]) => Promise<'go' | 'block'>
  /** 确认模式步级钩子；非 confirm 模式为 undefined（循环侧不启用） */
  beforeTool?: (tc: ToolCallDraft) => Promise<'allow' | 'deny'>
}

/**
 * 按权限模式生成循环审批钩子。
 * - full：两个钩子都缺省——所有工具直接执行。
 * - plan：beforeRound——本轮全为只读（或都是免问工具）时不弹计划；批准后本任务内变更全放行；
 * 计划被拒后（planBlocked）本任务内变更全禁。
 * - confirm：beforeTool——按 approvalNeedOf 判定；需要审批时先查会话记忆，再询问，
 * allow-always 记入会话级记忆。
 */
export function createToolGate(
  mode: PermissionMode,
  sessionId: string,
  requestApproval: RequestApproval,
  ctx: GateContext = { workspace: null }
): ToolGate {
  // 每次判定现取模式（运行中切档立即生效，见 liveMode 的说明）。
  // 注意：**不再在 full 时提前返回空 gate**——那样"从 full 切回 confirm"在本次 run 里
  // 就不会再拦（方向性失效）；现在钩子恒挂，内部按当前模式决定放行，两个方向都对。
  const modeOf = (): PermissionMode => liveMode ?? mode

  if (mode === 'plan') {
    let planApproved = false
    let planBlocked = false
    return {
      beforeRound: async (calls) => {
        // 运行中被切到「完全访问」：不再弹计划
        if (modeOf() === 'full') return 'go'
        // 本轮没有"变更类"调用时不弹计划（权限只管变更；只读与 MCP 工具不惊动用户）
        if (!calls.some((c) => isMutatingTool(c.name))) return 'go'
        if (planApproved) return 'go'
        if (planBlocked) return 'block' // 计划被拒后，本轮任务内变更全禁
        const decision = await requestApproval(
          'plan',
          calls,
          '本轮包含会改动文件的操作，先给你看一下计划。'
        )
        if (decision === 'deny') {
          planBlocked = true
          return 'block'
        }
        planApproved = true
        return 'go'
      }
    }
  }

  // confirm（标准）：按"是否越界"逐次判定
  return {
    beforeTool: async (tc) => {
      // 运行中被切到「完全访问」：剩下的调用全部放行
      if (modeOf() === 'full') return 'allow'
      // run_shell 特判：命令的副作用不由路径表达，"工作区内直放"
      // 语义不适用——allowed 直放；blocked 连问都不问（硬拦截不可审批，放行到执行层拒绝，
      // 那里回灌的"被安全策略拒绝"文案比审批卡更准确）；其余（ask）才弹卡。
      if (tc.name === 'run_shell') {
        const command = shellCommandOf(tc.argsJson)
        const verdict = command === null ? ('ask' as const) : classifyShellCommand(command)
        if (verdict === 'allowed') return 'allow'
        if (verdict === 'blocked') return 'allow' // 不弹卡：执行层直接拒绝并回灌可读原因
        if (command !== null && sessionAllowedCommands.get(sessionId)?.has(command) === true) {
          return 'allow' // "本会话允许"记忆：只对同一条命令原文生效
        }
        const decision = await requestApproval(
          'tool',
          [tc],
          `爱弥斯想执行命令：${command ?? '（参数异常）'}\n白名单外的命令每次执行都需要确认；"本会话允许"只记住这一条命令。`
        )
        if (decision === 'allow-always' && command !== null) {
          let allowed = sessionAllowedCommands.get(sessionId)
          if (allowed === undefined) {
            allowed = new Set<string>()
            sessionAllowedCommands.set(sessionId, allowed)
          }
          allowed.add(command)
          return 'allow'
        }
        return decision === 'allow' ? 'allow' : 'deny'
      }

      const need = approvalNeedOf(tc, ctx)

      // delete_file 特判（owner 硬要求）：除完全访问外**每次删除必弹审批**，
      // 即使在工作区内也不放行；且不记"本会话允许"——allow-always 也只当次有效。
      if (tc.name === 'delete_file') {
        const target = approvalTargetPath(tc.name, tc.argsJson, ctx.workspace)
        const reason =
          `爱弥斯想删除：${target ?? tc.argsJson.slice(0, 80)}\n` +
          '删除会移入回收站（可还原），但按你的设置每次删除都要单独确认；「完全访问」模式下才不再询问。'
        const decision = await requestApproval('tool', [tc], reason)
        return decision === 'allow' || decision === 'allow-always' ? 'allow' : 'deny'
      }

      // 工作区内的变更、只读工具、MCP 工具、豁免工具 → 直接放行
      if (!need.required) return 'allow'
      // "本会话允许此工具"记忆命中 → 放行（用户已明确表示过信任）
      if (isSessionToolAllowed(sessionId, tc.name)) return 'allow'
      const decision = await requestApproval('tool', [tc], need.reason)
      if (decision === 'allow-always') {
        allowSessionTool(sessionId, tc.name)
        return 'allow'
      }
      return decision === 'allow' ? 'allow' : 'deny'
    }
  }
}
