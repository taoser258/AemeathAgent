/**
 * Office 文档（docx / xlsx / pptx）文本级内联预览。
 *
 * 零依赖路线：OOXML 三件套本质是 ZIP 包 + XML，用 Node 内置 zlib 手解
 * ZIP central directory，正则扫 XML 提取文本级结构（标题/段落/表格/工作表/幻灯片）。
 * 这是「预览」不是「还原排版」——不解析样式、图片、公式结果以外的东西；
 * 排版级查看仍走「用系统默认应用打开」。
 *
 * 为什么不用第三方库（mammoth/SheetJS）：项目依赖清单纪律；且预览场景只要
 * 文本结构，自解 ~200 行可控可逐行读懂。
 */
import { inflateRawSync } from 'zlib'
import type { OfficeBlock, OfficePreview } from '@shared/types'

// ───────────────────────── ZIP 最小读取 ─────────────────────────

/** ZIP 内单个文件的内容（已解压） */
interface ZipEntry {
  name: string
  data: Buffer
}

/**
 * 解析 ZIP：从尾部找 EOCD（End of Central Directory），按 central directory
 * 逐项定位本地头再解压。只支持 store/deflate 两种压缩（OOXML 实际只用这两种）。
 * 返回 名称→内容 的 Map；非 ZIP / 加密项 / 损坏时抛错由调用方兜底。
 */
export function readZip(buf: Buffer): Map<string, ZipEntry> {
  const out = new Map<string, ZipEntry>()
  // EOCD 签名 0x06054b50；注释最长 65535，从尾部往前扫
  let eocd = -1
  const scanFrom = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到 EOCD）')
  const total = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16) // central directory 起始
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('ZIP central directory 损坏')
    const flags = buf.readUInt16LE(off + 8)
    if ((flags & 0x1) !== 0) throw new Error('ZIP 条目已加密（Office 文档设了打开密码）')
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8')
    // 本地文件头：30 字节定长 + 名字 + 扩展区，数据紧跟其后
    const localNameLen = buf.readUInt16LE(localOff + 26)
    const localExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + localNameLen + localExtraLen
    const raw = buf.subarray(dataStart, dataStart + compSize)
    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw)
    else throw new Error(`不支持的 ZIP 压缩方式 ${method}`)
    out.set(name, { name, data })
    off += 46 + nameLen + extraLen + commentLen
  }
  return out
}

// ───────────────────────── 预览数据结构 ─────────────────────────
// 类型定义在 shared/types.ts（渲染层也要消费），这里只引用

// 规模护栏：防超大文档把渲染层打满（预览够用即可）
const MAX_BLOCKS = 4000
const MAX_CHARS = 200_000
const MAX_TABLE_ROWS = 200
const MAX_TABLE_COLS = 60

class Budget {
  blocks = 0
  chars = 0
  truncated = false
  add(text: string): boolean {
    this.blocks += 1
    this.chars += text.length
    if (this.blocks > MAX_BLOCKS || this.chars > MAX_CHARS) {
      this.truncated = true
      return false
    }
    return true
  }
}

// ───────────────────────── XML 文本提取 ─────────────────────────

/** 解码常见 XML 实体 + 数字实体（&#38; / &#x26;） */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
}

/** 去掉标签只留文本（先剔除注释与 CDATA 标记） */
function stripTags(s: string): string {
  return decodeEntities(s.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ''))
}

// ───────────────────────── docx ─────────────────────────

/**
 * 提取 docx 正文：按顺序扫 body 内的 w:p（段落）与 w:tbl（表格）。
 * 段落样式 pStyle=Heading1~6 → heading 块；表格行嵌套表按「一层」处理
 * （嵌套表极少见，正则深度计数只把最外层 w:tbl 当表格）。
 */
function extractDocx(xml: string, budget: Budget): OfficeBlock[] {
  const blocks: OfficeBlock[] = []
  const body = xml.slice(xml.indexOf('<w:body>') + 8, xml.lastIndexOf('</w:body>'))
  // 顶层结构扫描：游标推进，遇到 <w:tbl> 就整段吃掉直到配对的 </w:tbl>
  let i = 0
  while (i < body.length && !budget.truncated) {
    const nextP = body.indexOf('<w:p ', i)
    const nextP2 = body.indexOf('<w:p>', i)
    const nextTbl =
      body.indexOf('<w:tbl>', i) >= 0 ? body.indexOf('<w:tbl>', i) : body.indexOf('<w:tbl ', i)
    const candidates = [nextP, nextP2, nextTbl].filter((x) => x >= 0)
    if (candidates.length === 0) break
    const pos = Math.min(...candidates)
    if (nextTbl >= 0 && pos === nextTbl) {
      // 表格：找配对结束（简单深度计数）
      let depth = 1
      let j = pos + 7
      while (j < body.length && depth > 0) {
        const open = body.indexOf('<w:tbl', j)
        const close = body.indexOf('</w:tbl>', j)
        if (close < 0) break
        if (open >= 0 && open < close) {
          depth += 1
          j = open + 6
        } else {
          depth -= 1
          if (depth === 0) {
            j = close
            break
          }
          j = close + 8
        }
      }
      const tblXml = body.slice(pos, j)
      const rows: string[][] = []
      let rowEnd = -1
      let rowCount = 0
      while (rowCount < MAX_TABLE_ROWS) {
        const tr = tblXml.indexOf('<w:tr', rowEnd + 1)
        const trEnd = tblXml.indexOf('</w:tr>', tr)
        if (tr < 0 || trEnd < 0) break
        const trXml = tblXml.slice(tr, trEnd)
        const cells: string[] = []
        let cellPos = 0
        for (;;) {
          const tc = trXml.indexOf('<w:tc>', cellPos)
          const tc2 = trXml.indexOf('<w:tc ', cellPos)
          const start = tc < 0 ? tc2 : tc2 < 0 ? tc : Math.min(tc, tc2)
          const end = trXml.indexOf('</w:tc>', start)
          if (start < 0 || end < 0) break
          // 单元格内所有 w:t 拼接（多段落用空格连接）
          const cellText = [
            ...trXml.slice(start, end).matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)
          ]
            .map((m) => decodeEntities(m[1]))
            .join(' ')
          cells.push(cellText)
          cellPos = end + 7
          if (cells.length >= MAX_TABLE_COLS) break
        }
        rows.push(cells)
        rowEnd = trEnd
        rowCount += 1
      }
      if (rows.length > 0) {
        budget.add('')
        blocks.push({ type: 'table', rows })
      }
      i = j + 8
      continue
    }
    // 段落：<w:p ...> … </w:p>（注意自闭合 <w:p/>）
    const pEnd = body.indexOf('</w:p>', pos)
    const selfClose = body.indexOf('>', pos)
    if (pEnd < 0) break
    if (selfClose >= 0 && body[selfClose - 1] === '/' && selfClose < pEnd) {
      i = selfClose + 1 // 空段落自闭合，跳过
      continue
    }
    const pXml = body.slice(pos, pEnd)
    const text = [...pXml.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((m) => decodeEntities(m[1]))
      .join('')
    const style = /<w:pStyle w:val="([^"]+)"/.exec(pXml)?.[1] ?? ''
    const heading = /^Heading([1-6])/i.exec(style) ?? /^heading([1-6])/i.exec(style)
    if (text.trim() !== '') {
      if (budget.add(text)) {
        blocks.push(
          heading !== null
            ? { type: 'heading', level: Number(heading[1]), text: text.trim() }
            : { type: 'para', text: text.trim() }
        )
      }
    }
    i = pEnd + 6
  }
  return blocks
}

// ───────────────────────── xlsx ─────────────────────────

/** sharedStrings：每个 <si> 内所有 <t> 拼接（富文本 <r><t> 天然被覆盖） */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = []
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    out.push(
      [...m[1].matchAll(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => decodeEntities(t[1])).join('')
    )
  }
  return out
}

/** 列号（A1 里的 A/AA…）→ 0 基下标 */
function colIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function extractXlsx(zip: Map<string, ZipEntry>, budget: Budget): OfficeBlock[] {
  const blocks: OfficeBlock[] = []
  const shared = zip.has('xl/sharedStrings.xml')
    ? parseSharedStrings(zip.get('xl/sharedStrings.xml')!.data.toString('utf8'))
    : []
  // 工作表按 workbook.xml 的声明顺序（sheet1、sheet2… 的 rId 映射太绕，
  // 预览场景按文件名数字序足够直观）
  const sheetNames = [...zip.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0))
  for (const key of sheetNames) {
    if (budget.truncated) break
    const xml = zip.get(key)!.data.toString('utf8')
    // 工作表名从 workbook.xml 里按顺序取（取不到就用文件名）
    const sheetIdx = sheetNames.indexOf(key) + 1
    const wb = zip.has('xl/workbook.xml') ? zip.get('xl/workbook.xml')!.data.toString('utf8') : ''
    const wbNames = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => decodeEntities(m[1]))
    const name = wbNames[sheetIdx - 1] ?? key
    budget.add(name)
    blocks.push({ type: 'sheet', name })
    let rowEnd = -1
    let rowCount = 0
    while (rowCount < MAX_TABLE_ROWS) {
      const tr = xml.indexOf('<row', rowEnd + 1)
      const trEnd = xml.indexOf('</row>', tr)
      if (tr < 0 || trEnd < 0) break
      const rowXml = xml.slice(tr, trEnd)
      const cells: string[] = []
      let gapGuard = 0
      for (const cm of rowXml.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1]
        const inner = cm[2] ?? ''
        const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? ''
        const idx = ref === '' ? cells.length : colIndex(ref)
        // 稀疏列（跳过的空单元格）补空串保持对齐
        while (cells.length < idx && gapGuard < MAX_TABLE_COLS) {
          cells.push('')
          gapGuard += 1
        }
        const t = /t="([^"]+)"/.exec(attrs)?.[1] ?? 'n'
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? ''
        const inline = /<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? ''
        let text = ''
        if (t === 's') text = shared[Number(v)] ?? ''
        else if (t === 'inlineStr')
          text = [...inline.matchAll(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/g)]
            .map((m) => decodeEntities(m[1]))
            .join('')
        else text = decodeEntities(stripTags(v))
        cells.push(text)
        if (cells.length >= MAX_TABLE_COLS) break
      }
      if (cells.some((c) => c !== '')) {
        if (!budget.add(cells.join(''))) break
        blocks.push({ type: 'table', rows: [cells] })
      }
      rowEnd = trEnd
      rowCount += 1
    }
  }
  return blocks
}

// ───────────────────────── pptx ─────────────────────────

function extractPptx(zip: Map<string, ZipEntry>, budget: Budget): OfficeBlock[] {
  const blocks: OfficeBlock[] = []
  const slideKeys = [...zip.keys()]
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0))
  slideKeys.forEach((key, n) => {
    if (budget.truncated) return
    const xml = zip.get(key)!.data.toString('utf8')
    budget.add('')
    blocks.push({ type: 'slide', index: n + 1 })
    // 文本框：每个 <a:t> 序列按 <a:p> 段落聚合
    for (const pm of xml.matchAll(/<a:p(?:>| [^>]*>)([\s\S]*?)<\/a:p>/g)) {
      const text = [...pm[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
        .map((m) => decodeEntities(m[1]))
        .join('')
      if (text.trim() !== '' && budget.add(text)) blocks.push({ type: 'para', text: text.trim() })
    }
    // 表格（a:tbl）：行 a:tr、格 a:tc
    for (const tm of xml.matchAll(/<a:tbl>([\s\S]*?)<\/a:tbl>/g)) {
      const rows: string[][] = []
      for (const rm of tm[1].matchAll(/<a:tr(?: [^>]*)?>([\s\S]*?)<\/a:tr>/g)) {
        const cells: string[] = []
        for (const cm of rm[1].matchAll(/<a:tc(?:>| [^>]*>)([\s\S]*?)<\/a:tc>/g)) {
          const text = [...cm[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
            .map((m) => decodeEntities(m[1]))
            .join(' ')
          cells.push(text)
          if (cells.length >= MAX_TABLE_COLS) break
        }
        rows.push(cells)
        if (rows.length >= MAX_TABLE_ROWS) break
      }
      if (rows.length > 0 && budget.add('')) blocks.push({ type: 'table', rows })
    }
  })
  return blocks
}

// ───────────────────────── 入口 ─────────────────────────

/**
 * 解析 Office 文档为文本级预览块。抛错由调用方兜底成错误态
 * （加密/损坏/非 OOXML 的旧 .doc 等都会走到这里被拒）。
 */
export function parseOffice(buf: Buffer, ext: string): OfficePreview {
  // OLE2 复合文档 = 加密的 OOXML（EncryptedPackage 流）或旧 .doc/.xls/.ppt——
  // 提前给出人话错误，别让 ZIP 解析报「找不到 EOCD」
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0xe011cfd2) {
    throw new Error('这是加密的 Office 文档或 2003 以前的旧格式（.doc/.xls/.ppt），无法内联预览')
  }
  const zip = readZip(buf)
  const budget = new Budget()
  const format = ext === '.docx' ? 'docx' : ext === '.xlsx' ? 'xlsx' : 'pptx'
  let blocks: OfficeBlock[]
  if (format === 'docx') {
    const entry = zip.get('word/document.xml')
    if (entry === undefined) throw new Error('docx 缺少 word/document.xml（文件可能损坏）')
    blocks = extractDocx(entry.data.toString('utf8'), budget)
  } else if (format === 'xlsx') {
    blocks = extractXlsx(zip, budget)
  } else {
    blocks = extractPptx(zip, budget)
  }
  return { format, blocks, truncated: budget.truncated, chars: budget.chars }
}
