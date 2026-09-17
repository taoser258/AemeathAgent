// 任务结束后的中间产物清理（owner 需求①）。
//
// ── 两次事故与本模块的最终结论（2026-09-16）─────────────────────────────
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
// 一个文件被自动清理，必须同时通过全部 7 道闸门：
//   1. 她**显式登记**过（mark_temp_files；这是唯一的意图信号）；
//   2. 命中中间件后缀 .tmp/.temp/.log（登记的若不在白名单后缀内，也不清，转汇报）；
//   3. 是她**本次任务新建**的（覆写用户已有文件不进轨迹）；
//   4. 位于绑定工作区内（盘外一律不清）；
//   5. 用户本轮消息里**提到过**该文件名的一律不清（说"保留 X"就绝不碰 X）；
//   6. 登记数量 ≤ TEMP_CLEANUP_MAX（超了疑似误判，一个都不清）；
//   7. 任务正常收尾（abort/超步不清）。
//
// 实际删除走回收站（trashToRecycleBin），即使全错仍可还原——最后一层保险。
// 本模块纯逻辑（无 fs/electron），文件存在性与删除由 run.ts 接线。

import { isAbsolute, relative, sep } from 'path'

/** 中间件后缀白名单：登记后的文件还须命中它（.md/.docx 等成果后缀永不清） */
const TEMP_EXT_RE = /\.(tmp|temp|log)$/i

/** 单次任务自动清理的数量上限：超过则一个都不清（疑似误判，交给用户与 delete_file） */
export const TEMP_CLEANUP_MAX = 10

/** 路径是否命中中间件后缀（供识别与汇报用；**不再是删除依据**） */
export function isTempPath(absPath: string): boolean {
  const file =
    absPath
      .split(/[\\/]/)
      .filter((p) => p !== '')
      .pop() ?? ''
  return TEMP_EXT_RE.test(file)
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

/** 用户本轮消息里是否提到过这个文件名（说"保留旧日志.log"就不许碰它） */
export function mentionedByUser(absPath: string, userText: string): boolean {
  const name = baseName(absPath)
  if (name === '') return true // 取不到名字 → 保守当提到过（不清）
  const hay = userText.toLowerCase()
  if (hay.includes(name.toLowerCase())) return true
  // 也拦"用户写了完整路径"的情况（含正反斜杠两种写法）
  const norm = absPath.replace(/[\\/]+/g, sep).toLowerCase()
  return hay.includes(norm) || hay.includes(norm.replace(/\\/g, '/'))
}

export interface CleanupPlan {
  /** 将被移入回收站的登记文件（数量超限时为空） */
  files: string[]
  /** 登记了但因数量超限而一个都没清的数量（>0 时 files 必为空） */
  skippedTooMany: number
  /** 她登记了、但被某道闸门挡下没清的 → 只汇报，不动 */
  leftovers: string[]
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
  const leftovers: string[] = []
  for (const abs of declaredAbs.values()) {
    // 闸门 4/2/5：工作区内、后缀像中间件、用户没提到过——任一不过就只汇报不删
    if (!inside(abs, workspace) || !isTempPath(abs) || mentionedByUser(abs, userText)) {
      leftovers.push(abs)
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
