// 产出文件解析（纯字符串处理，主进程与渲染层共用）。
//
// 用途：认出"这次工具写了哪个文件"，给聊天里的文件卡片（同款口径）提供
// 文件名 + 动作标签 + 相对工作区的路径；点击卡片 → 右侧栏预览。
//
// 为什么不放主进程：渲染层重建历史会话时也要生成卡片，而渲染层不能 import 主进程模块。
// 这里刻意不依赖 node:path（渲染层没有），全用字符串归一化。

/** 有"产出/修改文件"语义的工具 → 卡片上的动作标签 */
export const PRODUCING_TOOLS: Record<string, string> = {
  write_file: '已写入',
  edit_file: '已修改',
  mkdir: '已创建目录',
  note_export: '已导出',
  download_file: '已下载',
  export_pdf: '已导出'
}

/** run_js 产出文件标记（结果文本末尾的系统行）：模型代码写哪些文件不可预知，
 * 主进程执行前后快照 diff 出清单后①走 out 槽发实时事件②在结果里追加此行——
 * 历史会话重建时渲染层只有落盘的工具结果文本，靠它还原文件卡。模型会看见但无害
 * （description 里注明忽略）。 */
export const RUN_JS_MARKER = '__AEMEATH_FILES__:'

/** 从 run_js 结果文本解析产出文件清单。
 * 标记按**整行**匹配（放在结果开头——末尾会被工具结果截断管道切掉，历史还原就失效）。 */
export function parseRunJsMarker(resultText: string): string[] {
  const idx = resultText.indexOf(RUN_JS_MARKER)
  if (idx < 0) return []
  const lineEnd = resultText.indexOf('\n', idx)
  const payload = resultText.slice(idx + RUN_JS_MARKER.length, lineEnd < 0 ? undefined : lineEnd)
  try {
    const arr = JSON.parse(payload.trim()) as unknown
    if (!Array.isArray(arr)) return []
    return (
      arr
        .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        .map((x) => x.replace(/\\/g, '/').replace(/^\.\/+/, ''))
        // 防御：绝对路径/越界路径不进卡（右侧栏只认工作区内相对路径）
        .filter((x) => !/^[a-zA-Z]:/.test(x) && !x.startsWith('/') && !x.startsWith('../'))
    )
  } catch {
    return []
  }
}

/** 展示前剥掉标记行（工具卡预览不出现系统行；发给模型的全文保留，description 已注明忽略） */
export function stripRunJsMarker(resultText: string): string {
  const idx = resultText.indexOf(RUN_JS_MARKER)
  if (idx < 0) return resultText
  const lineEnd = resultText.indexOf('\n', idx)
  if (lineEnd < 0) return resultText.slice(0, idx).trimEnd()
  return (resultText.slice(0, idx) + resultText.slice(lineEnd + 1)).trimStart()
}

/** 工具调用 → 产出文件列表（历史重建入口：单路径工具走参数，run_js 走结果标记） */
export function producedFilesFromCall(
  toolName: string,
  argsJson: string,
  resultText: string | null,
  workspaceRoot?: string | null
): ProducedFile[] {
  const one = producedFileFromCall(toolName, argsJson, workspaceRoot)
  const out: ProducedFile[] = one !== null ? [one] : []
  if (toolName === 'run_js' && resultText !== null && resultText !== '') {
    for (const rel of parseRunJsMarker(resultText)) {
      if (out.some((f) => f.rel === rel)) continue
      const name =
        rel
          .split('/')
          .filter((p) => p !== '')
          .pop() ?? rel
      out.push({ rel, name, action: '已生成' })
    }
  }
  return out
}

export interface ProducedFile {
  /** 相对工作区的路径（/ 分隔）；右侧栏按它读预览 */
  rel: string
  /** 文件名（卡片标题） */
  name: string
  /** 动作标签（已写入 / 已修改 …） */
  action: string
}

export function isProducingTool(toolName: string): boolean {
  return PRODUCING_TOOLS[toolName] !== undefined
}

/** 从参数 JSON 里取出路径（不同工具族的键名不同） */
export function extractProducedPath(argsJson: string): string | null {
  let args: unknown
  try {
    args = JSON.parse(argsJson)
  } catch {
    return null
  }
  if (typeof args !== 'object' || args === null) return null
  const r = args as Record<string, unknown>
  for (const key of ['path', 'dest', 'savePath']) {
    const v = r[key]
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return null
}

/** 绝对路径判断（Windows 盘符 / UNC / POSIX 根） */
function looksAbsolute(p: string): boolean {
  return /^[a-zA-Z]:/.test(p) || p.startsWith('/') || p.startsWith('\\')
}

/**
 * 工具调用 → 产出文件信息（**只认同工作区内的相对路径**）。
 * 绝对路径：只有调用方提供 `workspaceRoot` 时才认（历史会话恢复时渲染层从 config
 * 拿到工作区根）；没给则返回 null——渲染层若无从得知根，硬猜会把卡片指向错误文件。
 * 主进程侧路径可用 resolveProducedFile（它从 config 自己取根）。
 */
export function producedFileFromCall(
  toolName: string,
  argsJson: string,
  workspaceRoot?: string | null
): ProducedFile | null {
  const action = PRODUCING_TOOLS[toolName]
  if (action === undefined) return null
  return buildFileRef(argsJson, action, workspaceRoot)
}

/** 路径参数 → 文件引用（归一化 + 越界防护，产出/读取两条入口共用） */
function buildFileRef(
  argsJson: string,
  action: string,
  workspaceRoot?: string | null
): ProducedFile | null {
  const raw = extractProducedPath(argsJson)
  if (raw === null) return null

  let rel: string
  if (looksAbsolute(raw)) {
    const root = workspaceRoot ?? ''
    if (root === '') return null
    rel = relativizeAgainst(raw, root)
    if (rel === '') return null
  } else {
    rel = raw
      .replace(/\\/g, '/')
      .replace(/^\.\/+/, '')
      .replace(/\/+/g, '/')
      .trim()
    if (rel === '' || rel === '.' || rel.startsWith('../') || rel.includes('/../')) {
      return null
    }
  }
  const name =
    rel
      .split('/')
      .filter((p) => p !== '')
      .pop() ?? rel
  return { rel, name, action }
}

/** 有"读取文件"语义的工具（点击可查看她读了什么， 参考成熟实现） */
const READING_TOOLS: Record<string, string> = {
  read_file: '读取',
  note_read: '读取'
}

/**
 * 工具调用 → 文件引用（**读写类都认**）：过程中文件行（同款口径）。
 * 与 producedFileFromCall 的区别：那个只认"产出"（回复末尾的卡片）；这个连读取也算——
 * 她读过/改过的文件都应该能直接点开看。
 */
export function fileRefFromCall(
  toolName: string,
  argsJson: string,
  workspaceRoot?: string | null
): ProducedFile | null {
  const reading = READING_TOOLS[toolName]
  if (reading !== undefined) return buildFileRef(argsJson, reading, workspaceRoot)
  const producing = PRODUCING_TOOLS[toolName]
  if (producing === undefined) return null
  return buildFileRef(argsJson, producing, workspaceRoot)
}

/** 绝对路径 → 相对 root 的路径；不在 root 内返回 ''（纯字符串实现，不依赖 node:path） */
function relativizeAgainst(abs: string, root: string): string {
  const norm = (x: string): string => x.replace(/\\/g, '/').replace(/\/+$/, '')
  const a = norm(abs)
  const r = norm(root)
  // Windows 路径大小写不敏感：比较时统一小写，切片用原串长度
  if (a.toLowerCase() === r.toLowerCase()) return ''
  if (!a.toLowerCase().startsWith(r.toLowerCase() + '/')) return ''
  return a.slice(r.length + 1)
}
