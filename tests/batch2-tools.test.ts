// 批次 2 四工具单测：fetch_url / download_file / note_export / search_history。
// fetch_url 的网络用 stub fetch（可控 content-type / 最终地址 / 状态码）；
// download_file 起真实本地 HTTP 服务（安全线用测试钩子放行回环）；
// note_export / search_history 走真实存储（临时目录注入），账本撤销链路一并验证。

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getToolDefinitions,
  assertPublicHttpUrl,
  isPrivateHost,
  approvalTargetPath,
  setLocalNetFetchAllowedForTests,
  setSearchHistoryBase,
  type ToolDef
} from '../src/main/agent/tools/registry'
import { setLedgerBase, undoLastChange } from '../src/main/agent/tools/ledger'
import { setNotesBase, appendNotes } from '../src/main/agent/tools/note-store'
import { htmlToText } from '../src/main/agent/tools/html-text'
import { saveSessionMessages } from '../src/main/sessions/session-store'

const defs = getToolDefinitions()
const fetchTool = defs.find((d) => d.name === 'fetch_url') as ToolDef
const downloadTool = defs.find((d) => d.name === 'download_file') as ToolDef
const exportTool = defs.find((d) => d.name === 'note_export') as ToolDef
const historyTool = defs.find((d) => d.name === 'search_history') as ToolDef

let root: string
const ctx = (workspace: string): { signal: AbortSignal; sessionId: string; workspace: string } => ({
  signal: new AbortController().signal,
  sessionId: 'test-session',
  workspace
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aemeath-batch2-'))
  setLedgerBase(mkdtempSync(join(tmpdir(), 'aemeath-ledger2-')))
})

afterEach(() => {
  setLedgerBase('')
  setNotesBase('')
  setSearchHistoryBase('')
  setLocalNetFetchAllowedForTests(false)
  vi.unstubAllGlobals()
  rmSync(root, { recursive: true, force: true })
})

// ── html-text：HTML → 纯文本 ─────────────────────────────────────────────
describe('htmlToText（fetch_url 的正文提取）', () => {
  it('剥脚本/样式/注释，块级标签折行，解实体，压空白', () => {
    const { title, text } = htmlToText(
      `<html><head><title>测试 &amp; 示例</title><style>.x{color:red}</style></head>` +
        `<body><!-- 注释 --><script>var a=1;</script>` +
        `<h1>标题一</h1><p>第一段&nbsp;&amp;&nbsp;内容</p><div>第二块<br>折行</div></body></html>`
    )
    expect(title).toBe('测试 & 示例')
    expect(text).toContain('标题一')
    expect(text).toContain('第一段 & 内容')
    expect(text).toContain('第二块\n折行')
    expect(text).not.toContain('var a=1')
    expect(text).not.toContain('color:red')
    expect(text).not.toContain('注释')
  })

  it('数字实体解码，未知实体原样保留', () => {
    expect(htmlToText('<p>&#x4F60;&#22909; &unknownent;</p>').text).toBe('你好 &unknownent;')
  })
})

// ── SSRF 安全线 ──────────────────────────────────────────────────────────
describe('assertPublicHttpUrl / isPrivateHost（网络工具安全线）', () => {
  it('公网 http/https 通过', () => {
    expect(assertPublicHttpUrl('https://example.com/a?q=1').hostname).toBe('example.com')
    expect(assertPublicHttpUrl('http://docs.example.co.uk/x').protocol).toBe('http:')
  })

  it('回环/私网/单标签/非 http 一律拒绝', () => {
    for (const bad of [
      'http://localhost/x',
      'http://127.0.0.1/x',
      'http://10.1.2.3/x',
      'http://192.168.1.1/x',
      'http://172.16.0.9/x',
      'http://169.254.1.1/x',
      'http://intranet/x', // 单标签内网名
      'http://router.local/x',
      'file:///etc/passwd',
      'ftp://example.com/f'
    ]) {
      expect(() => assertPublicHttpUrl(bad)).toThrow()
    }
    expect(isPrivateHost('[::1]')).toBe(true)
    expect(isPrivateHost('fd12::1')).toBe(true)
    expect(isPrivateHost('::ffff:192.168.0.1')).toBe(true)
    expect(isPrivateHost('example.com')).toBe(false)
  })
})

// ── fetch_url ────────────────────────────────────────────────────────────
describe('fetch_url', () => {
  it('抓取 HTML → 标题 + 纯文本正文', async () => {
    const html =
      '<html><head><title>页面标题</title></head><body><h1>大标题</h1><p>正文内容很多很多</p></body></html>'
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      )
    )
    const out = String(await fetchTool.execute({ url: 'https://example.com/post/1' }, ctx(root)))
    expect(out).toContain('# 页面标题')
    expect(out).toContain('https://example.com/post/1')
    expect(out).toContain('大标题')
    expect(out).toContain('正文内容很多很多')
  })

  it('JSON 内容直接给原文；非文本类型拒绝并指路 download_file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('{"a":1}', { headers: { 'content-type': 'application/json' } })
      )
    )
    expect(
      String(await fetchTool.execute({ url: 'https://api.example.com/v1/x' }, ctx(root)))
    ).toContain('"a":1')
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(Buffer.from([0x89, 0x50]), { headers: { 'content-type': 'image/png' } })
      )
    )
    await expect(
      fetchTool.execute({ url: 'https://example.com/a.png' }, ctx(root))
    ).rejects.toThrow(/download_file/)
  })

  it('HTTP 错误与内网地址拒绝', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 }))
    )
    await expect(fetchTool.execute({ url: 'https://example.com/404' }, ctx(root))).rejects.toThrow(
      /404/
    )
    await expect(fetchTool.execute({ url: 'http://192.168.1.1/' }, ctx(root))).rejects.toThrow(
      /内网|回环/
    )
  })
})

// ── download_file（真实本地 HTTP 服务）───────────────────────────────────
describe('download_file', () => {
  let server: http.Server
  let base = ''
  let served: Buffer

  const start = (): Promise<void> =>
    new Promise((resolve) => {
      server = http.createServer((req, res) => {
        if (req.url === '/file.bin') {
          res.writeHead(200, { 'content-type': 'application/octet-stream' })
          res.end(served)
        } else if (req.url === '/page.html') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end('<html><body>网页不是文件</body></html>')
        } else {
          res.writeHead(404)
          res.end('no')
        }
      })
      server.listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        resolve()
      })
    })

  beforeEach(async () => {
    served = Buffer.from('BIN\u0000DATA-下载内容-123')
    setLocalNetFetchAllowedForTests(true) // 回环服务默认被安全线拦，测试放行
    await start()
  })
  afterEach(() => {
    server.close()
  })

  it('下载落盘 + 记账 + undo 删除（create 语义）', async () => {
    const out = String(await downloadTool.execute({ url: `${base}/file.bin` }, ctx(root)))
    const target = join(root, 'downloads', 'file.bin')
    expect(out).toContain('已下载')
    expect(readFileSync(target)).toEqual(served)
    undoLastChange('test-session')
    expect(existsSync(target)).toBe(false)
  })

  it('同名拒绝，overwrite=true 覆盖且旧内容进快照可撤销', async () => {
    const target = join(root, 'downloads', 'file.bin')
    await downloadTool.execute({ url: `${base}/file.bin` }, ctx(root))
    const first = readFileSync(target)
    await expect(downloadTool.execute({ url: `${base}/file.bin` }, ctx(root))).rejects.toThrow(
      /已存在/
    )
    served = Buffer.from('NEW-CONTENT')
    const out = String(
      await downloadTool.execute({ url: `${base}/file.bin`, overwrite: true }, ctx(root))
    )
    expect(out).toContain('可撤销')
    expect(readFileSync(target, 'utf8')).toBe('NEW-CONTENT')
    undoLastChange('test-session')
    expect(readFileSync(target)).toEqual(first)
  })

  it('网页地址拒绝并指路 fetch_url；相对路径 .. 逃逸拒绝；404 报错', async () => {
    await expect(downloadTool.execute({ url: `${base}/page.html` }, ctx(root))).rejects.toThrow(
      /fetch_url/
    )
    await expect(
      downloadTool.execute({ url: `${base}/file.bin`, path: '../outside.bin' }, ctx(root))
    ).rejects.toThrow(/逃逸|越出/)
    await expect(downloadTool.execute({ url: `${base}/missing` }, ctx(root))).rejects.toThrow(/404/)
  })
})

// ── note_export ──────────────────────────────────────────────────────────
describe('note_export（笔记/闪卡 → Markdown）', () => {
  it('导出当前会话：frontmatter + 笔记 + 闪卡 Q/A，undo 一键还原', async () => {
    setNotesBase(mkdtempSync(join(tmpdir(), 'aemeath-notes-')))
    appendNotes('test-session', [
      { kind: 'note', title: 'TCP 三次握手', content: 'SYN → SYN/ACK → ACK' },
      { kind: 'card', title: '为什么需要三次握手？', content: '确认双方收发能力，防旧连接请求' }
    ])
    const out = String(await exportTool.execute({}, ctx(root)))
    expect(out).toContain('notes-export/notes-test-session.md')
    const md = readFileSync(join(root, 'notes-export', 'notes-test-session.md'), 'utf8')
    expect(md).toContain('session: test-session')
    expect(md).toContain('### 1. TCP 三次握手')
    expect(md).toContain('**Q1. 为什么需要三次握手？**')
    expect(md).toContain('**A1:** 确认双方收发能力，防旧连接请求')
    undoLastChange('test-session')
    expect(existsSync(join(root, 'notes-export', 'notes-test-session.md'))).toBe(false)
  })

  it('无笔记时报可读错误；scope=all 汇总多会话', async () => {
    setNotesBase(mkdtempSync(join(tmpdir(), 'aemeath-notes-')))
    await expect(exportTool.execute({}, ctx(root))).rejects.toThrow(/还没有笔记/)
    appendNotes('s-other1', [{ kind: 'card', title: 'Q', content: 'A' }])
    const out = String(await exportTool.execute({ scope: 'all' }, ctx(root)))
    expect(out).toContain('notes-s-other1.md')
  })
})

// ── 审批层路径解析（E2E 发现的弹卡 UX 缺陷回归）─────────────────────────
describe('approvalTargetPath（缺省目录工具不再成为"未知路径"黑洞）', () => {
  it('note_export / download_file 省略路径时按确定性缺省目录判定（工作区内 → 不弹卡）', () => {
    expect(approvalTargetPath('note_export', JSON.stringify({ scope: 'session' }), root)).toBe(
      join(root, 'notes-export')
    )
    expect(approvalTargetPath('download_file', JSON.stringify({ url: 'https://x/y' }), root)).toBe(
      join(root, 'downloads')
    )
    expect(approvalTargetPath('download_file', JSON.stringify({ path: 'a.bin' }), root)).toBe(
      join(root, 'a.bin')
    )
    // 无缺省目录语义的工具省略路径仍是 null（fail-closed 弹卡）
    expect(approvalTargetPath('write_file', '{}', root)).toBeNull()
  })
})

// ── search_history ───────────────────────────────────────────────────────
describe('search_history（历史会话搜索）', () => {
  beforeEach(() => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'aemeath-sessions-'))
    setSearchHistoryBase(sessionsDir)
    // 注册表 + 两份会话数据（一份命中、一份不命中）+ 一份损坏档（跳过不炸）
    writeFileSync(
      join(sessionsDir, 'index.json'),
      JSON.stringify({
        v: 1,
        sessions: [
          {
            id: 's-aaa111',
            title: 'React hooks 讨论',
            mode: 'learn',
            createdAt: 1,
            updatedAt: 100
          },
          { id: 's-bbb222', title: '随便聊聊', mode: 'chat', createdAt: 2, updatedAt: 90 },
          { id: 's-ccc333', title: '损坏会话', mode: 'work', createdAt: 3, updatedAt: 80 }
        ]
      }),
      'utf8'
    )
    saveSessionMessages(sessionsDir, 's-aaa111', [
      { id: 'm1', role: 'user', ts: 1, text: 'useEffect 的依赖数组怎么填？' },
      { id: 'm2', role: 'assistant', ts: 2, text: '依赖数组决定 effect 何时重新执行……' }
    ])
    saveSessionMessages(sessionsDir, 's-bbb222', [
      { id: 'm3', role: 'user', ts: 3, text: '今天天气不错' }
    ])
    writeFileSync(join(sessionsDir, 'data', 's-ccc333.json'), '{corrupt', 'utf8')
  })

  it('标题与正文都命中，返回片段；无关会话不出现', async () => {
    const out = String(await historyTool.execute({ query: 'useEffect' }, ctx(root)))
    expect(out).toContain('React hooks 讨论')
    expect(out).toContain('s-aaa111')
    expect(out).toContain('依赖数组')
    expect(out).not.toContain('随便聊聊')
  })

  it('无命中给可读提示；损坏档不炸', async () => {
    const out = String(await historyTool.execute({ query: '不存在的词xyzzy' }, ctx(root)))
    expect(out).toContain('未找到')
    expect(out).toContain('2 个会话') // 损坏档不计入扫描数
  })
})
