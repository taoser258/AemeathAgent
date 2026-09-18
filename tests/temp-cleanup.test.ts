// 中间产物清理单测（agent/tools/temp-cleanup.ts）。
//
// 设计结论：**只有她显式登记（mark_temp_files）的中间产物才可能被清**，
// 系统不再拿后缀/目录名"猜"用户意图。这里把 7 道闸门与三次事故全部钉死。
//
// 误删事故回归：
// ① 目录名 temp 里的正式成果 md 被清（旧规则认目录名）
// ② 用户明确要求保留的 旧日志.log 被清（旧规则只认 .log 后缀）
// 漏清事故回归：
// ③ 临时脚本 _preview-server.js 登记了却没清（旧规则只认 .tmp/.temp/.log 白名单）
// ④ 需求里点名了 _probe.js → 被当成"用户要保留"而没清（旧规则认"提到过就算"）

import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isDeliverablePath,
  keptByUser,
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

/** leftovers 的路径集合（断言用） */
const leftoverPaths = (r: ReturnType<typeof planTempCleanup>): string[] =>
  r.leftovers.map((l) => pathKey(l.path)).sort()

describe('isDeliverablePath · 成果后缀（命中 = 登记了也不清）', () => {
  it('报告/文档/网页/图片/音视频/压缩包一律算成果', () => {
    expect(isDeliverablePath('/ws/最终报告.md')).toBe(true)
    expect(isDeliverablePath('/ws/report.docx')).toBe(true)
    expect(isDeliverablePath('/ws/cow-on-bike.html')).toBe(true)
    expect(isDeliverablePath('/ws/shot.png')).toBe(true)
    expect(isDeliverablePath('/ws/demo.mp4')).toBe(true)
    expect(isDeliverablePath('/ws/pack.zip')).toBe(true)
  })

  it('脚本与中间数据不算成果（这些才是要被清掉的那一类）', () => {
    expect(isDeliverablePath('/ws/_preview-server.js')).toBe(false)
    expect(isDeliverablePath('/ws/scrape.py')).toBe(false)
    expect(isDeliverablePath('/ws/build.bat')).toBe(false)
    expect(isDeliverablePath('/ws/a.tmp')).toBe(false)
    expect(isDeliverablePath('/ws/logs/error.log')).toBe(false)
    expect(isDeliverablePath('/ws/dump.json')).toBe(false)
  })
})

describe('keptByUser · 只有"明确说要保留"才拦（提到名字不算）', () => {
  it('事故二原话："旧日志.log 给我保留" → 拦下', () => {
    expect(keptByUser('E:\\ws\\旧日志.log', '旧日志.log 给我保留')).toBe(true)
    expect(keptByUser('E:\\ws\\a.log', '这个 a.log 留着，别删')).toBe(true)
    expect(keptByUser('E:\\ws\\b.log', '留一份 b.log 给我')).toBe(true)
  })

  it('★ 事故四回归：需求里点名文件名（下需求，不是要留它）→ 不拦', () => {
    // owner 实测那次的**原话**（逐字抄自会话档案，别顺手改写——回归测试要的就是原话）
    const userText =
      '在工作区根目录帮我做两件事： 1) 写一个临时脚本 _probe.js，用 node 跑一下（打印 1 到 5 的平方就行），跑完按规矩登记成中间产物； 2) 另外做个正式成品 probe.html（一个居中的“你好”页面，双击能打开），这个别登记。'
    expect(keptByUser('E:\\Aemeath工作区\\_probe.js', userText)).toBe(false)
    // 老口径（"提到过就拦"）在这里是 true —— 那正是漏清的根因
    expect(keptByUser('E:\\Aemeath工作区\\probe.html', userText)).toBe(false)
  })

  it('反向措辞不算保留（"别留着""不需要保留"）', () => {
    expect(keptByUser('E:\\ws\\x.log', 'x.log 跑完别留着')).toBe(false)
    expect(keptByUser('E:\\ws\\x.log', 'x.log 不需要保留')).toBe(false)
  })

  it('★ 文件名里含 keep 不算"要保留"（名字自己不能触发措辞；否则 _keepalive.js 永远清不掉）', () => {
    expect(
      keptByUser('E:\\ws\\_keepalive.js', '写个 _keepalive.js 跑一下，跑完登记成中间产物')
    ).toBe(false)
  })

  it('保留措辞离文件名太远 → 不算（"同一句话"才算数）', () => {
    const far = `给我保留一份汇总，${'顺便把背景资料也整理一下，'.repeat(4)}另外 x.log 记得清掉`
    expect(keptByUser('E:\\ws\\x.log', far)).toBe(false)
  })

  it('压根没提到文件名 → 这道闸门不保护它（由别的闸门管）', () => {
    expect(keptByUser('E:\\ws\\notes\\x.md', '写个报告')).toBe(false)
  })

  it('大小写与斜杠不敏感（用户写完整路径也算提到）', () => {
    expect(keptByUser('E:\\ws\\A.TMP', 'e:/ws/a.tmp 留着')).toBe(true)
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
    expect(leftoverPaths(r)).toEqual([pathKey(oldLog)])
    expect(r.leftovers[0].reason).toBe('kept')
  })

  it('★ 事故四回归（漏清）：需求里点名了 _probe.js → 登记后照样清', () => {
    ws = mkdtempSync(join(tmpdir(), 'aemeath-cleanup-'))
    const server = join(ws, '_probe.js')
    const r = plan({
      declared: [server],
      created: [server, join(ws, 'probe.html')],
      userText:
        '1) 写一个临时脚本 _probe.js，用 node 跑一下，跑完按规矩登记成中间产物；2) 另外做个正式成品 probe.html，这个别登记。'
    })
    expect(r.files.map((p) => pathKey(p))).toEqual([pathKey(server)])
    expect(r.leftovers).toEqual([])
  })

  it('★ 事故二回归（保留路径仍在）：用户说"这个 keepme.log 我要留着" → 登记了也不清', () => {
    ws = mkdtempSync(join(tmpdir(), 'aemeath-cleanup-'))
    const keep = join(ws, 'keepme.log')
    const r = plan({
      declared: [keep], // 她若误登记
      created: [keep],
      userText: '再写个 keepme.log（随便一行字），这个我要留着，别登记也别删。'
    })
    expect(r.files).toEqual([])
    expect(leftoverPaths(r)).toEqual([pathKey(keep)])
    expect(r.leftovers[0].reason).toBe('kept')
  })

  it('★ 事故一回归：名为 temp 的目录里的成果 md，登记了也不清（成果闸门）', () => {
    ws = mkdtempSync(join(tmpdir(), 'aemeath-cleanup-'))
    const dir = join(ws, 'temp')
    const report = join(dir, '最终报告.md')
    const r = plan({ declared: [report], created: [report] })
    expect(r.files).toEqual([])
    expect(r.leftovers).toHaveLength(1)
    expect(r.leftovers[0].reason).toBe('deliverable')
  })

  it('★ 事故三回归（漏清）：临时脚本 _preview-server.js 登记 + 本轮新建 → 必须清', () => {
    ws = mkdtempSync(join(tmpdir(), 'aemeath-cleanup-'))
    const server = join(ws, '_preview-server.js')
    // 同一轮的成品 html 不被登记 → 完全不在候选里（她的登记才是唯一信号）
    const r = plan({
      declared: [server],
      created: [server, join(ws, 'cow-on-bike.html')],
      userText: '创建一个 HTML，内容是 SVG 绘制一个奶牛骑自行车的 2D 动画'
    })
    expect(r.files.map((p) => pathKey(p))).toEqual([pathKey(server)])
    expect(r.leftovers).toEqual([])
  })

  it('★ 她若把成品也登记了，成品仍不会被清（成果后缀兜底）', () => {
    ws = mkdtempSync(join(tmpdir(), 'aemeath-cleanup-'))
    const html = join(ws, 'cow-on-bike.html')
    const server = join(ws, '_preview-server.js')
    const r = plan({ declared: [html, server], created: [html, server] })
    expect(r.files.map((p) => pathKey(p))).toEqual([pathKey(server)])
    expect(leftoverPaths(r)).toEqual([pathKey(html)])
  })

  it('脚本类与中间数据类都能清（.js/.py/.bat/.json）', () => {
    ws = mkdtempSync(join(tmpdir(), 'aemeath-cleanup-'))
    const files = ['a.js', 'b.py', 'c.bat', 'd.json'].map((n) => join(ws, n))
    const r = plan({ declared: files, created: files })
    expect(r.files.map((p) => pathKey(p)).sort()).toEqual(files.map(pathKey).sort())
  })

  it('正常路径：登记 + 本轮新建 + 不像成果 + 工作区内 → 可清', () => {
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

  it('登记但越出工作区 → 不清（转汇报，注明原因）', () => {
    ws = mkdtempSync(join(tmpdir(), 'aemeath-cleanup-'))
    const outside = 'E:\\other\\x.tmp'
    const r = plan({ declared: [outside], created: [outside] })
    expect(r.files).toEqual([])
    expect(leftoverPaths(r)).toEqual([pathKey(outside)])
    expect(r.leftovers[0].reason).toBe('outside')
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
