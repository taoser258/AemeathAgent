// 分层记忆· 共享类型与纯函数。
//
// 只新建「长期记忆」一层：跨会话的结构化条目（偏好/事实/承诺）。
// 本文件刻意无 IO、无 electron 依赖——主进程（存储/提炼）与渲染层（设置页展示）共用；
// 检索打分与去重合并都是纯函数，vitest 直接测。
// 向量检索只留 Embed 适配位（本期空跑），未来接 embedding 时零改结构。

export type MemoryKind = 'preference' | 'fact' | 'commitment'

export const MEMORY_KIND_LABEL: Record<MemoryKind, string> = {
  preference: '偏好',
  fact: '事实',
  commitment: '承诺'
}

export interface MemoryEntry {
  id: string
  kind: MemoryKind
  /** 一句话（≤120 字，沉淀时截断） */
  content: string
  /** 检索关键词（沉淀时由提炼模型产出 3~6 个） */
  keywords: string[]
  sourceSessionId: string
  createdAt: number
  updatedAt: number
  /** 被注入 prompt 的次数（设置页排序 + 容量淘汰依据） */
  hits: number
}

/** 条目上限：人均年增 50~150 条 ≈ 3~10 年用量；超出淘汰 hits 最低最旧 */
export const MEMORY_MAX_ENTRIES = 500

/** 单条内容上限（字）——提炼时截断，防长篇大论挤爆注入预算 */
export const MEMORY_CONTENT_MAX = 120

/** 注入 prompt 的条数上限（约 1K token 封顶） */
export const MEMORY_INJECT_LIMIT = 8

/* ────────────────────────── 检索打分 ────────────────────────── */

/** 中文/英文混合停用词（内置常量，纯检索用途；数量不求全，够滤常用虚词即可） */
const STOPWORDS = new Set([
  '的',
  '了',
  '是',
  '我',
  '你',
  '他',
  '她',
  '在',
  '有',
  '和',
  '就',
  '不',
  '都',
  '一',
  '一个',
  '上',
  '也',
  '很',
  '到',
  '说',
  '要',
  '去',
  '会',
  '着',
  '没有',
  '看',
  '好',
  '自己',
  '这',
  '那',
  '这个',
  '那个',
  '什么',
  '怎么',
  'the',
  'a',
  'an',
  'is',
  'are',
  'to',
  'of',
  'and',
  'in',
  'on',
  'for',
  'with',
  'my',
  'your',
  'i',
  'you',
  'it'
])

/**
 * 简易切词：英文/数字整词（小写）+ 中文 2-gram。
 * 2-gram 粗糙但对「关键词命中」够用——keywords 本身是提炼时产出的规范词，
 * 查询侧只要能覆盖命中即可，不需要语言学级别的分词。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const m of text.matchAll(/[a-zA-Z0-9]+/g)) {
    const w = m[0].toLowerCase()
    if (!STOPWORDS.has(w)) tokens.push(w)
  }
  for (const m of text.matchAll(/[\u4e00-\u9fa5]+/g)) {
    const seg = m[0]
    if (seg.length === 1) {
      if (!STOPWORDS.has(seg)) tokens.push(seg)
      continue
    }
    for (let i = 0; i < seg.length - 1; i++) {
      const gram = seg.slice(i, i + 2)
      if (!STOPWORDS.has(gram)) tokens.push(gram)
    }
  }
  return tokens
}

/**
 * 对一组条目按「与查询的相关度」打分排序（降序）。
 * 打分口径（P7-T3 起正文也参与——否则手动改过的内容搜不到）：
 * - 关键词命中（keywords 被查询词元包含/反包含）每条 +2——规范词是提炼产出，权重高；
 * - 正文命中（查询词元在 content 的 2-gram 集合里精确出现）每词 +1；
 * 同分按 updatedAt 新者优先。返回带 score 的新数组（不改原条目）。
 */
export function scoreEntries(
  entries: MemoryEntry[],
  query: string
): Array<{ entry: MemoryEntry; score: number }> {
  const qTokens = new Set(tokenize(query))
  if (qTokens.size === 0) return []
  const scored = entries.map((entry) => {
    let score = 0
    const contentTokens = new Set(tokenize(entry.content))
    for (const t of qTokens) {
      if (entry.keywords.some((k) => k.toLowerCase().includes(t) || t.includes(k))) score += 2
      if (contentTokens.has(t)) score += 1
    }
    return { entry, score }
  })
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
}

/** 取注入用 top-k（≤MEMORY_INJECT_LIMIT），并返回命中的 id（调用方据此累加 hits） */
export function pickForInjection(
  entries: MemoryEntry[],
  query: string
): { memories: Array<{ kind: MemoryKind; content: string }>; hitIds: string[] } {
  const top = scoreEntries(entries, query).slice(0, MEMORY_INJECT_LIMIT)
  return {
    memories: top.map((s) => ({ kind: s.entry.kind, content: s.entry.content })),
    hitIds: top.map((s) => s.entry.id)
  }
}

/** 注入用附录段（照「关于用户」段同款格式）；空数组返回 ''（调用方跳过追加） */
export function buildMemoryAppendix(
  memories: Array<{ kind: MemoryKind; content: string }>
): string {
  if (memories.length === 0) return ''
  const lines = memories.map((m) => `- [${MEMORY_KIND_LABEL[m.kind]}] ${m.content}`)
  return [
    '## 关于用户的长期记忆（自然引用，不要逐条复述；与当前话题无关的不要硬提）',
    ...lines
  ].join('\n')
}

/* ────────────────────────── 去重合并 ────────────────────────── */

/** 关键词重合率：候选词中出现在已有条目词表的比例（≥60% 视为同一条） */
export function keywordOverlap(candidate: string[], existing: string[]): number {
  if (candidate.length === 0) return 0
  const ex = new Set(existing.map((k) => k.toLowerCase()))
  let hit = 0
  for (const k of candidate) {
    if (ex.has(k.toLowerCase())) hit += 1
  }
  return hit / candidate.length
}

/** 去重阈值：重合 ≥60% 且同 kind → 更新而非新增 */
export const MEMORY_MERGE_THRESHOLD = 0.6

export interface MemoryCandidate {
  kind: MemoryKind
  content: string
  keywords: string[]
}

/**
 * 把候选条目合并进列表（**纯函数**，返回新数组；不持久化）。
 * - 同 kind 且关键词重合 ≥60% → 更新最近的一条（保 id/createdAt，刷 content/keywords/updatedAt）
 * - 否则新增（超上限时淘汰 hits 最低且 createdAt 最旧的一条）
 * 返回 { entries, mergedId }——mergedId 是新增/更新的那条 id（调用方日志用）。
 */
export function mergeInto(
  entries: MemoryEntry[],
  candidate: MemoryCandidate,
  sourceSessionId: string,
  now = Date.now()
): { entries: MemoryEntry[]; mergedId: string } {
  const content = candidate.content.slice(0, 120).trim()
  const keywords = candidate.keywords.map((k) => k.trim()).filter((k) => k !== '')
  const sameKind = entries.filter((e) => e.kind === candidate.kind)
  const target = sameKind
    .map((e) => ({ e, overlap: keywordOverlap(keywords, e.keywords) }))
    .filter((x) => x.overlap >= MEMORY_MERGE_THRESHOLD)
    .sort((a, b) => b.e.updatedAt - a.e.updatedAt)[0]

  if (target !== undefined) {
    const next = entries.map((e) =>
      e.id === target.e.id ? { ...e, content, keywords, updatedAt: now } : e
    )
    return { entries: next, mergedId: target.e.id }
  }

  const created: MemoryEntry = {
    id: `mem-${now}-${Math.random().toString(36).slice(2, 8)}`,
    kind: candidate.kind,
    content,
    keywords,
    sourceSessionId,
    createdAt: now,
    updatedAt: now,
    hits: 0
  }
  let next = [...entries, created]
  if (next.length > MEMORY_MAX_ENTRIES) {
    // 淘汰 hits 最低、其次最旧（非 pinned 概念 v1 没有）
    let victimIdx = 0
    for (let i = 1; i < next.length; i++) {
      const v = next[victimIdx]
      const c = next[i]
      if (c.hits < v.hits || (c.hits === v.hits && c.createdAt < v.createdAt)) victimIdx = i
    }
    next = next.filter((_, i) => i !== victimIdx)
  }
  return { entries: next, mergedId: created.id }
}
