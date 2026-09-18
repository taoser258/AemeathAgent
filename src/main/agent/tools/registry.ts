// 工具注册表。早期只允许只允许只读工具**入表，
// 任何写文件 / 命令执行 / 网络请求类工具后续阶段。
// 每个工具自带 JSON Schema（供 LLM 的 tools 参数）+ execute（超时/异常由 executeToolCall 统一包裹）。

import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  statSync,
  readdirSync,
  writeFileSync
} from 'fs'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'path'
import type { LlmTool } from '../../llm/client'
import type { ChatMode } from '@shared/types'
import { recordChange, undoLastChange } from './ledger'
import { mcpManager } from '../../mcp/manager'
import { writeTodos } from './todo-store'
import { getActiveWindow, isScreenEnabled } from './screen'
import { isMemoryEnabled } from '../../memory/gate'
import { appendNotes, readNotes, listNoteSessions } from './note-store'
import { daysLeft, readProgress, setPlan, upsertTopic } from './progress-store'
import { readReview, summarize } from './review-store'
import { listEnabledSkills, readSkillBody } from '../skills'
import { htmlToText } from './html-text'
import { loadSessionMessages } from '../../sessions/session-store'
import {
  classifyCommand,
  executeShell,
  peekShellBg,
  startShellBackground,
  stopShellBg,
  SHELL_DEFAULT_TIMEOUT_MS
} from './run-shell'
import { executeJs, JS_DEFAULT_TIMEOUT_MS } from './run-js'
import { safeCalculate } from './calculate'
import { searchWeb } from './web-search'
import { netFetch } from '../../net/fetch'
import { countLineDiff } from '@shared/diff-stat'
import { RUN_JS_MARKER } from '@shared/produced-file'
import { addEntry, readEntries } from '../../memory/memory-store'
import { scoreEntries } from '@shared/memory'
import { searchWorkspaceContent } from '../../search/content-search'
import { runOcr } from './ocr'
import {
  PDF_DEFAULT_PAGES,
  PDF_MAX_BYTES,
  PDF_MAX_PAGES,
  formatPdfPages,
  isPdfFile,
  pageWindow,
  readPdfPages,
  SCANNED_PDF_HINT
} from '../../chat/pdf-extract'

export interface ToolContext {
  signal: AbortSignal
  /** 触发本次调用的会话 id（账本按会话记账；测试可传任意标识） */
  sessionId: string
  /** 会话模式的绑定工作目录 */
  workspace?: string | null
  /**
   * 附加产物槽（v17 diff 徽标）：write_file/edit_file 执行时写入变更行数统计，
   * 调用方（run.ts）在 onToolResult 时取走附到事件上 → 聊天文件行显示「+N -M」。
   * files：run_js 执行后快照 diff 出的产出文件（相对路径）→ 产出文件卡片。
   * 可选字段：直接构造 ctx 的测试代码不受影响。
   */
  out?: { diffStat?: { added: number; removed: number }; files?: string[] }
}

export interface ToolDef {
  /** 工具名，即传给 LLM 的 function 名称 */
  name: string
  /** 给 LLM 看的工具用途描述（写清楚什么时候该用，直接影响调用质量） */
  description: string
  /** 参数 JSON Schema（OpenAI function calling 的 parameters 字段） */
  parameters: Record<string, unknown>
  /**
   * 是否属"变更"类工具（权限管变更不管读取）。
   * 缺省 false = 只读工具，任何权限模式下直接执行不询问；
   * true = 会改动文件/环境。**注意变更类不等于"一定弹审批"**： 对齐
   * 成熟 Agent 实现 后，confirm 模式下工作区内的变更也直接执行，只有越界才请示
   * （判定见 chat/approval-policy.ts）。plan 模式则对所有变更类先出计划。
   */
  mutating?: boolean
  /** 执行入口：返回给 LLM 看的结果文本；抛异常 = 业务错误（会被回灌让模型自纠） */
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>
}

/** 单次工具执行超时（毫秒） */
const TOOL_TIMEOUT_MS = 10_000

/** 按工具的超时覆盖：run_shell 的命令本质需要分钟级（默认 60s + 余量）；
 * web_search 要跑多引擎回退链（单引擎 6s × 最多 4 个）。 */
const TOOL_TIMEOUT_OVERRIDES: Record<string, number> = {
  run_shell: 95_000,
  web_search: 35_000,
  run_js: 190_000, // 子进程冷启 + 文档生成留分钟级余量（工具内另有 180s 上限）
  // 识图要走一次视觉模型调用（推理慢、图片还要上传），默认 10s 必然被砍——
  // 与 vision.ts 的 VISION_TIMEOUT_MS(60s) 同档并留出余量
  describe_image: 95_000,
  // 本机 OCR 要冷启 WinRT（首次加载慢），给 20s 探针超时留余量
  ocr_image: 30_000
}

// ── 路径基准────────────────────────────────────────────
// 相对路径的解析基准 = 应用所在目录（dev 下即项目根）。不取 process.cwd()：
// 启动器 cwd 不可控（实测曾解析到盘根 E:\，模型只能从盘根盲钻目录树）。
// 基准由 main 进程 ready 后注入（setToolPathBase），registry 本身保持无 electron 依赖可单测。
let toolPathBase = ''

/** 注入相对路径解析基准（app.getAppPath()）；测试可直接注入临时目录 */
export function setToolPathBase(dir: string): void {
  toolPathBase = dir
}

export function getToolPathBase(): string {
  return toolPathBase
}

// ── 按模式工具可见性────────────────────────────────────
// 缺省 'all' = 全部可见（与 P2 行为一致）；数组 = 仅列出的内置工具可见。
// 与路径基准同款注入式：registry 保持无 config/electron 依赖，main ready 注入 + 设置保存后即时更新。
export interface ToolVisibility {
  work?: 'all' | string[]
  learn?: 'all' | string[]
}

let toolVisibility: ToolVisibility = {}

/** 注入按模式可见性配置（undefined/缺键 = 该模式全可见） */
export function setToolVisibility(vis: ToolVisibility | undefined): void {
  toolVisibility = vis ?? {}
}

/**
 * 内置工具在某模式下是否可见（喂给 LLM 的清单口径）。
 * chat 模式恒 false（对话模式无工具，与 run.ts 的调用侧门控双保险）；
 * MCP 工具不经过本函数——可见性由 server 启停开关管理。
 */
export function isToolVisibleForMode(name: string, mode: ChatMode): boolean {
  if (mode === 'chat') return false
  const vis = toolVisibility[mode]
  if (vis === undefined || vis === 'all') return true
  return vis.includes(name)
}

// ── search_history 的数据基准：会话存储根（userData/sessions）。
// registry 保持无 electron 依赖：main ready 注入，测试注入临时目录。
let searchHistoryBase = ''

export function setSearchHistoryBase(dir: string): void {
  searchHistoryBase = dir
}

// ── run_shell 的用户扩展白名单：内置默认 + 配置合并（运行时去重）。
// registry 无 config 依赖：main ready 注入，设置保存后即时更新。
let userShellAllowlist: readonly string[] = []

export function setShellAllowlist(list: readonly string[]): void {
  userShellAllowlist = list
}

/** 门禁与执行共用的命令分类入口（保证两侧白名单口径永远一致） */
export function classifyShellCommand(command: string): 'blocked' | 'allowed' | 'ask' {
  return classifyCommand(command, userShellAllowlist)
}

/**
 * 网络工具（fetch_url / download_file）的 SSRF 防线例外开关——**仅供单测**：
 * 测试要在 127.0.0.1 起 HTTP 服务，而回环地址默认被安全线拦截。
 * 应用主进程永不调用本函数（内网拦截在生产环境恒开）。
 */
let localNetFetchAllowed = false

export function setLocalNetFetchAllowedForTests(v: boolean): void {
  localNetFetchAllowed = v
}

/** 是否内网/保留地址主机名（SSRF 防线）：回环、私网段、链路本地、单标签内网名都算 */
export function isPrivateHost(hostname: string): boolean {
  let h = hostname.toLowerCase().trim()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1) // IPv6 字面量去方括号
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true
  if (!h.includes('.') && !h.includes(':')) return true // 单标签主机名（内网 NetBIOS 等）
  // IPv4 字面量：私网/保留段
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if ([0, 10, 127].includes(a)) return true
    if (a === 169 && b === 254) return true // 链路本地
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    return false
  }
  if (h.includes(':')) {
    // IPv6 字面量：回环 / 未指定 / 唯一本地（fc00::/7）/ 链路本地（fe80::/10）
    if (h === '::' || h === '::1') return true
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h)
    if (mapped !== null) return isPrivateHost(mapped[1])
    const first = h.split(':')[0] ?? ''
    if (/^f[cd]/.test(first) || /^fe[89ab]/.test(first)) return true
    return false
  }
  return false
}

/** 校验「公网 http(s) URL」：协议白名单 + 主机名安全线；返回解析后的 URL 供复用 */
export function assertPublicHttpUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error(`URL 无法解析：${raw.slice(0, 200)}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`只支持 http/https 协议（收到 ${u.protocol}）`)
  }
  if (!localNetFetchAllowed && isPrivateHost(u.hostname)) {
    throw new Error(`拒绝访问内网/回环地址：${u.hostname}（安全线：网络工具只访问公网）`)
  }
  return u
}

/** 工具入参路径归一：绝对路径原样规范化；相对路径优先在绑定工作目录内解析，
 * 未绑定回退应用目录基准（现状语义不变）。返回绝对路径。
 * 盘外语义不变：绝对路径（含其它盘符）原样使用——与 复核过的口径一致。 */
export function resolveToolPath(raw: string, workspace?: string | null): string {
  const p = normalize(raw)
  if (isAbsolute(p)) return p
  const base =
    workspace !== undefined && workspace !== null && workspace !== '' ? workspace : toolPathBase
  if (base === '') {
    throw new Error('相对路径基准未初始化（应用尚未就绪），请使用绝对路径。')
  }
  return join(base, p)
}

/** 只读工具白名单：current_time —— 查询当前时间（零副作用） */
const currentTimeTool: ToolDef = {
  name: 'current_time',
  description:
    '获取当前的日期、星期与精确时间。当用户询问时间/日期/星期，或任务需要知道当前时间时使用。',
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async () => {
    const now = new Date()
    const week = '日一二三四五六'[now.getDay()]
    return [
      `当前时间：${now.toLocaleString('zh-CN', { hour12: false })}（星期${week}）`,
      `ISO: ${now.toISOString()}`,
      `Unix 毫秒: ${now.getTime()}`
    ].join('\n')
  }
}

/** 只读工具白名单：calculate —— 单条算术表达式精确求值（零副作用，不弹审批）。
 * 治"口算自信但算错"：六位数以上/百分比/多步连算先走这里；多步或要用数学/日期
 * 函数才走 run_js（子进程 + 弹卡）。内核与安全拦截在 ./calculate（纯逻辑可单测）。 */
const calculateTool: ToolDef = {
  name: 'calculate',
  description:
    '精确计算单条数学表达式，立即返回确定数值。支持加减乘除、括号、乘方 **、取余 %、小数、千位逗号（3,842）与科学计数法（2.5e2）。' +
    '**凡是涉及算术（百分比换算、多步连算、总价/折扣/天数差等）都必须先调用本工具拿到结果再回答，禁止心算**——心算在多位数时经常错且错得很自然。' +
    '百分数自己换成小数写（17.5% 写成 0.175）。需要开方/三角函数/日期函数或多步编程计算时才用 run_js；本工具不支持变量、函数与标识符。',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: '一条算术表达式，如 3842*0.175*12.6'
      }
    },
    required: ['expression'],
    additionalProperties: false
  },
  execute: async (args) => {
    const r = safeCalculate(args.expression)
    if (!r.ok) throw new Error(r.error)
    return r.text
  }
}

/** read_file 单次读取的行数上限（模型可用 offset/limit 分段读大文件） */
const READ_MAX_LINES = 800
/** read_file 默认行数 */
const READ_DEFAULT_LINES = 400
/** read_file 单文件字节上限（超过直接拒绝，防止把二进制/巨型文件拖进内存） */
const READ_MAX_BYTES = 2 * 1024 * 1024
/** 二进制嗅探窗口：头部 8KB 出现 NUL 字节即判为二进制 */
const BINARY_SNIFF_BYTES = 8192
/** list_dir 单次列出的条目上限 */
const LIST_MAX_ENTRIES = 500

/** 人类可读的文件大小 */
function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

/**
 * 非纯文本文件的明确边界提示：read_file 只能读文本，图片/Office 会被
 * 二进制嗅探拒绝——但那句"含 NUL 字节"对用户是天书。这里按扩展名提前给准确指引：
 * 图片 → 走聊天附件（模型开多模态才能"看"）；Office → 走右侧栏预览。
 * **PDF 不在此列**（P8-T2 起 read_file 能直接抽它的正文，在 execute 里分流）。
 * 返回 null = 不是这些已知类型（交给通用二进制嗅探兜底）。
 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?)$/i
const OFFICE_EXT = /\.(docx?|xlsx?|pptx?|epub)$/i
function nonTextFileHint(filePath: string): string | null {
  if (IMAGE_EXT.test(filePath)) {
    return `${filePath} 是图片，read_file 读不了它的内容。要看图，请把图片作为聊天附件发给她（需当前模型在 设置 → 模型 开启「多模态」）；只想在界面上查看，用右侧栏文件预览打开。`
  }
  if (OFFICE_EXT.test(filePath)) {
    return `${filePath} 是 Office 文档（非纯文本），read_file 读不了。若是用户刚发来的附件，正文（docx/xlsx/pptx）已随消息内联，直接用消息里的内容即可；否则可在右侧栏文件树点开看文本级预览，或请用户另存为文本/重新附件发来（.docx→.txt 亦可）。`
  }
  return null
}

/** 参数里取字符串字段；缺省/类型不对返回 null（由调用方给模型可读报错） */
function strArg(args: Record<string, unknown>, key: string): string | null {
  const v = args[key]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

/** 参数里取正整数字段；缺省返回 fallback，非法返回 null */
function intArg(args: Record<string, unknown>, key: string, fallback: number): number | null {
  const v = args[key]
  if (v === undefined) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || !Number.isInteger(v)) return null
  return Math.floor(v)
}

/** 只读工具：read_file —— 在白名单目录内读取文本文件（带行窗口，防大文件吃穿上下文） */
const readFileTool: ToolDef = {
  name: 'read_file',
  description:
    '读取一个文本文件的内容（自动带行号）。推荐绝对路径；相对路径会相对应用所在目录解析。二进制文件与超过 2MB 的文件会被拒绝。大文件用 offset/limit 分段读取。' +
    `**PDF 也能直接读**（自动抽取正文并按【第 N 页】分段）：读 PDF 时 offset/limit 的含义变为页码——offset=起始页（缺省 1），limit=最多页数（缺省 ${PDF_DEFAULT_PAGES}）；扫描件（没有文本层）会明确告知。`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要读取的文件路径（推荐绝对路径）' },
      offset: {
        type: 'number',
        description: '起始位置：文本文件为起始行号，PDF 为起始页（都从 1 开始），缺省为 1'
      },
      limit: {
        type: 'number',
        description: `最多读取量：文本文件为行数（≤${READ_MAX_LINES}），PDF 为页数（≤${PDF_MAX_PAGES}）；缺省 文本 ${READ_DEFAULT_LINES} 行 / PDF ${PDF_DEFAULT_PAGES} 页`
      }
    },
    required: ['path']
  },
  execute: async (args, ctx) => {
    const rawPath = strArg(args, 'path')
    if (rawPath === null) throw new Error('缺少 path 参数（要读取的文件路径）')
    const offset = intArg(args, 'offset', 1)
    if (offset === null) throw new Error('offset 必须是正整数（起始行号/起始页，从 1 开始）')
    const limit = intArg(args, 'limit', 0) // 0 = 未指定（文本与 PDF 的缺省值不同，分别在各自分支取）
    if (limit === null) {
      throw new Error(`limit 必须是正整数（文本 ≤${READ_MAX_LINES} 行 / PDF ≤${PDF_MAX_PAGES} 页）`)
    }

    const filePath = resolveToolPath(rawPath, ctx.workspace)

    const info = statSync(filePath) // 不存在 → ENOENT 由 executeToolCall 收敛为可读错误
    if (info.isDirectory()) {
      throw new Error(`${filePath} 是一个目录，请改用 list_dir 查看其内容。`)
    }

    // ── PDF 分流（P8-T2）：它的正文靠 unpdf 抽文本层，按行读字节是读不出来的 ──
    if (isPdfFile(filePath)) {
      if (info.size > PDF_MAX_BYTES) {
        throw new Error(
          `PDF 过大（${fmtBytes(info.size)} > ${PDF_MAX_BYTES / 1024 / 1024} MB），拒绝读取——请让用户拆分或提供关键页截图。`
        )
      }
      const pdf = await readPdfPages(readFileSync(filePath))
      if (!pdf.ok) throw new Error(`${filePath}：${pdf.error}`)
      const { from, to } = pageWindow(
        pdf.totalPages,
        offset,
        limit === 0 ? PDF_DEFAULT_PAGES : limit
      )
      const header = `# ${filePath}（PDF，共 ${pdf.totalPages} 页；本次第 ${from}–${to} 页）`
      const formatted = formatPdfPages(pdf.pages, { from, to })
      // 扫描件：没有文本层就不是"读到空内容"，而是"这份文件本来就没有字"——说清楚
      if (formatted.empty) {
        return `${header}\n${SCANNED_PDF_HINT}`
      }
      let out = `${header}\n${formatted.text}`
      if (to < pdf.totalPages) {
        out += `\n…（未显示第 ${to + 1}–${pdf.totalPages} 页；可用 offset=${to + 1} 继续读）`
      }
      return out
    }

    // 图片/Office 不是纯文本——按扩展名给明确边界，而不是笼统的"二进制拒绝"。
    const binaryHint = nonTextFileHint(filePath)
    if (binaryHint !== null) throw new Error(binaryHint)
    if (info.size > READ_MAX_BYTES) {
      throw new Error(`文件过大（${fmtBytes(info.size)} > 2 MB），拒绝读取。`)
    }
    const textLimit = limit === 0 ? READ_DEFAULT_LINES : limit

    // 读满 8KB 嗅探窗口判二进制：NUL 字节几乎不会出现在正常文本里
    const fd = openSync(filePath, 'r')
    try {
      const head = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, info.size))
      readSync(fd, head, 0, head.length, 0)
      if (head.includes(0)) {
        throw new Error(`${filePath} 疑似二进制文件（头部含 NUL 字节），无法按文本读取。`)
      }
      const buf = Buffer.alloc(info.size)
      readSync(fd, buf, 0, buf.length, 0)
      const all = buf.toString('utf8')
      const lines = all.split('\n')
      const total = lines.length
      // 尾部换行产生的空行不算内容行
      const effectiveTotal = total > 1 && lines[total - 1] === '' ? total - 1 : total
      const start = Math.min(offset, Math.max(effectiveTotal, 1))
      const end = Math.min(start - 1 + Math.min(textLimit, READ_MAX_LINES), effectiveTotal)
      const slice = lines.slice(start - 1, end)
      const numbered = slice.map((line, i) => `${String(start + i).padStart(4, ' ')}→ ${line}`)
      const header = `# ${filePath}（第 ${start}–${end} 行，共 ${effectiveTotal} 行）`
      let out = [header, ...numbered].join('\n')
      if (end < effectiveTotal) {
        out += `\n…（未显示第 ${end + 1}–${effectiveTotal} 行；可加大 limit 或用 offset 继续读取）`
      }
      return out
    } finally {
      closeSync(fd)
    }
  }
}

/** 只读工具：list_dir —— 列出白名单目录内的一层条目（目录优先，带类型与大小） */
const listDirTool: ToolDef = {
  name: 'list_dir',
  description:
    '列出一个目录内一层的内容（子目录与文件，目录排前、按名称排序，附文件大小）。推荐绝对路径；相对路径会相对应用所在目录解析。需要看某个文件内容时配合 read_file 使用。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要列出的目录路径（推荐绝对路径）' }
    },
    required: ['path']
  },
  execute: async (args, ctx) => {
    const rawPath = strArg(args, 'path')
    if (rawPath === null) throw new Error('缺少 path 参数（要列出的目录路径）')

    const dirPath = resolveToolPath(rawPath, ctx.workspace)

    const info = statSync(dirPath)
    if (!info.isDirectory()) {
      throw new Error(`${dirPath} 不是目录（是文件），请改用 read_file 读取其内容。`)
    }
    const entries = readdirSync(dirPath, { withFileTypes: true })
    if (entries.length === 0) return `${dirPath} 是空目录。`

    const sorted = [...entries].sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-Hans-CN')
    })
    const shown = sorted.slice(0, LIST_MAX_ENTRIES)
    const lines = shown.map((e) => {
      if (e.isDirectory()) return `[目录] ${e.name}/`
      let size = ''
      try {
        size = ` (${fmtBytes(statSync(`${dirPath}${sep}${e.name}`).size)})`
      } catch {
        // 竞态删除等：大小拿不到就不显示
      }
      return `[文件] ${e.name}${size}`
    })
    if (sorted.length > LIST_MAX_ENTRIES) {
      lines.push(`…（共 ${sorted.length} 项，仅显示前 ${LIST_MAX_ENTRIES} 项）`)
    }
    return [`${dirPath}（${sorted.length} 项）`, ...lines].join('\n')
  }
}

/** 变更类工具：write_file —— 整文件写入（UTF-8），写前强制快照记账（红线②） */
const writeFileTool: ToolDef = {
  name: 'write_file',
  mutating: true,
  description:
    '把文本内容写入文件（UTF-8，整文件覆盖；父目录不存在会自动创建；文件不存在则新建）。相对路径优先在绑定的工作区目录内解析。这是变更类操作：写入前会自动对原文件做快照并记入账本（可撤销）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要写入的文件路径（推荐绝对路径）' },
      content: { type: 'string', description: '要写入的完整文本内容（UTF-8）' }
    },
    required: ['path', 'content']
  },
  execute: async (args, ctx) => {
    const rawPath = strArg(args, 'path')
    if (rawPath === null) throw new Error('缺少 path 参数（要写入的文件路径）')
    const content = args.content
    if (typeof content !== 'string')
      throw new Error('缺少 content 参数（要写入的文本内容，字符串）')

    const filePath = resolveToolPath(rawPath, ctx.workspace)
    // diff 徽标（同款口径）：覆盖前抓旧内容统计增删行（超大文件跳过统计）
    if (ctx.out !== undefined) {
      let oldText: string | null = null
      if (existsSync(filePath)) {
        try {
          const prev = readFileSync(filePath, 'utf8')
          if (prev.length <= 2 * 1024 * 1024) oldText = prev
        } catch {
          // 读不了（权限/编码）就不统计，不影响写入
        }
      }
      ctx.out.diffStat = countLineDiff(oldText, content)
    }
    // 红线②：先快照记账，成功后才允许写入；本行抛异常则整个调用失败、不落盘
    const entry = recordChange(ctx.sessionId, 'write_file', rawPath, filePath)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, content, 'utf8')
    const snapshotNote =
      entry.action === 'update'
        ? `原内容已快照（${entry.snapshotRef}），可撤销`
        : '新建文件，可撤销'
    return `已写入 ${filePath}（${Buffer.byteLength(content, 'utf8')} 字节；${snapshotNote}）`
  }
}

/** 变更类工具：edit_file —— 锚点精确替换（edit 与 str_replace 的收敛形态）。
 * 与 write_file 整文件覆盖互补：局部修改不再全量重写（省 token、免截断）。
 * 红线不变：先快照记账（recordChange 内部拷贝原文件）再写回，可一键撤销。 */
const editFileTool: ToolDef = {
  name: 'edit_file',
  mutating: true,
  description:
    '对已存在的文本文件做锚点精确替换（edits 数组，每处 {old_string, new_string}；可一处或多处）。' +
    '适合局部修改：改几行、修配置、微调文本——比 write_file 整文件重写更省更稳。' +
    'old_string 必须在文件中**唯一命中**：0 处或多处都会被拒绝（多处时请补足上下文使其唯一），' +
    '所以修改前通常先 read_file 确认当前内容。相对路径优先在绑定的工作区目录内解析。' +
    '变更类操作：写回前自动快照并记入账本（可撤销）。新建文件请用 write_file。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件路径（推荐绝对路径）' },
      edits: {
        type: 'array',
        description: '替换列表（至少一项），按顺序应用',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string', description: '要被替换的原文（必须唯一命中）' },
            new_string: { type: 'string', description: '替换后的新文本' }
          },
          required: ['old_string', 'new_string']
        }
      }
    },
    required: ['path', 'edits']
  },
  execute: async (args, ctx) => {
    const rawPath = strArg(args, 'path')
    if (rawPath === null) throw new Error('缺少 path 参数（目标文件路径）')
    const rawEdits = args.edits
    if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
      throw new Error('缺少 edits 参数（非空的 {old_string, new_string} 数组）')
    }
    const edits: Array<{ old: string; new: string }> = rawEdits.map((e, i) => {
      if (typeof e !== 'object' || e === null) throw new Error(`edits[${i}] 必须是对象`)
      const o = (e as Record<string, unknown>).old_string
      const n = (e as Record<string, unknown>).new_string
      if (typeof o !== 'string' || o === '')
        throw new Error(`edits[${i}].old_string 缺失或为空（锚点不能是空串）`)
      if (typeof n !== 'string') throw new Error(`edits[${i}].new_string 缺失（字符串）`)
      return { old: o, new: n }
    })

    const filePath = resolveToolPath(rawPath, ctx.workspace)
    if (!existsSync(filePath)) {
      throw new Error(`文件不存在：${filePath}（新建文件请用 write_file）`)
    }
    const original = readFileSync(filePath, 'utf8')
    // 逐条应用：每条锚点必须恰好命中 1 处（0 处=不存在，多处以=有歧义，都拒绝让模型自纠）
    let content = original
    for (const [i, e] of edits.entries()) {
      const hits = content.split(e.old).length - 1
      if (hits === 0) {
        throw new Error(
          `第 ${i + 1}/${edits.length} 处替换失败：old_string 在当前文件中不存在（文件可能已被改动？先 read_file 确认）`
        )
      }
      if (hits > 1) {
        throw new Error(
          `第 ${i + 1}/${edits.length} 处替换失败：old_string 命中 ${hits} 处（不唯一）——请包含更多上下文使其唯一`
        )
      }
      // 用函数形式替换：避免 new_string 里的 $&/$1 等被当作替换模式展开
      content = content.replace(e.old, () => e.new)
    }
    if (content === original) {
      return '替换未产生任何变化（new_string 与 old_string 相同？）——文件未改动'
    }
    // diff 徽标（同款口径）：原内容 vs 新内容的行集合差
    if (ctx.out !== undefined) ctx.out.diffStat = countLineDiff(original, content)
    // 红线②：先快照记账再写回（与 write_file 同一条账本链路，撤销语义一致）
    const entry = recordChange(ctx.sessionId, 'edit_file', rawPath, filePath)
    writeFileSync(filePath, content, 'utf8')
    return `已编辑 ${filePath}（${edits.length} 处替换，${Buffer.byteLength(content, 'utf8')} 字节；原内容已快照 ${entry.snapshotRef}，可撤销）`
  }
}

/** 变更类工具：mkdir —— 递归创建目录（幂等），记账（红线②） */
const mkdirTool: ToolDef = {
  name: 'mkdir',
  mutating: true,
  description:
    '递归创建目录（父目录一并创建；目录已存在则不做任何变更）。相对路径会相对应用所在目录解析。变更类操作，新建目录会记入账本（可撤销）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要创建的目录路径（推荐绝对路径）' }
    },
    required: ['path']
  },
  execute: async (args, ctx) => {
    const rawPath = strArg(args, 'path')
    if (rawPath === null) throw new Error('缺少 path 参数（要创建的目录路径）')

    const dirPath = resolveToolPath(rawPath, ctx.workspace)
    if (existsSync(dirPath)) {
      return `${dirPath} 已存在（未做任何变更）`
    }
    // 红线②：先记账再落盘
    recordChange(ctx.sessionId, 'mkdir', rawPath, dirPath)
    mkdirSync(dirPath, { recursive: true })
    return `已创建目录 ${dirPath}（已入账本，可撤销）`
  }
}

/**
 * 登记中间产物：mark_temp_files —— 把"本轮自己产生、确认是中间产物"的文件登记为
 * 可清理。**这是自动清理唯一的意图信号**（不猜后缀、不猜目录名——两次误删事故的教训）。
 * 非 mutating（只登记意图，不碰文件）；真正的删除在任务正常收尾时由 run.ts 按
 * temp-cleanup 的 7 道闸门执行，且走回收站。
 * execute 仅占位：登记表是 per-run 内存态，在 run.ts 的 executeTool 包装层拦截。
 */
const markTempFilesTool: ToolDef = {
  name: 'mark_temp_files',
  mutating: false,
  description:
    '登记本轮你自己产生的中间产物（临时脚本、中间数据、调试日志等），任务正常结束后系统会把它们移入回收站。' +
    '**只登记你确认没用的中间文件**：用户要求保留或交付的文件（报告、成品、他让你建的文件）一律不许登记；' +
    '用户已有的文件也不登记（系统只清理你本轮新建的）。不确定就不登记——不登记只是留着，登记错了才是真损失。' +
    '成果类后缀（.md/.html/.pdf/.png 等）即使误登记了也不会被清，只会原样保留并汇报。' +
    '可一次登记多个；登记后照常在回复里说明你清理了哪些。',
  parameters: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: '要登记的中间产物路径（相对工作区或绝对路径，1-10 个）'
      }
    },
    required: ['paths']
  },
  execute: async () => 'mark_temp_files 需要在主会话运行时中执行（登记表未在当前上下文接入）。'
}

/**
 * 删除文件/文件夹：delete_file —— 移入回收站（可还原），不做永久删除。
 * mutating 且在 permission.ts 里**特判为每次必审批**（完全访问模式除外，
 * 且不记 allow-always）。execute 仅占位：真正的回收站调用用了 electron shell，
 * 在 run.ts 的 executeTool 包装层拦截转 tools/trash.ts（同 ask_user）。
 */
const deleteFileTool: ToolDef = {
  name: 'delete_file',
  mutating: true,
  description:
    '把文件或文件夹移入系统回收站（不是永久删除，可在回收站还原）。' +
    '每次删除都会请用户确认（「完全访问」模式除外）；盘根、用户目录、工作区根与系统目录受保护、无法删除。' +
    '适合清理用户明确要求删除的文件；你自己产生的中间产物请用 mark_temp_files 登记，任务收尾会自动清理，不用调本工具。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要删除的文件或文件夹路径（相对工作区或绝对路径）' }
    },
    required: ['path']
  },
  execute: async () => 'delete_file 需要在主会话运行时中执行（回收站调用未在当前上下文接入）。'
}

/** 变更类工具：undo_last_change —— 线性回滚本会话最近一笔变更 */
const undoLastChangeTool: ToolDef = {
  name: 'undo_last_change',
  mutating: true,
  description:
    '撤销你（在本会话中）最近一次被批准的文件变更：更新过的文件恢复为改前内容；新建的文件会被删除；撤销动作本身也会记账。用户对结果不满意或要求"撤销刚才的修改"时使用。没有可撤销的记录时会返回提示。',
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async (_args, ctx) => {
    const undo = undoLastChange(ctx.sessionId)
    const what = undo.action === 'update' ? '文件内容已恢复为改前快照' : '新建的文件/目录已删除'
    return `已撤销最近一笔变更（${undo.targetAbsPath}）：${what}。撤销动作本身也已记入账本。`
  }
}

/**
 * todo_write：更新本会话任务清单（整表替换）。非 mutating——
 * 只写 harness 内部进度记录（userData/todos），不动用户文件系统，任何模式直接执行不弹卡。
 * run.ts 在 onToolResult 时检测本工具并向前端推 todo_updated（进度卡实时刷新）。
 */
const todoWriteTool: ToolDef = {
  name: 'todo_write',
  description:
    '更新当前任务的进度清单（整表替换：每次提交完整清单）。开始多步骤任务前先列出全部步骤（status=pending）；' +
    '**每完成一步立刻重新提交一次**（把该项改 done）——清单在界面上实时可见，攒到最后再交会让人以为卡住了。' +
    '**任务收尾前必须再提交一次**：做完的全标 done，没做的留 pending 并在正文说明原因。' +
    'status 只写 pending 或 done 两个值（写 in_progress/completed 之类其他词也行，会自动折算，但直接用这两个最准）。' +
    '适合 3 步以上的任务；简单闲聊不要使用。',
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: '完整清单（每次全量提交）',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '步骤描述' },
            status: {
              type: 'string',
              enum: ['pending', 'done'],
              description: 'pending=待办 done=已完成'
            }
          },
          required: ['text', 'status']
        }
      }
    },
    required: ['items']
  },
  execute: async (args, ctx) => {
    const items = args.items
    // 宽容归一：status 别名 / 字符串条目 / 超限都自动折算，不再整表拒
    const { state, dropped, coerced } = writeTodos(ctx.sessionId, Array.isArray(items) ? items : [])
    const done = state.items.filter((i) => i.status === 'done').length
    const notes: string[] = []
    if (coerced > 0) notes.push(`${coerced} 项的 status 认不出，已按「未完成」记`)
    if (dropped > 0) notes.push(`超出上限的 ${dropped} 项已忽略（可拆分任务后重交）`)
    return (
      `清单已更新（${done}/${state.items.length} 完成）${state.items.length === 0 ? '，已清空' : ''}。当前未完成项：` +
      (state.items
        .filter((i) => i.status === 'pending')
        .map((i) => i.text)
        .join('；') || '无') +
      (notes.length > 0 ? `\n（注意：${notes.join('；')}）` : '') +
      '\n（清单在界面上实时显示——本步做完请立即再提交一次，把对应项改成 done。）'
    )
  }
}

/** 屏幕感知工具：隐私开关开启时才进入 LLM 注册表（见 getLlmTools 的门控） */
/** 学习笔记工具：note_write 追加沉淀 / note_read 回显回顾；非 mutating——内部学习记录不弹审批 */
const noteWriteTool: ToolDef = {
  name: 'note_write',
  description:
    '把值得记住的知识点写入学习笔记。每条条目：kind（"note"=知识点笔记 / "card"=闪卡，此时 title 是问题、content 是答案）、title（主题或问题，≤80 字）、content（内容或答案，≤2000 字）、topic（可选：知识点归属，掌握度按它聚合并回流，同一知识点的卡片填同一个 topic 名）。一次可写多条（≤10 条）。写完简要告知用户已记入笔记。',
  parameters: {
    type: 'object',
    properties: {
      entries: {
        type: 'array',
        description: '要追加的条目数组',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['note', 'card'], description: 'note=笔记 / card=闪卡' },
            title: { type: 'string', description: '笔记主题；闪卡则为问题' },
            content: { type: 'string', description: '笔记内容；闪卡则为答案' },
            topic: {
              type: 'string',
              description:
                '可选：知识点名（如"泰勒展开"）；同知识点的卡片填同一个名字，掌握度才能聚合'
            }
          },
          required: ['kind', 'title', 'content']
        }
      }
    },
    required: ['entries']
  },
  mutating: false,
  execute: async (args, ctx) => {
    const entries = args['entries']
    if (!Array.isArray(entries)) throw new Error('缺少 entries 数组参数。')
    const state = appendNotes(ctx?.sessionId ?? 'unknown-session', entries)
    const cards = state.items.filter((i) => i.kind === 'card').length
    return `已记入 ${entries.length} 条笔记（本会话累计 ${state.items.length} 条，其中闪卡 ${cards} 张），用户可在笔记卡查看或导出复习。`
  }
}

const noteReadTool: ToolDef = {
  name: 'note_read',
  description:
    '回显当前会话已记录的学习笔记与闪卡（用于回顾之前讲过什么、避免重复讲解、保持教学连贯）。无参数。',
  parameters: { type: 'object', properties: {}, required: [] },
  mutating: false,
  execute: async (_args, ctx) => {
    const state = readNotes(ctx?.sessionId ?? 'unknown-session')
    if (state === null || state.items.length === 0) {
      return '本会话还没有笔记。可以用 note_write 记录知识点与闪卡。'
    }
    const lines = state.items.map((item, i) => {
      const head = item.kind === 'card' ? `🃏 闪卡 Q${i + 1}` : `📝 笔记 ${i + 1}`
      return `${head}｜${item.title}\n${item.content}`
    })
    return `本会话共 ${state.items.length} 条笔记：\n\n${lines.join('\n\n')}`
  }
}

const activeWindowTool: ToolDef = {
  name: 'active_window',
  description:
    '获取用户当前聚焦的前台窗口（应用名 + 窗口标题）。屏幕感知是隐私功能：用户在设置中开启后才可用；用它可以了解用户正在用什么应用、聊天更贴语境，但不要过度打探。',
  parameters: { type: 'object', properties: {}, required: [] },
  mutating: false, // 只读：不改动任何东西；隐私管控走独立开关而非审批弹卡
  execute: async () => getActiveWindow()
}

// ── describe_image（P8-T3 视觉旁路）：把本地图片转述成文字 ────────────────
/**
 * 识图跑腿函数：主进程 ready 时注入（实现见 llm/vision.ts 的 makeVisionRunner，
 * 读配置 / 选视觉档案 / 取密钥 / 调模型都在那边）。
 * registry 自身保持无 config / secrets 依赖——与 setScreenProbe 同款注入模式。
 */
export type DescribeImageProbe = (
  dataUrl: string,
  question: string | null,
  signal: AbortSignal
) => Promise<string>

let describeImageProbe: DescribeImageProbe | null = null

/** 注入识图实现（测试注入假实现；null = 未就绪） */
export function setDescribeImageProbe(fn: DescribeImageProbe | null): void {
  describeImageProbe = fn
}

/** 图片 dataUrl 的 MIME 表（与 file-pick 同口径） */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}
/** 单张图上限（与聊天附件一致：6MB 二进制） */
const DESCRIBE_MAX_BYTES = 6 * 1024 * 1024

/** 图片类工具（describe_image / ocr_image）共用的路径校验：解析 → 扩展名 → 是文件 → 大小 */
function resolveImageForTool(
  rawPath: string,
  workspace: string | null | undefined
): { filePath: string; mime: string } {
  const filePath = resolveToolPath(rawPath, workspace)
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  const mime = IMAGE_MIME_BY_EXT[ext]
  if (mime === undefined) {
    throw new Error(
      `${filePath} 不是支持的图片格式（只认 png/jpg/jpeg/webp/gif）。若这是 PDF，请用 read_file。`
    )
  }
  const info = statSync(filePath) // 不存在 → ENOENT 由 executeToolCall 收敛为可读错误
  if (info.isDirectory()) throw new Error(`${filePath} 是一个目录，请改用 list_dir。`)
  if (info.size > DESCRIBE_MAX_BYTES) {
    throw new Error(`图片过大（${fmtBytes(info.size)} > 6 MB），拒绝处理。`)
  }
  return { filePath, mime }
}

/**
 * describe_image：读一张本地图片并返回**文字转述**。
 * 用途：任务中途看工作区里的截图 / 图表 / 报错弹窗——她自己看不到图片文件。
 * 非 mutating（只读）；图片会发往"视觉档案"（用户在设置里指定，隐私说明写在设置页）。
 */
const describeImageTool: ToolDef = {
  name: 'describe_image',
  description:
    '读取一张本地图片并返回文字转述（逐字文字 / 版面结构 / 语义摘要三段）。' +
    '**你自己看不到图片文件**，所以要看工作区里的截图、图表、报错弹窗、设计稿时用这个工具；' +
    '用户直接发来的图片不需要调它（会随消息自动处理）。' +
    '转述可能是错的（尤其长数字）：引用时标明"根据图片识别"，关键信息让用户核对；' +
    '需要**精确逐字**（数字、代码、表格单元格）时再用 ocr_image 核一遍，两者不一致要把冲突点出来。' +
    'question 可选，用来追问具体信息（如"这张报表第三行是多少"）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '图片路径（推荐绝对路径）' },
      question: { type: 'string', description: '可选：希望特别回答的问题' }
    },
    required: ['path']
  },
  mutating: false,
  execute: async (args, ctx) => {
    const rawPath = strArg(args, 'path')
    if (rawPath === null) throw new Error('缺少 path 参数（要识别的图片路径）')
    const { filePath, mime } = resolveImageForTool(rawPath, ctx.workspace)
    if (describeImageProbe === null) {
      throw new Error('识图功能尚未就绪（应用还在启动中），请稍后重试。')
    }
    const dataUrl = `data:${mime};base64,${readFileSync(filePath).toString('base64')}`
    const question = strArg(args, 'question')
    return describeImageProbe(dataUrl, question, ctx.signal)
  }
}

/**
 * ocr_image（P8-T3 第二条腿）：用 **Windows 自带** OCR 逐字识别本地图片文字。
 * 与 describe_image 的分工（要写进工具描述，防她选错）：
 * - 要**精确逐字**（数字/编号/代码/表格单元格）→ 本工具（本机识别、不上网、不漏字）
 * - 要**版面理解与语义**（这是什么图、讲了什么）→ describe_image（视觉模型）
 * - 两边结果不一致 → 必须把冲突点出来让用户定，不许自己选一个当真
 * 非 Windows 或没装中文 OCR 语言包时明确回一句"不可用"，不静默失败。
 */
const ocrImageTool: ToolDef = {
  name: 'ocr_image',
  description:
    '用本机 Windows 的 OCR 引擎逐字识别一张图片里的文字（不联网、不上传、不花钱）。' +
    '**要精确抄字时用它**：数字、金额、编号、代码、表格单元格、报错信息。' +
    '它不懂版面与语义——想知道"这张图在讲什么"用 describe_image。' +
    '**只接受工作区里有真实路径的图片文件**；用户在聊天里直接粘贴/发送的图片没有磁盘路径，' +
    '对它们调本工具必然 ENOENT——那种图片你直接就能看到，不要猜路径、不要搜磁盘，' +
    '需要更清晰的字就请用户把图存到工作区或重发。' +
    '识别结果仍可能错认个别字符，关键数字要提醒用户核对；' +
    '若与 describe_image 的转述不一致，把两边结果都摆出来让用户定，不要自己挑一个当真。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '图片路径（推荐绝对路径）' }
    },
    required: ['path']
  },
  mutating: false,
  execute: async (args, ctx) => {
    const rawPath = strArg(args, 'path')
    if (rawPath === null) throw new Error('缺少 path 参数（要识字的图片路径）')
    const { filePath } = resolveImageForTool(rawPath, ctx.workspace)
    return runOcr(filePath)
  }
}

/**
 * skill_use：加载一个技能的完整说明并照做。非 mutating（只读注入，不弹审批）。
 * 触发方式 §11.2：v1 仅经本工具调用——附录只给 name+description 引导模型按需加载。
 * 无启用技能时 getLlmTools 会把本工具从清单摘掉（执行侧兜底：readSkillBody 自带可读回灌）。
 */
const skillUseTool: ToolDef = {
  name: 'skill_use',
  description:
    '加载一个技能的完整说明并照做。这些技能是用户亲手勾选启用的，所以**每个任务都先拿它过一遍「可用技能」清单**：' +
    '可能有命中就先调用（加载很便宜，宁可先看一眼说明再决定要不要照做），只有明确属于另一类任务、或与用户当下这句话无关时才跳过。' +
    '参数 name 填技能名；一次只需加载完成任务所需的那一个。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名（来自可用技能清单，如 study-flashcard）' }
    },
    required: ['name']
  },
  mutating: false,
  execute: async (args) => {
    const name = strArg(args, 'name')
    if (name === null) throw new Error('缺少 name 参数（要加载的技能名）')
    return readSkillBody(name)
  }
}

/** 只读工具：search_files —— 文件名通配 + 内容正则一次搞定（glob/grep 的合并适配）。
 * 大仓库里逐层 list_dir 是主要摩擦；本工具一次调用返回「命中文件 + 命中行预览」。
 * 硬上限防失控：扫描文件数 / 结果条数 / 单文件字节；node_modules 等噪声目录直接跳过。 */
const SEARCH_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'coverage',
  '.workbuddy',
  '.playwright-mcp',
  '__pycache__'
])
const SEARCH_MAX_FILES = 4000
const SEARCH_MAX_RESULTS = 60
const SEARCH_MAX_FILE_BYTES = 1_000_000

/** 通配转正则：** 跨目录，* 单层，? 单字符；其余字符按字面量。
 * 用字符串占位符保护 ** 不被单 * 规则抢先替换（控制字符会触发 no-control-regex）。 */
function globToRegex(pattern: string): RegExp {
  const globstar = '@@GLOBSTAR@@'
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, globstar)
    .replace(/\*/g, '[^\\\\/]*')
    .replace(/\?/g, '[^\\\\/]')
    .split(globstar)
    .join('.*')
  return new RegExp(`^${escaped}$`, 'i')
}

const searchFilesTool: ToolDef = {
  name: 'search_files',
  mutating: false,
  description:
    '在工作区里搜索文件：可按文件名通配（如 *.ts）、按内容正则（或字面量）匹配，也可两者组合。' +
    '返回命中文件与命中行预览。找代码、找配置、确认某个符号出现在哪，都用它——比逐层 list_dir 快得多。' +
    '只读操作。node_modules 等构建/依赖目录自动跳过。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '可选。起始目录（缺省 = 当前路径基准根）' },
      pattern: {
        type: 'string',
        description: '可选。文件名通配（如 *.ts、src/**/*.json）；* 单层、** 跨目录'
      },
      query: {
        type: 'string',
        description: '可选。内容匹配（正则表达式；写非法正则时按普通文本处理）'
      },
      max_results: { type: 'number', description: '可选。结果条数上限（缺省 60，上限 200）' }
    }
  },
  execute: async (args, ctx) => {
    const rawPath = typeof args.path === 'string' && args.path.trim() !== '' ? args.path : '.'
    const pattern =
      typeof args.pattern === 'string' && args.pattern.trim() !== '' ? args.pattern.trim() : null
    const query = typeof args.query === 'string' && args.query.trim() !== '' ? args.query : null
    if (pattern === null && query === null) {
      throw new Error('pattern 与 query 至少提供一个（列目录请用 list_dir）')
    }
    const maxResults = Math.min(
      200,
      Math.max(
        1,
        typeof args.max_results === 'number' ? Math.floor(args.max_results) : SEARCH_MAX_RESULTS
      )
    )
    const baseDir = resolveToolPath(rawPath, ctx.workspace)
    if (!existsSync(baseDir)) throw new Error(`起始目录不存在：${baseDir}`)
    const fileRe = pattern !== null ? globToRegex(pattern) : null
    let contentRe: RegExp | null = null
    if (query !== null) {
      try {
        contentRe = new RegExp(query, 'i')
      } catch {
        contentRe = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') // 非法正则按字面量
      }
    }

    const lines: string[] = []
    let scanned = 0
    let truncatedByFiles = false
    const walk = (dir: string): void => {
      if (scanned >= SEARCH_MAX_FILES || lines.length >= maxResults) return
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return // 无权限/已消失的目录：跳过
      }
      for (const name of entries) {
        if (scanned >= SEARCH_MAX_FILES || lines.length >= maxResults) return
        const full = join(dir, name)
        let isDir = false
        try {
          isDir = statSync(full).isDirectory()
        } catch {
          continue
        }
        if (isDir) {
          if (!SEARCH_SKIP_DIRS.has(name) && !name.startsWith('.')) walk(full)
          continue
        }
        scanned += 1
        const rel = relative(baseDir, full).split(sep).join('/')
        if (fileRe !== null && !fileRe.test(rel) && !fileRe.test(name)) continue
        if (contentRe === null) {
          lines.push(rel)
          continue
        }
        // 内容匹配：跳过超大文件与疑似二进制
        try {
          if (statSync(full).size > SEARCH_MAX_FILE_BYTES) continue
          const text = readFileSync(full, 'utf8')
          const fileLines = text.split('\n')
          let hitsInFile = 0
          for (
            let i = 0;
            i < fileLines.length && hitsInFile < 3 && lines.length < maxResults;
            i++
          ) {
            if (contentRe.test(fileLines[i] ?? '')) {
              hitsInFile += 1
              lines.push(`${rel}:${i + 1}: ${(fileLines[i] ?? '').trim().slice(0, 160)}`)
            }
          }
        } catch {
          // 二进制/编码异常文件：跳过
        }
      }
      if (scanned >= SEARCH_MAX_FILES) truncatedByFiles = true
    }
    walk(baseDir)

    if (lines.length === 0) {
      return `扫描 ${scanned} 个文件，无命中${truncatedByFiles ? '（达到扫描文件数上限，结果可能不完整——请缩小起始目录）' : ''}。`
    }
    const head = `扫描 ${scanned} 个文件，命中 ${lines.length} 条${truncatedByFiles ? '（达到扫描上限，可能不完整——请缩小范围）' : ''}：`
    return [head, ...lines].join('\n')
  }
}

// ── 网络工具共用件──────────────────
/** 浏览器 UA：多数站点对非浏览器 UA 直接 403（对齐 free-search 的实践） */
const NET_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
/** fetch_url：抓取超时（工具统一超时 10s，留出余量） */
const FETCH_TIMEOUT_MS = 8_000
/** fetch_url：HTML 原文字节上限（正文提取用不到更多） */
const FETCH_MAX_BYTES = 2_000_000
/** fetch_url：返回正文默认/最大字符数（与 skill 截断管道同量级） */
const FETCH_DEFAULT_CHARS = 8_000
const FETCH_MAX_CHARS = 20_000
/** 可转文本的内容类型（其余一律拒绝并指路 download_file） */
const FETCH_TEXT_TYPE = /^(text\/|application\/(xhtml\+xml|json|xml|ld\+json))/i
/** download_file：单文件字节上限（写盘前就拦，避免无谓流量） */
const DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024
/** download_file：下载超时（同受工具统一 10s 超时约束——大文件在慢网下可能到不了 50MB 就超时） */
const DOWNLOAD_TIMEOUT_MS = 9_000

/** 增量读取响应体，超过上限立即取消连接（不信任 Content-Length，防说谎与缺头） */
async function readBodyWithCap(res: Response, maxBytes: number, label: string): Promise<Buffer> {
  const reader = res.body?.getReader()
  if (reader === undefined) throw new Error(`${label}：响应体不可读`)
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) {
      total += value.byteLength
      if (total > maxBytes) {
        void reader.cancel()
        throw new Error(`${label}：内容超过上限 ${fmtBytes(maxBytes)}，已中止`)
      }
      chunks.push(Buffer.from(value))
    }
  }
  return Buffer.concat(chunks)
}

/** 从 URL 取干净的下载文件名（只留中英文/数字/点/横线；取不出就用时间戳兜底） */
function urlBasename(u: URL): string {
  let raw = u.pathname.split('/').pop() ?? ''
  try {
    raw = decodeURIComponent(raw)
  } catch {
    /* 编码异常就用原样 */
  }
  const cleaned = raw.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned !== '' ? cleaned : `download-${Date.now()}.bin`
}

/** 变更类落点的越界防护：相对路径解析后必须仍留在基准目录内（远程内容不允 .. 逃逸） */
function assertInsideBase(rawPath: string, absPath: string, workspace?: string | null): void {
  if (isAbsolute(rawPath)) return // 绝对路径沿用「盘外语义不变」口径，不在此拦
  const baseDir = workspace ?? toolPathBase
  if (baseDir === '') return // resolveToolPath 已对空基准抛错过，到不了这里
  const rel = relative(baseDir, absPath)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('目标路径越出了基准目录（相对路径不允许 .. 逃逸）')
  }
}

/** 只读工具：fetch_url —— 轻量网页直取（公网 http/https → 标题 + 纯文本正文） */
const fetchUrlTool: ToolDef = {
  name: 'fetch_url',
  mutating: false,
  description:
    '抓取一个公网网页，返回「标题 + 提取好的纯文本正文」（自动剥掉脚本/样式，正文字符数可调）。' +
    '查资料、读文档、看文章内容都用它——比启动浏览器快得多；需要 JS 渲染/页面交互/截图时才改用浏览器 MCP。' +
    '只读操作。仅支持公网 http/https（内网/回环地址会被拒绝）；二进制文件请用 download_file。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的 http/https 网址' },
      max_chars: {
        type: 'number',
        description: `可选。正文返回字符数上限（缺省 ${FETCH_DEFAULT_CHARS}，上限 ${FETCH_MAX_CHARS}）`
      }
    },
    required: ['url']
  },
  execute: async (args, ctx) => {
    const rawUrl = strArg(args, 'url')
    if (rawUrl === null) throw new Error('缺少 url 参数（要抓取的 http/https 网址）')
    const maxChars = intArg(args, 'max_chars', FETCH_DEFAULT_CHARS)
    if (maxChars === null) throw new Error('max_chars 必须是正整数')
    const cap = Math.min(FETCH_MAX_CHARS, Math.max(500, maxChars))
    const u = assertPublicHttpUrl(rawUrl)

    let res: Response
    try {
      res = await netFetch(u.href, {
        // 工具统一超时是 10s：这里 8s 先行中止，避免吃满全局配额
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
        redirect: 'follow',
        headers: {
          'user-agent': NET_UA,
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5'
        }
      })
    } catch (err) {
      if (ctx.signal.aborted) throw new Error('用户中断了本次抓取')
      throw new Error(
        `抓取失败：${err instanceof Error ? err.message : String(err)}（超时上限 ${FETCH_TIMEOUT_MS / 1000} 秒）`
      )
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}——页面不可访问`)
    if (res.url !== '') assertPublicHttpUrl(res.url) // 重定向后的最终地址也要过安全线（防公网 30x 跳内网）
    const ctype = (res.headers.get('content-type') ?? '').toLowerCase()
    if (!FETCH_TEXT_TYPE.test(ctype)) {
      throw new Error(
        `不支持的内容类型「${ctype.split(';')[0] || '未知'}」——二进制/媒体内容请改用 download_file 下载到工作区`
      )
    }
    const body = await readBodyWithCap(res, FETCH_MAX_BYTES, '网页')
    const raw = body.toString('utf8')

    // JSON 直接给原文（模型自己读结构）；HTML 走正文提取
    if (ctype.includes('json')) {
      const clipped = raw.length > cap * 2 ? raw.slice(0, cap * 2) : raw
      return `# JSON 响应（${u.href}）\n\n${clipped}${raw.length > clipped.length ? '\n…（已截断）' : ''}`
    }
    const { title, text } = htmlToText(raw)
    if (text === '') {
      throw new Error(
        '页面没有可提取的正文（多半是纯脚本渲染的单页应用）——请改用浏览器 MCP 打开真实渲染后再取内容'
      )
    }
    const chars = [...text]
    const truncated = chars.length > cap
    return [
      `# ${title || u.href}`,
      u.href,
      '',
      chars.slice(0, cap).join(''),
      ...(truncated ? [`…（正文已截断到 ${cap} 字符，可加大 max_chars）`] : [])
    ].join('\n')
  }
}

/** 变更类工具：download_file —— 公网文件下载进工作区（走门禁 + 账本快照） */
const downloadFileTool: ToolDef = {
  name: 'download_file',
  mutating: true,
  description:
    '把一个公网 URL 的文件下载保存到工作区（默认存到 downloads/<来源文件名>）。' +
    '适合下载压缩包/数据集/图片等非文本资源——读网页正文请用 fetch_url。' +
    '变更类操作：写盘前记入账本（可撤销）。单文件 50MB 上限；同名文件已存在时默认拒绝（overwrite=true 才覆盖）；' +
    '相对路径会解析在绑定的工作区内（不允许 .. 逃逸）。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要下载的 http/https 文件地址' },
      path: {
        type: 'string',
        description: '可选。保存位置（相对路径默认基于工作区；缺省 downloads/<来源文件名>）'
      },
      overwrite: { type: 'boolean', description: '可选。目标已存在时是否覆盖（缺省 false）' }
    },
    required: ['url']
  },
  execute: async (args, ctx) => {
    const rawUrl = strArg(args, 'url')
    if (rawUrl === null) throw new Error('缺少 url 参数（要下载的 http/https 文件地址）')
    const overwrite = args.overwrite === true
    const u = assertPublicHttpUrl(rawUrl)

    let rawTarget = strArg(args, 'path')
    if (rawTarget === null) rawTarget = `downloads/${urlBasename(u)}`
    const targetAbs = resolveToolPath(rawTarget, ctx.workspace)
    assertInsideBase(rawTarget, targetAbs, ctx.workspace)
    if (existsSync(targetAbs)) {
      if (statSync(targetAbs).isDirectory()) {
        throw new Error(`目标是一个已存在的目录：${targetAbs}（请指定包含文件名的完整路径）`)
      }
      if (!overwrite) {
        throw new Error(`目标文件已存在：${targetAbs}（要覆盖请传 overwrite=true）`)
      }
    }

    let res: Response
    try {
      res = await netFetch(u.href, {
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
        redirect: 'follow',
        headers: { 'user-agent': NET_UA, accept: '*/*' }
      })
    } catch (err) {
      if (ctx.signal.aborted) throw new Error('用户中断了本次下载')
      throw new Error(
        `下载失败：${err instanceof Error ? err.message : String(err)}（超时上限 ${DOWNLOAD_TIMEOUT_MS / 1000} 秒）`
      )
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}——文件不可访问`)
    if (res.url !== '') assertPublicHttpUrl(res.url)
    const ctype = (res.headers.get('content-type') ?? '').toLowerCase()
    if (/^text\/html/i.test(ctype)) {
      throw new Error('该地址返回的是网页（text/html）而不是文件——读网页内容请用 fetch_url')
    }
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > DOWNLOAD_MAX_BYTES) {
      throw new Error(
        `文件过大（声明 ${fmtBytes(declared)} > 上限 ${fmtBytes(DOWNLOAD_MAX_BYTES)}），已取消`
      )
    }
    const buf = await readBodyWithCap(res, DOWNLOAD_MAX_BYTES, '下载')

    // 红线②：先快照记账再落盘（overwrite 时旧内容同样进快照，可撤销）
    const entry = recordChange(ctx.sessionId, 'download_file', rawTarget, targetAbs)
    mkdirSync(dirname(targetAbs), { recursive: true })
    writeFileSync(targetAbs, buf)
    const note =
      entry.action === 'update'
        ? `已覆盖旧文件（${entry.snapshotRef}，可撤销）`
        : '新建文件，可撤销'
    return `已下载 ${targetAbs}（${fmtBytes(buf.length)}，来源 ${u.href}；${note}）`
  }
}

/** 变更类工具：note_export —— 学习笔记/闪卡导出为标准 Markdown（Obsidian 生态互通） */
const noteExportTool: ToolDef = {
  name: 'note_export',
  mutating: true,
  description:
    '把学习笔记与闪卡导出为标准 Markdown 文件（含 frontmatter：会话/时间/条数）到工作区目录' +
    '（默认 notes-export/，每会话一份 notes-<会话id>.md），可直接放进 Obsidian 等笔记工具。' +
    '默认只导出当前会话的笔记；scope="all" 导出全部会话。变更类操作（写工作区，记账可撤销）。',
  parameters: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['session', 'all'],
        description: '可选。session=仅当前会话（缺省）；all=全部会话的笔记'
      },
      target_dir: { type: 'string', description: '可选。导出目录（相对工作区，缺省 notes-export）' }
    }
  },
  execute: async (args, ctx) => {
    const scope = args.scope === 'all' ? 'all' : 'session'
    const rawDir = strArg(args, 'target_dir') ?? 'notes-export'
    const dirAbs = resolveToolPath(rawDir, ctx.workspace)
    assertInsideBase(rawDir, dirAbs, ctx.workspace)

    const ids = scope === 'all' ? listNoteSessions() : [ctx.sessionId]
    const written: string[] = []
    let totalNotes = 0
    let totalCards = 0
    for (const id of ids) {
      const state = readNotes(id)
      if (state === null || state.items.length === 0) continue
      const notes = state.items.filter((i) => i.kind === 'note')
      const cards = state.items.filter((i) => i.kind === 'card')
      const md = buildNotesMarkdown(id, state)
      const fileAbs = join(dirAbs, `notes-${id}.md`)
      const rawFile = `${rawDir.replace(/[\\/]+$/, '')}/notes-${id}.md`
      const entry = recordChange(ctx.sessionId, 'note_export', rawFile, fileAbs)
      mkdirSync(dirAbs, { recursive: true })
      writeFileSync(fileAbs, md, 'utf8')
      written.push(
        `· ${rawFile}（笔记 ${notes.length} 条 / 闪卡 ${cards.length} 张；${
          entry.action === 'update' ? '原文件已快照，可撤销' : '新建，可撤销'
        }）`
      )
      totalNotes += notes.length
      totalCards += cards.length
    }
    if (written.length === 0) {
      throw new Error(
        scope === 'all'
          ? '没有任何会话有可导出的笔记。'
          : '本会话还没有笔记（先用 note_write 记录知识点与闪卡，再导出）。'
      )
    }
    return `已导出 ${written.length} 份 Markdown 到 ${dirAbs}（共笔记 ${totalNotes} 条 / 闪卡 ${totalCards} 张）：\n${written.join('\n')}`
  }
}

/** 笔记档 → Markdown（frontmatter + 笔记节 + 闪卡 Q/A 节） */
function buildNotesMarkdown(
  sessionId: string,
  state: {
    items: Array<{ kind: 'note' | 'card'; title: string; content: string; ts: number }>
    updatedAt: number
  }
): string {
  const notes = state.items.filter((i) => i.kind === 'note')
  const cards = state.items.filter((i) => i.kind === 'card')
  const lines: string[] = [
    '---',
    `session: ${sessionId}`,
    `exported_at: ${new Date().toISOString()}`,
    `notes: ${notes.length}`,
    `cards: ${cards.length}`,
    '---',
    '',
    `# 学习笔记 · ${sessionId}`,
    ''
  ]
  if (notes.length > 0) {
    lines.push('## 📝 笔记', '')
    notes.forEach((n, i) => {
      lines.push(`### ${i + 1}. ${n.title}`, '', n.content, '')
    })
  }
  if (cards.length > 0) {
    lines.push('## 🃏 闪卡', '')
    cards.forEach((c, i) => {
      lines.push(`**Q${i + 1}. ${c.title}**`, '', `**A${i + 1}:** ${c.content}`, '')
    })
  }
  return lines.join('\n')
}

/** 只读工具：search_history —— 搜历史会话（标题 + 消息正文，本地零依赖） */
const HISTORY_MAX_SESSIONS = 300
const HISTORY_MAX_FILE_BYTES = 4_000_000

const searchHistoryTool: ToolDef = {
  name: 'search_history',
  mutating: false,
  description:
    '在历史会话里搜索（匹配会话标题与消息正文，大小写不敏感），返回命中的会话与上下文片段。' +
    '「上次讲到哪」「之前那个报错怎么解的」「之前聊过的 XX」这类回顾场景用它。只读操作。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '要搜索的关键词' },
      limit: { type: 'number', description: '可选。返回会话数上限（缺省 8，上限 20）' }
    },
    required: ['query']
  },
  execute: async (args) => {
    const query = strArg(args, 'query')
    if (query === null) throw new Error('缺少 query 参数（要搜索的关键词）')
    const limit = intArg(args, 'limit', 8)
    if (limit === null) throw new Error('limit 必须是正整数')
    if (searchHistoryBase === '') throw new Error('会话存储未初始化（应用尚未就绪）。')

    // 轻量解析注册表（与 session-store 的 index.json 契约一致；缺失/损坏 = 无可搜）
    const metas: Array<{ id: string; title: string; mode: string; updatedAt: number }> = []
    try {
      const parsed = JSON.parse(readFileSync(join(searchHistoryBase, 'index.json'), 'utf8')) as {
        sessions?: unknown
      }
      if (Array.isArray(parsed.sessions)) {
        for (const s of parsed.sessions) {
          if (typeof s !== 'object' || s === null) continue
          const r = s as Record<string, unknown>
          if (typeof r.id !== 'string' || r.id === '') continue
          metas.push({
            id: r.id,
            title: typeof r.title === 'string' && r.title !== '' ? r.title : '未命名会话',
            mode: r.mode === 'chat' || r.mode === 'learn' ? r.mode : 'work',
            updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0
          })
        }
      }
    } catch {
      /* 无注册表 = 没有可搜内容 */
    }
    metas.sort((a, b) => b.updatedAt - a.updatedAt)

    const q = query.toLowerCase()
    interface HistoryHit {
      id: string
      title: string
      mode: string
      updatedAt: number
      count: number
      snippet: string
    }
    const hits: HistoryHit[] = []
    let scanned = 0
    for (const m of metas.slice(0, HISTORY_MAX_SESSIONS)) {
      // 超大档跳过（异常膨胀的会话不该拖垮搜索）
      try {
        const f = statSync(join(searchHistoryBase, 'data', `${m.id}.json`))
        if (f.size > HISTORY_MAX_FILE_BYTES) continue
      } catch {
        continue // 无数据文件的空会话
      }
      const loaded = loadSessionMessages(searchHistoryBase, m.id)
      if (!loaded.ok) continue
      scanned += 1
      let count = m.title.toLowerCase().includes(q) ? 5 : 0 // 标题命中权重更高
      let snippet = ''
      for (const msg of loaded.messages) {
        if (typeof msg.text !== 'string' || msg.text === '') continue
        const lower = msg.text.toLowerCase()
        const idx = lower.indexOf(q)
        if (idx === -1) continue
        count += 1
        if (snippet === '') {
          const start = Math.max(0, idx - 60)
          snippet =
            (start > 0 ? '…' : '') +
            msg.text
              .slice(start, idx + query.length + 80)
              .replace(/\s+/g, ' ')
              .trim() +
            '…'
        }
      }
      if (count > 0) hits.push({ ...m, count, snippet })
    }

    if (hits.length === 0) {
      return `在 ${scanned} 个会话中未找到与「${query}」相关的内容（共注册 ${metas.length} 个会话）。`
    }
    hits.sort((a, b) => b.count - a.count)
    const shown = hits.slice(0, Math.min(20, Math.max(1, limit)))
    const blocks = shown.map((h) => {
      const date = new Date(h.updatedAt || Date.now()).toLocaleDateString('zh-CN')
      const head = `▶ ${h.title}（${h.mode} · ${date} · 命中 ${h.count} 处）\n  会话 id: ${h.id}`
      return h.snippet !== '' ? `${head}\n  片段：${h.snippet}` : head
    })
    return `在 ${scanned} 个会话中命中 ${hits.length} 个${
      hits.length > shown.length ? `（按命中数显示前 ${shown.length} 个）` : ''
    }：\n\n${blocks.join('\n\n')}`
  }
}

/** 变更类工具：run_shell —— 白名单命令执行。
 * work 专属（getLlmTools 门控）；门禁层按 classifyCommand 决定弹不弹卡（allowed 直放 /
 * ask 弹卡 / blocked 放行到执行层拒绝——回灌文案在执行层更精确）。 */
const runShellTool: ToolDef = {
  name: 'run_shell',
  mutating: true,
  description:
    '在工作区里执行一条命令行命令（跑测试、构建、git 查看等），返回输出与退出码。' +
    '只读类命令（git status/log/diff、npm test 等白名单内）直接执行；其他命令需要用户批准；' +
    '危险命令（删文件/格式化/改系统）会被直接拒绝。一次只执行一条命令；' +
    '默认 60 秒超时（可到 300 秒），超时会被强制终止。' +
    '长命令（起 dev 服务器、长测试）用 background:true 放到后台立即返回，' +
    '之后用 bg_action=peek 查输出、bg_action=stop 停止。',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: '要执行的命令（单条；复杂串接会被要求用户批准）。bg_action 模式下可省略'
      },
      timeout_ms: {
        type: 'number',
        description:
          '可选。超时毫秒数（默认 60000，上限 300000），超时后命令被强制终止。background 模式下忽略（后台任务无超时）'
      },
      background: {
        type: 'boolean',
        description:
          '可选。true = 后台运行：立即返回任务 id（bg-xxx），不等待命令结束、无超时；输出用 bg_action=peek 查看'
      },
      bg_id: {
        type: 'string',
        description: '可选。后台任务 id（形如 bg-001），配合 bg_action 使用'
      },
      bg_action: {
        type: 'string',
        enum: ['peek', 'stop'],
        description:
          '可选。peek = 查看该后台任务的输出与运行状态；stop = 强制终止该任务（整树强杀）。使用时无需传 command'
      }
    }
  },
  execute: async (args, ctx) => {
    // 后台管理分支：bg_action 优先（peek/stop 不需要 command）
    const bgId = strArg(args, 'bg_id')
    const bgAction = strArg(args, 'bg_action')
    if (bgAction !== null) {
      if (bgId === null) throw new Error('bg_action 需要 bg_id（要查看/停止的后台任务 id）')
      if (bgAction === 'peek') return peekShellBg(bgId)
      if (bgAction === 'stop') return stopShellBg(bgId)
      throw new Error(`bg_action 只支持 peek/stop，收到：${bgAction}`)
    }
    const command = strArg(args, 'command')
    if (command === null) throw new Error('缺少 command 参数（要执行的命令）')
    const timeoutArg = intArg(args, 'timeout_ms', SHELL_DEFAULT_TIMEOUT_MS)
    if (timeoutArg === null) throw new Error('timeout_ms 必须是正整数（毫秒）')
    const background = args['background'] === true
    // 工作区是硬门槛：没有 cwd 边界就不放行任何命令（fail-closed）
    const workspace = ctx.workspace
    if (workspace === undefined || workspace === null || workspace.trim() === '') {
      throw new Error('未绑定工作目录，无法执行命令。请先在 设置 → 目录 绑定一个工作目录。')
    }
    const verdict = classifyShellCommand(command)
    if (verdict === 'blocked') {
      throw new Error(
        `命令被安全策略拒绝（不可批准）：${command.slice(0, 200)}。` +
          '该命令属于破坏性/系统级操作。如需达成目标，请改用文件工具或其他安全方式。'
      )
    }
    // 后台模式：立即返回 bgId（输出进内存环形缓冲，peek 查看；无超时）
    if (background) {
      const id = startShellBackground(command, { cwd: workspace })
      return (
        `[${id}] 已在后台启动：${command}\n` +
        '查看输出：bg_action=peek + bg_id；停止：bg_action=stop + bg_id。' +
        '任务无超时，注意事后收尾（长期驻留的 dev 服务器记得停）。'
      )
    }
    // allowed（白名单）与 ask（非白名单，门禁已批）都到这里执行
    const res = await executeShell(command, { cwd: workspace, timeoutMs: timeoutArg })
    const note = res.timedOut ? '（超时已强制终止）' : ''
    return `$ ${command}\nexit code: ${res.exitCode ?? 'null'}（耗时 ${(res.durationMs / 1000).toFixed(1)}s）${note}\n\n${res.output}`
  }
}

/** 变更类工具：run_js —— 在受控子进程执行 JS 生成办公文档（docx/exceljs/pptxgenjs 内置）。
 * 任意代码执行面：mutating 且无 path → confirm 模式每次弹卡看代码原文再放行（fail-closed 刻意设计）。 */
const runJsTool: ToolDef = {
  name: 'run_js',
  mutating: true,
  description:
    '执行一段 JavaScript 来生成办公文档：Word（docx 库）、Excel（exceljs）、PPT（pptxgenjs）——' +
    '三个库已内置，直接 const { docx, ExcelJS, PptxGenJS } 可用（已注入全局，无需 require）。' +
    '代码在工作区目录里运行（相对路径写文件落在工作区），可顶层 await，console.log 会回给你。' +
    '适合：导出报告/表格/幻灯片、批量处理数据文件。跑之前把成品文件路径想清楚；' +
    '生成完用一句话告诉用户文件在哪。默认 60 秒超时（可到 180 秒）。',
  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description:
          '要执行的 JavaScript（CommonJS；docx/ExcelJS/PptxGenJS 已是全局；可顶层 await）'
      },
      timeout_ms: {
        type: 'number',
        description: `可选。超时毫秒数（默认 ${JS_DEFAULT_TIMEOUT_MS}，上限 180000）`
      }
    },
    required: ['code']
  },
  execute: async (args, ctx) => {
    const code = strArg(args, 'code')
    if (code === null) throw new Error('缺少 code 参数（要执行的 JavaScript）')
    const timeoutArg = intArg(args, 'timeout_ms', JS_DEFAULT_TIMEOUT_MS)
    if (timeoutArg === null) throw new Error('timeout_ms 必须是正整数（毫秒）')
    // 与 run_shell 同款硬门槛：没有工作区边界不放行任意代码（fail-closed）
    const workspace = ctx.workspace
    if (workspace === undefined || workspace === null || workspace.trim() === '') {
      throw new Error('未绑定工作目录，无法执行代码。请先在 设置 → 目录 绑定一个工作目录。')
    }
    const res = await executeJs(code, { cwd: workspace, timeoutMs: timeoutArg })
    const note = res.timedOut ? '（超时已强制终止）' : ''
    const head = `exit code: ${res.exitCode ?? 'null'}（耗时 ${(res.durationMs / 1000).toFixed(1)}s）${note}`
    if (res.exitCode === 0 && res.files.length > 0) {
      // 产出文件 → 实时事件走 out 槽（应用自己的通道），历史重建走结果标记行。
      // ★ 标记必须放**最前面**：工具结果超长截断切的是尾部，放末尾会丢（parseRunJsMarker 整行匹配）
      if (ctx.out !== undefined) ctx.out.files = res.files
      return (
        `${RUN_JS_MARKER}${JSON.stringify(res.files)}\n` +
        `本次生成/修改的文件：${res.files.join('、')}。把文件位置告诉用户即可，` +
        `开头的系统标记行是应用内部数据，忽略它。\n\n${head}\n\n` +
        (res.output === '' ? '（执行成功，无 console 输出）' : res.output)
      )
    }
    if (res.exitCode !== 0 && !res.timedOut) {
      return `${head}\n\n执行失败——错误详情如下，修正代码后可重试：\n\n${res.output}`
    }
    return `${head}\n\n${res.output === '' ? '（无输出。若你预期生成了文件，请确认写文件调用真的执行了）' : res.output}`
  }
}

// ── export_pdf：HTML → PDF（Chromium 排版，中文零依赖）─────────────────────
// registry 保持无 electron 依赖：打印实现由 main ready 注入（screen 探针同款模式）。
type PdfPrinter = (input: {
  htmlPath?: string
  html?: string
  outPath: string
  landscape?: boolean
}) => Promise<{ bytes: number }>

let pdfPrinter: PdfPrinter | null = null

export function setPdfPrinter(fn: PdfPrinter): void {
  pdfPrinter = fn
}

const exportPdfTool: ToolDef = {
  name: 'export_pdf',
  mutating: true,
  description:
    '把 HTML 转成 PDF 文件（Chromium 排版引擎，中文/表格/图表/CSS 都还原得很好）。' +
    '两种用法：①传 html 字符串（短文档）；②先 write_file 写好 .html 再传 html_path（长文档推荐，' +
    '还能让用户先预览）。输出 path 相对工作区。适合：报告、简历、讲义、把 genui 图表页存成 PDF。' +
    '排版技巧：@page 控制边距、page-break-before 分页、A4 宽度约 21cm。',
  parameters: {
    type: 'object',
    properties: {
      html: { type: 'string', description: 'HTML 全文（与 html_path 二选一）' },
      html_path: { type: 'string', description: '工作区内 HTML 文件路径（与 html 二选一，优先）' },
      path: { type: 'string', description: '输出 PDF 路径（相对工作区，如 报告.pdf）' },
      landscape: { type: 'boolean', description: '可选。横版 A4（缺省竖版）' }
    },
    required: ['path']
  },
  execute: async (args, ctx) => {
    if (pdfPrinter === null) throw new Error('PDF 打印器未就绪（应用初始化异常）')
    const rawTarget = strArg(args, 'path')
    if (rawTarget === null) throw new Error('缺少 path 参数（输出 PDF 路径）')
    const html = strArg(args, 'html')
    const rawHtmlPath = strArg(args, 'html_path')
    if (html === null && rawHtmlPath === null) {
      throw new Error('html 与 html_path 至少要给一个')
    }
    let htmlPath: string | undefined
    if (rawHtmlPath !== null) {
      htmlPath = resolveToolPath(rawHtmlPath, ctx.workspace)
      assertInsideBase(rawHtmlPath, htmlPath, ctx.workspace)
      if (!existsSync(htmlPath))
        throw new Error(`HTML 文件不存在：${rawHtmlPath}（先用 write_file 写好它）`)
    }
    const outAbs = resolveToolPath(rawTarget, ctx.workspace)
    assertInsideBase(rawTarget, outAbs, ctx.workspace)
    if (!outAbs.toLowerCase().endsWith('.pdf')) {
      throw new Error(`输出路径要 .pdf 结尾：${rawTarget}`)
    }
    // 红线②：先快照记账再落盘（download_file 同款；新建/覆盖 ledger 都能处理）
    recordChange(ctx.sessionId, 'export_pdf', rawTarget, outAbs)
    const res = await pdfPrinter({
      ...(htmlPath !== undefined ? { htmlPath } : {}),
      ...(htmlPath === undefined ? { html: html ?? '' } : {}),
      outPath: outAbs,
      landscape: args['landscape'] === true
    })
    return `已生成 PDF：${outAbs}（${fmtBytes(res.bytes)}，来源 ${htmlPath !== undefined ? rawHtmlPath : '内联 HTML'}；变更前已快照，可撤销）`
  }
}

/** 只读工具：web_search —— 免 key 多引擎联网搜索。
 * 零依赖抓公开结果页：ddg-lite → ddg → bing → searxng 回退链 + LRU 缓存；只读不弹卡。 */
const webSearchTool: ToolDef = {
  name: 'web_search',
  mutating: false,
  description:
    '联网搜索：给一个问题/关键词，返回多条结果（标题 + 链接 + 摘要）。' +
    '查最新资料、库的 API 变更、报错解法、文档版本时用它；' +
    '需要读某个结果的全文时，拿到链接后配合 fetch_url。' +
    '免 API key（多引擎自动回退，结果可能受公共引擎限流影响）。只读操作。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词或问题' },
      max_results: { type: 'number', description: '可选。返回条数（缺省 8，上限 20）' }
    },
    required: ['query']
  },
  execute: async (args, ctx) => {
    const query = strArg(args, 'query')
    if (query === null) throw new Error('缺少 query 参数（搜索关键词或问题）')
    const maxResults = intArg(args, 'max_results', 8)
    if (maxResults === null) throw new Error('max_results 必须是正整数（≤20）')
    const outcome = await searchWeb(query, {
      maxResults: Math.min(20, maxResults),
      signal: ctx.signal
    })
    const head = `搜索「${query}」→ ${outcome.items.length} 条结果（引擎：${outcome.engine}${
      outcome.cached ? '，来自缓存' : ''
    }）`
    // 降级页如实标注（9.15）：所有引擎都只给出与查询零重叠的结果时，别让模型当好消息用
    const warn = outcome.suspect
      ? '⚠️ 这轮结果与查询词几乎不沾边（搜索引擎疑似返回降级页/被反爬降级）——改用更短更常见的关键词重搜，或直接 fetch_url 打开权威站点；不要把上面的内容当答案。'
      : ''
    const lines = outcome.items.map((it, i) => {
      const title = it.title === '' ? '(无标题)' : it.title
      const snippet = it.snippet === '' ? '' : `\n   ${it.snippet.slice(0, 240)}`
      return `${i + 1}. ${title}\n   ${it.url}${snippet}`
    })
    return [
      head,
      ...(warn === '' ? [''] : ['', warn]),
      ...lines,
      '',
      '（需要读全文时用 fetch_url 打开对应链接）'
    ].join('\n')
  }
}

/** spawn_agent：派生任务分身。
 * mutating=false 是刻意决策：委托动作本身不动文件，分身内部的每一次变更都由
 * 分身自己的门禁逐项把关（plan 模式下等同 confirm 逐次弹卡并标注「来自子任务」）——
 * 若这里标 mutating，confirm 模式会多出一张无路径、无操作细节的噪声卡。
 * 运行时接线在 chat/run.ts 的 executeTool 包装（需要 LLM 依赖，registry 不含）；
 * 本 execute 只是防御兜底（绕过包装直调注册表时给出可读错误）。 */
const spawnAgentTool: ToolDef = {
  name: 'spawn_agent',
  description:
    '派生一个任务分身去完成一件明确交办的事，等它做完后把最终报告带回来。' +
    '适合交给分身：批量机械操作（整理/重命名/多文件同构修改）、大范围检索调研（要读很多东西但只需要结论）。' +
    '不适合：需要用户反馈的交互；一两步就能完成的小事（自己做更快）。' +
    '分身看不到主对话，objective 必须自包含；分身完成后你基于它的报告向用户转述。',
  parameters: {
    type: 'object',
    properties: {
      objective: {
        type: 'string',
        description: '一句话任务目标，必须自包含（分身看不到主会话历史）'
      },
      context: { type: 'string', description: '可选。主会话已知的背景、约束或相关路径' },
      report_focus: { type: 'string', description: '可选。希望最终报告侧重什么' }
    },
    required: ['objective']
  },
  execute: async () => 'spawn_agent 需要在主会话运行时中执行（当前上下文未接入分身运行时）。'
}

/** 结构化提问：ask_user 需要主会话运行时的"暂停-等待作答-唤醒"能力
 * （复用审批卡机制），execute 仅占位，实际在 run.ts 的 executeTool 里拦截。 */
const askUserTool: ToolDef = {
  name: 'ask_user',
  mutating: false,
  description:
    '向用户提一个或几个结构化问题并等待其选择/填写，用于澄清需求、二选一、收集偏好。' +
    '**需求有岔路或信息不全时优先用它问清再动手**（比做完再返工便宜得多）：' +
    '比如"两条不同做法没指定""放哪个目录/什么格式没说清""要动用户文件但范围待确认"。' +
    '比纯文本追问更好：用户点一下就能答，不用打字。每题给 type——' +
    'single（单选，配 options）、multi（多选）、text（自由填写）。' +
    '一次最多 4 题；能一次问清就别分多次。' +
    '不适合：能自己合理决定的别问（问了是打扰）；用户已明确说过的别重复问。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '可选。整组问题的一句话标题（如"确认几个细节"）' },
      questions: {
        type: 'array',
        description: '要问的问题（1-4 题）',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '题目标识（英文短词，答案按它回填）' },
            prompt: { type: 'string', description: '题干（给用户看的一句话，中文）' },
            type: { type: 'string', enum: ['single', 'multi', 'text'], description: '控件类型' },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'single/multi 的选项列表（2-6 个，每项简短）'
            },
            placeholder: { type: 'string', description: 'text 题的输入占位提示（可选）' },
            required: {
              type: 'boolean',
              description: '是否必答，缺省 true；false 允许用户跳过该题'
            }
          },
          required: ['id', 'prompt', 'type']
        }
      }
    },
    required: ['questions']
  },
  execute: async () => 'ask_user 需要在主会话运行时中执行（当前上下文未接入提问运行时）。'
}

/** 工作区内容检索：全文关键词搜索（扫描式，千文件级 <1s）。
 * 与 search_files（只搜文件名）互补——找「哪篇文章提到过 XX」用这个。 */
const searchContentTool: ToolDef = {
  name: 'search_content',
  mutating: false,
  description:
    '在当前工作区的所有文本文件内容里搜索关键词（全文检索），返回命中的文件、行号与该行内容。' +
    '适合「哪篇文章提到过 XX」「我记得有个文件写过 XX」这类内容查找；只找文件名请用 search_files。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '要搜索的关键词（可多个词，全部命中排前）' },
      limit: { type: 'number', description: '返回条数上限（缺省 20，最大 50）' }
    },
    required: ['query']
  },
  execute: async (args, ctx) => {
    const query = args.query
    if (typeof query !== 'string' || query.trim() === '') throw new Error('缺少 query')
    const limitRaw = args.limit
    const limit =
      typeof limitRaw === 'number' && Number.isFinite(limitRaw)
        ? Math.min(50, Math.max(1, Math.round(limitRaw)))
        : 20
    const root = ctx.workspace
    if (typeof root !== 'string' || root === '') {
      throw new Error('当前会话未绑定工作区（内容检索只在绑定的工作区内进行）')
    }
    const { hits, scanned, truncated } = searchWorkspaceContent(root, query, limit)
    if (hits.length === 0) {
      return `全文搜索「${query}」无命中（扫描了 ${scanned} 个文件${truncated ? '，已达扫描上限，结果可能不全' : ''}）。`
    }
    const byFile = new Map<string, typeof hits>()
    for (const h of hits) {
      const list = byFile.get(h.rel) ?? []
      list.push(h)
      byFile.set(h.rel, list)
    }
    const parts: string[] = [
      `全文搜索「${query}」命中 ${hits.length} 行 / ${byFile.size} 个文件（扫描 ${scanned} 个${truncated ? '，已达上限' : ''}）：`
    ]
    for (const [rel, list] of byFile) {
      parts.push(`【${rel}】`)
      for (const h of list.slice(0, 3)) {
        parts.push(`  L${h.line}: ${h.snippet}`)
      }
      if (list.length > 3) parts.push(`  …共 ${list.length} 行命中`)
    }
    return parts.join('\n')
  }
}

/** 学习进度工具：把"这门课学到哪了"记下来。
 * 两个工具都不碰工作区文件（只写 userData/progress）→ non-mutating，不弹审批。 */
const studyProgressWriteTool: ToolDef = {
  name: 'study_progress_write',
  description:
    '更新学习进度：设置/修改学习计划（目标与截止日），或记录某个知识点的掌握度（0-100 的自评）。' +
    '时机：讲解完一个章节、测完一轮、用户说"我要在 X 之前学完 Y"时调用。' +
    '掌握度要诚实——用户复习闪卡后的**实测**掌握度由系统自动回流并覆盖自评值，' +
    '所以这里给的是"你观察到他能讲清楚几成"的估计，别一律填 100。',
  parameters: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: '学习目标（一句话，如"两周内掌握线性代数前三章"）；不填则不改'
      },
      deadline: {
        type: 'string',
        description: '截止日期（YYYY-MM-DD）；不填则不改。用户没提 deadline 就别硬编一个'
      },
      planNotes: { type: 'string', description: '目标补充说明（范围、考试形式等，可选）' },
      topics: {
        type: 'array',
        description: '要更新的知识点掌握度（可选）',
        items: {
          type: 'object',
          properties: {
            topic: {
              type: 'string',
              description: '知识点名（与闪卡 note_write 的 topic 保持一致）'
            },
            score: { type: 'number', description: '自评掌握度 0-100' }
          },
          required: ['topic', 'score']
        }
      }
    },
    required: []
  },
  mutating: false,
  execute: async (args, ctx) => {
    const sessionId = ctx?.sessionId ?? 'unknown-session'
    const out: string[] = []
    const hasPlan = args['goal'] !== undefined || args['deadline'] !== undefined
    if (hasPlan) {
      const db = setPlan(sessionId, {
        goal: args['goal'],
        deadline: args['deadline'],
        notes: args['planNotes']
      })
      const left = daysLeft(db.plan.deadline, Date.now())
      out.push(
        `学习计划已更新${db.plan.goal === '' ? '（未设目标）' : `：${db.plan.goal}`}` +
          (left === null ? '' : `，距截止日还有 ${left} 天`)
      )
    }
    const topics = args['topics']
    if (Array.isArray(topics)) {
      let n = 0
      for (const t of topics) {
        const item = t as Record<string, unknown>
        const name = typeof item?.topic === 'string' ? item.topic : ''
        const score = typeof item?.score === 'number' ? item.score : NaN
        if (name.trim() === '' || !Number.isFinite(score)) continue
        upsertTopic(sessionId, name, score)
        n += 1
      }
      if (n > 0) out.push(`已更新 ${n} 个知识点的掌握度`)
    }
    if (out.length === 0) return '没有要更新的内容（可传 goal / deadline / topics）。'
    return `${out.join('；')}。用户可在学习进度卡查看。`
  }
}

const studyProgressReadTool: ToolDef = {
  name: 'study_progress_read',
  description:
    '读当前会话的学习进度：学习目标与剩余天数、各知识点掌握度（实测优先，标注来源）、' +
    '闪卡复习情况（今日待复习 / 已练 / 已掌握）。' +
    '用它来：讲新内容前知道哪些知识点还弱、决定该复习什么、回答"我学到哪了/复习得怎么样"。无参数。',
  parameters: { type: 'object', properties: {}, required: [] },
  mutating: false,
  execute: async (_args, ctx) => {
    const sessionId = ctx?.sessionId ?? 'unknown-session'
    const db = readProgress(sessionId)
    const notes = readNotes(sessionId)
    const cards = notes === null ? [] : notes.items.filter((i) => i.kind === 'card')
    const reviewDb = readReview(sessionId)
    const now = Date.now()
    const sum = summarize(cards.length, reviewDb.cards, now)
    const left = daysLeft(db.plan.deadline, now)
    const lines: string[] = []
    lines.push(
      db.plan.goal === ''
        ? '学习目标：未设置（可用 study_progress_write 设一个）'
        : `学习目标：${db.plan.goal}${left === null ? '' : `（距截止 ${left} 天）`}`
    )
    lines.push(
      `闪卡：共 ${sum.total} 张，今日待复习 ${sum.due} 张，已练 ${sum.started} 张，已掌握 ${sum.mature} 张` +
        (sum.started > 0 ? `，平均掌握度 ${sum.mastery}%` : '')
    )
    if (db.topics.length === 0) {
      lines.push('知识点掌握度：还没有记录（讲解完可用 study_progress_write 记一条）')
    } else {
      lines.push('知识点掌握度：')
      for (const t of db.topics) {
        const score = t.measuredScore ?? t.selfScore
        const src = t.measuredScore !== null ? '实测' : '自评'
        lines.push(`- ${t.topic}：${score}%（${src}）`)
      }
    }
    return lines.join('\n')
  }
}

/** 记忆写入：显式「记住这个」。不碰工作区文件 → non-mutating，不走变更门禁。
 * 自动沉淀已覆盖大部分场景；此工具给用户明确说「记住…」时一个可靠入口。 */
const memorySaveTool: ToolDef = {
  name: 'memory_save',
  mutating: false,
  description:
    '把关于用户的长期信息存入记忆（跨会话可 recall）。适合用户明确说「记住…」「以后注意…」时；' +
    '一次存一条，一句话以内。kind：preference=用户偏好 / fact=个人事实 / commitment=承诺约定。' +
    '一次性任务细节不要存（会污染记忆）。',
  parameters: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['preference', 'fact', 'commitment'],
        description: '记忆类型'
      },
      content: { type: 'string', description: '一句话内容（≤60 字）' },
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description: '3~6 个检索关键词（从内容里抽）'
      }
    },
    required: ['kind', 'content']
  },
  execute: async (args, ctx) => {
    if (!isMemoryEnabled()) throw new Error('长期记忆当前关闭（设置 → 记忆 打开后才可写入）')
    const kind = args.kind
    const content = args.content
    if (typeof kind !== 'string' || !['preference', 'fact', 'commitment'].includes(kind)) {
      throw new Error('kind 必须是 preference / fact / commitment 之一')
    }
    if (typeof content !== 'string' || content.trim() === '') throw new Error('缺少 content')
    const keywords = Array.isArray(args.keywords)
      ? args.keywords.filter((k): k is string => typeof k === 'string')
      : []
    const r = addEntry(
      { kind: kind as 'preference' | 'fact' | 'commitment', content: content.trim(), keywords },
      ctx.sessionId
    )
    return r === 'added' ? '已记住。' : '已更新原有记忆。'
  }
}

/** 记忆检索：她自查「我记过什么」。non-mutating。 */
const memorySearchTool: ToolDef = {
  name: 'memory_search',
  mutating: false,
  description: '检索关于用户的长期记忆。想确认「我之前记过什么」或用户问「你还记得吗」时用。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索词（自然语言即可）' }
    },
    required: ['query']
  },
  execute: async (args) => {
    const query = args.query
    if (typeof query !== 'string' || query.trim() === '') throw new Error('缺少 query')
    const hits = scoreEntries(readEntries(), query).slice(0, 5)
    if (hits.length === 0) return '记忆里没有相关内容。'
    return hits.map((h) => `- [${h.entry.kind}] ${h.entry.content}`).join('\n')
  }
}

const TOOLS: ToolDef[] = [
  currentTimeTool,
  calculateTool,
  readFileTool,
  listDirTool,
  writeFileTool,
  editFileTool,
  searchFilesTool,
  fetchUrlTool,
  downloadFileTool,
  noteExportTool,
  searchHistoryTool,
  runShellTool,
  runJsTool,
  exportPdfTool,
  webSearchTool,
  mkdirTool,
  markTempFilesTool,
  deleteFileTool,
  undoLastChangeTool,
  todoWriteTool,
  activeWindowTool,
  describeImageTool,
  ocrImageTool,
  noteWriteTool,
  noteReadTool,
  searchContentTool,
  memorySaveTool,
  memorySearchTool,
  skillUseTool,
  spawnAgentTool,
  askUserTool,
  studyProgressWriteTool,
  studyProgressReadTool
]
/** 注册表快照（防御性拷贝：外部改动不影响内部注册表） */
export function getToolDefinitions(): ToolDef[] {
  return TOOLS.map((t) => ({ ...t }))
}

/**
 * 工具是否属"变更"类（权限只管变更，读取永远不问）。
 *
 * **MCP 工具一律返回 false**：
 * 成熟实现里 MCP 工具就是普通工具，不因"是 MCP"而自动弹确认；接入某个 server 即等于信任它，
 * 其边界由该 server 自己负责。此前按 `readOnlyHint/destructiveHint` 分级会让
 * `browser_navigate` 这类工具每次都弹卡（Playwright 把它标了 destructive），体验很糟。
 */
export function isMutatingTool(name: string): boolean {
  if (name.startsWith('mcp__')) return false
  return TOOLS.find((t) => t.name === name)?.mutating === true
}

/**
 * 显式豁免审批的变更类工具。
 * - `undo_last_change`：只回滚「应用自己快照过的」内容，是**恢复路径**；
 * 对"撤销刚发生的错误"再弹一次确认，是把安全机制用在了错误的地方。
 */
const APPROVAL_EXEMPT_TOOLS = new Set<string>(['undo_last_change'])

export function isApprovalExempt(name: string): boolean {
  return APPROVAL_EXEMPT_TOOLS.has(name)
}

/**
 * 解析"审批越界判定"用的目标路径（绝对路径）；该工具无路径语义时返回 null。
 *
 * 只处理会写文件系统的内置工具。之所以在这里解析而不是让调用方各写一份：
 * 路径基准（工作区 vs 应用目录）与 `resolveToolPath` 的规则必须唯一。
 */
/** 路径参数可省略的工具 → 确定性缺省目录（ E2E 发现：省略路径时审批层
 * 解析不到目标会 fail-closed 弹卡问用户，但这俩工具的缺省目录其实是确定的，
 * 不该把"已知缺省"变成"未知路径"黑洞打断用户）。 */
const TOOL_DEFAULT_TARGET: Record<string, string> = {
  note_export: 'notes-export',
  download_file: 'downloads'
}

export function approvalTargetPath(
  name: string,
  argsJson: string,
  workspace: string | null
): string | null {
  // 只关心变更类内置工具；只读/MCP 不参与越界判定
  if (name.startsWith('mcp__')) return null
  const def = TOOLS.find((t) => t.name === name)
  if (def === undefined || def.mutating !== true) return null
  let args: Record<string, unknown>
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>
  } catch {
    return null // 参数非法：交回调用方按 fail-closed 处理
  }
  const raw = args.path ?? args.target_dir
  if (typeof raw !== 'string' || raw.trim() === '') {
    // 路径省略：用工具的确定性缺省目录参与判定（note_export → notes-export/ 等）
    const fallback = TOOL_DEFAULT_TARGET[name]
    if (fallback === undefined) return null
    try {
      return resolveToolPath(fallback, workspace)
    } catch {
      return null
    }
  }
  try {
    return resolveToolPath(raw, workspace)
  } catch {
    return null // 相对路径且基准未就绪：无法判定 → fail-closed
  }
}

/** 转成 openai SDK 的 tools 参数形状（streamChat 透传）：内置工具 + 已连接 MCP 工具。
 * 隐私门控：active_window 仅在用户显式开启屏幕感知后才出现（与 可见性取 AND）；
 * 模式可见性门控：按 allowlist 过滤内置工具，缺省全可见。
 * 技能门控：无启用技能时 skill_use 不进清单（有技能才需要"按需加载"这个动作）。
 * chat 模式返回空表（调用侧 run.ts 对 chat 根本不传 tools，这里是防御兜底）。 */
export function getLlmTools(mode: ChatMode = 'work'): LlmTool[] {
  const hasSkills = listEnabledSkills(mode).length > 0
  const builtin = TOOLS.filter(
    (t) =>
      isToolVisibleForMode(t.name, mode) &&
      (t.name !== 'active_window' || isScreenEnabled()) &&
      (t.name !== 'skill_use' || hasSkills) &&
      // 长期记忆关闭 = 工具不进注册表（此前开关只管自动提炼，
      // 模型仍能显式 memory_save，用户看到"明明没开却记下了"）
      (!['memory_save', 'memory_search'].includes(t.name) || isMemoryEnabled())
    // run_shell / run_js 的学习模式解禁：此前 work 专属（设计 §2 缩小
    // 暴露面），但学习模式同样要跑例子、生成讲义/表格——"工作与学习全工具可用"是
    // 明确要求。权限闸门（run_js 每次弹卡、run_shell 白名单外请示）仍是同一道边界。
  ).map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
  if (mode === 'chat') return builtin // chat：无 MCP（调用侧也不传 tools，双保险）
  // MCP 适用模式：每个 server 自带 modes，不按模式就不过滤时
  // 会出现"学习模式里冒出浏览器自动化工具"这种噪声；缺省 work+learn。
  const views = mcpManager.listTools().filter((t) => t.modes.includes(mode))
  const mcp = views.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.prefixedName,
      description:
        (t.description
          ? `[MCP:${t.serverName}] ${t.description}`
          : `[MCP:${t.serverName}] ${t.name}`) +
        (t.readOnly ? '（外部只读工具，可直接执行）' : '（外部工具，执行前通常需要用户批准）'),
      parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} }
    }
  }))
  return [...builtin, ...mcp]
}

export type ToolExecStatus = 'ok' | 'failed' | 'timeout' | 'denied'

export interface ToolExecResult {
  /** 兼容字段：status === 'ok' */
  ok: boolean
  /** 四态：ok = 成功；timeout = 执行超时；denied = 审批拒绝；failed = 其余失败（回灌文本已说明） */
  status: ToolExecStatus
  /** 结果文本（失败时为错误说明，二者都会回灌给 LLM） */
  result: string
}

/** 重试退避序列（毫秒）：1s / 2s / 4s，最多 3 次重试 */
export const RETRY_BACKOFF_MS = [1000, 2000, 4000]

/**
 * 是否值得重试：仅系统级"占用/权限暂时不可用"类（EBUSY/EPERM/EACCES/EAGAIN/ETXTBSY）——
 * 重试可能成功；ENOENT/EISDIR/参数错等确定性失败重试也不会变，直接 failed。
 */
export function isRetryableError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return (
    typeof code === 'string' && ['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'ETXTBSY'].includes(code)
  )
}

/** 超时专用错误：catch 侧据此归类 timeout 态（避免靠中文 message 字符串匹配） */
class ToolTimeoutError extends Error {}

/** 失败错误 → 四态归类（timeout 由内部 ToolTimeoutError 触发；其余确定性失败归 failed） */
export function classifyExecError(err: unknown): ToolExecStatus {
  if (err instanceof ToolTimeoutError) return 'timeout'
  return 'failed'
}

/** 可被 abort 的退避等待；中断时抛 'aborted-during-backoff' */
async function sleepCancellable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('aborted-during-backoff')
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted-during-backoff'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export interface ToolExecOptions {
  /** 单次尝试超时（默认 TOOL_TIMEOUT_MS；测试可注入短值） */
  timeoutMs?: number
  /** 重试退避序列（默认 RETRY_BACKOFF_MS；测试可注入短值验证顺序） */
  retryDelays?: number[]
  /** 发起调用的会话模式；缺省 work */
  mode?: ChatMode
  /** 会话模式的绑定工作目录 */
  workspace?: string | null
  /** 附加产物槽（v17 diff 徽标）：write_file/edit_file 执行时写 diffStat，调用方取走 */
  out?: { diffStat?: { added: number; removed: number } }
}

/** 执行一次工具调用：未知工具 / 参数解析失败 / 超时 / 异常统统收敛为 {ok:false}，不向循环抛异常。
 * ：四态归类 + 对"占用类"错误自动指数退避重试（确定性失败不浪费时间）。
 * ：mode 可见性双保险——模型点名了被隐藏的内置工具时按"不可用"拒绝（与清单门控同口径）。 */
export async function executeToolCall(
  name: string,
  argsJson: string,
  signal: AbortSignal,
  sessionId = 'unknown-session',
  options: ToolExecOptions = {}
): Promise<ToolExecResult> {
  const timeoutMs = options.timeoutMs ?? TOOL_TIMEOUT_OVERRIDES[name] ?? TOOL_TIMEOUT_MS
  const retryDelays = options.retryDelays ?? RETRY_BACKOFF_MS
  const mode: ChatMode = options.mode ?? 'work'
  // MCP 外部工具路由：mcp__<serverId>__<tool> → manager.callTool（SDK 自带超时/错误收敛）
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length)
    const sep = rest.indexOf('__')
    if (sep <= 0) {
      return { ok: false, status: 'failed', result: `MCP 工具名不合法：${name}` }
    }
    const serverId = rest.slice(0, sep)
    const remoteName = rest.slice(sep + 2)
    const mcpResult = await mcpManager.callTool(serverId, remoteName, argsJson)
    return { ...mcpResult, status: mcpResult.ok ? 'ok' : 'failed' }
  }
  const visibleNames = TOOLS.filter((t) => isToolVisibleForMode(t.name, mode)).map((t) => t.name)
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool || !isToolVisibleForMode(name, mode)) {
    // 未知工具与"该模式下被隐藏的工具"同一口径回灌（不暴露隐藏工具的存在，也防模型反复重试）
    return {
      ok: false,
      status: 'failed',
      result: `工具不可用：${name}。当前模式下可用工具：${
        visibleNames.length > 0 ? visibleNames.join('、') : '（无）'
      }（以及已连接 MCP 服务器的工具）`
    }
  }
  let args: Record<string, unknown> = {}
  try {
    args = argsJson.trim() === '' ? {} : (JSON.parse(argsJson) as Record<string, unknown>)
  } catch {
    return { ok: false, status: 'failed', result: `参数不是合法 JSON：${argsJson.slice(0, 200)}` }
  }

  let lastErr: unknown = null
  // 尝试循环：第 1 次执行 + 最多 retryDelays.length 次重试（每次尝试独立超时控制器）
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    if (attempt > 0) {
      // 退避等待；等待期间被中断 → 直接按中断收敛
      try {
        await sleepCancellable(retryDelays[attempt - 1], signal)
      } catch {
        return { ok: false, status: 'failed', result: '用户中断了本次执行' }
      }
      if (signal.aborted) return { ok: false, status: 'failed', result: '用户中断了本次执行' }
    }
    const controller = new AbortController()
    const onOuterAbort = (): void => controller.abort(signal.reason)
    signal.addEventListener('abort', onOuterAbort, { once: true })
    try {
      const result = await Promise.race([
        tool.execute(args, {
          signal: controller.signal,
          sessionId,
          workspace: options.workspace,
          out: options.out
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            controller.abort()
            reject(new ToolTimeoutError(`工具执行超时（${timeoutMs / 1000} 秒）`))
          }, timeoutMs)
        })
      ])
      return { ok: true, status: 'ok', result }
    } catch (err) {
      lastErr = err
      if (signal.aborted) break
      if (!(err instanceof ToolTimeoutError) && !isRetryableError(err)) break // 确定性失败
      if (err instanceof ToolTimeoutError) break // 超时不重试（再来一次大概率还是超时烧时间）
      // 占用类错误 → 继续下一轮退避重试
    } finally {
      signal.removeEventListener('abort', onOuterAbort)
    }
  }

  if (signal.aborted) return { ok: false, status: 'failed', result: '用户中断了本次执行' }
  const status = classifyExecError(lastErr)
  const message = lastErr instanceof Error ? lastErr.message : String(lastErr ?? '未知错误')
  return {
    ok: false,
    status,
    result: status === 'timeout' ? message : `工具执行出错：${message}`
  }
}
