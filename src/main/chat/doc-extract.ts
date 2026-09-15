// 附件文档正文抽取：
// 起因——把 .docx 发给她，她读不到正文（附件只留了个文件名），只能满磁盘找文件。
// "发给她 = 她能看"，所以选择文件的那一刻就把正文抽出来，随消息内联给模型。
//
// 零依赖：Office 现代格式（docx/xlsx/pptx）就是 ZIP + XML——Node 内置 zlib 解出 zip 条目，
// 再按格式剥 XML 标签。不用第三方解析库（依赖清单从紧，且这些库都是生成向的）。
// 本模块无 electron 依赖，vitest 可直接单测（用 docx/exceljs/pptxgenjs 现场造包再抽，
// 闭环验证"生成的文档能被自己读回来"）。

import { inflateRawSync } from 'zlib'
import { decodeEntities } from '../agent/tools/html-text'

/** 支持正文抽取的扩展名（旧版二进制 .doc/.xls/.ppt 不是 zip，抽不了） */
const OFFICE_TEXT_EXT = /\.(docx|xlsx|pptx)$/i
/** 单个文档的抽取上限字符数——与文本附件同一口径（超限截断并标注） */
export const DOC_MAX_CHARS = 40_000
/** 解压前的体积闸门：防止误读超大二进制（几 GB 的包）——**但正文 XML 只占其中极小比例**，
 * 所以闸门要放得比"文本量"宽得多。 实测：96MB 的 docx（塞满图片、
 * document.xml 7.7MB）此前被 48MB 闸门挡下 → 退化成文件名占位，她只能自己拆包硬解。
 * 现在放到 400MB（文本抽取本身仍截断到 DOC_MAX_CHARS）。 */
const MAX_INPUT_BYTES = 400 * 1024 * 1024
/** 解压后的累计字节闸门：防 zip 炸弹（单个条目声称巨大时提前收手） */
const MAX_INFLATED_BYTES = 64 * 1024 * 1024

export function isExtractableDoc(name: string): boolean {
  return OFFICE_TEXT_EXT.test(name)
}

// ── 极简 ZIP 读取（只做"从中央目录定位条目 + inflateRaw"两件事）─────────────
// 结构：EOCD 在文件尾 → 中央目录逐条列出（含本地头偏移）→ 本地头之后才是数据。
// 不处理 zip64 / 加密 / 分卷——Office 文档不会这样；遇到就返回空表（上层退化为文件名占位）。

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  localOffset: number
}

function readZipEntries(buf: Buffer): ZipEntry[] {
  // EOCD 签名 0x06054b50：从尾部往前找（注释最长 65535 字节）
  const minPos = Math.max(0, buf.length - 65557)
  let eocd = -1
  for (let i = buf.length - 22; i >= minPos; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return []
  const count = buf.readUInt16LE(eocd + 10)
  let pos = buf.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i += 1) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) break
    const method = buf.readUInt16LE(pos + 10)
    const compressedSize = buf.readUInt32LE(pos + 20)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)
    const localOffset = buf.readUInt32LE(pos + 42)
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen)
    entries.push({ name, method, compressedSize, localOffset })
    pos += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** 取某条目内容（未压缩 = 直拷；deflate = inflateRaw；其它方法不支持） */
function readEntry(buf: Buffer, entry: ZipEntry): Buffer | null {
  const off = entry.localOffset
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== 0x04034b50) return null
  const nameLen = buf.readUInt16LE(off + 26)
  const extraLen = buf.readUInt16LE(off + 28)
  const start = off + 30 + nameLen + extraLen
  const size = entry.compressedSize
  if (start + size > buf.length) return null
  const raw = buf.subarray(start, start + size)
  if (entry.method === 0) return raw
  if (entry.method === 8) {
    try {
      return inflateRawSync(raw, { maxOutputLength: MAX_INFLATED_BYTES })
    } catch {
      return null
    }
  }
  return null
}

// ── XML → 纯文本 ────────────────────────────────────────────────────────
/** 剥标签 + 解实体（结构标签先在调用侧换成换行/制表符） */
function stripXml(xml: string): string {
  return decodeEntities(xml.replace(/<[^>]*>/g, ''))
}

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 按文档顺序取出所有匹配标签的内容片段 */
function collect(xml: string, re: RegExp): string[] {
  const out: string[] = []
  for (const m of xml.matchAll(re)) out.push(m[1])
  return out
}

// ── Word（.docx）：word/document.xml ────────────────────────────────────
function extractDocx(files: Map<string, Buffer>): string | null {
  const entry = files.get('word/document.xml')
  if (entry === undefined) return null
  let xml = entry.toString('utf8')
  const body = xml.indexOf('<w:body')
  if (body >= 0) xml = xml.slice(body) // 只取正文，跳过样式/关系声明
  const text = tidy(
    stripXml(
      xml
        .replace(/<w:tab\b[^>]*\/>/g, '\t')
        .replace(/<w:br\b[^>]*\/>/g, '\n')
        .replace(/<\/w:tc>/g, '\t') // 单元格分隔（否则整行黏成一串）
        .replace(/<\/w:p>/g, '\n') // 段落 = 行
        .replace(/<\/w:tr>/g, '\n')
    )
  )
  return text === '' ? null : text
}

// ── Excel（.xlsx）：sharedStrings.xml + 首个工作表 ───────────────────────
function extractXlsx(files: Map<string, Buffer>): string | null {
  const shared = files.get('xl/sharedStrings.xml')?.toString('utf8') ?? ''
  // 共享串按 <si> 顺序成表；<rPh> 是拼音注音，丢掉免得混进正文
  const strings = collect(shared.replace(/<rPh[\s\S]*?<\/rPh>/g, ''), /<si>([\s\S]*?)<\/si>/g).map(
    (s) => stripXml(s)
  )

  const sheetName = [...files.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0]
  if (sheetName === undefined) return null
  const sheet = files.get(sheetName)?.toString('utf8') ?? ''

  const lines: string[] = []
  for (const rowMatch of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = []
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1]
      const inner = cellMatch[2]
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? ''
      if (type === 's') {
        const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '')
        cells.push(Number.isInteger(idx) ? (strings[idx] ?? '') : '')
      } else if (type === 'inlineStr') {
        cells.push(stripXml(inner))
      } else {
        cells.push(stripXml(inner))
      }
    }
    const line = cells.join('\t').replace(/\t+$/, '') // 尾部空单元格不留制表符
    if (line.trim() !== '') lines.push(line)
  }
  const text = tidy(lines.join('\n'))
  return text === '' ? null : text
}

// ── PowerPoint（.pptx）：ppt/slides/slideN.xml ──────────────────────────
function extractPptx(files: Map<string, Buffer>): string | null {
  const slides = [...files.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  if (slides.length === 0) return null
  const parts: string[] = []
  for (const [i, name] of slides.entries()) {
    const xml = files.get(name)?.toString('utf8') ?? ''
    // <a:p> 是一段；段内多个 <a:t> 是同一段的文本片段，用 '' 拼接（否则中文句子被切碎）
    const paras = collect(xml, /<a:p>([\s\S]*?)<\/a:p>/g)
      .map((p) =>
        collect(p, /<a:t>([\s\S]*?)<\/a:t>/g)
          .map((t) => stripXml(t))
          .join('')
      )
      .filter((p) => p.trim() !== '')
    if (paras.length > 0) parts.push(`【第 ${i + 1} 页】\n${paras.join('\n')}`)
  }
  const text = tidy(parts.join('\n\n'))
  return text === '' ? null : text
}

/**
 * 抽取 Office 文档正文（纯函数，失败返回 null → 调用方退化为"仅文件名"占位）。
 * 截断上限 DOC_MAX_CHARS，末尾标注，避免长文档挤爆上下文。
 */
export function extractOfficeText(buf: Buffer, name: string): string | null {
  if (buf.length === 0 || buf.length > MAX_INPUT_BYTES) return null
  const lower = name.toLowerCase()
  if (!OFFICE_TEXT_EXT.test(lower)) return null
  const entries = readZipEntries(buf)
  if (entries.length === 0) return null
  const files = new Map<string, Buffer>()
  // 只解自己需要的那几个条目（docx：文档；xlsx：共享串 + 工作表；pptx：各页）
  const wanted =
    /^(word\/document\.xml|xl\/sharedStrings\.xml|xl\/worksheets\/sheet\d+\.xml|ppt\/slides\/slide\d+\.xml)$/
  for (const e of entries) {
    if (!wanted.test(e.name)) continue
    const data = readEntry(buf, e)
    if (data !== null) files.set(e.name, data)
  }
  let text: string | null = null
  if (lower.endsWith('.docx')) text = extractDocx(files)
  else if (lower.endsWith('.xlsx')) text = extractXlsx(files)
  else text = extractPptx(files)
  if (text === null) return null
  if (text.length > DOC_MAX_CHARS) {
    text = `${text.slice(0, DOC_MAX_CHARS)}\n…（文档正文超出 ${DOC_MAX_CHARS} 字符，已截断）`
  }
  return text
}
