// 收尾核对：她"声称产出"的文件是否真的存在。
//
// ── 为什么要有这个（2026-09-17 实测，owner 复现）─────────────────────────
// 那次任务让她写三个文件，其中 keepme.log **从头到尾没写**：她把清单第三项标成
// done，总结里也写「keepme.log — 一行字，你说留着，那就留着」，用户看到的是
// "三件事都搞定了"。文件其实不存在——**凭空宣称**，用户只能自己去翻目录才发现。
//
// 模型诚不诚实不归我们管，但 harness 能兜住这一层：任务收尾时把"她声称写完的东西"
// 与"工作区里真实存在的文件"对一次账，对不上就如实通报。
//
// ★ 抽取口径刻意收窄（宁可漏检，不可误报——每多一条噪音提示，用户就少信一分）：
//   只认**两个来源**的"完成式"表述：
//     ① 清单里状态为 done 的条目（结构化数据，最可信）；
//     ② 最终回复里**带完成动词的那几行**（写好/已写/已生成/已创建/已保存…）。
//   普通提及（"参考 package.json""双击就能打开 probe2.html"）不进核对。
// 其余过滤：只认"带扩展名"的 token（排除 URL/域名/版本号），且解析后必须落在
//   绑定工作区内——盘外、越界、解析不出来的路径一律忽略（不能拿它冤枉人）。
//
// 本模块纯逻辑（无 fs/electron）：文件是否存在由调用方以 exists 回调注入。

import { isAbsolute, join, relative, sep } from 'path'

/** 完成式动词：只有这些行里出现的文件名才被当作"她声称产出了" */
const CLAIM_RE =
  /(写好|已写好|写完了|已写|写完|已生成|生成好|已创建|创建好|已保存|已存|保存到|生成到|创建了|写入了|已完成|已就绪|搞定了)/

/** 带扩展名的 token（反引号内或裸写都认）：`a/b.md`、notes/x.log、probe2.html */
const BACKTICK_RE = /`([^`\n]{1,160})`/g
const BARE_RE =
  /(?:^|[\s（(「【，,、；;：:！!？?）)」】])([A-Za-z0-9_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5.\-/\\]*\.[A-Za-z][A-Za-z0-9]{0,7})(?=$|[\s（()）「」【】，,、；;：:。！!？?])/g

/** 单个候选 token 是否"像个工作区内文件路径"（排除 URL / 邮箱 / 版本号） */
function looksLikePath(token: string): boolean {
  const t = token.trim()
  if (t === '' || t.length > 160) return false
  if (t.includes('://') || t.includes('@') || t.startsWith('www.')) return false
  // 扩展名必须落在最后一段，且是字母开头的 1–8 位（挡掉 1.5 / v0.3.2 这类）
  const base = t.split(/[\\/]/).pop() ?? ''
  return /^[^\\/]+\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(base)
}

/** 从一段文本里抽出候选文件名（去重，保序） */
export function extractFileTokens(text: string): string[] {
  const out: string[] = []
  const push = (raw: string): void => {
    const token = raw.trim().replace(/^[（(「【]+|[）)」】。，,]+$/g, '')
    if (!looksLikePath(token)) return
    if (!out.includes(token)) out.push(token)
  }
  for (const m of text.matchAll(BACKTICK_RE)) {
    // 反引号里可能是命令（"node _probe2.js"）：逐个词试，命中的才算
    for (const word of m[1].split(/\s+/)) push(word)
  }
  for (const m of text.matchAll(BARE_RE)) push(m[1] ?? '')
  return out
}

/** 归一成绝对路径并判断是否落在工作区内；越界/解析不出返回 null */
function toWorkspacePath(token: string, workspace: string): string | null {
  const norm = token.replace(/[\\/]+/g, sep)
  const abs = isAbsolute(norm) ? norm : join(workspace, norm)
  const rel = relative(workspace, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return abs
}

export interface ClaimedCheckInput {
  /** 最终回复全文（只扫带完成动词的行） */
  answerText: string
  /** 清单条目（只核对 status === 'done' 的） */
  todos: ReadonlyArray<{ text: string; status: string }>
  /** 绑定工作区根；null/空 = 什么都不核对（fail-closed） */
  workspace: string | null
  /** 工作区内的相对路径 → 是否存在（由调用方注入 fs 能力，便于单测） */
  exists: (absPath: string) => boolean
}

/** 单次核对最多报几个（再多就是噪音，用户也不会逐个看） */
export const CLAIMED_MAX = 5

/**
 * 找出"她声称写好、但工作区里找不到"的文件（绝对路径，去重保序）。
 * 找不到不是错误——只是提醒用户核对；所以宁缺勿滥（见文件头抽取口径）。
 */
export function findClaimedButMissing(input: ClaimedCheckInput): string[] {
  const { answerText, todos, workspace, exists } = input
  if (workspace === null || workspace.trim() === '') return []

  const candidates: string[] = []
  for (const item of todos) {
    if (item.status !== 'done') continue
    candidates.push(...extractFileTokens(item.text))
  }
  for (const line of answerText.split('\n')) {
    if (!CLAIM_RE.test(line)) continue
    candidates.push(...extractFileTokens(line))
  }

  const missing: string[] = []
  for (const token of candidates) {
    const abs = toWorkspacePath(token, workspace)
    if (abs === null) continue // 盘外/越界：不冤枉
    if (exists(abs)) continue
    if (!missing.includes(abs)) missing.push(abs)
  }
  return missing.slice(0, CLAIMED_MAX)
}
