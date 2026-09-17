// OpenAI 兼容系思考强度的「厂商适配器」（P9-T1）。
//
// 为什么需要它（B+甲，owner 拍板）：
// 同一个 OpenAI 兼容壳子下，各家对"思考"的参数表达完全不同——
//   百炼/方舟：顶层 reasoning_effort 七档全收 + 方舟另要 thinking 开关；
//   DeepSeek/Kimi-K3：reasoning_effort 只收 low/high/max；
//   智谱 GLM-5.3：只收 low/high/max，非法枚举直接 400，且必带 thinking.enabled；
//   智谱旧型号/Kimi-K2/MiMo/MiniMax：只有 thinking 开关，没有强度档；
//   通用 OpenAI：只认 low/medium/high。
// 本模块只做三件事（纯数据、纯函数，渲染层与主进程共用）：
//   1) resolveReasoningAdapter：按 baseUrl 宿主识别适配器（可被档案显式覆盖）；
//   2) planAdapterReasoning：我们的六档 → 该厂商请求体片段（折算不报错，折算原因记 note）；
//   3) 给设置页用的能力描述（哪些档会被折算、提示文案）。
// 事实来源：各厂商官方文档（2026-09 核实），链接见 docs/交接 与 DEVLOG。

import type { ReasoningAdapterId, ReasoningEffort } from './types'

/** 厂商思考开关的请求体形状（均为 OpenAI 兼容壳里的非标顶层字段，SDK 原样透传） */
export type ThinkingSwitch = { type: 'enabled' | 'adaptive' | 'disabled' }

export interface AdapterReasoningPlan {
  /** 是否真的注入思考相关字段（default/缺省 = false，跟随端点默认） */
  enabled: boolean
  /** 折算后的内部档位（展示层用；开关型厂商保持用户所选档，靠 folded/note 说明） */
  level: ReasoningEffort
  /** 顶层 reasoning_effort 实际发送值（厂商原字枚举）；undefined = 不发 */
  sentEffort?: string
  /** thinking 开关字段；undefined = 不发 */
  thinking?: ThinkingSwitch
  /** 是否发生了折算/合并（用户选的档 ≠ 厂商实际表达） */
  folded: boolean
  /** 折算/限制的人话说明（无折算为 ''），用于勾选区提示与调档通知 */
  note: string
}

/** 五档（除 default 外） */
const REAL_LEVELS: ReadonlySet<ReasoningEffort> = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

export const ADAPTER_LABELS: Record<ReasoningAdapterId, string> = {
  openai: '通用 OpenAI',
  dashscope: '阿里百炼',
  deepseek: 'DeepSeek',
  zhipu: '智谱 GLM',
  kimi: 'Kimi',
  ark: '豆包 火山方舟',
  mimo: 'MiMo 小米',
  minimax: 'MiniMax'
}

const ADAPTER_VALUES = new Set<ReasoningAdapterId>(
  Object.keys(ADAPTER_LABELS) as ReasoningAdapterId[]
)

/** 白名单校验（sanitize 用）：非合法值一律视为 undefined（=自动识别） */
export function isReasoningAdapterId(v: unknown): v is ReasoningAdapterId {
  return typeof v === 'string' && ADAPTER_VALUES.has(v as ReasoningAdapterId)
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    // 用户可能只填了主机名（无协议），退化为字符串匹配
    return baseUrl
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]
  }
}

/**
 * 识别档案接入端点对应的思考参数风格。
 * 只看 Base URL 宿主，与档案 id/名称/是否内置预设无关（自建档案同样适用）。
 */
export function resolveReasoningAdapter(input: {
  baseUrl: string
  /** 档案里的手动覆盖值（显式选择优先） */
  override?: ReasoningAdapterId
}): ReasoningAdapterId {
  if (input.override !== undefined && isReasoningAdapterId(input.override)) return input.override
  const host = hostOf(input.baseUrl)
  if (host === '') return 'openai'
  // 百炼：新旧 dashscope 域名 + WorkspaceId 专属域名 *.maas.aliyuncs.com（各区域）
  if (
    host === 'dashscope.aliyuncs.com' ||
    host === 'dashscope-intl.aliyuncs.com' ||
    host.endsWith('.maas.aliyuncs.com')
  )
    return 'dashscope'
  if (host === 'api.deepseek.com') return 'deepseek'
  if (host === 'open.bigmodel.cn') return 'zhipu'
  if (host === 'api.moonshot.cn' || host === 'api.moonshot.ai') return 'kimi'
  if (host.endsWith('.volces.com')) return 'ark'
  // MiMo：按量域名 + Token Plan 专属域名（cn/sgp/ams）
  if (host === 'api.xiaomimimo.com' || host.endsWith('.xiaomimimo.com')) return 'mimo'
  if (
    host === 'api.minimax.cn' ||
    host === 'api.minimax.io' ||
    host.endsWith('.minimaxi.com') ||
    host.endsWith('.minimax.io')
  )
    return 'minimax'
  return 'openai'
}

/** 折算结果小工具 */
function fold(
  level: ReasoningEffort,
  sentEffort: string | undefined,
  thinking: ThinkingSwitch | undefined,
  note: string,
  folded: boolean
): AdapterReasoningPlan {
  return {
    enabled: true,
    level,
    ...(sentEffort !== undefined ? { sentEffort } : {}),
    ...(thinking ? { thinking } : {}),
    folded,
    note
  }
}

const SWITCH_ONLY_NOTE: Record<string, string> = {
  zhipu: '该型号的思考只有开/关（thinking 开关），各档位都会以「开启思考」发送，不调节深度',
  kimi: 'Kimi K2 的思考只有开/关（thinking 开关），档位不调节深度；K3 请在模型名填含 k3 的型号',
  mimo: 'MiMo 的思考只有开/关（thinking 开关），档位不调节深度',
  minimax: 'MiniMax 的思考只有开/关（adaptive），档位不调节深度'
}

/**
 * 六档 → 某厂商请求体片段（纯函数）。
 * @param effort 用户档位；undefined/'default' 都按"不注入"处理
 * @param model 模型名（同端点内同族差异用，如 glm-5.3 vs 4.x、kimi-k3 vs k2；空串按旗舰代口径）
 */
export function planAdapterReasoning(input: {
  adapter: ReasoningAdapterId
  effort?: ReasoningEffort
  model?: string
}): AdapterReasoningPlan {
  const { adapter, model } = input
  const effort = input.effort ?? 'default'
  if (effort === 'default' || !REAL_LEVELS.has(effort)) {
    return { enabled: false, level: 'default', folded: false, note: '' }
  }
  const name = (model ?? '').toLowerCase()

  switch (adapter) {
    case 'dashscope':
      // 七档枚举全收（none/minimal/low/medium/high/xhigh/max），五档原值直传
      return fold(effort, effort, undefined, '', false)

    case 'ark':
      // 七档全收；思考开关显式发（Agent 场景官方建议 enabled）
      return fold(effort, effort, { type: 'enabled' }, '', false)

    case 'deepseek': {
      // 官方 Chat：none/low/high/max
      if (effort === 'low') return fold('low', 'low', undefined, '', false)
      if (effort === 'medium')
        return fold('high', 'high', undefined, 'DeepSeek 无中档，已按「高（high）」发送', true)
      if (effort === 'high') return fold('high', 'high', undefined, '', false)
      // xhigh→max 是折算；max→max 值相同无损
      if (effort === 'xhigh')
        return fold('max', 'max', undefined, 'DeepSeek 无超高档，已按「极致（max）」发送', true)
      return fold('max', 'max', undefined, '', false)
    }

    case 'zhipu': {
      const think: ThinkingSwitch = { type: 'enabled' }
      if (/glm[\s-]?5[\s.-]?3/.test(name)) {
        // GLM-5.3：仅 low/high/max，传别的 400
        if (effort === 'low') return fold('low', 'low', think, '', false)
        if (effort === 'medium')
          return fold('high', 'high', think, 'GLM-5.3 只有低/高/极致三档，已按「高」发送', true)
        if (effort === 'high') return fold('high', 'high', think, '', false)
        if (effort === 'xhigh')
          return fold('max', 'max', think, 'GLM-5.3 无超高档，已按「极致（max）」发送', true)
        return fold('max', 'max', think, '', false)
      }
      if (/glm[\s-]?5[\s.-]?2/.test(name)) {
        // GLM-5.2：low/medium 服务端合并为 high，xhigh 映射 max
        if (effort === 'low' || effort === 'medium')
          return fold('high', 'high', think, 'GLM-5.2 的低/中档均按「高」执行', true)
        if (effort === 'high') return fold('high', 'high', think, '', false)
        if (effort === 'xhigh')
          return fold('max', 'max', think, 'GLM-5.2 无超高档，已按「极致（max）」发送', true)
        return fold('max', 'max', think, '', false)
      }
      // GLM-4.x / GLM-5/5.1 / 未填型号：只有 thinking 开关，不发 effort（未填按 5.3 口径提示）
      return fold(effort, undefined, think, SWITCH_ONLY_NOTE.zhipu, true)
    }

    case 'kimi': {
      if (/k3/.test(name)) {
        // K3：low/high/max（默认 max）
        if (effort === 'low') return fold('low', 'low', undefined, '', false)
        if (effort === 'medium')
          return fold('high', 'high', undefined, 'Kimi K3 只有低/高/极致三档，已按「高」发送', true)
        if (effort === 'high') return fold('high', 'high', undefined, '', false)
        if (effort === 'xhigh')
          return fold('max', 'max', undefined, 'Kimi K3 无超高档，已按「极致（max）」发送', true)
        return fold('max', 'max', undefined, '', false)
      }
      // K2/旧 moonshot/未填型号（未填按 K3 口径给 hint 更友好？——保守按开关型，因为 effort 可能被拒）
      return fold(effort, undefined, { type: 'enabled' }, SWITCH_ONLY_NOTE.kimi, true)
    }

    case 'mimo':
      // thinking.type enabled/disabled，默认开；无强度档
      return fold(effort, undefined, { type: 'enabled' }, SWITCH_ONLY_NOTE.mimo, true)

    case 'minimax':
      // thinking.type adaptive/disabled；M3 默认开，M2.x 不可关；无强度档
      return fold(effort, undefined, { type: 'adaptive' }, SWITCH_ONLY_NOTE.minimax, true)

    case 'openai':
    default: {
      // 通用 OpenAI：low/medium/high；超高/极致钳到 high（旧行为，不报错）
      if (effort === 'low' || effort === 'medium' || effort === 'high')
        return fold(effort, effort, undefined, '', false)
      return fold(
        'high',
        'high',
        undefined,
        '通用 OpenAI 端点最高只到「高」，超高/极致已按「高」发送',
        true
      )
    }
  }
}

/**
 * 哪些档位在该适配器（+型号）下会被折算/合并——设置页勾选 chip 变灰用。
 * 判定口径：实际发送值 ≠ 用户所选档（max 原样发 max 不算折算）。
 */
export function adapterFoldedLevels(
  adapter: ReasoningAdapterId,
  model?: string
): ReasoningEffort[] {
  const levels: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
  // 五档原值直传的两家：无折算
  if (adapter === 'dashscope' || adapter === 'ark') return []
  return levels.filter((effort) => {
    const p = planAdapterReasoning({ adapter, effort, model })
    return p.sentEffort !== effort
  })
}

/**
 * 设置页勾选区底部提示（随适配器/型号实时变化）。
 * @param modelEmpty 模型名是否为空（未填时对依赖型号的分支给保守提示）
 */
export function adapterLevelsHint(adapter: ReasoningAdapterId, model?: string): string {
  const name = (model ?? '').trim()
  switch (adapter) {
    case 'dashscope':
      return '阿里百炼：五档原值发送（reasoning_effort），超高/极致可用。'
    case 'ark':
      return '火山方舟：五档原值发送，并显式开启思考（thinking.enabled）。'
    case 'deepseek':
      return 'DeepSeek 官方只收 low/high/max：中档按高发送，超高/极致按 max 发送。'
    case 'zhipu':
      if (name === '') return '智谱：模型名填 glm-5.3 / glm-5.2 可精确折算；未填时只发思考开关。'
      if (/glm[\s-]?5[\s.-]?3/.test(name.toLowerCase()))
        return 'GLM-5.3 只认低/高/极致（其他值会报错），中档按高、超高按极致发送。'
      if (/glm[\s-]?5[\s.-]?2/.test(name.toLowerCase()))
        return 'GLM-5.2：低/中档按高执行，超高按极致发送。'
      return '该型号思考只有开/关，勾选档位都会以「开启思考」发送。'
    case 'kimi':
      if (/k3/.test(name.toLowerCase())) return 'Kimi K3 只认低/高/极致：中档按高、超高按极致发送。'
      if (name === '') return 'Kimi：模型名含 k3 走三档 effort；未填时按 K2 只发思考开关。'
      return '该型号（K2 系）思考只有开/关，档位不调节深度。'
    case 'mimo':
      return 'MiMo 思考只有开/关（thinking 开关），勾选档位都会以「开启思考」发送。'
    case 'minimax':
      return 'MiniMax 思考只有开/关（adaptive），勾选档位都会以「开启思考」发送。'
    case 'openai':
    default:
      return '通用 OpenAI 兼容：最高只到「高」——勾了超高/极致也会在发送时降级为高（不报错）。'
  }
}
