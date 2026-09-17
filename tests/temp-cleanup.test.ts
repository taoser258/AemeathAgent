// 中间产物清理单测（agent/tools/temp-cleanup.ts）。
//
// 设计结论：**只有她显式登记（mark_temp_files）的中间产物才可能被清**，
// 系统不再拿后缀/目录名"猜"用户意图。这里把 7 道闸门与两次误删事故全部钉死。
//
// 事故回归：
// ① 目录名 temp 里的正式成果 md 被清（旧规则认目录名）
// ② 用户明确要求保留的 旧日志.log 被清（旧规则只认 .log 后缀）

import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isTempPath,
  mentionedByUser,
  pathKey,
  planTempCleanup,
  TEMP_CLEANUP_MAX
} from '../src/main/agent/tools/temp-cleanup'
import { isProtectedPath } from '../src/main/agent/tools/delete-guard'

let ws = ''
afterEach(() => {
  ws = ''
})

/** 测试用 resolve：相对路径按工作区解析（与 run.ts 的接线同口径） */
const makeResolve =
  (root: string) =>
  (raw: string): string | null =>
    /^[a-zA-Z]:/.test(raw) || raw.startsWith('/') ? raw : join(root, raw)

function plan(input: {
  declared: string[]
  created: string[]
  userText?: string
}): ReturnType<typeof planTempCleanup> {
  return planTempCleanup({
    declared: input.declared,
    created: input.created,
    workspace: ws,
    userText: input.userText ?? '',
    resolveDeclared: makeResolve(ws)
  })
}

describe('isTempPath · 后缀判定（只用于识别，不再是删除依据）', () => {
  it('.tmp/.temp/.log 命中；成果后缀与"长得像"的名字不命中', () => {
    expect(isTempPath('E:\\ws\\a.tmp')).toBe(true)
    expect(isTempPath('/ws/x.temp')).toBe(true)
    expect(isTempPath('/ws/logs/error.log')).toBe(true)
    expect(isTempPath('/ws/temp/最终报告.md')).toBe(false)
    expect(isTempPath('/ws/report.docx')).toBe(false)
    expect(isTempPath('/ws/logger.ts')).toBe(false)
  })
})

describe('mentionedByUser · 用户提到过就不许碰', () => {
  it('文件名或完整路径出现在用户消息里即命中（大小写与斜杠不敏感）', () => {
    expect(mentionedByUser('E:\\ws\\旧日志.log', '旧日志.log 给我保留')).toBe(true)
    expect(mentionedByUser('E:\\ws\\A.TMP', '帮我建个 a.tmp')).toBe(true)
    expect(mentionedByUser('E:\\ws\\notes\\x.md', '写个报告')).toBe(false)
  })
})

describe('planTempCleanup · 7 道闸门', () => {
  it('★ 事故二回归：用户要求保留的 旧日志.log（本轮新建、后缀命中）**未登记 → 绝不清**', () => {
    ws = mkdtempSync(join(tmpdir(), 'aemeath-cleanup-'))
    const oldLog = join(ws, '旧日志.log')
    const r = plan({
      declared: [], // 她认为该留，没登记
      created: [oldLog],
      userText: '在工作区根目录再放一个 旧日志.log，给我保留'
    })
    expect(r.files).toEqual([])
    expect(r.leftovers).toEqual([]) // 没登记的不进候选（也不汇报，避免噪声）
  })

  it('★ 事故二回归：即使她误登记了，用户消息提到过该文件名也不清', () => {
    ws = mkdtempSync(join(tmpdir(), 'aemeath-cleanup-'))
    const oldLog = join(ws, '旧日志.log')
    const r = plan({
      declared: [oldLog],
      created: [oldLog],
      userText: '旧日志.log 给我保留'
    })
    expect(r.files).toEqual([])
    expect(r.leftovers.map((p) => pathKey(p))).toEqual([pathKey(oldLog)])
  })

  it('★ 事故一回归：名为 temp 的目录里的成果 md，登记了也不清（后缀闸门）', () => {
    ws = mkdtempSync(join(tmpdir(), 'aemeath-cleanup-'))
    const dir = join(ws, 'temp')
    const report = join(dir, '最终报告.md')
    const r = plan({ declared: [report], created: [report] })
    expect(r.files).toEqual([])
    expect(r.leftovers).toHaveLength(1)
  })

  it('正常路径：登记 + 本轮新建 + 后缀命中 + 工作区内 → 可清', () => {
    ws = mkdtempSync(join(tmpdir(), 'aemeath-cleanup-'))
    const a = join(ws, 'data.tmp')
    const b = join(ws, 'sub', 'run.log')
    const r = plan({ declared: [a, 'sub/run.log'], created: [a, b, join(ws, 'keep.md')] })
    expect(r.files.map((p) => pathKey(p)).sort()).toEqual([pathKey(a), pathKey(b)].sort())
    expect(r.skippedTooMany).toBe(0)
  })

  it('登记但**不是本轮新建**（用户已有文件）→ 不清', () => {
    ws = mkdtempSync(join(tmpdir(), 'aemeath-cleanup-'))
    const pre = join(ws, 'app.log')
    const r = plan({ declared: [pre], created: [] }) // 她覆写却没新建
    expect(r.files).toEqual([])
    expect(r.leftovers).toEqual([])
  })

  it('登记但越出工作区 → 不清（转汇报）', () => {
    ws = mkdtempSync(join(tmpdir(), 'aemeath-cleanup-'))
    const outside = 'E:\\other\\x.tmp'
    const r = plan({ declared: [outside], created: [outside] })
    expect(r.files).toEqual([])
    expect(r.leftovers).toEqual([outside])
  })

  it('★ 数量熔断：登记数超上限 → 一个都不清，只报数', () => {
    ws = mkdtempSync(join(tmpdir(), 'aemeath-cleanup-'))
    const many = Array.from({ length: TEMP_CLEANUP_MAX + 1 }, (_, i) => join(ws, `x${i}.tmp`))
    const r = plan({ declared: many, created: many })
    expect(r.files).toEqual([])
    expect(r.skippedTooMany).toBe(TEMP_CLEANUP_MAX + 1)
  })

  it('★ 未绑定工作区 → 什么都不清（fail-closed）', () => {
    const r = planTempCleanup({
      declared: ['E:\\ws\\a.tmp'],
      created: ['E:\\ws\\a.tmp'],
      workspace: null,
      userText: '',
      resolveDeclared: (raw) => raw
    })
    expect(r.files).toEqual([])
    expect(r.skippedTooMany).toBe(0)
  })
})

describe('delete-guard · 受保护位置', () => {
  it('工作区根本身受保护（可以删里面的文件，不能一锅端）', () => {
    ws = mkdtempSync(join(tmpdir(), 'aemeath-guard-'))
    expect(isProtectedPath(ws, ws)).toBe(true)
    expect(isProtectedPath(join(ws, 'a.tmp'), ws)).toBe(false)
  })

  it('盘根与系统目录恒受保护（即使 full 模式、即使工作区故意指过去）', () => {
    expect(isProtectedPath('C:\\', 'C:\\work')).toBe(true)
    expect(isProtectedPath('C:\\Windows\\System32', null)).toBe(true)
    expect(isProtectedPath('C:\\Program Files', null)).toBe(true)
  })

  it('用户主目录/桌面/文档/下载本身受保护，其内部文件不受', () => {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
    expect(isProtectedPath(home, null)).toBe(true)
    expect(isProtectedPath(join(home, 'Downloads'), null)).toBe(true)
    expect(isProtectedPath(join(home, 'Downloads', 'x.zip'), null)).toBe(false)
  })
})
