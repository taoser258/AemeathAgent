import { describe, expect, it } from 'vitest'
import { estimateTokens } from '../src/shared/token-estimate'

describe('estimateTokens · 流式 token 实时估算', () => {
  it('空串/纯空白 = 0（含全角空格 U+3000）', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('   \n\t ')).toBe(0)
    expect(estimateTokens('　　')).toBe(0)
  })

  it('CJK 汉字/假名/韩文/全角标点：每字约 1 token', () => {
    expect(estimateTokens('离散数学')).toBe(4)
    expect(estimateTokens('こんにちは')).toBe(5)
    expect(estimateTokens('안녕하세요')).toBe(5)
    expect(estimateTokens('思考：')).toBe(3) // 全角冒号算 1
  })

  it('数学运算符（U+2200 等）走拉丁/符号口径：每 4 字符 1 token', () => {
    // ∀ x ∃ y 四个非空白非 CJK 字符 → ceil(4/4)=1
    expect(estimateTokens('∀x∃y')).toBe(1)
  })

  it('英文：非空白字符约每 4 个 1 token（向上取整，空格不计）', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2) // ceil(5/4)
    expect(estimateTokens('hello world')).toBe(3) // 10 个字母 → ceil(10/4)=3
  })

  it('中英混排分别计数', () => {
    // 「答案是」3 CJK + "abc" 3 拉丁（ceil 3/4=1）= 4
    expect(estimateTokens('答案是 abc')).toBe(4)
  })

  it('markdown / 代码符号计入非 CJK 字符', () => {
    // 「第」「题」2 CJK + 4 星号 + 数字3 共 5 个非 CJK → ceil(5/4)=2，合计 4
    expect(estimateTokens('**第 3 题**')).toBe(4)
    expect(estimateTokens('{}[]()')).toBe(2) // 6 符号 → ceil(6/4)=2
  })

  it('大段中文文本：token 数随字数线性，且明显大于“按 chunk 条数=1”的旧口径', () => {
    const text = '谓词逻辑等值式的证明需要逐步消去量词并保持约束变元一致'.repeat(4)
    const est = estimateTokens(text)
    expect(est).toBeGreaterThan(80)
    // 模拟“整条 SSE delta 一次到达”：旧口径算 1，估算给真实量级
    expect(est / 1).toBeGreaterThan(80)
  })
})
