// 思考强度映射单测（P8-T4）：三协议 × 六档 → 实际参数。
// 守护的核心是**钳制而非报错**：OpenAI 兼容端点表达不了「超高/极致」，
// 我们降级到它最高的「高」并把这件事如实标出来——绝不能因为我们发不出去就拦住整轮对话。

import { describe, expect, it } from 'vitest'
import {
  ANTHROPIC_BUDGETS,
  GEMINI_BUDGETS,
  REASONING_LABELS,
  REASONING_LEVELS,
  clampLevelForProtocol,
  planReasoning,
  protocolMaxLevel,
  reasoningDetail,
  reasoningSummary
} from '../src/shared/reasoning'
import { buildGeminiBody } from '../src/main/llm/gemini'

describe('reasoning · 档位与协议上限', () => {
  it('五档顺序 = 强度顺序；中文名齐全（设置页与滑条共用一份）', () => {
    expect(REASONING_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    for (const l of [...REASONING_LEVELS, 'default'] as const) {
      expect(REASONING_LABELS[l]).toBeTruthy()
    }
    expect(REASONING_LABELS.max).toBe('极致')
  })

  it('协议上限：openai 兼容只到「高」，anthropic/gemini 到「极致」', () => {
    expect(protocolMaxLevel('openai')).toBe('high')
    expect(protocolMaxLevel('anthropic')).toBe('max')
    expect(protocolMaxLevel('gemini')).toBe('max')
  })

  it('钳制：超出的档位降级到该协议最高档（不报错）；合法档位原样放行', () => {
    expect(clampLevelForProtocol('max', 'openai')).toEqual({ level: 'high', clamped: true })
    expect(clampLevelForProtocol('xhigh', 'openai')).toEqual({ level: 'high', clamped: true })
    expect(clampLevelForProtocol('medium', 'openai')).toEqual({ level: 'medium', clamped: false })
    expect(clampLevelForProtocol('max', 'anthropic')).toEqual({ level: 'max', clamped: false })
    expect(clampLevelForProtocol('default', 'openai')).toEqual({ level: 'default', clamped: false })
  })
})

describe('reasoning · 三协议映射表', () => {
  it('default / 缺省 = 不注入任何思考参数', () => {
    for (const protocol of ['openai', 'anthropic', 'gemini'] as const) {
      const p = planReasoning({ protocol })
      expect(p.enabled).toBe(false)
      expect(p.level).toBe('default')
      expect(p.budget).toBeUndefined()
      expect(planReasoning({ protocol, effort: 'default' }).enabled).toBe(false)
    }
  })

  it('openai：只发档位（不发预算），超高/极致被钳到 high', () => {
    expect(planReasoning({ protocol: 'openai', effort: 'medium' })).toEqual({
      level: 'medium',
      clamped: false,
      enabled: true
    })
    const clamped = planReasoning({ protocol: 'openai', effort: 'max' })
    expect(clamped.level).toBe('high')
    expect(clamped.clamped).toBe(true)
    expect(clamped.budget).toBeUndefined()
  })

  it('anthropic：五档预算齐全，max_tokens 未设时按"预算 + 默认输出"给', () => {
    const p = planReasoning({ protocol: 'anthropic', effort: 'max' })
    expect(p.budget).toBe(ANTHROPIC_BUDGETS.max)
    expect(p.enabled).toBe(true)
    expect(p.maxTokens).toBeUndefined() // 未设输出上限 → 不发 max_tokens，走原逻辑
    expect(planReasoning({ protocol: 'anthropic', effort: 'low' }).budget).toBe(4096)
    expect(planReasoning({ protocol: 'anthropic', effort: 'xhigh' }).budget).toBe(32768)
  })

  it('anthropic：输出上限压小预算（max_tokens 必须 > 预算），并标记钳制', () => {
    const p = planReasoning({ protocol: 'anthropic', effort: 'max', maxOutput: 20_000 })
    expect(p.maxTokens).toBe(20_000)
    expect(p.budget).toBe(20_000 - 4096)
    expect(p.clamped).toBe(true)
  })

  it('anthropic：输出上限太小 → 思考开不起来（如实关闭注入，但仍把上限发出去）', () => {
    const p = planReasoning({ protocol: 'anthropic', effort: 'high', maxOutput: 2_000 })
    expect(p.enabled).toBe(false)
    expect(p.budget).toBeUndefined()
    expect(p.maxTokens).toBe(2_000)
    expect(p.clamped).toBe(true)
  })

  it('gemini：五档预算齐全（上限按官方区间取保守值）', () => {
    expect(planReasoning({ protocol: 'gemini', effort: 'low' }).budget).toBe(GEMINI_BUDGETS.low)
    expect(planReasoning({ protocol: 'gemini', effort: 'high' }).budget).toBe(24576)
    expect(planReasoning({ protocol: 'gemini', effort: 'xhigh' }).budget).toBe(24576)
    expect(planReasoning({ protocol: 'gemini', effort: 'max' }).budget).toBe(32768)
  })

  it('P9-T1 厂商适配器：百炼五档直传不钳制；开关型只发 thinking 不发 effort', () => {
    // 百炼 max：通用 openai 会被钳 high，指定 dashscope 后原样 max
    const qwen = planReasoning({ protocol: 'openai', adapter: 'dashscope', effort: 'max' })
    expect(qwen.level).toBe('max')
    expect(qwen.clamped).toBe(false)
    expect(qwen.effort).toBe('max')
    expect(qwen.thinking).toBeUndefined()
    // 方舟：effort 原值 + 显式思考开关
    const ark = planReasoning({ protocol: 'openai', adapter: 'ark', effort: 'high' })
    expect(ark.effort).toBe('high')
    expect(ark.thinking).toEqual({ type: 'enabled' })
    // DeepSeek medium → 实际 high，带折算说明
    const ds = planReasoning({ protocol: 'openai', adapter: 'deepseek', effort: 'medium' })
    expect(ds.effort).toBe('high')
    expect(ds.adapterNote).toContain('DeepSeek')
    // 智谱旧型号：不发 effort，只发开关
    const glm = planReasoning({
      protocol: 'openai',
      adapter: 'zhipu',
      model: 'glm-4.6',
      effort: 'max'
    })
    expect(glm.effort).toBeUndefined()
    expect(glm.thinking).toEqual({ type: 'enabled' })
    // MiniMax：adaptive 开关
    const mm = planReasoning({ protocol: 'openai', adapter: 'minimax', effort: 'low' })
    expect(mm.effort).toBeUndefined()
    expect(mm.thinking).toEqual({ type: 'adaptive' })
  })

  it('P9-T1 default 档：适配器分支也不注入任何字段', () => {
    const p = planReasoning({ protocol: 'openai', adapter: 'ark', effort: 'default' })
    expect(p.enabled).toBe(false)
    expect(p.effort).toBeUndefined()
    expect(p.thinking).toBeUndefined()
  })

  it('输出上限：只有显式设置才作为 maxTokens 透出（缺省保持"不发"）', () => {
    expect(planReasoning({ protocol: 'openai', effort: 'low' }).maxTokens).toBeUndefined()
    expect(planReasoning({ protocol: 'openai', effort: 'low', maxOutput: 8_192 }).maxTokens).toBe(
      8192
    )
    // 脏值（0 / 负数 / 非有限）一律视为未设置
    expect(planReasoning({ protocol: 'openai', maxOutput: 0 }).maxTokens).toBeUndefined()
    expect(planReasoning({ protocol: 'openai', maxOutput: -5 }).maxTokens).toBeUndefined()
    expect(planReasoning({ protocol: 'openai', maxOutput: Number.NaN }).maxTokens).toBeUndefined()
  })

  it('展示文案：带预算的档位把 tokens 也说出来；detail 只给 tokens 部分（防重复拼接）', () => {
    expect(reasoningSummary(planReasoning({ protocol: 'anthropic', effort: 'high' }))).toContain(
      '20,480'
    )
    expect(reasoningSummary(planReasoning({ protocol: 'openai', effort: 'low' }))).toBe('低')
    expect(reasoningSummary(planReasoning({ protocol: 'openai' }))).toContain('不注入')
    // 滑条浮出 = 档位名 + detail：detail 里不能再带档位名（实测踩过「中 · 中 · 10,240 tokens」）
    const anthropic = planReasoning({ protocol: 'anthropic', effort: 'medium' })
    expect(reasoningDetail(anthropic)).toBe('10,240 tokens')
    expect(reasoningDetail(planReasoning({ protocol: 'openai', effort: 'medium' }))).toBe('')
  })
})

describe('reasoning · 接到协议实现上（body 形状）', () => {
  const turns = [{ role: 'user' as const, content: '你好' }]

  it('gemini body：档位 → thinkingConfig.thinkingBudget；缺省不带', () => {
    const on = buildGeminiBody({
      model: 'gemini-2.5-pro',
      temperature: 0.8,
      messages: turns,
      reasoningEffort: 'xhigh'
    })
    expect(on.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 24576 })
    const off = buildGeminiBody({ model: 'g', temperature: 0.8, messages: turns })
    expect(off.generationConfig.thinkingConfig).toBeUndefined()
  })

  it('gemini body：**显式**输出上限才带 maxOutputTokens（默认仍然刻意不带）', () => {
    const withCap = buildGeminiBody({
      model: 'g',
      temperature: 0.8,
      messages: turns,
      maxOutput: 32_000
    })
    expect(withCap.generationConfig.maxOutputTokens).toBe(32000)
    const without = buildGeminiBody({ model: 'g', temperature: 0.8, messages: turns })
    expect(without.generationConfig.maxOutputTokens).toBeUndefined()
  })

  it('gemini：不认识的档位组合也不会抛（钳制兜底）', () => {
    const body = buildGeminiBody({
      model: 'g',
      temperature: 0.8,
      messages: turns,
      reasoningEffort: 'max',
      maxOutput: 4_096
    })
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 32768 })
    expect(body.generationConfig.maxOutputTokens).toBe(4096)
  })
})
