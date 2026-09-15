// ask_user 纯逻辑单测：参数解析规范化 / 答案格式化 / 挂起流程编排。

import { describe, expect, it } from 'vitest'
import { formatAskResult, handleAskTool, parseAskArgs } from '../src/main/chat/ask'
import type { AskAnswer, AskQuestion } from '../src/shared/protocol'

describe('parseAskArgs（题目解析与防御规范化）', () => {
  it('合法单选：保留选项与必答缺省', () => {
    const r = parseAskArgs(
      JSON.stringify({
        title: '确认细节',
        questions: [{ id: 'q1', prompt: '要哪种？', type: 'single', options: ['A', 'B'] }]
      })
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.title).toBe('确认细节')
      expect(r.questions).toEqual([
        { id: 'q1', prompt: '要哪种？', type: 'single', options: ['A', 'B'] }
      ])
    }
  })

  it('选择类缺选项 → 退化为 text（比空选项框好）', () => {
    const r = parseAskArgs(JSON.stringify({ questions: [{ id: 'q', prompt: 'p', type: 'multi' }] }))
    expect(r.ok && r.questions[0].type).toBe('text')
  })

  it('非法项静默丢弃：缺 id/prompt/未知 type 的题不进清单', () => {
    const r = parseAskArgs(
      JSON.stringify({
        questions: [
          { id: '', prompt: 'p', type: 'single', options: ['a'] },
          { prompt: 'p', type: 'single', options: ['a'] },
          { id: 'x', prompt: 'p', type: 'dropdown' },
          { id: 'ok', prompt: 'p', type: 'text' }
        ]
      })
    )
    expect(r.ok && r.questions.length).toBe(1)
    expect(r.ok && r.questions[0].id).toBe('ok')
  })

  it('required:false 保留；缺省不带该字段（渲染层按必答处理）', () => {
    const r = parseAskArgs(
      JSON.stringify({
        questions: [
          { id: 'a', prompt: 'p', type: 'text', required: false },
          { id: 'b', prompt: 'p', type: 'text' }
        ]
      })
    )
    expect(r.ok && r.questions[0].required).toBe(false)
    expect(r.ok && r.questions[1].required).toBeUndefined()
  })

  it('超 4 题截断；选项超 6 个截断', () => {
    const qs = Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, prompt: 'p', type: 'text' }))
    const r = parseAskArgs(JSON.stringify({ questions: qs }))
    expect(r.ok && r.questions.length).toBe(4)
    const r2 = parseAskArgs(
      JSON.stringify({
        questions: [
          { id: 'q', prompt: 'p', type: 'single', options: ['1', '2', '3', '4', '5', '6', '7'] }
        ]
      })
    )
    expect(r2.ok && r2.questions[0].options?.length).toBe(6)
  })

  it('坏 JSON / 空 questions / 全非法 → 错误文本（不挂起）', () => {
    expect(parseAskArgs('{oops').ok).toBe(false)
    expect(parseAskArgs('{"questions":[]}').ok).toBe(false)
    expect(parseAskArgs('{"questions":[{"nope":1}]}').ok).toBe(false)
  })
})

describe('formatAskResult（答案回灌文本）', () => {
  const qs: AskQuestion[] = [
    { id: 'a', prompt: '甲？', type: 'single', options: ['x', 'y'] },
    { id: 'b', prompt: '乙？', type: 'multi', options: ['1', '2'] },
    { id: 'c', prompt: '丙？', type: 'text' }
  ]

  it('单值/多值/跳过三种形态都格式化进「用户回答」', () => {
    const answers: AskAnswer[] = [
      { questionId: 'a', value: 'x' },
      { questionId: 'b', value: ['1', '2'] }
    ]
    const text = formatAskResult(qs, answers)
    expect(text).toContain('用户回答')
    expect(text).toContain('甲？ → x')
    expect(text).toContain('乙？ → 1、2')
    expect(text).toContain('丙？ → （跳过）')
  })

  it('空答案 = 被中断 → 明确告知模型未获回答', () => {
    expect(formatAskResult(qs, [])).toContain('未获得回答')
  })
})

describe('handleAskTool（编排：解析→挂起→格式化）', () => {
  it('非法参数不触达 requestAsk', async () => {
    let called = false
    const r = await handleAskTool('nope', async () => {
      called = true
      return []
    })
    expect(r.ok).toBe(false)
    expect(called).toBe(false)
  })

  it('合法参数：requestAsk 收到规范化题目，答案转文本回灌', async () => {
    let seen: AskQuestion[] | null = null
    const r = await handleAskTool(
      JSON.stringify({
        questions: [{ id: 'q1', prompt: '选哪个？', type: 'single', options: ['A', 'B'] }]
      }),
      async (_title, questions) => {
        seen = questions
        return [{ questionId: 'q1', value: 'A' }]
      }
    )
    expect(r.ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(r.result).toContain('选哪个？ → A')
  })
})
