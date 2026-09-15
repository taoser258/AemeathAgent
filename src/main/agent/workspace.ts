// 工作区辅助：learn 模式绑定目录的笔记 vault 初始化。
// 独立纯 Node 模块（无 electron 依赖）可单测；绑定空目录 → 建 notes/index.md；
// 目录非空 / 不存在 → 不动并给可读结论（可重复执行不报错）。

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'

export const VAULT_INDEX_TEMPLATE = [
  '# 学习笔记 vault',
  '',
  '此目录由 Aemeath 创建，用于沉淀学习模式的笔记与闪卡（Markdown，可直接用 Obsidian 等打开）。',
  '',
  '- 创建时间：见文件时间戳',
  '- 用法：对话里让爱弥斯把知识点落成笔记，她会用 note_write 记录；导出的 Markdown 也可手动放进 notes/。',
  ''
].join('\n')

export interface VaultInitResult {
  /** 是否实际做了初始化（建了 notes/index.md） */
  initialized: boolean
  /** 可读结论（设置页提示 / debug 日志两用） */
  message: string
}

/**
 * learn 绑定目录的 vault 初始化（幂等）：
 * - 目录不存在 → 不动（绑定流程走目录选择器，正常不会发生；防手滑不静默建目录）
 * - 目录非空 → 不动（尊重已有内容，绝不覆盖）
 * - 空目录 → 建 notes/ + notes/index.md 占位
 */
export function ensureLearnVault(dir: string): VaultInitResult {
  if (dir === '' || !existsSync(dir)) {
    return { initialized: false, message: `目录不存在，未初始化：${dir}` }
  }
  const entries = readdirSync(dir)
  if (entries.length > 0) {
    return { initialized: false, message: `目录非空，保持原样未初始化：${dir}` }
  }
  mkdirSync(join(dir, 'notes'), { recursive: true })
  writeFileSync(join(dir, 'notes', 'index.md'), VAULT_INDEX_TEMPLATE, 'utf8')
  return { initialized: true, message: `已初始化笔记 vault（notes/index.md）：${dir}` }
}
