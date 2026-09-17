// calculate 求值内核单测（agent/tools/calculate.ts，P7-T2）。
// 覆盖：算术正确性 / 浮点收尾 / 输入归一 / 安全拦截 / 错误收敛。

import { describe, expect, it } from 'vitest'
import { CALC_MAX_LEN, safeCalculate } from '../src/main/agent/tools/calculate'
import { executeToolCall, getLlmTools, isMutatingTool } from '../src/main/agent/tools/registry'

describe('safeCalculate · 算术正确性', () => {
  it('★ 验收用例：3842 的 17.5% × 12.6', () => {
    const r = safeCalculate('3842*0.175*12.6')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBeCloseTo(8471.61, 4)
      expect(r.text).toContain('8471.61')
    }
  })

  it('四则/括号/乘方/取余/优先级', () => {
    expect((safeCalculate('2+3*4') as { value: number }).value).toBe(14)
    expect((safeCalculate('(2+3)*4') as { value: number }).value).toBe(20)
    expect((safeCalculate('2**10') as { value: number }).value).toBe(1024)
    expect((safeCalculate('17%5') as { value: number }).value).toBe(2)
    expect((safeCalculate('-6+2') as { value: number }).value).toBe(-4)
    expect((safeCalculate('2.5e2') as { value: number }).value).toBe(250)
  })

  it('浮点误差压到 12 位有效数字：0.1+0.2=0.3', () => {
    const r = safeCalculate('0.1+0.2')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toBe('计算结果：0.1+0.2 = 0.3')
  })

  it('千位分隔逗号剥掉：3,842*2 = 7684', () => {
    const r = safeCalculate('3,842*2')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe(7684)
      expect(r.text).toContain('3,842*2') // 回显保留用户原样
    }
  })
})

describe('safeCalculate · 安全拦截', () => {
  it('任何标识符都在白名单字符层挡掉（require/process/globalThis/Math/constructor）', () => {
    for (const evil of [
      'process.exit(1)',
      "require('fs')",
      'globalThis',
      'Math.sqrt(4)',
      'this.constructor.constructor("return 1")()',
      'x=1', // 等号/字母 x 都不在白名单
      'while(1){}'
    ]) {
      const r = safeCalculate(evil)
      expect(r.ok, evil).toBe(false)
      if (!r.ok) expect(r.error).toContain('只支持')
    }
  })

  it('空上下文双保险：即使混入标识符，vm 内也拿不到宿主对象', () => {
    // 单独构造一个理论上的逃逸：白名单只放 e/E，故 process 必被前置拦截；
    // 这里验 vm 错误路径本身是收敛的（ReferenceError → 可读文案，不抛异常）
    const r = safeCalculate('e+1') // e 不是科学计数法语境
    expect(r.ok).toBe(false)
  })

  it('除零 / 0 除 0 → 非有限数值，拒绝', () => {
    expect(safeCalculate('1/0').ok).toBe(false)
    expect(safeCalculate('0/0').ok).toBe(false)
  })

  it('语法错误收敛为可读错误', () => {
    expect(safeCalculate('1+').ok).toBe(false)
    expect(safeCalculate('(2+3').ok).toBe(false)
    expect(safeCalculate('*9').ok).toBe(false)
  })

  it('长度上限 500', () => {
    expect(safeCalculate('1'.repeat(CALC_MAX_LEN + 1)).ok).toBe(false)
    // 合法的 499 字表达式（不能用几百位数字字面量——那会溢出成 Infinity）
    const longExpr = `${'1+'.repeat(249)}1`
    expect(longExpr).toHaveLength(499)
    expect(safeCalculate(longExpr).ok).toBe(true)
  })

  it('非字符串 / 空白 / 纯逗号拒绝', () => {
    expect(safeCalculate(123).ok).toBe(false)
    expect(safeCalculate(undefined).ok).toBe(false)
    expect(safeCalculate(null).ok).toBe(false)
    expect(safeCalculate('   ').ok).toBe(false)
    expect(safeCalculate(',').ok).toBe(false)
  })
})

describe('calculate · 注册表接线', () => {
  it('executeToolCall：正常出结果；坏表达式收敛 ok:false', async () => {
    const ok = await executeToolCall(
      'calculate',
      JSON.stringify({ expression: '3842*0.175*12.6' }),
      new AbortController().signal
    )
    expect(ok.ok).toBe(true)
    expect(ok.result).toContain('8471.61')

    const bad = await executeToolCall(
      'calculate',
      JSON.stringify({ expression: 'process.exit()' }),
      new AbortController().signal
    )
    expect(bad.ok).toBe(false)
    expect(bad.result).toContain('只支持')
  })

  it('非 mutating（纯算无副作用，不弹审批）；work/learn 可见、chat 不可见', () => {
    expect(isMutatingTool('calculate')).toBe(false)
    expect(getLlmTools('work').some((t) => t.function.name === 'calculate')).toBe(true)
    expect(getLlmTools('learn').some((t) => t.function.name === 'calculate')).toBe(true)
    expect(getLlmTools('chat').some((t) => t.function.name === 'calculate')).toBe(false)
  })
})
