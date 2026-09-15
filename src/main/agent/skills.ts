// 技能注册表：skills/<name>/SKILL.md 目录扫描 + frontmatter 解析 + 双来源合并。
// 设计与 registry.ts 同款注入式：目录与禁用清单由 main ready 注入，本文件保持无 electron 依赖可单测。
// 契约：
// SKILL.md = frontmatter（description 必填 / modes 可选逗号分隔，缺省全模式）+ 正文；
// 双来源：项目内 skills/（builtin，随仓库分发）+ userData/skills/（user，用户自装）；同名 user 优先。
// 触发方式：v1 仅经 skill_use 工具调用——prompt 附录只列 name+description 引导模型按需加载。

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { ChatMode, SkillMeta } from '@shared/types'

let builtinDir = ''
let userDir = ''
const disabledNames = new Set<string>()

/** 注入技能目录（builtin = 项目内 skills/，user = userData/skills/）；测试可指向临时目录 */
export function setSkillDirs(builtin: string, user: string): void {
  builtinDir = builtin
  userDir = user
}

/** 用户技能目录（userData/skills/）——技能面板「打开技能文件夹」用；未注入时 '' */
export function getUserSkillsDir(): string {
  return userDir
}

/** 注入禁用清单（config.skills.disabled；缺省空 = 全启用）。设置保存后即时更新（免重启）。 */
export function setSkillDisabled(names: string[] | undefined): void {
  disabledNames.clear()
  for (const n of names ?? []) {
    if (typeof n === 'string' && n.trim() !== '') disabledNames.add(n.trim())
  }
}

/** 合法 ChatMode 集合（modes frontmatter 的白名单口径） */
const ALL_MODES: ChatMode[] = ['chat', 'work', 'learn']

/**
 * 解析 SKILL.md：frontmatter 夹在首行 `---` 与下一个 `---` 之间，逐行 key: value。
 * description 必填；modes 可选（逗号分隔，非法值丢弃，缺省全模式）。
 * 返回 null = 无 frontmatter / 缺 description（调用方跳过该目录，不拖垮扫描）。
 */
export function parseSkillMd(raw: string): { description: string; modes: ChatMode[] } | null {
  if (!raw.startsWith('---')) return null
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return null
  let description = ''
  let modes: ChatMode[] | null = null
  for (const line of raw.slice(3, end).split('\n')) {
    const sep = line.indexOf(':')
    if (sep <= 0) continue
    const key = line.slice(0, sep).trim().toLowerCase()
    const value = line.slice(sep + 1).trim()
    if (key === 'description') {
      description = value
    } else if (key === 'modes') {
      const parsed = value
        .split(',')
        .map((m) => m.trim().toLowerCase())
        .filter((m): m is ChatMode => (ALL_MODES as string[]).includes(m))
      if (parsed.length > 0) modes = parsed
    }
  }
  if (description === '') return null
  return { description, modes: modes ?? [...ALL_MODES] }
}

/** 扫描单目录：每个子目录一份 SKILL.md；毁损/缺字段/无 SKILL.md 的目录静默跳过（防御式） */
function scanDir(dir: string, source: SkillMeta['source']): SkillMeta[] {
  if (dir === '' || !existsSync(dir)) return []
  const out: SkillMeta[] = []
  for (const entry of readdirSync(dir)) {
    try {
      const skillDir = join(dir, entry)
      if (!statSync(skillDir).isDirectory()) continue
      const mdPath = join(skillDir, 'SKILL.md')
      if (!existsSync(mdPath)) continue
      const parsed = parseSkillMd(readFileSync(mdPath, 'utf8'))
      if (parsed === null) continue
      out.push({
        name: entry,
        description: parsed.description,
        source,
        modes: parsed.modes,
        enabled: !disabledNames.has(entry)
      })
    } catch {
      /* 单目录异常不拖垮整体扫描 */
    }
  }
  return out
}

/** 全量技能清单：双来源合并（同名 user 覆盖 builtin），名字典序 */
export function listSkills(): SkillMeta[] {
  const users = scanDir(userDir, 'user')
  const builtins = scanDir(builtinDir, 'builtin').filter(
    (b) => !users.some((u) => u.name === b.name)
  )
  return [...users, ...builtins].sort((a, b) => a.name.localeCompare(b.name))
}

/** 某模式下启用的技能（chat 恒空：对话模式无工具，skill_use 也进不去）——prompt 附录与清单口径 */
export function listEnabledSkills(mode: ChatMode): SkillMeta[] {
  if (mode === 'chat') return []
  return listSkills().filter((s) => s.enabled && s.modes.includes(mode))
}

/**
 * 读取技能正文（skill_use 的执行体）：剥掉 frontmatter，带来源标注返回。
 * 技能名白名单校验（模型传参不可信，防路径穿越）；未命中回"没有这个技能"并列可用清单。
 */
export function readSkillBody(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return `技能名不合法：${name}（只允许字母数字、连字符与下划线）。`
  }
  const skill = listSkills().find((s) => s.name === name)
  if (skill === undefined || !skill.enabled) {
    const available = listSkills()
      .filter((s) => s.enabled)
      .map((s) => s.name)
    return `没有这个技能：${name}。当前可用技能：${available.length > 0 ? available.join('、') : '（无）'}`
  }
  const dir = skill.source === 'user' ? userDir : builtinDir
  try {
    const skillDir = join(dir, name)
    const raw = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
    const body = raw.startsWith('---') ? raw.slice(raw.indexOf('\n---', 3) + 4).trim() : raw.trim()
    return `【技能：${name}（${skill.source === 'user' ? '用户' : '内置'}）】请按以下说明执行任务：\n\n${body}${referenceAppendix(skillDir)}`
  } catch {
    return `技能 ${name} 的 SKILL.md 读取失败（文件可能被移动或删除），请让用户检查技能目录。`
  }
}

/** 技能目录下 references/ 的绝对路径清单（追加在正文末尾）：
 * 正文里写"读 references/xxx.md"的技能（如 course-notes）需要真实路径才能用 read_file
 * 读取——read_file 支持绝对路径。没有 references/ 的技能追加空串，零影响。 */
function referenceAppendix(skillDir: string): string {
  const refDir = join(skillDir, 'references')
  if (!existsSync(refDir)) return ''
  let files: string[] = []
  try {
    files = readdirSync(refDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
  } catch {
    return ''
  }
  if (files.length === 0) return ''
  const lines = files.map((f) => `- ${join(refDir, f)}`)
  return `\n\n【本技能参考文件（正文要求细读时，用 read_file 按以下绝对路径读取）】\n${lines.join('\n')}`
}
