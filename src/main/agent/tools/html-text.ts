// HTML → 纯文本转换。
// 设计取舍：不做 Markdown 保真，只求
// 「标题 + 干净正文」喂给模型——剥掉脚本/样式/注释，块级标签折行，解常见实体，
// 压缩空白并按 maxChars 截断。表格/链接结构保真的需求出现时再议转换依赖。

/** 常见命名字符实体 → 字符（顺序无关，逐个替换） */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  middot: '·',
  laquo: '«',
  raquo: '»',
  times: '×',
  divide: '÷',
  cent: '¢',
  pound: '£',
  yen: '¥',
  euro: '€',
  deg: '°',
  plusmn: '±',
  frac12: '½',
  sup2: '²',
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  szlig: 'ß'
}

/** 解码命名字符实体与数字实体（&#160; / &#xA0;）；未知实体原样保留 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = parseInt(body.slice(2), 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole
    }
    if (body.startsWith('#')) {
      const code = parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named ?? whole
  })
}

/** 会产生换行的块级标签闭合处（把结构变成可读的行） */
const BLOCK_BREAK =
  /<\/?(?:p|div|section|article|header|footer|main|nav|aside|ul|ol|dl|li|dt|dd|table|thead|tbody|tr|h[1-6]|blockquote|pre|figure|figcaption|form|fieldset|hr|br)\b[^>]*>/gi

/** 提取 <title>；没有返回空串 */
function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (m === null) return ''
  return decodeEntities(m[1].replace(/\s+/g, ' ')).trim()
}

/**
 * HTML → 纯文本。
 * 步骤：剥 script/style/noscript/svg 与注释 → 块级标签折行 → 剩余标签剥掉 →
 * 解实体 → 逐行压空白、去空行收敛（≤2 连续换行）。
 */
export function htmlToText(html: string): { title: string; text: string } {
  const title = extractTitle(html)
  let s = html
  // 脚本/样式/注释整体删除（内部文本对阅读无意义且极噪）
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<(script|style|noscript|svg|template|iframe|object)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  // 块级边界折行（闭合与开标签都算边界）
  s = s.replace(BLOCK_BREAK, '\n')
  // 剩余标签一律剥掉
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  // 逐行压空白 + 收敛空行
  const lines = s
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter((line, i, arr) => line !== '' || (arr[i - 1] ?? '') !== '')
  const text = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text }
}
