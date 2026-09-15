// 技能注册表单测：frontmatter 解析 / 双来源合并 / 模式与禁用过滤 / 路径穿越防护。
// 只测纯逻辑：目录由临时 fixture 注入（setSkillDirs），无 electron 依赖。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listEnabledSkills,
  listSkills,
  parseSkillMd,
  readSkillBody,
  setSkillDisabled,
  setSkillDirs
} from '../src/main/agent/skills'

let tmp = ''

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'aemeath-skills-'))
  mkdirSync(join(tmp, 'builtin'), { recursive: true })
  mkdirSync(join(tmp, 'user'), { recursive: true })
  setSkillDisabled(undefined)
})

afterEach(() => {
  setSkillDirs('', '')
  setSkillDisabled(undefined)
  rmSync(tmp, { recursive: true, force: true })
})

function addSkill(base: 'builtin' | 'user', name: string, md: string): void {
  mkdirSync(join(tmp, base, name), { recursive: true })
  writeFileSync(join(tmp, base, name, 'SKILL.md'), md, 'utf8')
}

const VALID = `---
description: 整理学习闪卡
modes: work, learn
---
正文内容
`

describe('agent/skills · parseSkillMd', () => {
  it('合法 frontmatter：description 必填，modes 白名单过滤', () => {
    expect(parseSkillMd(VALID)).toEqual({ description: '整理学习闪卡', modes: ['work', 'learn'] })
  })

  it('无 modes → 缺省全模式；非法模式值丢弃', () => {
    expect(parseSkillMd('---\ndescription: 通用技能\n---\n正文')).toEqual({
      description: '通用技能',
      modes: ['chat', 'work', 'learn']
    })
    expect(parseSkillMd('---\ndescription: x\nmodes: work, hack, learn\n---\n')).toEqual({
      description: 'x',
      modes: ['work', 'learn']
    })
  })

  it('无 frontmatter / 缺 description / frontmatter 未闭合 → null（调用方跳过）', () => {
    expect(parseSkillMd('# 直接正文，没有 frontmatter')).toBeNull()
    expect(parseSkillMd('---\nmodes: work\n---\n正文')).toBeNull()
    expect(parseSkillMd('---\ndescription: 没有闭合\n正文')).toBeNull()
  })
})

describe('agent/skills · 双来源扫描与合并', () => {
  it('同名 user 覆盖 builtin；名字典序；无 SKILL.md 目录跳过', () => {
    addSkill('builtin', 'alpha', VALID)
    addSkill('builtin', 'beta', '---\ndescription: 内置 beta\n---\n')
    addSkill('user', 'beta', '---\ndescription: 用户 beta（覆盖）\n---\n')
    addSkill('user', 'empty-dir', '占位但无 SKILL.md')
    writeFileSync(join(tmp, 'user', 'loose-file.txt'), '不是目录', 'utf8')
    setSkillDirs(join(tmp, 'builtin'), join(tmp, 'user'))

    const list = listSkills()
    expect(list.map((s) => `${s.name}:${s.source}`)).toEqual(['alpha:builtin', 'beta:user'])
    expect(list.find((s) => s.name === 'beta')?.description).toBe('用户 beta（覆盖）')
  })

  it('enabled 反演禁用名单；chat 恒空；modes 过滤生效', () => {
    addSkill('builtin', 'flash', VALID) // work, learn
    addSkill('builtin', 'chatty', '---\ndescription: 全模式技能\n---\n')
    setSkillDirs(join(tmp, 'builtin'), join(tmp, 'user'))
    setSkillDisabled(['flash'])

    expect(listSkills().find((s) => s.name === 'flash')?.enabled).toBe(false)
    expect(listEnabledSkills('chat')).toEqual([])
    expect(listEnabledSkills('work').map((s) => s.name)).toEqual(['chatty'])
    expect(listEnabledSkills('learn').map((s) => s.name)).toEqual(['chatty'])
    setSkillDisabled(undefined)
    expect(listEnabledSkills('work').map((s) => s.name)).toEqual(['chatty', 'flash'])
  })
})

describe('agent/skills · readSkillBody（skill_use 执行体）', () => {
  beforeEach(() => {
    addSkill('builtin', 'flash', VALID.replace('正文内容', '闪卡步骤一：拆知识点'))
    setSkillDirs(join(tmp, 'builtin'), join(tmp, 'user'))
  })

  it('剥 frontmatter 带来源标注；路径穿越与非法名拒绝', () => {
    const body = readSkillBody('flash')
    expect(body).toContain('【技能：flash（内置）】')
    expect(body).toContain('闪卡步骤一')
    expect(body).not.toContain('description:')

    expect(readSkillBody('../escape')).toContain('技能名不合法')
    expect(readSkillBody('no-such')).toContain('没有这个技能')
  })

  it('禁用技能按"没有这个技能"口径回灌（不暴露禁用清单）', () => {
    setSkillDisabled(['flash'])
    expect(readSkillBody('flash')).toContain('没有这个技能')
  })

  it('有 references/ 目录 → 正文末尾追加绝对路径清单（course-notes 靠它 read_file 细则）', () => {
    mkdirSync(join(tmp, 'builtin', 'cn', 'references'), { recursive: true })
    writeFileSync(join(tmp, 'builtin', 'cn', 'SKILL.md'), VALID, 'utf8')
    writeFileSync(join(tmp, 'builtin', 'cn', 'references', 'style-guide.md'), 'x', 'utf8')
    writeFileSync(join(tmp, 'builtin', 'cn', 'references', 'subject-playbooks.md'), 'x', 'utf8')
    writeFileSync(join(tmp, 'builtin', 'cn', 'references', 'ignore.txt'), 'x', 'utf8')
    setSkillDirs(join(tmp, 'builtin'), join(tmp, 'user'))
    const body = readSkillBody('cn')
    expect(body).toContain('本技能参考文件')
    expect(body).toContain(join('cn', 'references', 'style-guide.md'))
    expect(body).toContain(join('cn', 'references', 'subject-playbooks.md'))
    expect(body).not.toContain('ignore.txt') // 只列 .md
    // 排序稳定（字典序）：style-guide（sty < sub）排在 subject-playbooks 之前
    expect(body.indexOf('style-guide.md')).toBeLessThan(body.indexOf('subject-playbooks.md'))
  })

  it('无 references/ 目录 → 不追加（现有技能零影响）', () => {
    expect(readSkillBody('flash')).not.toContain('本技能参考文件')
  })
})
