// 思考强度厂商适配器单测（P9-T1）：
// ① resolveReasoningAdapter 按 Base URL 宿主识别（自建档案/WorkspaceId 专属域名同样命中）；
// ② planAdapterReasoning 六档 → 各厂商请求体片段（折算不报错）；
// ③ foldedLevels / hint 对所有厂商×型号组合不抛错。

import { describe, expect, it } from 'vitest'
import {
  ADAPTER_LABELS,
  adapterFoldedLevels,
  adapterLevelsHint,
  isReasoningAdapterId,
  planAdapterReasoning,
  resolveReasoningAdapter
} from '../src/shared/reasoning-adapters'

describe('reasoning-adapters · 按 Base URL 识别', () => {
  it('阿里百炼：旧域名 / 国际域名 / WorkspaceId 专属 maas 域名都识别为 dashscope', () => {
    expect(
      resolveReasoningAdapter({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' })
    ).toBe('dashscope')
    expect(
      resolveReasoningAdapter({ baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' })
    ).toBe('dashscope')
    // owner 自建档案的真实形态（业务空间专属域名）
    expect(
      resolveReasoningAdapter({
        baseUrl: 'https://ws-x414hiyi2fo1keoi.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
      })
    ).toBe('dashscope')
    expect(
      resolveReasoningAdapter({
        baseUrl: 'https://x.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'
      })
    ).toBe('dashscope')
  })

  it('其余各家官方端点', () => {
    expect(resolveReasoningAdapter({ baseUrl: 'https://api.deepseek.com/v1' })).toBe('deepseek')
    expect(resolveReasoningAdapter({ baseUrl: 'https://open.bigmodel.cn/api/paas/v4' })).toBe(
      'zhipu'
    )
    expect(resolveReasoningAdapter({ baseUrl: 'https://api.moonshot.cn/v1' })).toBe('kimi')
    expect(resolveReasoningAdapter({ baseUrl: 'https://api.moonshot.ai/v1' })).toBe('kimi')
    expect(resolveReasoningAdapter({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' })).toBe(
      'ark'
    )
    expect(resolveReasoningAdapter({ baseUrl: 'https://api.xiaomimimo.com/v1' })).toBe('mimo')
    expect(resolveReasoningAdapter({ baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1' })).toBe(
      'mimo'
    )
    expect(resolveReasoningAdapter({ baseUrl: 'https://api.minimax.cn/v1' })).toBe('minimax')
    expect(resolveReasoningAdapter({ baseUrl: 'https://api.minimax.io/v1' })).toBe('minimax')
  })

  it('未知端点 / 无协议字符串 → 通用 openai；尾斜杠与大小写不影响识别', () => {
    expect(resolveReasoningAdapter({ baseUrl: 'https://one-api.example.com/v1' })).toBe('openai')
    expect(resolveReasoningAdapter({ baseUrl: 'api.deepseek.com/v1/' })).toBe('deepseek')
    expect(resolveReasoningAdapter({ baseUrl: 'https://API.DEEPSEEK.com/v1' })).toBe('deepseek')
    expect(resolveReasoningAdapter({ baseUrl: '' })).toBe('openai')
  })

  it('手动覆盖优先于 URL 识别（中转网关逃生口）', () => {
    expect(
      resolveReasoningAdapter({ baseUrl: 'https://one-api.example.com/v1', override: 'dashscope' })
    ).toBe('dashscope')
    expect(
      resolveReasoningAdapter({ baseUrl: 'https://api.deepseek.com/v1', override: 'openai' })
    ).toBe('openai')
    expect(
      resolveReasoningAdapter({ baseUrl: 'https://api.deepseek.com/v1', override: 'nope' as never })
    ).toBe('deepseek')
  })

  it('白名单校验', () => {
    expect(isReasoningAdapterId('zhipu')).toBe(true)
    expect(isReasoningAdapterId('auto')).toBe(false)
    expect(isReasoningAdapterId(undefined)).toBe(false)
    expect(isReasoningAdapterId(123)).toBe(false)
    expect(Object.keys(ADAPTER_LABELS)).toHaveLength(8)
  })
})

describe('reasoning-adapters · default 不注入', () => {
  it.each(['openai', 'dashscope', 'deepseek', 'zhipu', 'kimi', 'ark', 'mimo', 'minimax'] as const)(
    '%s：default/缺省都不注入任何思考字段',
    (adapter) => {
      for (const effort of [undefined, 'default'] as const) {
        const p = planAdapterReasoning({ adapter, effort })
        expect(p.enabled).toBe(false)
        expect(p.sentEffort).toBeUndefined()
        expect(p.thinking).toBeUndefined()
        expect(p.folded).toBe(false)
      }
    }
  )
})

describe('reasoning-adapters · 各厂商折算', () => {
  it('百炼：五档原值直传，无 thinking、无折算', () => {
    for (const lvl of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const p = planAdapterReasoning({ adapter: 'dashscope', effort: lvl })
      expect(p).toMatchObject({ enabled: true, sentEffort: lvl, folded: false, note: '' })
      expect(p.thinking).toBeUndefined()
    }
  })

  it('方舟：五档原值 + thinking.enabled 开关', () => {
    const p = planAdapterReasoning({ adapter: 'ark', effort: 'max' })
    expect(p.sentEffort).toBe('max')
    expect(p.thinking).toEqual({ type: 'enabled' })
    expect(p.folded).toBe(false)
  })

  it('DeepSeek：low/high 原样，medium→high，xhigh/max→max', () => {
    expect(planAdapterReasoning({ adapter: 'deepseek', effort: 'low' }).sentEffort).toBe('low')
    const medium = planAdapterReasoning({ adapter: 'deepseek', effort: 'medium' })
    expect(medium.sentEffort).toBe('high')
    expect(medium.folded).toBe(true)
    expect(planAdapterReasoning({ adapter: 'deepseek', effort: 'high' }).sentEffort).toBe('high')
    const xhigh = planAdapterReasoning({ adapter: 'deepseek', effort: 'xhigh' })
    expect(xhigh.sentEffort).toBe('max')
    expect(xhigh.folded).toBe(true)
    // 极致→max 值相同，无损：不算折算
    const max = planAdapterReasoning({ adapter: 'deepseek', effort: 'max' })
    expect(max.sentEffort).toBe('max')
    expect(max.folded).toBe(false)
    expect(max.note).toBe('')
  })

  it('智谱 GLM-5.3：仅 low/high/max，medium→high、xhigh→max，且必带 thinking.enabled', () => {
    const opts = { adapter: 'zhipu' as const, model: 'glm-5.3' }
    expect(planAdapterReasoning({ ...opts, effort: 'low' })).toMatchObject({
      sentEffort: 'low',
      thinking: { type: 'enabled' },
      folded: false
    })
    expect(planAdapterReasoning({ ...opts, effort: 'medium' }).sentEffort).toBe('high')
    expect(planAdapterReasoning({ ...opts, effort: 'high' }).sentEffort).toBe('high')
    expect(planAdapterReasoning({ ...opts, effort: 'xhigh' }).sentEffort).toBe('max')
    expect(planAdapterReasoning({ ...opts, effort: 'max' }).sentEffort).toBe('max')
  })

  it('智谱 GL-5.2：low/medium 合并为 high，xhigh→max；型号写法变化也能识别', () => {
    expect(
      planAdapterReasoning({ adapter: 'zhipu', model: 'GLM-5.2', effort: 'low' }).sentEffort
    ).toBe('high')
    expect(
      planAdapterReasoning({ adapter: 'zhipu', model: 'glm5.2', effort: 'medium' }).sentEffort
    ).toBe('high')
    expect(
      planAdapterReasoning({ adapter: 'zhipu', model: 'glm-5.2', effort: 'xhigh' }).sentEffort
    ).toBe('max')
  })

  it('智谱旧型号/未填型号：只发 thinking 开关，不发 effort', () => {
    for (const model of ['glm-4.6', '']) {
      const p = planAdapterReasoning({ adapter: 'zhipu', model, effort: 'max' })
      expect(p.sentEffort).toBeUndefined()
      expect(p.thinking).toEqual({ type: 'enabled' })
      expect(p.folded).toBe(true)
      expect(p.note).not.toBe('')
    }
  })

  it('Kimi K3：low/high/max；K2/空型号只发 thinking.enabled', () => {
    expect(
      planAdapterReasoning({ adapter: 'kimi', model: 'kimi-k3', effort: 'low' }).sentEffort
    ).toBe('low')
    expect(
      planAdapterReasoning({ adapter: 'kimi', model: 'moonshot-k3-128k', effort: 'medium' })
        .sentEffort
    ).toBe('high')
    expect(
      planAdapterReasoning({ adapter: 'kimi', model: 'kimi-k3', effort: 'xhigh' }).sentEffort
    ).toBe('max')
    const k2 = planAdapterReasoning({ adapter: 'kimi', model: 'kimi-k2.6', effort: 'high' })
    expect(k2.sentEffort).toBeUndefined()
    expect(k2.thinking).toEqual({ type: 'enabled' })
    const empty = planAdapterReasoning({ adapter: 'kimi', model: '', effort: 'max' })
    expect(empty.thinking).toEqual({ type: 'enabled' })
    expect(empty.sentEffort).toBeUndefined()
  })

  it('MiMo / MiniMax：只有 thinking 开关（adaptive），五档都不发 effort', () => {
    const mimo = planAdapterReasoning({ adapter: 'mimo', effort: 'xhigh' })
    expect(mimo.sentEffort).toBeUndefined()
    expect(mimo.thinking).toEqual({ type: 'enabled' })
    const mm = planAdapterReasoning({ adapter: 'minimax', effort: 'low' })
    expect(mm.sentEffort).toBeUndefined()
    expect(mm.thinking).toEqual({ type: 'adaptive' })
  })

  it('通用 OpenAI：超高/极致钳到 high', () => {
    expect(planAdapterReasoning({ adapter: 'openai', effort: 'medium' })).toMatchObject({
      sentEffort: 'medium',
      folded: false
    })
    for (const lvl of ['xhigh', 'max'] as const) {
      const p = planAdapterReasoning({ adapter: 'openai', effort: lvl })
      expect(p.sentEffort).toBe('high')
      expect(p.folded).toBe(true)
    }
  })
})

describe('reasoning-adapters · UI 辅助', () => {
  it('foldedLevels：五档直传厂商为空；开关型厂商五档全折', () => {
    expect(adapterFoldedLevels('dashscope')).toEqual([])
    expect(adapterFoldedLevels('ark')).toEqual([])
    expect(adapterFoldedLevels('openai')).toEqual(['xhigh', 'max'])
    expect(adapterFoldedLevels('deepseek')).toEqual(['medium', 'xhigh'])
    expect(adapterFoldedLevels('zhipu', 'glm-5.3')).toEqual(['medium', 'xhigh'])
    expect(adapterFoldedLevels('zhipu', 'glm-5.2')).toContain('low')
    expect(adapterFoldedLevels('zhipu', 'glm-4.6')).toHaveLength(5)
    expect(adapterFoldedLevels('kimi', 'kimi-k3')).toEqual(['medium', 'xhigh'])
    expect(adapterFoldedLevels('mimo')).toHaveLength(5)
    expect(adapterFoldedLevels('minimax')).toHaveLength(5)
  })

  it('hint：所有适配器 × 空/常见型号都返回非空字符串且不抛错', () => {
    for (const id of Object.keys(ADAPTER_LABELS) as (keyof typeof ADAPTER_LABELS)[]) {
      expect(adapterLevelsHint(id, '').length).toBeGreaterThan(0)
      expect(adapterLevelsHint(id, 'some-model').length).toBeGreaterThan(0)
    }
  })
})
