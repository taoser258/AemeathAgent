// web_search v1：免 key 多引擎联网搜索。
// 思路对齐 free-search（DDMUC/free-search，MIT）：**不调搜索 API，直接抓公开结果页**。
// 引擎链 ddg-lite → ddg(html) → bing → searxng(公共实例池)，首个成功即返回——DDG 常被
// 反爬挑战，必须多引擎兜底；浏览器 UA 伪装 + 重试 + LRU 缓存压限流。
// 零依赖：Node 内置 fetch + 正则解析（HTML 结构变化时只需修对应 parse 函数）。
// 本模块保持无 electron 依赖，vitest 可直接单测（解析函数均导出）。
//
// 两个叠加根因——
// ① DDG 国内直连超时（Node fetch 不走系统代理）：每次白烧 6s+6s 才轮到 bing；
// 出站改走 netFetch（main 注入 Electron net.fetch=尊重系统代理，Clash 用户 DDG 可达）。
// ② bing 对裸请求的多词中文查询返回降级页（把"某高校 双一流学科"理解成
// "南京"，全是景点——她说的"污染"其实是这个）：DDG 恢复后自然优先吃到好结果；
// 另加引擎健康度：连续失败的引擎冷却降权到链尾，无代理用户不再每次白等 12s。
//
// 9.15 二轮修：实测定因——本机直连下
// sogou 2.5s/485KB 正常、**360(so.com) 2.3s/366KB 正常**、baidu 567B 封、bing 238B 封；
// 而链里 sogou 一旦失败就被冷却 10 分钟 → 顺序变成 ddg-lite(6s 超时)→ddg(6s 超时)→bing，
// 既慢又必然吃 bing 的降级页。三处修：
// ① **补 360 搜索**（国内直连可用、中文不降级）——sogou 挂掉时的同级别 CN 兜底；
// ② **相关性闸门**：结果集与查询词零重叠 = 引擎降级页，判失败继续走链（不再把垃圾当成功）；
// ③ 全部引擎都只给出不相关结果时，返回最好的一份但标 suspect，工具回执如实提示用户。

import { decodeEntities } from './html-text'
import { netFetch } from '../../net/fetch'

/** 浏览器 UA：公开结果页对非浏览器 UA 直接 403（free-search 同款实践） */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const ACCEPT_LANG = 'zh-CN,zh;q=0.9,en;q=0.8'
const DDG_LITE_URL = 'https://lite.duckduckgo.com/lite/'
const DDG_HTML_URL = 'https://html.duckduckgo.com/html/'
const BING_URL = 'https://www.bing.com/search'
/** 搜狗：国内直连可用，且中文多词查询不像 bing 那样对裸请求降级（
 * 「苏州大学 计算机 学科评估」bing 全返苏州景点，sogou 条条命中） */
const SOGOU_URL = 'https://www.sogou.com/web'
/** 360 搜索（9.15 实测补入）：国内直连 2.3s/366KB 正常，中文查询不降级——
 * sogou 失败被冷却时的同级别 CN 兜底，避免直接掉进 DDG 超时 + bing 降级页 */
const SO_URL = 'https://www.so.com/s'
/** SearXNG 公共实例池（逐实例尝试；多数实例默认关闭 json 格式，失败顺延下一个） */
const SEARXNG_INSTANCES = [
  'https://searx.be',
  'https://searx.tiekoetter.com',
  'https://priv.au',
  'https://paulgo.io',
  'https://opnxng.com',
  'https://search.inetol.net'
]

/** 单引擎请求超时（整链受工具级 30s 覆盖约束——最多试 4 个引擎） */
const PER_ENGINE_TIMEOUT_MS = 6_000
/** 缓存：LRU 50 条 / TTL 5 分钟（防限流的核心，free-search 同款参数） */
const CACHE_MAX = 50
const CACHE_TTL_MS = 5 * 60 * 1000
/** 结果条数上限 */
const MAX_RESULTS_LIMIT = 20

export interface WebSearchItem {
  title: string
  url: string
  snippet: string
}

export interface WebSearchOutcome {
  /** 实际命中的引擎名（回执里告诉用户，便于判断结果可信度/限流状态） */
  engine: string
  items: WebSearchItem[]
  /** 是否来自缓存（命中缓存不重复请求，省限流配额） */
  cached: boolean
  /** 全部引擎都只给出与查询词零重叠的结果（疑似搜索引擎降级页）——回执须如实提醒 */
  suspect?: boolean
}

/** 剥标签 + 解实体 + 压空白（引用正文转换器的实体解码，口径统一） */
function stripTags(html: string): string {
  return decodeEntities(
    String(html)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/** DDG 结果链接是 //duckduckgo.com/l/?uddg=<urlencoded> 跳转壳——提取真实 URL */
export function decodeDdgUrl(rel: string | undefined): string | null {
  if (rel === undefined || rel === '') return null
  const m = /uddg=([^&]+)/.exec(rel)
  if (m !== null) {
    try {
      return decodeURIComponent(m[1])
    } catch {
      return m[1]
    }
  }
  // 少数结果是直链（无跳转壳）
  if (/^https?:\/\//i.test(rel)) return rel
  return null
}

/** 去重（按 URL）+ 截断到 limit */
export function uniqueItems(items: WebSearchItem[], limit: number): WebSearchItem[] {
  const seen = new Set<string>()
  const out: WebSearchItem[] = []
  for (const s of items) {
    if (s.url === '' || seen.has(s.url)) continue
    seen.add(s.url)
    out.push(s)
    if (out.length >= limit) break
  }
  return out
}

/** lite.duckduckgo.com 解析：result-link 锚点 + result-snippet 单元格（按序配对） */
export function parseDdgLite(html: string): WebSearchItem[] {
  const linkMatches = html.match(/<a[^>]*class=['"]result-link['"][^>]*>[\s\S]*?<\/a>/g) ?? []
  const snippetMatches = html.match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g) ?? []
  const out: WebSearchItem[] = []
  for (const [i, tag] of linkMatches.entries()) {
    const href = /href="([^"]*)"/.exec(tag)?.[1]
    const url = decodeDdgUrl(href)
    if (url === null) continue
    const title = /class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/.exec(tag)?.[1] ?? ''
    const snippetRaw = snippetMatches[i] ?? ''
    const snippet = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/.exec(snippetRaw)?.[1] ?? ''
    out.push({ url, title: stripTags(title), snippet: stripTags(snippet) })
  }
  return out
}

/** html.duckduckgo.com 解析：result__a 锚点（URL + 标题）+ result__snippet */
export function parseDdgHtml(html: string): WebSearchItem[] {
  const blocks =
    html.match(/<div class="result results_links[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g) ?? []
  const out: WebSearchItem[] = []
  for (const block of blocks) {
    const url = decodeDdgUrl(/<a[^>]*class="result__a"[^>]*href="([^"]*)"/.exec(block)?.[1])
    if (url === null) continue
    const title = /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? ''
    const snippet = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? ''
    out.push({ url, title: stripTags(title), snippet: stripTags(snippet) })
  }
  return out
}

/** bing.com 公开页解析：b_algo 列表块（h2 内锚点 + p 摘要） */
export function parseBing(html: string): WebSearchItem[] {
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? []
  const out: WebSearchItem[] = []
  for (const block of blocks) {
    const url = /<a[^>]*href="(https?:\/\/[^"]+)"/.exec(block)?.[1]
    if (url === undefined) continue
    const title = /<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/.exec(block)?.[1] ?? ''
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1] ?? ''
    out.push({ url, title: stripTags(title), snippet: stripTags(snippet) })
  }
  return out
}

/**
 * 搜狗结果页解析：`<div class="vrwrap">` 逐块切分。
 * 真实 URL 在块内 `data-url="http…"`（标题锚点的 href 是 /link?url= 跳转壳，不用）；
 * 标题在 `vr-title` 锚点（含 `<!--red_beg-->` 高亮注释，stripTags 前先剥 HTML 注释）；
 * 摘要模板多变（fz-mid/普通 p），取块内第一段 ≥15 字的正文文本，取不到就留空。
 */
export function parseSogou(html: string): WebSearchItem[] {
  const parts = html.split(/<div class="vrwrap">/)
  const out: WebSearchItem[] = []
  for (const rawPart of parts.slice(1)) {
    // 截到下一个候选块边界，避免跨块污染（结果块之间还夹着别的 div，宽松取整段即可）
    const block = rawPart.slice(0, 4000)
    const url = /data-url="(https?:\/\/[^"]+)"/.exec(block)?.[1]
    if (url === undefined) continue
    const titleRaw = /vr-title[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? ''
    const snippetRaw =
      /class="[^"]*fz-mid[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1] ??
      /<p[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1] ??
      ''
    out.push({
      url,
      title: stripTight(stripComments(titleRaw)),
      snippet: stripTight(stripComments(snippetRaw))
    })
  }
  return out
}

/** 剥 HTML 注释（搜狗高亮标记 <!--red_beg--> 会混进文本） */
function stripComments(html: string): string {
  return String(html).replace(/<!--[\s\S]*?-->/g, '')
}

/**
 * 360 搜索（so.com）结果页解析（9.15 新增）：`<li class="res-list">` 逐块切分。
 * 真实 URL 在 `data-mdurl="http…"`（锚点 href 是 /link?m=… 跳转壳，不用）；
 * 标题在 `h3.res-title` 内锚点，摘要在 `p.res-desc`——均含 `<em>` 高亮，走 stripTight
 * （删标签不补空格，中文不插假空格）。
 */
export function parseSo(html: string): WebSearchItem[] {
  const parts = String(html).split(/<li class="res-list/)
  const out: WebSearchItem[] = []
  for (const rawPart of parts.slice(1)) {
    const block = rawPart.slice(0, 4000)
    const url = /data-mdurl="(https?:\/\/[^"]+)"/.exec(block)?.[1]
    if (url === undefined) continue
    const titleRaw =
      /class="res-title[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? ''
    const snippetRaw = /class="res-desc"[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1] ?? ''
    out.push({
      url,
      title: stripTight(stripComments(titleRaw)),
      snippet: stripTight(stripComments(snippetRaw))
    })
  }
  return out
}

/**
 * 紧凑清洗：删标签**不补空格**（区别于 stripTags）。搜狗标题/摘要里有关键词高亮的
 * 内联 `<em>苏州大学</em>的`——若按 stripTags 把标签换成空格，中文会被插入假空格
 * （"苏州大学 的"）。解实体 + 压空白照旧。
 */
function stripTight(html: string): string {
  return decodeEntities(
    String(html)
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/** searxng JSON 解析（实例开启 json 格式时最省事；字段：results[].{title,url,content}） */
export function parseSearxng(data: unknown): WebSearchItem[] {
  const results =
    typeof data === 'object' && data !== null ? (data as { results?: unknown }).results : undefined
  if (!Array.isArray(results)) return []
  const out: WebSearchItem[] = []
  for (const r of results) {
    if (typeof r !== 'object' || r === null) continue
    const rec = r as Record<string, unknown>
    if (typeof rec.url !== 'string' || rec.url === '') continue
    out.push({
      url: rec.url,
      title: typeof rec.title === 'string' ? stripTags(rec.title) : '',
      snippet: typeof rec.content === 'string' ? stripTags(rec.content) : ''
    })
  }
  return out
}

// ── 抓取与引擎执行 ────────────────────────────────────────────────────────
/** 带一次重试的取页（响应过短视为反爬挑战页——DDG 常见，换重试或换引擎） */
async function fetchText(
  url: string,
  signal: AbortSignal,
  accept: string,
  attempts = 2
): Promise<string> {
  let lastErr: unknown = null
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await netFetch(url, {
        signal,
        redirect: 'follow',
        headers: {
          'user-agent': UA,
          'accept-language': ACCEPT_LANG,
          accept
        }
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      if (text.length < 500) throw new Error(`响应过短（${text.length} 字节，疑似反爬页）`)
      return text
    } catch (err) {
      lastErr = err
      if (signal.aborted) throw err
      if (i < attempts) await new Promise((r) => setTimeout(r, 800))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('抓取失败')
}

/** 单引擎执行（超时独立，不影响整链预算外的引擎） */
async function runEngine(
  engine: string,
  query: string,
  outerSignal: AbortSignal
): Promise<WebSearchItem[]> {
  const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(PER_ENGINE_TIMEOUT_MS)])
  if (engine === 'ddg-lite') {
    const params = new URLSearchParams({ q: query, adlt: '-1' })
    return parseDdgLite(await fetchText(`${DDG_LITE_URL}?${params}`, signal, 'text/html'))
  }
  if (engine === 'ddg') {
    const params = new URLSearchParams({ q: query, adlt: '-1', kl: 'cn-zh' })
    return parseDdgHtml(await fetchText(`${DDG_HTML_URL}?${params}`, signal, 'text/html'))
  }
  if (engine === 'sogou') {
    const params = new URLSearchParams({ query })
    return parseSogou(await fetchText(`${SOGOU_URL}?${params}`, signal, 'text/html'))
  }
  if (engine === 'so') {
    const params = new URLSearchParams({ q: query })
    return parseSo(await fetchText(`${SO_URL}?${params}`, signal, 'text/html'))
  }
  if (engine === 'bing') {
    const params = new URLSearchParams({ q: query, mkt: 'zh-CN', adlt: 'off' })
    return parseBing(await fetchText(`${BING_URL}?${params}`, signal, 'text/html'))
  }
  if (engine === 'searxng') {
    // 实例池逐个试：json 格式被多数公共实例关闭 → 失败顺延（错误汇总不在此抛出）
    let lastErr: unknown = null
    for (const base of SEARXNG_INSTANCES) {
      try {
        const params = new URLSearchParams({ q: query, format: 'json' })
        const res = await netFetch(`${base}/search?${params}`, {
          signal,
          redirect: 'follow',
          headers: { 'user-agent': UA, accept: 'application/json' }
        })
        if (!res.ok) throw new Error(`${base}: HTTP ${res.status}`)
        const items = parseSearxng(await res.json().catch(() => null))
        if (items.length > 0) return items
        lastErr = new Error(`${base}: 无结果`)
      } catch (err) {
        lastErr = err
        if (outerSignal.aborted) throw err
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('SearXNG 实例均不可用')
  }
  throw new Error(`未知引擎：${engine}`)
}

/** 缓存（Map 天然 LRU：命中即删了重插到尾部；超限删最旧键） */
const cache = new Map<string, { at: number; outcome: WebSearchOutcome }>()

function cacheGet(key: string): WebSearchOutcome | null {
  const hit = cache.get(key)
  if (hit === undefined) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  cache.delete(key)
  cache.set(key, hit) // LRU 触达
  return { ...hit.outcome, cached: true }
}

function cacheSet(key: string, outcome: WebSearchOutcome): void {
  cache.set(key, { at: Date.now(), outcome: { ...outcome, cached: false } })
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** 清缓存（测试用） */
export function clearWebSearchCache(): void {
  cache.clear()
}

/** 引擎链：**两个中文引擎打头**（sogou → 360）——国内直连可用、中文多词查询不降级；
 * DDG 靠后（国内须挂代理才有戏）；bing 垫后（裸请求多词中文返回降级页，仅作最后兜底，
 * 且过不了相关性闸门）。越靠前越省时（首个通过闸门的结果即返回）。
 * 健康度冷却只调"未冷却在前"的分组顺序，不改这条基准序（见 orderEngines）。 */
export const SEARCH_ENGINE_CHAIN = ['sogou', 'so', 'ddg-lite', 'ddg', 'bing', 'searxng'] as const
export type SearchEngine = (typeof SEARCH_ENGINE_CHAIN)[number]

// ── 引擎健康度──────────────────────────────────────────────────────
// 连续超时/失败的引擎冷却 ENGINE_COOLDOWN_MS 内降权到链尾：国内无代理用户 DDG 直连
// 必超时（6s×2 引擎=12s 白等），首搜后 bing 就排到前面；冷却到期自动恢复原顺序
// （代理可能中途开启，不永久拉黑）。纯内存状态，进程重启即清零。
const ENGINE_COOLDOWN_MS = 10 * 60 * 1000
const enginePenaltyUntil = new Map<SearchEngine, number>()

/** 排链：未冷却的按原序在前，冷却中的按原序垫后（导出供单测注入时钟） */
export function orderEngines(now: number): SearchEngine[] {
  const fresh: SearchEngine[] = []
  const penalized: SearchEngine[] = []
  for (const e of SEARCH_ENGINE_CHAIN) {
    const until = enginePenaltyUntil.get(e)
    if (until !== undefined && until > now) penalized.push(e)
    else fresh.push(e)
  }
  return [...fresh, ...penalized]
}

function penalize(engine: SearchEngine): void {
  enginePenaltyUntil.set(engine, Date.now() + ENGINE_COOLDOWN_MS)
}

/** 清健康度状态（测试用） */
export function clearEnginePenalties(): void {
  enginePenaltyUntil.clear()
}

/**
 * 查询词切片（相关性闸门用）：ASCII 词（≥2 字）+ 中文 2-gram。
 * 只做"有没有沾边"的粗判——目的是识别**引擎降级页**（整页与查询零重叠），
 * 不是精排，所以宁可宽松（2-gram 命中一个就算相关）。
 */
export function queryTerms(query: string): string[] {
  const terms = new Set<string>()
  for (const w of query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []) terms.add(w)
  for (const zh of query.match(/[\u4e00-\u9fa5]+/g) ?? []) {
    if (zh.length <= 2) {
      if (zh.length === 2) terms.add(zh)
      continue
    }
    for (let i = 0; i + 2 <= zh.length; i++) terms.add(zh.slice(i, i + 2))
  }
  return [...terms]
}

/**
 * 结果集是否与查询有实际重叠：标题/摘要命中的**不同查询切片数**须达到阈值。
 * 阈值 min(2, 切片数)——单切片查询（如"换行符"）命中 1 个即可；
 * 多切片查询要求 ≥2，避免"只蒙对年份/常见词"的降级页蒙混过关
 * （实测：查"2026考研数学一真题"，bing 降级页含"2026 年元旦"只重叠一个切片）。
 */
export function itemsRelevant(items: WebSearchItem[], terms: string[]): boolean {
  if (items.length === 0) return false
  if (terms.length === 0) return true
  const matched = new Set<string>()
  for (const it of items) {
    const hay = `${it.title} ${it.snippet}`.toLowerCase()
    for (const t of terms) if (hay.includes(t)) matched.add(t)
    if (matched.size >= Math.min(2, terms.length)) return true
  }
  return matched.size >= Math.min(2, terms.length)
}

/**
 * 多引擎搜索：按链依次尝试，首个**通过相关性闸门**的结果胜出；全失败抛可读错误。
 * 闸门（9.15）：结果与查询零重叠 = 引擎降级页 → 判该引擎失败并冷却，继续走链。
 * 若所有引擎都只给出不相关结果，返回信息量最大的那份并标 suspect（如实告知，不装作成功）。
 * 结果写 LRU 缓存（同 query + 条数 5 分钟内复用）。
 */
export async function searchWeb(
  query: string,
  opts: { maxResults: number; signal: AbortSignal }
): Promise<WebSearchOutcome> {
  const maxResults = Math.min(Math.max(opts.maxResults, 1), MAX_RESULTS_LIMIT)
  const key = `${query}\u0000${maxResults}`
  const cached = cacheGet(key)
  if (cached !== null) return cached

  const terms = queryTerms(query)
  const failures: string[] = []
  let fallback: WebSearchOutcome | null = null // 非空但不相关的兜底（suspect）
  for (const engine of orderEngines(Date.now())) {
    if (opts.signal.aborted) throw new Error('用户中断了本次搜索')
    try {
      const items = uniqueItems(await runEngine(engine, query, opts.signal), maxResults)
      if (items.length === 0) {
        failures.push(`${engine}: 无结果`) // 查询太偏的正常空手，不惩罚
        continue
      }
      if (!itemsRelevant(items, terms)) {
        // 降级页（整页与查询零重叠）：判失败 + 冷却，继续走链——这是"污染"的真身
        penalize(engine)
        failures.push(`${engine}: 结果与查询不相关（疑似降级页）`)
        if (fallback === null) fallback = { engine, items, cached: false, suspect: true }
        continue
      }
      const outcome: WebSearchOutcome = { engine, items, cached: false }
      cacheSet(key, outcome)
      return outcome
    } catch (err) {
      // 超时/403/解析失败 → 冷却降权：下次直接先试可用引擎（用户中断不罚）
      if (!opts.signal.aborted) penalize(engine)
      failures.push(`${engine}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (fallback !== null) {
    cacheSet(key, fallback)
    return fallback // 宁可交出不相关的结果并如实标注，也不假装搜不到
  }
  throw new Error(`所有搜索引擎均未能返回结果（${failures.join('；')}）——稍后再试或换个关键词`)
}
