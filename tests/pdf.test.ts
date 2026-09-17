// PDF 直读单测（P8-T2）：
// 「发来的/工作区里的 PDF 她能读出正文」是这一项的全部承诺，所以两端都测：
// ① 抽取层（pdf-extract）：页码窗口、分页拼装、扫描件、坏文件收敛；
// ② 接线层（read_file 端到端）：遇 .pdf 自动分流、offset/limit 变页码语义。
//
// fixture 用**极简 PDF 生成器现场造**（ASCII 文本、未压缩内容流、xref 手算偏移）：
// 不引第二个依赖、不改二进制进仓库，且"造得出来就抽得回来"是闭环证据。
// 中文抽取另在真机验过（docs/用户文档/使用说明书.pdf，20 页全中文，正文与页码均正确）。

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PDF_MAX_CHARS,
  classifyPdfError,
  formatPdfPages,
  isPdfFile,
  pageWindow,
  PDF_MAX_PAGES,
  readPdfPages
} from '../src/main/chat/pdf-extract'
import { executeToolCall, setToolPathBase } from '../src/main/agent/tools/registry'

// ── 极简 PDF 生成器（fixture）──────────────────────────────────────────
// 结构：Catalog → Pages → 每页 Page + Contents，字体用标准 Type1/Helvetica。
// 内容流不压缩（`BT ... Tj ET`），xref 偏移按实际写入位置算——pdf.js 能直接读。
interface FixturePage {
  /** 该页正文（ASCII；null = 不写任何文字，模拟扫描页：有页面无文本层） */
  text: string | null
}

function makePdf(pages: FixturePage[]): Buffer {
  type Obj = { num: number; body: string }
  const objs: Obj[] = []
  const kids: string[] = []
  const firstPageNum = 3
  const fontNum = firstPageNum + pages.length * 2
  for (const [i, page] of pages.entries()) {
    const pageNum = firstPageNum + i * 2
    const contentNum = pageNum + 1
    const stream = page.text === null ? '' : `BT /F1 18 Tf 72 720 Td (${page.text}) Tj ET`
    objs.push({
      num: pageNum,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNum} 0 R /Resources << /Font << /F1 ${fontNum} 0 R >> >> >>`
    })
    objs.push({
      num: contentNum,
      body: `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
    })
    kids.push(`${pageNum} 0 R`)
  }
  objs.push({ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' })
  objs.push({ num: 2, body: `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>` })
  objs.push({
    num: fontNum,
    body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  })
  objs.sort((a, b) => a.num - b.num)

  const maxNum = objs[objs.length - 1].num
  let out = '%PDF-1.4\n'
  const offsets = new Map<number, number>()
  for (const o of objs) {
    offsets.set(o.num, out.length)
    out += `${o.num} 0 obj\n${o.body}\nendobj\n`
  }
  const xrefPos = out.length
  out += `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`
  for (let n = 1; n <= maxNum; n += 1) {
    const off = offsets.get(n)
    out +=
      off === undefined ? '0000000000 65535 f \n' : `${String(off).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${maxNum + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  // latin1：内容流里全是 ASCII，保证字节偏移与写入长度一一对应
  return Buffer.from(out, 'latin1')
}

const twoPagePdf = (): Buffer =>
  makePdf([{ text: 'Chapter one: revenue 1234' }, { text: 'Chapter two: cost 567' }])

describe('PDF 抽取（pdf-extract）', () => {
  it('扩展名口径：只认 .pdf（大小写不敏感）', () => {
    expect(isPdfFile('报告.pdf')).toBe(true)
    expect(isPdfFile('REPORT.PDF')).toBe(true)
    expect(isPdfFile('report.docx')).toBe(false)
    expect(isPdfFile('pdf.txt')).toBe(false)
  })

  it('页码窗口：越界钳到合法区间而不是报错；页数封顶', () => {
    expect(pageWindow(10, 1, 3)).toEqual({ from: 1, to: 3 })
    expect(pageWindow(10, 9, 5)).toEqual({ from: 9, to: 10 }) // 尾巴不够就截到末页
    expect(pageWindow(10, 99, 5)).toEqual({ from: 10, to: 10 }) // 起始页越界 → 钳到末页
    expect(pageWindow(10, 0, 5)).toEqual({ from: 1, to: 5 }) // 非法起始页 → 钳到首页
    expect(pageWindow(500, 1, 9999).to).toBe(PDF_MAX_PAGES) // 单次页数上限
  })

  it('分页拼装：每页带【第 N 页】标题，空页不占正文只在末尾汇总', () => {
    const r = formatPdfPages(['甲页正文', '', '丙页正文'], { from: 1, to: 3 })
    expect(r.text).toContain('【第 1 页】\n甲页正文')
    expect(r.text).toContain('【第 3 页】\n丙页正文')
    expect(r.text).not.toContain('【第 2 页】') // 空页不冒充有内容
    expect(r.text).toContain('第 2 页没有文本层')
    expect(r.empty).toBe(false)
    expect(r.truncated).toBe(false)
    expect(r.resumePage).toBeNull()
  })

  it('窗口内全部没文本层 → empty=true（扫描件判定依据）', () => {
    const r = formatPdfPages(['', ''], { from: 1, to: 2 })
    expect(r.empty).toBe(true)
    expect(r.emptyPages).toEqual([1, 2])
  })

  it('超字符上限：停下并给出续读页码（不静默丢内容）', () => {
    const pages = ['A'.repeat(30), 'B'.repeat(30), 'C'.repeat(30)]
    // 单页块宽 = 「【第 N 页】\n」8 字符 + 30 正文 = 38；两块 38 + 2(分隔) + 38 = 78 ≤ 80，
    // 第三块放不下 → 应从第 3 页起停
    const r = formatPdfPages(pages, { from: 1, to: 3, maxChars: 80 })
    expect(r.truncated).toBe(true)
    expect(r.resumePage).toBe(3)
    expect(r.text).toContain('【第 2 页】')
    expect(r.text).not.toContain('【第 3 页】')
    expect(r.text).toContain('offset=3')
  })

  it('字符上限缺省 = PDF_MAX_CHARS', () => {
    const r = formatPdfPages(['x'.repeat(PDF_MAX_CHARS + 100)], { from: 1, to: 1 })
    expect(r.truncated).toBe(true)
  })

  it('错误分类：密码 / 非有效 PDF / 其他都收敛成可执行的下一步', () => {
    expect(classifyPdfError(new Error('PasswordException: No password given'))).toContain('密码')
    expect(classifyPdfError(new Error('InvalidPDFException: Invalid PDF structure'))).toContain(
      '不是有效的 PDF'
    )
    expect(classifyPdfError(new Error('boom'))).toContain('boom')
    expect(classifyPdfError('字符串异常也不炸')).toContain('字符串异常也不炸')
  })

  it('readPdfPages：真实抽回逐页文本与总页数', async () => {
    const r = await readPdfPages(twoPagePdf())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.totalPages).toBe(2)
    expect(r.pages[0]).toContain('revenue 1234')
    expect(r.pages[1]).toContain('cost 567')
  })

  it('readPdfPages：坏文件/空文件收敛为可读错误（绝不抛）', async () => {
    const broken = await readPdfPages(Buffer.from('%PDF-1.4 这不是真 PDF', 'latin1'))
    expect(broken.ok).toBe(false)
    if (!broken.ok) expect(broken.error).toContain('PDF')
    const empty = await readPdfPages(Buffer.alloc(0))
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.error).toContain('空')
  })
})

describe('read_file 读 PDF（端到端接线）', () => {
  let tmp = ''

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aemeath-pdf-'))
    setToolPathBase(tmp)
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('遇 .pdf 自动分流：抽正文 + 按页分段 + offset/limit 变页码语义', async () => {
    const file = join(tmp, '报告.pdf')
    writeFileSync(file, twoPagePdf())
    const signal = new AbortController().signal

    const all = await executeToolCall('read_file', JSON.stringify({ path: file }), signal)
    expect(all.ok).toBe(true)
    expect(all.result).toContain('共 2 页')
    expect(all.result).toContain('【第 1 页】')
    expect(all.result).toContain('revenue 1234')
    expect(all.result).toContain('【第 2 页】')

    const second = await executeToolCall(
      'read_file',
      JSON.stringify({ path: file, offset: 2, limit: 1 }),
      signal
    )
    expect(second.ok).toBe(true)
    expect(second.result).toContain('本次第 2–2 页')
    expect(second.result).toContain('cost 567')
    expect(second.result).not.toContain('revenue 1234')
  })

  it('扫描件：明说"没有文本层"并给下一步，而不是报空内容', async () => {
    const file = join(tmp, '扫描件.pdf')
    writeFileSync(file, makePdf([{ text: null }, { text: null }]))
    const r = await executeToolCall(
      'read_file',
      JSON.stringify({ path: file }),
      new AbortController().signal
    )
    expect(r.ok).toBe(true)
    expect(r.result).toContain('没有文本层')
    expect(r.result).toContain('截图')
  })

  it('坏 PDF：可读错误（而不是"含 NUL 字节"天书）', async () => {
    const file = join(tmp, '坏的.pdf')
    writeFileSync(file, Buffer.from('%PDF-1.4 坏掉了', 'latin1'))
    const r = await executeToolCall(
      'read_file',
      JSON.stringify({ path: file }),
      new AbortController().signal
    )
    expect(r.ok).toBe(false)
    expect(r.result).toContain('PDF')
    expect(r.result).not.toContain('NUL')
  })

  it('回归：文本文件仍走行号通道（PDF 分流没打坏原路径）', async () => {
    const file = join(tmp, 'a.txt')
    writeFileSync(file, 'hello\nworld\nthird')
    const r = await executeToolCall(
      'read_file',
      JSON.stringify({ path: file, offset: 2, limit: 1 }),
      new AbortController().signal
    )
    expect(r.ok).toBe(true)
    expect(r.result).toContain('2→ world')
    expect(r.result).toContain('行')
  })
})
