// 工作区内容检索：零依赖扫描式全文搜索。
//
// 为什么不建常驻倒排索引：千文件级工作区一次全量扫描 ≈ 数百 ms（文本文件 + 2MB 单文件
// 上限 + 目录忽略），满足验收（<1s）；免去文件变更监听/增量维护/失效一致性三件套。
// 文件数超上限直接截断并如实返回 truncated 标记。
//
// 打分：行级 = 命中的查询词数（全词命中的行权重大）；文件级 = 命中行数聚合。
// 二进制防护：扩展名白名单 + 内容 NUL 嗅探双保险。

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, relative, extname } from 'path'
import { tokenize } from '@shared/memory'

export interface ContentHit {
  /** 相对工作区路径（/ 分隔） */
  rel: string
  name: string
  /** 1-based 行号 */
  line: number
  /** 命中行内容（截断 ~200 字，查询词已原样在内） */
  snippet: string
  score: number
}

export interface ContentSearchResult {
  hits: ContentHit[]
  /** 扫描的文件数（诊断用） */
  scanned: number
  /** true = 文件数超上限，结果可能不全 */
  truncated: boolean
}

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'release',
  'coverage',
  '.workbuddy',
  '__pycache__',
  '.venv',
  'venv'
])

const TEXT_EXT = new Set([
  '.md', '.txt', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.html', '.htm',
  '.css', '.scss', '.less', '.vue', '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp',
  '.sh', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.sql', '.svg', '.xml'
])

const MAX_FILES = 3000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const SNIPPET_MAX = 200

/** 单文件逐行匹配：返回命中行（全词命中行排前） */
function matchFile(
  abs: string,
  rel: string,
  name: string,
  terms: string[]
): ContentHit[] {
  let text: string
  try {
    const st = statSync(abs)
    if (st.size > MAX_FILE_BYTES) return []
    text = readFileSync(abs, 'utf8')
  } catch {
    return []
  }
  if (text.includes('\0')) return [] // 二进制嗅探
  const lower = text.toLowerCase()
  // 快速放弃：文件里一个词都没有（大多数文件走这条快速路径）
  if (!terms.some((t) => lower.includes(t))) return []

  const hits: ContentHit[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase()
    let score = 0
    for (const t of terms) {
      if (lineLower.includes(t)) score += 1
    }
    if (score === 0) continue
    const raw = lines[i].trim()
    hits.push({
      rel,
      name,
      line: i + 1,
      snippet: raw.length > SNIPPET_MAX ? `${raw.slice(0, SNIPPET_MAX)}…` : raw,
      // 全词命中（所有查询词都在该行）权重翻倍
      score: score === terms.length ? score * 2 : score
    })
  }
  return hits
}

/**
 * 工作区全文检索。query 先走 tokenize（复用记忆切词：中文 2-gram + 英文词），
 * 再补充原始整词——「Rust」这类英文词 tokenize 后原样保留，中文长词靠 2-gram 命中。
 */
export function searchWorkspaceContent(
  root: string,
  query: string,
  limit = 20
): ContentSearchResult {
  const terms = Array.from(new Set(tokenize(query)))
  if (terms.length === 0 || !existsSync(root)) {
    return { hits: [], scanned: 0, truncated: false }
  }

  const hits: ContentHit[] = []
  let scanned = 0
  let truncated = false
  const queue: string[] = [root]

  while (queue.length > 0) {
    const dir = queue.shift()
    if (dir === undefined) break
    let items: string[]
    try {
      items = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of items) {
      if (scanned >= MAX_FILES) {
        truncated = true
        break
      }
      const abs = join(dir, name)
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (!IGNORE_DIRS.has(name) && !name.startsWith('.')) queue.push(abs)
        continue
      }
      scanned += 1
      const ext = extname(name).toLowerCase()
      if (ext !== '' && !TEXT_EXT.has(ext)) continue
      const rel = relative(root, abs).replace(/\\/g, '/')
      hits.push(...matchFile(abs, rel, name, terms))
    }
    if (truncated) break
  }

  hits.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
  return { hits: hits.slice(0, limit), scanned, truncated }
}
