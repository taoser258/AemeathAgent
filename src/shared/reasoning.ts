// 思考强度 → 各协议实际参数的映射（P8-T4）。
//
// 设计取舍（照交接文档-P8 §1.4）：
// ① **表驱动 + 钳制，不报错**：同一个档位在不同协议上能表达的上限不同
//    （OpenAI 兼容端点的 `reasoning_effort` 只认 low/medium/high）。用户在设置里选了
//    「极致」，不能因为我们发不出去就把整轮对话拦下来——**降级到该协议最高档**并在 UI 标注。
// ② 纯函数、可单测：档位 → 预算/上限的换算是最容易"悄悄算错"的地方（错一次就是钱和体验）。
// ③ 与 T1 的教训一致：判定逻辑独立成模块，不许散在三个协议实现里各写一套。

import type { ApiProtocol, ReasoningAdapterId, ReasoningEffort } from '@shared/types'
import { planAdapterReasoning, type ThinkingSwitch } from '@shared/reasoning-adapters'

/** UI 可用档位（顺序即强度顺序）；'default' = 不注入，单独处理 */
export const REASONING_LEVELS: readonly ReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

/** 档位中文名（设置页、右键滑条共用一份，别两处各写一套） */
export const REASONING_LABELS: Record<ReasoningEffort, string> = {
  default: '自动',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '极致'
}

/** Anthropic extended thinking 预算（tokens）；API 要求 ≥1024 */
export const ANTHROPIC_BUDGETS: Record<Exclude<ReasoningEffort, 'default'>, number> = {
  low: 4096,
  medium: 10240,
  high: 20480,
  xhigh: 32768,
  max: 65536
}

/** Gemini 2.5 系 thinkingBudget；上限按官方区间（pro 最高 32768 / flash 24576）取保守值 */
export const GEMINI_BUDGETS: Record<Exclude<ReasoningEffort, 'default'>, number> = {
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 24576,
  max: 32768
}

/** OpenAI 兼容端点的 reasoning_effort 认的档位（更高的档位是 GPT-5 系专有，兼容端点多半不认） */
const OPENAI_LEVELS: readonly ReasoningEffort[] = ['low', 'medium', 'high']

/** 该协议认得的档位表（openai 兼容端点只到「高」；更高的档位是 GPT-5 系专有） */
function allowedLevels(protocol: ApiProtocol): readonly ReasoningEffort[] {
  return protocol === 'openai' ? OPENAI_LEVELS : REASONING_LEVELS
}

/** 该协议能表达的最高档位（设置页用来标注"选「极致」会被降级到…"） */
export function protocolMaxLevel(protocol: ApiProtocol): ReasoningEffort {
  const allowed = allowedLevels(protocol)
  return allowed[allowed.length - 1]
}

/** 把用户选的档位钳到该协议能表达的档位（返回是否发生了钳制） */
export function clampLevelForProtocol(
  level: ReasoningEffort,
  protocol: ApiProtocol
): { level: ReasoningEffort; clamped: boolean } {
  if (level === 'default') return { level, clamped: false }
  const allowed = allowedLevels(protocol)
  if (allowed.includes(level)) return { level, clamped: false }
  return { level: allowed[allowed.length - 1], clamped: true }
}

export interface ReasoningPlan {
  /** 实际要用的档位（可能被钳制）；'default' = 不注入 */
  level: ReasoningEffort
  /** 是否发生了钳制（档位被降级 / 预算被输出上限压小） */
  clamped: boolean
  /** 是否真的注入思考参数（输出上限太小等边界情况下为 false） */
  enabled: boolean
  /** anthropic / gemini：思考预算 tokens */
  budget?: number
  /** 各协议的输出上限（max_tokens / maxOutputTokens）；未设置则为 undefined */
  maxTokens?: number
  /**
   * openai 兼容系（P9-T1）：顶层 reasoning_effort 的实际发送枚举。
   * undefined = 不发该字段（开关型厂商只发 thinking，或通用 openai 回退用 level）。
   */
  effort?: string
  /** openai 兼容系：thinking 开关字段（智谱/方舟/MiMo/MiniMax/K2 等） */
  thinking?: ThinkingSwitch
  /** 厂商内折算/限制的人话说明（'' = 无），用于调档通知 */
  adapterNote?: string
}

/** 思考预算与输出上限之间的安全间距：max_tokens 必须严格大于预算（预算含在 completion 里） */
const ANTHROPIC_BUDGET_HEADROOM = 4096

/**
 * 档位 → 该协议的实际参数（纯函数）。
 * `maxOutput` = 档案里的"输出上限"（未设置 = 不发送该参数，保持各协议原有缺省行为）。
 */
export function planReasoning(input: {
  protocol: ApiProtocol
  effort?: ReasoningEffort
  maxOutput?: number
  /**
   * openai 兼容系的厂商风格（P9-T1）：调用方应先用 resolveReasoningAdapter 按
   * baseUrl+手动覆盖解析好再传入；缺省 = 通用 OpenAI（保持 P8-T4 旧钳制行为）。
   */
  adapter?: ReasoningAdapterId
  /** 模型名（智谱/Kimi 等同端点内按型号折算用） */
  model?: string
}): ReasoningPlan {
  const maxTokens =
    typeof input.maxOutput === 'number' && Number.isFinite(input.maxOutput) && input.maxOutput > 0
      ? Math.floor(input.maxOutput)
      : undefined
  const requested = input.effort ?? 'default'

  if (requested === 'default') {
    return {
      level: 'default',
      clamped: false,
      enabled: false,
      ...(maxTokens !== undefined ? { maxTokens } : {})
    }
  }

  const { level, clamped } = clampLevelForProtocol(requested, input.protocol)

  if (input.protocol === 'anthropic') {
    const wanted = ANTHROPIC_BUDGETS[level as Exclude<ReasoningEffort, 'default'>]
    if (maxTokens === undefined) {
      return { level, clamped, enabled: true, budget: wanted }
    }
    // 输出上限比预算还小 → 思考开不起来（Anthropic 硬约束）：如实关掉注入，仍把上限发出去
    const room = maxTokens - ANTHROPIC_BUDGET_HEADROOM
    if (room < 1024) {
      return { level, clamped: true, enabled: false, maxTokens }
    }
    const budget = Math.min(wanted, room)
    return { level, clamped: clamped || budget !== wanted, enabled: true, budget, maxTokens }
  }

  if (input.protocol === 'gemini') {
    return {
      level,
      clamped,
      enabled: true,
      budget: GEMINI_BUDGETS[level as Exclude<ReasoningEffort, 'default'>],
      ...(maxTokens !== undefined ? { maxTokens } : {})
    }
  }

  // openai 兼容：
  // - 通用 OpenAI（缺省）：保持 P8-T4 行为——只发 reasoning_effort，超高/极致钳到 high，
  //   返回形状不带新字段（旧单测以此精确断言）；
  // - 具体厂商适配器（P9-T1）：按厂商规则产出 sentEffort / thinking / 折算说明。
  if (input.adapter === undefined || input.adapter === 'openai') {
    return {
      level,
      clamped,
      enabled: true,
      ...(maxTokens !== undefined ? { maxTokens } : {})
    }
  }
  const vendor = planAdapterReasoning({
    adapter: input.adapter,
    effort: requested,
    model: input.model
  })
  return {
    level: vendor.level,
    clamped: false, // 厂商内折算不算"协议钳制"，由 adapterNote 如实说明
    enabled: vendor.enabled,
    ...(vendor.sentEffort !== undefined ? { effort: vendor.sentEffort } : {}),
    ...(vendor.thinking ? { thinking: vendor.thinking } : {}),
    ...(vendor.note !== '' ? { adapterNote: vendor.note } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {})
  }
}

/** 档位名 + 预算的展示文案（设置页提示、气泡提示共用） */
export function reasoningSummary(plan: ReasoningPlan): string {
  if (!plan.enabled) return plan.level === 'default' ? '不注入（跟随模型默认）' : '思考已关闭'
  const name = REASONING_LABELS[plan.level]
  if (plan.level === 'default') return '不注入（跟随模型默认）'
  return plan.budget !== undefined ? `${name} · ${plan.budget.toLocaleString()} tokens` : name
}
