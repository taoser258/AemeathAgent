// 任务结束后的中间产物清理（owner 需求①）。
//
// ── 两次误删事故（2026-09-16）───────────────────────────────────────────
// 事故一：规则含"路径含 tmp/temp 目录段" → 用户让她把正式成果 `最终报告.md`
//   放进名叫 temp 的文件夹，成果被连累清掉。**目录名是随便取的，不能当依据。**
// 事故二：改成"只看 .tmp/.temp/.log 后缀" → 用户明确要求保留的 `旧日志.log`
//   因为是本轮新建且后缀命中，照样被清。**后缀只说明文件类型，不说明要不要留。**
//
// 两次错在同一件事：**拿"猜测"当删除依据**。所以现行设计彻底不再猜——
//
// ★ 现行铁律：**只有她主动登记的中间产物才可能被清**。
// 系统提示与工具说明都要求她：自己产生、确认是中间产物、用户没要求保留的文件，
// 才调 mark_temp_files 登记。没登记的一律不动（哪怕叫 xxx.tmp），只汇报给用户。
//
// ── 一次漏清事故（2026-09-17，第一次真实使用就踩到）─────────────────────
// 她登记了 `_preview-server.js`（预览用的临时静态服务器，正是提示词里点名的
// 「临时脚本」），工具回执也承诺"任务正常结束后移入回收站"，**结果文件留在工作区**。
// 根因：当时的第 2 道闸门是"中间件后缀白名单"（.tmp/.temp/.log）——而真实世界的
// 中间产物以**脚本与中间数据**为主（.js/.py/.json/…），这些后缀与成果后缀天然重叠，
// 没有任何白名单能写对。**这又是一次"拿名字像不像垃圾"的猜测**，只是这次猜错的
// 方向是"该清没清"（用户得自己收尾），而不是误删。
//
// ★ 修正后的口径：把"像不像垃圾"换成"像不像用户要的东西"——
//   命中**成果后缀黑名单**的（.md/.pdf/.png/.html/…）登记了也不清，只汇报；
//   其余在过完其它闸门后可以清。判定依据重新回到唯一意图信号 = 她的登记。
//
// 一个文件被自动清理，必须同时通过全部 7 道闸门：
//   1. 她**显式登记**过（mark_temp_files；这是唯一的意图信号）；
//   2. **不像成果**（成果后缀黑名单：报告/文档/图片/音视频/压缩包/安装包 → 不清，转汇报）；
//   3. 是她**本次任务新建**的（覆写用户已有文件不进轨迹）；
//   4. 位于绑定工作区内（盘外一律不清）；
//   5. 用户本轮消息里**明确说要保留**它的一律不清（说"留一份 X"就绝不碰 X；
//      只是被点名叫她建这个文件不算——见 keptByUser 的事故四）；
//   6. 登记数量 ≤ TEMP_CLEANUP_MAX（超了疑似误判，一个都不清）；
//   7. 任务正常收尾（abort/超步不清）。
//
// 实际删除走回收站（trashToRecycleBin），即使全错仍可还原——最后一层保险。
// 本模块纯逻辑（无 fs/electron），文件存在性与删除由 run.ts 接线。

import { isAbsolute, relative, sep } from 'path'

/**
 * 成果后缀黑名单：用户很可能真的想要的东西 —— 登记了也不清，只汇报。
 * 判据是"这个东西像不像交付物"，而不是"像不像临时文件"（见上方漏清事故）。
 * 漏掉某个后缀的代价 = 该中间产物留在工作区（保守方向）；写多了的代价 = 一个
 * 中间产物不被自动清。所以宁可列全，别漏。
 */
const DELIVERABLE_EXT = [
  // 文档 / 表格 / 演示
  'md',
  'markdown',
  'txt',
  'pdf',
  'docx',
  'doc',
  'xlsx',
  'xls',
  'pptx',
  'ppt',
  'csv',
  'rtf',
  'epub',
  // 网页（本应用最常见的成品形态）
  'html',
  'htm',
  // 图片
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'ico',
  // 音视频
  'mp3',
  'wav',
  'm4a',
  'flac',
  'mp4',
  'mov',
  'webm',
  'avi',
  'mkv',
  // 压缩包 / 安装包
  'zip',
  '7z',
  'rar',
  'tar',
  'gz',
  'exe',
  'msi'
]
const DELIVERABLE_EXT_RE = new RegExp(`\\.(${DELIVERABLE_EXT.join('|')})$`, 'i')

/** 单次任务自动清理的数量上限：超过则一个都不清（疑似误判，交给用户与 delete_file） */
export const TEMP_CLEANUP_MAX = 10

/** 路径是否命中成果后缀（命中 = 用户可能真想要它 → 永不清） */
export function isDeliverablePath(absPath: string): boolean {
  const file =
    absPath
      .split(/[\\/]/)
      .filter((p) => p !== '')
      .pop() ?? ''
  return DELIVERABLE_EXT_RE.test(file)
}

/** 路径归一化比较键（Windows 大小写不敏感） */
export function pathKey(absPath: string): string {
  return absPath
    .replace(/[\\/]+/g, sep)
    .replace(/[\\/]+$/, '')
    .toLowerCase()
}

/** 文件名（末段） */
export function baseName(absPath: string): string {
  return (
    absPath
      .split(/[\\/]/)
      .filter((p) => p !== '')
      .pop() ?? absPath
  )
}

/** 是否位于 root 之内（root 自身不算；复用 approval-policy 同款相对路径判定） */
function inside(target: string, root: string): boolean {
  const rel = relative(root, target)
  if (rel === '') return false
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 保留意图短语：用户**明确说"留"**的措辞（"给我保留""这个留着""别删"）。
 * 只看措辞、不看"提到过"——见下方 keptByUser 的事故四说明。
 */
const KEEP_PHRASES = [
  '保留',
  '留着',
  '留下',
  '留一份',
  '留一个',
  '存着',
  '别删',
  '不要删',
  '不许删',
  '不能删',
  '别动',
  '不要动',
  '别清',
  '不要清',
  'keep',
  'preserve'
]
/** 反向措辞：出现在保留短语前不远处，说明其实是不想留（"别留着""不需要保留""don't keep"） */
const NEGATION_CHARS = ['不', '别', '甭', '勿', '免', '没', '无']
const NEGATION_EN_RE = /(?:don'?t|does\s+not|do\s+not|not|never|no)\s*$/i
/** 文件名前后多少字符内出现保留短语才算数（"同一句话"的量级） */
const KEEP_WINDOW = 30

/** 这段文字里有没有"非否定"的保留短语 */
function hasKeepIntent(text: string): boolean {
  for (const phrase of KEEP_PHRASES) {
    let at = text.indexOf(phrase)
    while (at !== -1) {
      const before = text.slice(Math.max(0, at - 4), at)
      const negated =
        NEGATION_CHARS.some((n) => before.includes(n)) ||
        NEGATION_EN_RE.test(text.slice(Math.max(0, at - 12), at))
      if (!negated) return true
      at = text.indexOf(phrase, at + phrase.length)
    }
  }
  return false
}

/**
 * 用户本轮消息里是否**明确要求保留**这个文件（第 5 道闸门）。
 *
 * ── 事故四（2026-09-17，真实使用）────────────────────────────────────
 * 原文写法是"用户消息里提到过该文件名就不清"，实测立刻翻车：
 * 用户的原话是「写一个临时脚本 `_probe.js`…跑完按规矩登记成中间产物」——
 * 那是在**下需求点名文件**，不是"要保留它"。她照规矩登记了，文件却被这道闸门拦下，
 * 用户看到的是"登记了却没清"（同一天第二次踩）。
 *
 * 本闸门要拦的是**明确的保留要求**（事故二："旧日志.log 给我保留"），
 * 所以现在只看"文件名附近有没有保留措辞"，而不是全文有没有出现过这个名字。
 * 说"留一份 X"照样绝不碰 X；只是被提到名字不算。
 */
export function keptByUser(absPath: string, userText: string): boolean {
  const name = baseName(absPath)
  if (name === '') return true // 取不到名字 → 保守当提到过（不清）
  const hay = userText.toLowerCase()
  const needle = name.toLowerCase()
  const norm = absPath.replace(/[\\/]+/g, sep).toLowerCase()
  // 提到的位置：文件名，或用户写出的完整路径（含正反斜杠两种写法）
  const positions: number[] = []
  for (const t of [needle, norm, norm.replace(/\\/g, '/')]) {
    if (t === '') continue
    let at = hay.indexOf(t)
    while (at !== -1) {
      positions.push(at)
      at = hay.indexOf(t, at + t.length)
    }
  }
  if (positions.length === 0) return false // 压根没提到 → 这道闸门不保护它
  return positions.some((at) => {
    // 先把"文件名/路径本身"从窗口里挖掉再找措辞——
    // 否则 `keepme.log` / `_keepalive.js` 会自己命中 `keep`，永远被判成"要保留"
    const windowText = hay
      .slice(Math.max(0, at - KEEP_WINDOW), at + needle.length + KEEP_WINDOW)
      .split(needle)
      .join('·')
      .split(norm)
      .join('·')
    return hasKeepIntent(windowText)
  })
}

/** 登记了却没清的原因（run.ts 据此如实告诉用户"为什么这个还在"） */
export type LeftoverReason = 'deliverable' | 'kept' | 'outside'

export interface Leftover {
  path: string
  reason: LeftoverReason
}

export interface CleanupPlan {
  /** 将被移入回收站的登记文件（数量超限时为空） */
  files: string[]
  /** 登记了但因数量超限而一个都没清的数量（>0 时 files 必为空） */
  skippedTooMany: number
  /** 她登记了、但被某道闸门挡下没清的 → 只汇报，不动（带原因） */
  leftovers: Leftover[]
}

/**
 * 生成清理计划（纯逻辑，不验存在性、不执行删除）。
 * @param declared 她通过 mark_temp_files 登记的文件路径（绝对或相对工作区）
 * @param created 本次任务**新建**文件的绝对路径轨迹
 * @param workspace 绑定工作区根；null/空 = 什么都不清（fail-closed）
 * @param userText 本轮用户消息原文（用于"用户提到过就不许删"这道闸门）
 * @param resolveDeclared 把登记路径归一成绝对路径（相对路径按工作区解析）；失败返回 null
 */
export function planTempCleanup(input: {
  declared: readonly string[]
  created: readonly string[]
  workspace: string | null
  userText: string
  resolveDeclared: (raw: string) => string | null
}): CleanupPlan {
  const empty: CleanupPlan = { files: [], skippedTooMany: 0, leftovers: [] }
  const { declared, created, workspace, userText, resolveDeclared } = input
  if (workspace === null || workspace.trim() === '') return empty

  // 轨迹集合（只认绝对路径；相对路径不猜）
  const createdKeys = new Set<string>()
  for (const raw of created) {
    const norm = raw.replace(/[\\/]+/g, sep)
    if (isAbsolute(norm)) createdKeys.add(pathKey(norm))
  }

  // 登记集合：归一为绝对路径，逐条过闸门
  const declaredAbs = new Map<string, string>() // key → 绝对路径
  for (const raw of declared) {
    const abs = resolveDeclared(raw)
    if (abs === null) continue
    const key = pathKey(abs)
    if (declaredAbs.has(key)) continue
    if (!createdKeys.has(key)) continue // 闸门 3：不是本轮新建 → 不碰
    declaredAbs.set(key, abs)
  }

  const eligible: string[] = []
  const leftovers: Leftover[] = []
  for (const abs of declaredAbs.values()) {
    // 闸门 4/2/5：工作区内、不像成果、用户没提到过——任一不过就只汇报不删
    if (!inside(abs, workspace)) {
      leftovers.push({ path: abs, reason: 'outside' })
      continue
    }
    if (isDeliverablePath(abs)) {
      leftovers.push({ path: abs, reason: 'deliverable' })
      continue
    }
    if (keptByUser(abs, userText)) {
      leftovers.push({ path: abs, reason: 'kept' })
      continue
    }
    eligible.push(abs)
  }

  if (eligible.length > TEMP_CLEANUP_MAX) {
    // 闸门 6：数量异常 → 全部不清（含未超限时本可清的那些）
    return { files: [], skippedTooMany: eligible.length, leftovers }
  }
  return { files: eligible, skippedTooMany: 0, leftovers }
}
