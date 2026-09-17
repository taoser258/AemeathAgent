/**
 * 工具中文名 + "人话"描述。
 *
 * 过程时间线只写 `edit_file` 这种英文名、审批卡里全是英文参数与技术术语，
 * 用户看不懂发生了什么、该不该点同意。这里集中两层翻译：
 * ① toolNameWithLabel：`edit_file（改文件）`——时间线与审批卡统一写法；
 * ② summarizeToolCall：把参数 JSON 翻成一句人话（"改动「notes/a.md」里的内容"）。
 *
 * 放 shared 是因为渲染层（工具卡/审批卡）与主进程（审批 reason 文案）都要用；
 * 纯函数、零依赖，可单测。
 */

/** 内置工具的中文短名（与 registry.ts 的 ToolDef.name 一一对应，新增工具记得补） */
export const TOOL_LABELS: Record<string, string> = {
  current_time: '查时间',
  calculate: '算数',
  read_file: '读文件',
  list_dir: '看目录',
  write_file: '写文件',
  edit_file: '改文件',
  mkdir: '建文件夹',
  mark_temp_files: '登记中间产物',
  delete_file: '删文件',
  undo_last_change: '撤销改动',
  todo_write: '更新任务清单',
  note_write: '记笔记',
  note_read: '看笔记',
  study_progress_write: '记学习进度',
  study_progress_read: '看学习进度',
  active_window: '看当前窗口',
  describe_image: '识图',
  ocr_image: '本机识字',
  skill_use: '用技能',
  search_files: '按文件名找',
  search_content: '搜文件内容',
  fetch_url: '打开网页',
  download_file: '下载文件',
  note_export: '导出笔记',
  search_history: '翻历史对话',
  run_shell: '跑命令',
  run_js: '写文档',
  export_pdf: '转 PDF',
  web_search: '联网搜索',
  spawn_agent: '派子代理',
  ask_user: '问你问题',
  memory_save: '记住一条',
  memory_search: '回忆'
}

/**
 * 取中文短名。MCP 工具（`mcp__命名空间__工具`）单独标注；未知工具返回 ''（调用方自行兜底，
 * 不要瞎编名字——宁可只显示英文原名）。
 */
export function toolLabel(name: string): string {
  const hit = TOOL_LABELS[name]
  if (hit !== undefined) return hit
  if (name.startsWith('mcp__')) {
    const ns = name.split('__')[1] ?? ''
    return ns === '' ? '外部工具' : `外部工具：${ns}`
  }
  return ''
}

/** `edit_file（改文件）`——时间线与审批卡的统一写法；未知工具只回英文名 */
export function toolNameWithLabel(name: string): string {
  const label = toolLabel(name)
  return label === '' ? name : `${name}（${label}）`
}

/**
 * 宽松解析 argsPreview。注意它可能被**截断**（主进程截到 120 字符），
 * 所以 JSON.parse 失败是常态：退化为正则抠 `"键":"值"` 对，够我们取 path/command 了。
 */
export function parseArgsLoose(preview: string): {
  flat: Record<string, string>
  /** 完整可解析时的原始对象（取数组长度等用）；截断时为 null */
  json: Record<string, unknown> | null
} {
  const text = preview.trim()
  if (text === '') return { flat: {}, json: null }
  let json: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      json = parsed as Record<string, unknown>
    }
  } catch {
    /* 截断的 JSON：下面走正则兜底 */
  }
  if (json !== null) {
    const flat: Record<string, string> = {}
    for (const [k, v] of Object.entries(json)) {
      flat[k] = typeof v === 'string' ? v : JSON.stringify(v)
    }
    return { flat, json }
  }
  const flat: Record<string, string> = {}
  const re = /"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) flat[m[1]] = m[2]
  return { flat, json: null }
}

/** 一句话太长就截断（审批卡里只留一眼能扫完的长度） */
function brief(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** ask_user 的 questions → 题干列表（优先原始 json；截断兜底时退用抠到的单个 prompt） */
function askPromptsOf(parsed: {
  flat: Record<string, string>
  json: Record<string, unknown> | null
}): string[] {
  const qs = parsed.json?.questions
  if (Array.isArray(qs)) {
    return qs
      .map((q) =>
        typeof q === 'object' &&
        q !== null &&
        typeof (q as { prompt?: unknown }).prompt === 'string'
          ? ((q as { prompt: string }).prompt ?? '').trim()
          : ''
      )
      .filter((p) => p !== '')
  }
  return parsed.flat.prompt ? [parsed.flat.prompt] : []
}

/**
 * 只取这次调用的「关键参数」（活动行专用）——活动行已经写了「正在跑命令…」，
 * 再接一句完整动宾短语就重复造句了，这里只给目标：命令 / 路径 / 查询词。
 * 取不到返回 ''（调用方就不拼这一段）。
 */
export function keyArgOf(name: string, argsPreview: string): string {
  const parsed = parseArgsLoose(argsPreview)
  const { flat, json } = parsed
  switch (name) {
    case 'run_shell':
      return brief(flat.command ?? '', 60)
    case 'run_js':
      // 代码常为多行：压掉换行再截断（活动行是一行式 UI，brief 本身不处理换行）
      return brief((flat.code ?? '').replace(/\s+/g, ' ').trim(), 60)
    case 'calculate':
      return brief(flat.expression ?? '', 60)
    case 'export_pdf':
      return brief(flat.path ?? '', 60)
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'list_dir':
    case 'mkdir':
    case 'delete_file':
    case 'download_file':
      return brief(flat.path ?? '', 60)
    case 'search_files':
    case 'search_content':
    case 'web_search':
    case 'memory_search':
    case 'search_history':
      return brief(flat.query ?? flat.pattern ?? '', 48)
    case 'fetch_url':
      return brief(flat.url ?? '', 50)
    case 'skill_use':
      return brief(flat.name ?? '', 32)
    case 'spawn_agent':
      return brief(flat.objective ?? '', 48)
    case 'ask_user':
      return brief(askPromptsOf({ flat, json })[0] ?? '', 48)
    case 'memory_save':
      return brief(flat.content ?? '', 48)
    default:
      return ''
  }
}

/**
 * 把一次工具调用翻成一句人话（返回动宾短语，不带主语——调用方自己拼"她打算…"）。
 * 未知工具返回 ''：调用方就别硬翻译，退回显示原始参数即可。
 */
export function summarizeToolCall(name: string, argsPreview: string): string {
  const { flat, json } = parseArgsLoose(argsPreview)
  const path = flat.path ?? ''
  const query = flat.query ?? flat.pattern ?? ''
  switch (name) {
    case 'current_time':
      return '看看现在几点'
    case 'calculate':
      return flat.expression === undefined || flat.expression === ''
        ? '算一个数'
        : `算「${brief(flat.expression, 60)}」`
    case 'read_file':
      return path === '' ? '读取文件内容' : `读取「${path}」的内容`
    case 'list_dir':
      return path === '' ? '看看某个目录里有哪些文件' : `看看「${path}」里有哪些文件`
    case 'write_file':
      return path === '' ? '写一份文件' : `把内容写进「${path}」（整份文件）`
    case 'edit_file': {
      const edits = json !== null && Array.isArray(json.edits) ? json.edits.length : 0
      const where = path === '' ? '文件' : `「${path}」`
      return edits > 0 ? `改动${where}里的内容（共 ${edits} 处）` : `改动${where}里的内容`
    }
    case 'mkdir':
      return path === '' ? '新建一个文件夹' : `新建文件夹「${path}」`
    case 'mark_temp_files': {
      const n = json !== null && Array.isArray(json.paths) ? json.paths.length : 0
      return n > 0 ? `登记 ${n} 个中间产物待清理` : '登记自己产生的中间产物'
    }
    case 'delete_file':
      return path === '' ? '删除一个文件' : `把「${brief(path, 60)}」移入回收站`
    case 'undo_last_change':
      return '撤销上一次文件改动'
    case 'todo_write':
      return '更新任务清单'
    case 'note_write':
      return '把知识点记进笔记'
    case 'note_read':
      return '看看之前记的笔记'
    case 'study_progress_write':
      return '更新学习进度与掌握度'
    case 'study_progress_read':
      return '看看学到哪了'
    case 'active_window':
      return '看看你当前开着的窗口'
    case 'describe_image':
      return flat.path === undefined || flat.path === '' ? '看图' : `看图：${brief(flat.path, 50)}`
    case 'ocr_image':
      return flat.path === undefined || flat.path === ''
        ? '本机识字'
        : `本机识字：${brief(flat.path, 50)}`
    case 'skill_use':
      return flat.name === undefined || flat.name === ''
        ? '使用一个技能'
        : `使用技能「${flat.name}」`
    case 'search_files':
      return query === '' ? '按文件名找文件' : `按文件名找「${query}」`
    case 'search_content':
      return query === '' ? '在所有文件内容里搜' : `在所有文件内容里搜「${query}」`
    case 'fetch_url':
      return flat.url === undefined || flat.url === ''
        ? '打开一个网页'
        : `打开网页 ${brief(flat.url, 60)}`
    case 'download_file': {
      const to = flat.path === undefined || flat.path === '' ? '工作目录' : `「${flat.path}」`
      return flat.url === undefined || flat.url === ''
        ? '下载一个文件'
        : `把 ${brief(flat.url, 50)} 下载到${to}`
    }
    case 'note_export':
      return '把笔记导出成文件'
    case 'search_history':
      return query === '' ? '翻一翻历史对话' : `翻历史对话，找「${query}」`
    case 'run_shell':
      return flat.command === undefined || flat.command === ''
        ? '执行一条命令'
        : `在你的工作目录里执行命令：${brief(flat.command, 80)}`
    case 'run_js':
      return flat.code === undefined || flat.code === ''
        ? '执行一段代码来生成文档'
        : `执行一段代码来生成文档（Word/Excel/PPT）：${brief(flat.code.replace(/\s+/g, ' ').trim(), 80)}`
    case 'export_pdf':
      return flat.path === undefined || flat.path === ''
        ? '把 HTML 转成 PDF'
        : `把 HTML 转成 PDF：${brief(flat.path, 60)}`
    case 'web_search':
      return query === '' ? '上网搜一搜' : `上网搜「${query}」`
    case 'spawn_agent':
      return flat.objective === undefined || flat.objective === ''
        ? '派一个子代理去处理'
        : `派一个子代理去处理：${brief(flat.objective)}`
    case 'memory_save':
      return flat.content === undefined || flat.content === ''
        ? '记住一件事'
        : `记住这件事：${brief(flat.content)}`
    case 'memory_search':
      return query === '' ? '回忆一下之前的事' : `回忆和「${query}」有关的事`
    case 'ask_user': {
      const prompts = askPromptsOf({ flat, json })
      if (prompts.length === 0) return '想问你几个问题'
      if (prompts.length === 1) return `想问你：${brief(prompts[0])}`
      return `想问你 ${prompts.length} 个问题：${brief(prompts[0])}`
    }
    default:
      return ''
  }
}
