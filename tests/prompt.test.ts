// buildSystemPrompt（纯函数）与 persona 加载器的测试。

import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  buildLearnAppendix,
  buildPlanAppendix,
  buildRuntimeAppendix,
  buildSystemPrompt,
  buildWorkflowAppendix,
  PROMPT_SEPARATOR
} from '../src/main/agent/prompt'
import { listPersonas, loadPersona } from '../src/main/agent/persona'

const FIXTURES = join(__dirname, 'fixtures', 'personas')

describe('agent/prompt · buildSystemPrompt 组装', () => {
  const persona = { soul: 'SOUL 部分', style: 'STYLE 部分' }

  it('顺序固定：soul → style → 运行时附录，段间有分隔线', () => {
    const prompt = buildSystemPrompt(persona, { now: new Date('2026-09-06T18:00:00') })
    const segments = prompt.split(PROMPT_SEPARATOR)
    expect(segments).toHaveLength(3)
    expect(segments[0]).toBe('SOUL 部分')
    expect(segments[1]).toBe('STYLE 部分')
    expect(segments[2]).toContain('# 运行时附录')
  })

  it('附录包含注入的当前时间（中文长日期 + 时分）', () => {
    const appendix = buildRuntimeAppendix({ now: new Date('2026-09-06T18:05:00') })
    expect(appendix).toContain('2026年9月6日')
    expect(appendix).toContain('星期')
    expect(appendix).toContain('18:05')
  })

  it('now 缺省时取当前时间（有产出即可）', () => {
    const appendix = buildRuntimeAppendix()
    expect(appendix).toContain('当前时间')
  })

  it('技能清单：有技能时附录列 name+description 并引导 skill_use；无则不提', () => {
    const withSkills = buildRuntimeAppendix({
      skills: [{ name: 'study-flashcard', description: '整理学习闪卡' }]
    })
    expect(withSkills).toContain('## 可用技能')
    expect(withSkills).toContain('- study-flashcard：整理学习闪卡')
    expect(withSkills).toContain('skill_use')
    expect(buildRuntimeAppendix()).not.toContain('可用技能')
  })

  it('soul/style 尾部空白被 trim，不产生多余空行', () => {
    const prompt = buildSystemPrompt(
      { soul: '  A\n\n', style: '\n\nB  ' },
      { now: new Date('2026-09-06T08:00:00') }
    )
    expect(prompt.startsWith('A')).toBe(true)
    expect(prompt).toContain('\n\n---\n\nB')
  })
})

describe('agent/persona · 目录加载', () => {
  it('listPersonas 返回目录名（字典序），根不存在返回空表', () => {
    expect(listPersonas(FIXTURES)).toEqual(['alpha', 'broken'])
    expect(listPersonas(join(FIXTURES, '不存在的目录'))).toEqual([])
  })

  it('loadPersona 读到两件套原文', () => {
    const persona = loadPersona(FIXTURES, 'alpha')
    expect(persona).not.toBeNull()
    expect(persona?.soul).toContain('alpha 灵魂')
    expect(persona?.style).toContain('alpha 风格')
  })

  it('缺 style.md 的目录返回 null（不抛异常）', () => {
    expect(loadPersona(FIXTURES, 'broken')).toBeNull()
    expect(loadPersona(FIXTURES, '不存在的人设')).toBeNull()
  })
})

describe('学习模式辅导守则', () => {
  const persona = { soul: '# 灵魂', style: '# 风格' }

  it('buildLearnAppendix：三段式守则齐全（讲解/追问/落笔记）', () => {
    const learn = buildLearnAppendix()
    expect(learn).toContain('先讲解')
    expect(learn).toContain('苏格拉底追问')
    expect(learn).toContain('note_write')
    expect(learn).toContain('note_read')
  })

  it('buildSystemPrompt：learnMode=true 追加守则段；缺省不含', () => {
    const plain = buildSystemPrompt(persona, {})
    const learn = buildSystemPrompt(persona, { learnMode: true })
    expect(plain).not.toContain('学习模式辅导守则')
    expect(learn).toContain('学习模式辅导守则')
    expect(learn.split(PROMPT_SEPARATOR)).toHaveLength(4) // soul → style → 运行时 → 学习守则
  })
})

describe('计划模式守则', () => {
  const persona = { soul: '# 灵魂', style: '# 风格' }

  it('buildPlanAppendix：先文字计划/只读直放/被拒收手三规则齐全', () => {
    const plan = buildPlanAppendix()
    expect(plan).toContain('先写文字计划')
    expect(plan).toContain('只读操作不用等')
    expect(plan).toContain('被拒就收手')
  })

  it('buildSystemPrompt：planMode=true 追加守则段；缺省不含；与 learn 可叠加', () => {
    const plain = buildSystemPrompt(persona, {})
    const plan = buildSystemPrompt(persona, { planMode: true })
    expect(plain).not.toContain('计划模式守则')
    expect(plan).toContain('计划模式守则')
    expect(plan.split(PROMPT_SEPARATOR)).toHaveLength(4) // soul → style → 运行时 → 计划守则
    const both = buildSystemPrompt(persona, { learnMode: true, planMode: true })
    expect(both).toContain('学习模式辅导守则')
    expect(both).toContain('计划模式守则')
    expect(both.split(PROMPT_SEPARATOR)).toHaveLength(5)
  })
})

describe('运行时附录 · 关于用户（反馈批次④）', () => {
  // 本块自带一份人设，不依赖上一个 describe 的局部常量
  const localPersona = { soul: 'SOUL 部分', style: 'STYLE 部分' }

  it('有昵称与自述时成段，含称呼与自述原文', () => {
    const appendix = buildRuntimeAppendix({
      now: new Date('2026-09-06T18:00:00'),
      user: { nickname: '测试昵称', about: '一段测试自述' }
    })
    expect(appendix).toContain('## 关于用户')
    expect(appendix).toContain('测试昵称')
    expect(appendix).toContain('一段测试自述')
  })

  it('缺省或全空白时完全不出现该段（不占上下文、不凭空捏造用户信息）', () => {
    expect(buildRuntimeAppendix({ now: new Date() })).not.toContain('关于用户')
    expect(
      buildRuntimeAppendix({ now: new Date(), user: { nickname: '  ', about: '  ' } })
    ).not.toContain('关于用户')
  })

  it('只有昵称（无自述）也成段，且不出现自述小标题', () => {
    const appendix = buildRuntimeAppendix({ user: { nickname: '测试昵称' } })
    expect(appendix).toContain('关于用户')
    expect(appendix).toContain('测试昵称')
    expect(appendix).not.toContain('用户自述')
  })

  it('走 buildSystemPrompt 时同样注入（真实发送链路用的就是它）', () => {
    const prompt = buildSystemPrompt(localPersona, {
      user: { nickname: '测试昵称', about: '一段测试自述' }
    })
    expect(prompt).toContain('关于用户')
    expect(prompt).toContain('测试昵称')
    expect(prompt).toContain('一段测试自述')
  })
})

describe('开工方式守则', () => {
  const persona = { soul: '# 灵魂', style: '# 风格' }

  it('buildWorkflowAppendix：任务清单 / 问清三情形 / 别挤牙膏 / 别问琐事 四规则齐全', () => {
    const wf = buildWorkflowAppendix()
    expect(wf).toContain('todo_write')
    expect(wf).toContain('ask_user')
    expect(wf).toContain('3 步以上')
    expect(wf).toContain('右侧「任务」轨')
  })

  it('toolMode=true 才注入（work/learn）；对话模式不带工具，不该提清单', () => {
    const plain = buildSystemPrompt(persona, {})
    const withTools = buildSystemPrompt(persona, { toolMode: true })
    expect(plain).not.toContain('开工方式')
    expect(withTools).toContain('开工方式')
    expect(withTools.split(PROMPT_SEPARATOR)).toHaveLength(4) // soul → style → 运行时 → 开工方式
  })

  it('与学习守则叠加：学习模式（有工具）同时拿到开工方式与辅导守则', () => {
    const both = buildSystemPrompt(persona, { toolMode: true, learnMode: true })
    expect(both).toContain('开工方式')
    expect(both).toContain('学习模式辅导守则')
    expect(both.split(PROMPT_SEPARATOR)).toHaveLength(5)
  })

  it('技能段改为"先过清单、倾向加载"', () => {
    const app = buildRuntimeAppendix({
      skills: [{ name: 'study-flashcard', description: '做闪卡' }]
    })
    expect(app).toContain('## 可用技能（用户已勾选启用）')
    expect(app).toContain('倾向于加载')
    expect(app).toContain('skill_use(name)')
    expect(app).toContain('study-flashcard')
  })
})

describe('学习模式复习闭环守则', () => {
  it('讲清 topic 字段 / 提醒复习 / 记进度 / 讲前先看进度 四件事', () => {
    const learn = buildLearnAppendix()
    expect(learn).toContain('topic')
    expect(learn).toContain('今日复习')
    expect(learn).toContain('study_progress_write')
    expect(learn).toContain('study_progress_read')
    expect(learn).toContain('实测') // 实测优先于自评的机制要说明
  })
})
