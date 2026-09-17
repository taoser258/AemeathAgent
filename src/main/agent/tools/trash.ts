// 删除文件工具的回收站执行层（owner 需求①）。
//
// 设计拍板（owner 2026-09-16）：
// - 删除**一律进 Windows 回收站**（shell.trashItem），不做永久删除——误删可一键还原；
// - 权限：除「完全访问」外每次删除必弹审批（见 permission.ts 的 delete_file 特判，
//   且不记 allow-always——"每次都问"是硬要求）；
// - 保护路径硬拒绝（见 delete-guard.ts，盘根/用户目录/工作区根/系统目录）。
//
// registry 为保持无 electron 依赖，delete_file 的 ToolDef 只放占位 execute，
// 真正的删除在 run.ts 的 executeTool 包装层拦截转这里（同 ask_user）。

import { existsSync } from 'fs'
import { resolve } from 'path'
import { shell } from 'electron'
import { isProtectedPath } from './delete-guard'

export interface TrashOutcome {
  ok: boolean
  /** 归一化后的实际删除目标 */
  path: string
  /** ok=false 时给模型/用户看的原因 */
  error?: string
}

/**
 * 把文件/文件夹移入回收站。
 * @param target 模型给的路径（调用方已用 resolveToolPath 归一为绝对路径）
 * @param workspace 绑定工作区（用于保护根判定）
 */
export async function trashToRecycleBin(
  target: string,
  workspace: string | null
): Promise<TrashOutcome> {
  const abs = resolve(target)
  if (isProtectedPath(abs, workspace)) {
    return {
      ok: false,
      path: abs,
      error: `拒绝删除：${abs} 是受保护位置（盘根/用户目录/工作区根/系统目录），不允许删除。`
    }
  }
  if (!existsSync(abs)) {
    return { ok: false, path: abs, error: `文件不存在：${abs}` }
  }
  try {
    await shell.trashItem(abs)
  } catch (err) {
    return {
      ok: false,
      path: abs,
      error: `移入回收站失败：${err instanceof Error ? err.message : String(err)}`
    }
  }
  return { ok: true, path: abs }
}
