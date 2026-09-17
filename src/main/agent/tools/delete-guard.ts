// 删除保护判定（纯路径逻辑，无 electron / 无 fs 依赖，可直接单测）。
// trash.ts 的回收站执行与 permission.ts 的审批都以这里为准，避免两处口径漂移。

import { homedir } from 'os'
import { parse, resolve, sep } from 'path'

/** 受保护目录（精确匹配；其**内部**文件仍可删，禁止的是把这些目录本身删掉） */
export function protectedRoots(): string[] {
  const home = homedir()
  const sysDrive = parse(home).root // C:\
  return [
    home,
    `${home}${sep}Desktop`,
    `${home}${sep}Documents`,
    `${home}${sep}Downloads`,
    sysDrive,
    `${sysDrive}Windows`,
    `${sysDrive}Windows${sep}System32`,
    `${sysDrive}Program Files`,
    `${sysDrive}Program Files (x86)`
  ].map((p) => resolve(p))
}

/**
 * 目标本身是否是受保护位置（盘根 / 用户主目录及系统库 / 工作区根自身）。
 * target 需为绝对路径；workspace 为绑定工作区（可空）。
 */
export function isProtectedPath(target: string, workspace: string | null): boolean {
  const norm = resolve(target)
  for (const root of protectedRoots()) {
    if (norm.toLowerCase() === root.toLowerCase()) return true
  }
  if (workspace !== null && workspace !== '') {
    if (norm.toLowerCase() === resolve(workspace).toLowerCase()) return true
  }
  return false
}
