// PDF 正文抽取（P8-T2）：
// 起因——把 .pdf 发给她或让她读工作区里的 PDF，此前只有一句"读不了正文,请用户粘贴"。
// 现在 read_file 遇 .pdf 自动分流到这里（她读文件时不会先想"这是不是 PDF"），
// 聊天附件侧也在选文件那刻就把正文抽出来内联（与 doc-extract.ts 同口径）。
//
// 依赖：unpdf（unjs，**0 依赖**、2.2MB，内含 serverless 版 PDF.js——worker 内联、
// 自带 polyfill，Node ≥22 直接用）。选型理由与排除 pdfjs-dist / pdf-parse 的过程见
// docs/交接文档/交接文档-P8.md §1.2：后两者要原生 canvas（@napi-rs/canvas），
// 我们只要文本层，不该为此背一个原生二进制。
//
// 本模块只做「字节 → 分页正文」这一件事，纯逻辑（页码范围 / 拼装 / 错误分类）与
// IO 分离，vitest 可直接单测（用 tests/pdf.test.ts 里的极简生成器现场造 PDF）。

import { extractText } from 'unpdf'

/** 单次交付给模型的正文上限（与 doc-extract 的 DOC_MAX_CHARS 同口径，防长文档挤爆上下文） */
export const PDF_MAX_CHARS = 40_000
/** 读取前的体积闸门：PDF 常比文本文件大得多，但几百 MB 的扫描件会把内存拖爆 */
export const PDF_MAX_BYTES = 60 * 1024 * 1024
/** read_file 读 PDF 的默认页窗口（页码语义见 readFileTool 的描述） */
export const PDF_DEFAULT_PAGES = 20
/** 单次最多读多少页 */
export const PDF_MAX_PAGES = 100

/** 扩展名口径：只认 .pdf（大小写不敏感） */
export function isPdfFile(name: string): boolean {
  return /\.pdf$/i.test(name)
}

/**
 * 页码范围钳制（纯函数）：
 * `offset` = 起始页（从 1 开始），`limit` = 最多页数。
 * 越界一律钳到合法区间而不是报错——模型给了个离谱页码时，
 * 回一段最接近的内容比回一句"参数非法"有用（同 calculate 的钳制思路）。
 */
export function pageWindow(
  totalPages: number,
  offset: number,
  limit: number
): { from: number; to: number } {
  const total = Number.isFinite(totalPages) ? Math.max(0, Math.floor(totalPages)) : 0
  const from = Math.min(Math.max(1, Math.floor(offset)), Math.max(total, 1))
  const span = Math.min(Math.max(1, Math.floor(limit)), PDF_MAX_PAGES)
  const to = Math.min(from + span - 1, total)
  return { from, to }
}

export interface FormattedPdf {
  /** 带【第 N 页】标题的正文（可能被截断） */
  text: string
  /** 是否因字符上限被截断 */
  truncated: boolean
  /** 窗口内所有页都没有文本层（扫描件/纯图片 PDF） */
  empty: boolean
  /** 被截断时的续读页码（未截断则为 null） */
  resumePage: number | null
  /** 窗口内没有文本层的页码（扫描页混排时点出来，别让她以为丢内容了） */
  emptyPages: number[]
}

/**
 * 逐页文本 → 交付给模型的分页正文（纯函数）。
 * - 每页一个 `【第 N 页】` 标题（她引用页码时才对得上）
 * - 无文本层的页不占正文，只在末尾汇总一句
 * - 超 `maxChars` 即停，并标注从第几页起可续读
 */
export function formatPdfPages(
  pages: readonly string[],
  opts: { from: number; to: number; maxChars?: number }
): FormattedPdf {
  const maxChars = opts.maxChars ?? PDF_MAX_CHARS
  const parts: string[] = []
  const emptyPages: number[] = []
  let used = 0
  let truncated = false
  let resumePage: number | null = null

  for (let p = opts.from; p <= opts.to; p += 1) {
    const body = (pages[p - 1] ?? '').trim()
    if (body === '') {
      emptyPages.push(p)
      continue
    }
    const block = `【第 ${p} 页】\n${body}`
    // 空页会被跳过，所以"已用字符"要用实际拼进去的块来算
    const cost = block.length + (parts.length > 0 ? 2 : 0)
    if (used + cost > maxChars) {
      truncated = true
      resumePage = p
      break
    }
    parts.push(block)
    used += cost
  }

  const shown = pages.slice(opts.from - 1, opts.to).filter((t) => t.trim() !== '').length
  let text = parts.join('\n\n')
  if (truncated && resumePage !== null) {
    text += `\n\n…（正文超出 ${maxChars} 字符上限，第 ${resumePage} 页起未显示；可用 offset=${resumePage} 继续读）`
  }
  if (emptyPages.length > 0) {
    const label =
      emptyPages.length > 1 ? `第 ${emptyPages.join('、')} 页` : `第 ${emptyPages[0]} 页`
    text += `\n（${label}没有文本层，多为图片/扫描页）`
  }
  return { text, truncated, empty: shown === 0, resumePage, emptyPages }
}

/**
 * 错误 → 可读中文（纯函数）。
 * 模型只会看到这句话，所以要说清"下一步怎么办"，而不是丢个堆栈。
 */
export function classifyPdfError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/password/i.test(msg)) {
    return '这个 PDF 有密码保护，读不了正文——需要用户先解除密码（或另存一份无密码版）再读。'
  }
  if (/invalid|structure|corrupt|format/i.test(msg)) {
    return '这个文件不是有效的 PDF（可能已损坏，或只是改了后缀名）——读不了正文。'
  }
  return `PDF 解析失败：${msg}`
}

export type PdfPagesResult =
  { ok: true; totalPages: number; pages: string[] } | { ok: false; error: string }

/**
 * 字节 → 逐页文本（薄封装，唯一碰 unpdf 的地方）。
 * 失败一律收敛为可读 error（不抛异常）：调用方要么回一句提示，
 * 要么退化为文件名校验——绝不该因为一个坏 PDF 打断对话。
 */
export async function readPdfPages(buf: Buffer): Promise<PdfPagesResult> {
  if (buf.length === 0) return { ok: false, error: '文件是空的（0 字节），不是有效的 PDF。' }
  if (buf.length > PDF_MAX_BYTES) {
    return {
      ok: false,
      error: `PDF 过大（${Math.round(buf.length / 1024 / 1024)} MB > ${PDF_MAX_BYTES / 1024 / 1024} MB），拒绝解析——请让用户拆分或提供关键页截图。`
    }
  }
  try {
    // mergePages: false → 按页拿文本，才能给【第 N 页】标题、才能做页窗口
    const res = await extractText(new Uint8Array(buf), { mergePages: false })
    return { ok: true, totalPages: res.totalPages, pages: res.text }
  } catch (err) {
    return { ok: false, error: classifyPdfError(err) }
  }
}

/** 扫描件/图片型 PDF 的统一口径（owner 拍板：先只提示，不在此转图识图） */
export const SCANNED_PDF_HINT =
  '这份 PDF 没有文本层（扫描件/图片型 PDF），读不出正文——如需内容，请让用户把关键页截图发来（截图她能看图），或提供文本版；不要为此搜索磁盘。'
