// 产出文件解析（主进程侧）：在 shared/produced-file 的纯字符串规则之上，
// 额外支持**绝对路径**——主进程知道工作区根，能把它换算成右侧栏可读的相对路径。
// （渲染层重建历史时只能用 shared 的相对路径版本，见那边的注释。）

import { isAbsolute, relative, resolve } from 'path'
import { PRODUCING_TOOLS, extractProducedPath, type ProducedFile } from '@shared/produced-file'

export type { ProducedFile }

/**
 * 工具名 + 参数 JSON + 工作区根 → 产出文件信息。
 * 返回 null = 不产出文件 / 没给路径 / 落在工作区外 / 参数非法。
 */
export function resolveProducedFile(
  toolName: string,
  argsJson: string,
  workspace: string | null
): ProducedFile | null {
  const action = PRODUCING_TOOLS[toolName]
  if (action === undefined) return null
  if (workspace === null || workspace === '') return null

  const raw = extractProducedPath(argsJson)
  if (raw === null) return null

  const abs = isAbsolute(raw) ? raw : resolve(workspace, raw)
  const rel = relative(resolve(workspace), abs).replace(/\\/g, '/')
  // 越界（../ 开头）或就是工作区本身都不给卡片
  if (rel === '' || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) return null

  const name =
    rel
      .split('/')
      .filter((p) => p !== '')
      .pop() ?? rel
  return { rel, name, action }
}
