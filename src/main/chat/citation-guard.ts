// 引用护栏：她引用的链接必须"有据可查"——出现在本轮工具结果里、历史工具结果里，
// 或用户自己在对话里发过。否则大概率是编的（看着合理但不存在，语气与真链接无异）。
//
// ── 为什么要 harness 层做（P7-T1，缺陷报告 2.4）─────────────────────────────
// 被要求"给几个链接"时，模型可能生成看似合理但不存在的 URL，提示词里写
// "链接只能来自工具返回"实测守不住（todo 催办同款教训）——行为类要求进 harness。
// 打法完全照 chat/todo-nudge.ts 的姊妹模块：判定抽成纯逻辑类 + 单测，
// 收尾前把 finalText 里的 URL 与已验证集合做 diff，有未验证链接 → 不结束，催一次。
//
// 误报防御三件套（都是实测会踩的坑）：
// ① 比对口径 = origin + path（去行尾斜杠/去 #fragment/查询参数不参与比对）——
//    搜索结果 URL 常带 ?utm/签名参数，模型省略它们是正常行为，精确匹配会误催；
//    但同域名不同路径**不算**对上（编造最常见的手法就是真域名 + 假路径）。
// ② 白名单：example.com / localhost / *.test 这类占位域名不参与校验；
//    代码块（围栏与行内）里的 URL 跳过——那是她在写示例代码，不是引用出处。
// ③ 历史种子：多轮对话里引用上一轮搜到的真链接是正当行为，
//    种子只收 历史工具结果 + 用户消息 里的链接；assistant 历史文本**不扫**
//    （上轮编造的链接混进种子 = 错误被洗白，下轮引用就查不出来了）。
//
// 本模块无 electron / 无 IO：工具结果全文与历史文本从注入的方法取，纯逻辑可测。

/** URL 字符集按 RFC 3986 取，天然在中文处截断（"链接https://a.com/x是假的"不会把汉字吞进 URL） */
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g
/** 行尾粘连的标点（中英文 + markdown 括号/引号）逐个剥掉 */
const TRAILING_PUNCT_RE = /[)\]}'".,;:!?，。、；：！？）】》」』]+$/
/** 占位/示例域名：example.com 族、*.example、保留 TLD .test、本机回环 */
const WHITELIST_RE =
  /(^|\.)example\.(com|org|net)$|\.example$|\.test$|^localhost$|\.localhost$|^127\.0\.0\.1$|^::1$|^0\.0\.0\.0$/

/** 占位/示例域名白名单：这些不参与"是否编造"的判定 */
function isWhitelistedHost(host: string): boolean {
  return WHITELIST_RE.test(host)
}

/**
 * 把一个 URL 归一成比对 key（origin + path，忽略查询/片段/行尾斜杠/大小写域名）。
 * 返回 null = 不参与校验（非法 URL、非 http(s)、白名单占位域名）。
 */
export function normalizeUrl(raw: string): string | null {
  let s = raw.trim()
  // 掐掉前导杂质（直调时可能传进 "(https://…" 这种带左括号的整体；
  // 正则抽取路径下不会走到这里，但归一函数本身要自洽）
  const start = s.search(/https?:\/\//)
  if (start > 0) s = s.slice(start)
  // 反复剥行尾标点（"https://a.com/x)。" 这种 markdown+中文标点粘连要剥两轮）
  for (;;) {
    const next = s.replace(TRAILING_PUNCT_RE, '')
    if (next === s) break
    s = next
  }
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const host = u.hostname.toLowerCase()
  if (isWhitelistedHost(host)) return null
  let path = u.pathname
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return `${u.origin.toLowerCase()}${path}`
}

/** 剥掉围栏代码块与行内代码——里面的 URL 是示例，不是引用出处 */
function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
}

/** 从一段文本抽出全部候选 URL 的归一 key（跳过白名单/非法/代码块内） */
export function extractUrlKeys(text: string): string[] {
  const keys: string[] = []
  for (const m of stripCode(text).matchAll(URL_RE)) {
    const key = normalizeUrl(m[0])
    if (key !== null) keys.push(key)
  }
  return keys
}

/** 收尾催办文案：列出未验证链接，给两条出路（删除 / fetch_url 验证后再引） */
function reminderText(unverified: readonly string[]): string {
  return (
    '（系统提示：你刚才的最终回复里引用了下面这些链接，但它们没有出现在本轮任何工具' +
    '结果或此前的对话记录里——很可能是你编造的：\n' +
    unverified.map((u) => `- ${u}`).join('\n') +
    '\n请二选一：要么把这些链接从回复里删掉，要么先用 fetch_url 逐个验证确实存在再引用' +
    '（验证失败的同样要删）。如果用户要的就是"示例格式"而非真实网址，改写一句说明即可。）'
  )
}

/**
 * 引用护栏状态机（每个 run 一个实例）。
 *
 * 与 TodoNudges 同款纪律：判定全在这里、可单测；run.ts 只负责把
 * 工具结果全文喂进来（noteToolResult）和收尾时问一句（finishReminder）。
 */
export class CitationGuard {
  private readonly verified = new Set<string>()
  /** 本轮跑过成功的工具才启用（纯聊天轮不校验——没有工具结果可对照，见任务书红线） */
  private touched = false
  /** 催办只给一次额度（同 todo 口径）：催完仍引用未验证链接 → 放行，不无限拉扯 */
  private reminded = false

  /** 历史种子：会话已落盘的工具结果与用户消息里的链接（run.ts 过滤好角色再喂） */
  seedFrom(texts: Iterable<string>): void {
    for (const text of texts) {
      for (const key of extractUrlKeys(text)) this.verified.add(key)
    }
  }

  /** 工具执行完喂进来：**全文**（8000 截断前的原文），只收成功结果 */
  noteToolResult(ok: boolean, fullResult: string): void {
    if (!ok) return
    this.touched = true
    for (const key of extractUrlKeys(fullResult)) this.verified.add(key)
  }

  /**
   * 收尾前：finalText 里有"本轮/历史都没出处的链接" → 返回催办文案（仅一次）。
   * touched=false（纯聊天）直接放行：没跑过工具就没有"该有据可查"的前提。
   * 额度**只在真催出去时消耗**——干净收尾不烧额度（否则同一次 run 里
   * 先干净后编造就查不出来了）。
   */
  finishReminder(finalText: string): string | null {
    if (this.reminded || !this.touched) return null
    const seen = new Set<string>()
    const unverified: string[] = []
    for (const key of extractUrlKeys(finalText)) {
      if (this.verified.has(key) || seen.has(key)) continue
      seen.add(key)
      unverified.push(key)
    }
    if (unverified.length === 0) return null
    this.reminded = true
    return reminderText(unverified)
  }
}
