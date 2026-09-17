// ask_user 纯逻辑单测：参数解析规范化 / 答案格式化 / 挂起流程编排。

import { describe, expect, it } from 'vitest'
import { formatAskResult, handleAskTool, parseAskArgs, repairJsonText } from '../src/main/chat/ask'
import type { AskAnswer, AskQuestion } from '../src/shared/protocol'

describe('ask_user · 参数容错（owner 实测：一直调用失败）', () => {
  it('★ 字符串里混入裸 \\r / \\n（模型常见毛病）→ 修复后照样能解析', () => {
    // owner 实测那条：她在思考里都写了"`\r` 混进去了"，而严格 parse 会整条拒绝
    const broken =
      '{"questions":[{"id":"q1","prompt":"要哪一版？\r\n请选一个","type":"single","options":["甲","乙"]}]}'
    const parsed = parseAskArgs(broken)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.questions).toHaveLength(1)
      expect(parsed.questions[0].prompt).toContain('要哪一版？')
      expect(parsed.questions[0].options).toEqual(['甲', '乙'])
    }
  })

  it('裸制表符同样修好；已转义的 \\n 不受影响（不会二次转义）', () => {
    expect(parseAskArgs('{"questions":[{"id":"q1","prompt":"A\tB","type":"text"}]}').ok).toBe(true)
    const parsed = parseAskArgs(
      '{"questions":[{"id":"q1","prompt":"第一行\\n第二行","type":"text"}]}'
    )
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.questions[0].prompt).toBe('第一行\n第二行')
  })

  it('```json 包裹也吃掉（模型偶尔套一层代码块）', () => {
    const wrapped =
      '```json\n{"questions":[{"id":"q1","prompt":"要不要覆盖？","type":"single","options":["要","不要"]}]}\n```'
    expect(parseAskArgs(wrapped).ok).toBe(true)
  })

  it('真·语法错误仍然拒绝，但错误文案给出可执行的下一步', () => {
    const r = parseAskArgs('{"questions":[{"id":"q1"')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('JSON')
  })

  it('repairJsonText 不动合法 JSON（幂等）', () => {
    expect(repairJsonText('{"a":"x","b":1}')).toBe('{"a":"x","b":1}')
    expect(repairJsonText('{"a":"x\\\\y"}')).toBe('{"a":"x\\\\y"}')
  })
})

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
