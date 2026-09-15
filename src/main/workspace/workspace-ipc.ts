// 右侧边栏（学 成熟实现better-sidebar 的工作台）后端：浏览会话工作区 + 读取文件预览。
//
// 安全边界：渲染层只能读**当前模式绑定的工作区**内的路径——
// · 根目录由主进程从 app.json 推导（渲染层传不了任意根，防止被诱导读 C:\ 或家目录）
// · 相对路径进 join 后必须仍在根内（resolve 后做前缀比对，挡 `..\..\` 越狱）
// · 目录/文件读取都有大小与条数上限；符号链接按真实路径判定，不跟随出根
// 越界/不存在/超大一律返回结构化错误，不抛异常（渲染层要能优雅显示）。

import { readdirSync, readFileSync, statSync, realpathSync } from 'fs'
import { isAbsolute, join, relative, resolve, extname } from 'path'
import { execFile } from 'child_process'
import { ipcMain, shell } from 'electron'
import {
  WORKSPACE_GIT,
  WORKSPACE_READ,
  WORKSPACE_REVEAL,
  WORKSPACE_TODO_TOGGLE,
  WORKSPACE_OPEN_EXTERNAL,
  WORKSPACE_OPEN_PATH,
  SEARCH_CONTENT,
  WORKSPACE_TREE
} from '@shared/ipc-channels'
import { readTodos, writeTodos } from '../agent/tools/todo-store'
import { parseOffice } from './office-preview'
import { searchWorkspaceContent } from '../search/content-search'
import { boundWorkspace } from '@shared/workspace'
import type { WorkspaceTreeEntry, WorkspaceReadResult, WorkspaceTreeResult } from '@shared/types'
import { readAppConfig } from '../settings/app-config'
import { configDir } from '../paths'

/** 目录树返回上限（防超大工程把树撑爆；超出标记 truncated） */
const MAX_ENTRIES = 400
/** 文本预览上限 */
const MAX_TEXT_BYTES = 20 * 1024 * 1024
/** 图片预览上限（8MB → 25MB） */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
/** 文本嗅探窗口（NUL 字节判二进制） */
const SNIFF_BYTES = 8192

/** 音视频（dataUrl 内联预览；超过上限提示用系统播放器） */
const MEDIA_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac'
}
const MAX_MEDIA_BYTES = 50 * 1024 * 1024
const MAX_PDF_BYTES = 50 * 1024 * 1024

const IMAGE_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

/** 当前模式的工作区根；没有（对话模式未绑定/未配置）返回 null */
function currentWorkspaceRoot(): string | null {
  const config = readAppConfig(configDir())
  // 侧栏是主窗内的通用面板：取工作模式的绑定（含学习库），与聊天用同一套绑定规则
  const ws = boundWorkspace(config.workspace, 'work') ?? boundWorkspace(config.workspace, 'learn')
  if (ws === null || ws === '') return null
  try {
    if (!statSync(ws).isDirectory()) return null
  } catch {
    return null
  }
  return ws
}

/**
 * 相对路径 → 绝对路径，并校验仍在根内。
 * 用 realpath 比对（防符号链接逃逸），`..` 越狱在这里被挡掉。
 * 返回 null = 越界或不存在。
 */
function safeJoin(root: string, rel: string): string | null {
  if (rel.includes('\0')) return null
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  const target = resolve(join(root, cleaned))
  let realRoot: string
  let realTarget: string
  try {
    realRoot = realpathSync(root)
    realTarget = realpathSync(target)
  } catch {
    return null
  }
  const relToRoot = relative(realRoot, realTarget)
  if (relToRoot.startsWith('..') || isAbsolute(relToRoot)) return null
  return realTarget
}

/** 列出目录（单层，根或子目录） */
function listDir(root: string, rel: string): WorkspaceTreeResult {
  const target = rel === '' ? root : safeJoin(root, rel)
  if (target === null) return { ok: false, error: '路径不在工作区内或不存在' }
  try {
    if (!statSync(target).isDirectory()) return { ok: false, error: '不是一个目录' }
    const names = readdirSync(target)
    const entries: WorkspaceTreeEntry[] = []
    for (const name of names) {
      // 隐藏文件（. 开头）不进树：噪声大（.git/.cache），需要时用文件工具看
      if (name.startsWith('.')) continue
      const child = safeJoin(root, rel === '' ? name : `${rel}/${name}`)
      if (child === null) continue
      let size = 0
      let kind: 'file' | 'dir' = 'file'
      try {
        const st = statSync(child)
        kind = st.isDirectory() ? 'dir' : 'file'
        size = st.size
      } catch {
        continue
      }
      entries.push({
        name,
        rel: (rel === '' ? name : `${rel}/${name}`).replace(/\\/g, '/'),
        kind,
        size
      })
    }
    entries.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name, 'zh') : a.kind === 'dir' ? -1 : 1
    )
    const truncated = entries.length > MAX_ENTRIES
    return { ok: true, root, entries: entries.slice(0, MAX_ENTRIES), truncated }
  } catch (err) {
    return { ok: false, error: `读取目录失败：${String(err)}` }
  }
}

/** 读文件预览：图片 → dataUrl；文本 → 原文；二进制 → 只报大小 */
function readForPreview(root: string, rel: string): WorkspaceReadResult {
  const target = safeJoin(root, rel)
  if (target === null) return { ok: false, error: '路径不在工作区内或不存在' }
  let size: number
  try {
    const st = statSync(target)
    if (st.isDirectory()) return { ok: false, error: '这是一个目录，请展开查看' }
    size = st.size
  } catch (err) {
    return { ok: false, error: `文件不存在或无法访问：${String(err)}` }
  }
  const ext = extname(target).toLowerCase()
  const imageMime = IMAGE_EXT[ext]
  const mediaMime = MEDIA_EXT[ext]
  const isPdf = ext === '.pdf'
  if (imageMime !== undefined || mediaMime !== undefined || isPdf) {
    const limit = isPdf
      ? MAX_PDF_BYTES
      : mediaMime !== undefined
        ? MAX_MEDIA_BYTES
        : MAX_IMAGE_BYTES
    const label = isPdf ? 'PDF' : mediaMime !== undefined ? '媒体文件' : '图片'
    if (size > limit) {
      return { ok: false, error: `${label}过大（${size} 字节 > ${limit}），不内联预览` }
    }
    try {
      const buf = readFileSync(target)
      const mime = imageMime ?? mediaMime ?? 'application/pdf'
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
      if (imageMime !== undefined) return { ok: true, kind: 'image', rel, size, dataUrl }
      if (isPdf) return { ok: true, kind: 'pdf', rel, size, dataUrl }
      return { ok: true, kind: 'media', rel, size, mime: mediaMime ?? '', dataUrl }
    } catch (err) {
      return { ok: false, error: `读取${label}失败：${String(err)}` }
    }
  }
  if (size > MAX_TEXT_BYTES) return { ok: false, error: `文件过大（${size} 字节 > 20 MB），不预览` }
  // Office 三件套：docx/xlsx/pptx 走零依赖 ZIP+XML 文本级预览；
  // 旧格式 .doc/.xls/.ppt 与加密文档在 parseOffice 里抛人话错误兜底成错误态。
  const OFFICE_EXT = ['.docx', '.xlsx', '.pptx']
  if (OFFICE_EXT.includes(ext)) {
    const MAX_OFFICE_BYTES = 50 * 1024 * 1024
    if (size > MAX_OFFICE_BYTES) {
      return { ok: false, error: `Office 文档过大（${size} 字节 > 50 MB），不内联预览` }
    }
    try {
      const preview = parseOffice(readFileSync(target), ext)
      return { ok: true, kind: 'office', rel, size, preview }
    } catch (err) {
      return { ok: false, error: `Office 预览失败：${String(err)}` }
    }
  }
  try {
    const buf = readFileSync(target)
    const head = buf.subarray(0, Math.min(SNIFF_BYTES, buf.length))
    if (head.includes(0)) return { ok: true, kind: 'binary', rel, size }
    // 大文本只回传前 2MB（渲染层 pre 全量渲染超大文本会把 DOM 打满），尾部加截断提示
    const maxChars = 2 * 1024 * 1024
    const full = buf.toString('utf8')
    const text =
      full.length > maxChars
        ? `${full.slice(0, maxChars)}\n\n…[内容过长，仅显示前 2MB，完整内容请用系统编辑器打开]`
        : full
    return { ok: true, kind: 'text', rel, size, text }
  } catch (err) {
    return { ok: false, error: `读取失败：${String(err)}` }
  }
}

/* ═══ Git 面板（v15）：只读概览 ═══ */

export interface GitChange {
  /** porcelain XY 状态码（M/A/D/R/?? 等） */
  code: string
  rel: string
}

export interface GitOverview {
  isRepo: boolean
  hint?: string
  branch?: string
  changes?: GitChange[]
  /** 最近提交（新→旧） */
  log?: Array<{ hash: string; date: string; subject: string }>
  aheadBehind?: string
}

/** porcelain=v1 单条记录 → 变更项（纯函数可单测；-z 的重命名两段式简化为取新名） */
export function parsePorcelainEntry(raw: string): GitChange | null {
  if (raw.length < 4) return null
  const code = raw.slice(0, 2)
  let rel = raw.slice(3).trim()
  if (rel === '') return null
  // -z 模式重命名：new\0old 已被调用方按 NUL 切散，这里只处理 -> 形式兜底
  const arrow = rel.indexOf('->')
  if (arrow !== -1) rel = rel.slice(arrow + 2).trim()
  rel = rel.replace(/^"|"$/g, '').replace(/\\/g, '/')
  if (rel === '') return null
  return { code, rel }
}

function runGit(root: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      'git',
      args,
      { cwd: root, windowsHide: true, maxBuffer: 1024 * 1024, timeout: 15000 },
      (err, stdout) => {
        if (err !== null) rejectPromise(err)
        else resolvePromise(String(stdout))
      }
    )
  })
}

async function gitOverview(root: string): Promise<GitOverview> {
  try {
    await runGit(root, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    return { isRepo: false, hint: '当前工作区不是 git 仓库（或在子模块外）' }
  }
  const out: GitOverview = { isRepo: true }
  try {
    out.branch = (await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  } catch {
    out.branch = '(无提交)'
  }
  try {
    // -z：NUL 分隔，文件名原样（含空格/中文），quotepath 一起关掉
    const raw = await runGit(root, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z'])
    const changes: GitChange[] = []
    for (const entry of raw.split('\0')) {
      if (entry === '') continue
      const parsed = parsePorcelainEntry(entry)
      if (parsed !== null) changes.push(parsed)
    }
    out.changes = changes
  } catch {
    out.changes = []
  }
  try {
    const raw = await runGit(root, ['log', '--pretty=format:%h|%ar|%s', '-15'])
    out.log = raw
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => {
        const [hash, date, ...rest] = l.split('|')
        return { hash: hash ?? '', date: date ?? '', subject: rest.join('|') ?? '' }
      })
  } catch {
    out.log = []
  }
  try {
    const st = await runGit(root, ['status', '-sb'])
    const first = st.split('\n')[0] ?? ''
    // 形如 ## main...origin/main [ahead 1]
    const m = first.match(/\[(ahead|behind)\s+\d+(?:\s+(?:ahead|behind)\s+\d+)?\]/)
    if (m !== null) out.aheadBehind = m[0].slice(1, -1)
  } catch {
    /* 无上游忽略 */
  }
  return out
}

/* ═══ 简易终端（v15）：单命令执行 + 增量输出 ═══
 * 说明：真 PTY（node-pty）是原生依赖，等 再上；本版为"每回车执行一条命令"的
 * 简化终端，覆盖 dir/type/git status 这类查看型命令足够。Windows 输出是 GBK——
 * Node 22 自带 full-icu，TextDecoder('gbk') 直接可解，零新依赖。
 */

// v1 简易终端（一次性 spawn + GBK 解码）已由 终端 v2 取代，见 terminal-ipc.ts
export const __testables2 = { parsePorcelainEntry }

export function registerWorkspaceIpc(): void {
  // 目录树：rel 缺省 = 根（''）——前端懒加载逐层展开
  ipcMain.handle(WORKSPACE_TREE, (_event, rel: unknown): WorkspaceTreeResult => {
    const root = currentWorkspaceRoot()
    if (root === null) {
      return {
        ok: false,
        error: '当前还没有绑定工作区——到 设置 → 工作区 选一个目录，或切到工作模式。'
      }
    }
    const sub = typeof rel === 'string' ? rel : ''
    return listDir(root, sub)
  })

  ipcMain.handle(WORKSPACE_READ, (_event, rel: unknown): WorkspaceReadResult => {
    const root = currentWorkspaceRoot()
    if (root === null) return { ok: false, error: '当前还没有绑定工作区' }
    if (typeof rel !== 'string' || rel === '') return { ok: false, error: '缺少文件路径' }
    return readForPreview(root, rel)
  })

  // Git 概览（只读）：branch + status 变更 + 最近提交；非 git 仓库给提示不给假数据
  ipcMain.handle(WORKSPACE_GIT, async (): Promise<GitOverview> => {
    const root = currentWorkspaceRoot()
    if (root === null) return { isRepo: false, hint: '当前还没有绑定工作区' }
    return gitOverview(root)
  })

  // 在系统资源管理器中显示（文件树/预览的跳转按钮）
  ipcMain.handle(WORKSPACE_REVEAL, (_event, rel: unknown): boolean => {
    const root = currentWorkspaceRoot()
    if (root === null || typeof rel !== 'string' || rel === '') return false
    const target = safeJoin(root, rel)
    if (target === null) return false
    shell.showItemInFolder(target)
    return true
  })

  // 工作区内容检索：右侧栏搜索面板；根推导与越界防护同文件树
  ipcMain.handle(
    SEARCH_CONTENT,
    (
      _event,
      query: unknown,
      limit: unknown
    ): { hits: unknown[]; scanned: number; truncated: boolean; error?: string } => {
      const root = currentWorkspaceRoot()
      if (root === null)
        return { hits: [], scanned: 0, truncated: false, error: '当前还没有绑定工作区' }
      if (typeof query !== 'string' || query.trim() === '') {
        return { hits: [], scanned: 0, truncated: false, error: '搜索词为空' }
      }
      const lim =
        typeof limit === 'number' && Number.isFinite(limit)
          ? Math.min(50, Math.max(1, Math.round(limit)))
          : 20
      return searchWorkspaceContent(root, query, lim)
    }
  )

  // 用系统默认应用打开工作区文件（pptx/docx 等内联预览不了的格式走这里）
  ipcMain.handle(
    WORKSPACE_OPEN_PATH,
    async (_event, rel: unknown): Promise<{ ok: boolean; error?: string }> => {
      const root = currentWorkspaceRoot()
      if (root === null) return { ok: false, error: '当前还没有绑定工作区' }
      if (typeof rel !== 'string' || rel === '') return { ok: false, error: '缺少文件路径' }
      const target = safeJoin(root, rel)
      if (target === null) return { ok: false, error: '路径不在工作区内' }
      const err = await shell.openPath(target)
      return err === '' ? { ok: true } : { ok: false, error: err }
    }
  )

  // 外链交给系统浏览器（只放行 http/https，防 file: 等协议被滥用）
  ipcMain.on(WORKSPACE_OPEN_EXTERNAL, (_event, url: unknown): void => {
    if (typeof url !== 'string') return
    if (!/^https?:\/\//i.test(url)) return
    void shell.openExternal(url)
  })

  // 任务面板：勾选切换一项的状态（复用 agent 的 todo-store，同一份落盘）
  ipcMain.handle(
    WORKSPACE_TODO_TOGGLE,
    (_event, sessionId: unknown, todoId: unknown): { ok: boolean; error?: string } => {
      if (typeof sessionId !== 'string' || sessionId === '')
        return { ok: false, error: '缺少会话 id' }
      if (typeof todoId !== 'string') return { ok: false, error: '缺少清单项 id' }
      const state = readTodos(sessionId)
      if (state === null)
        return { ok: false, error: '当前会话还没有任务清单（让爱弥斯先规划一下）' }
      const item = state.items.find((it) => it.id === todoId)
      if (item === undefined) return { ok: false, error: '清单项不存在' }
      item.status = item.status === 'done' ? 'pending' : 'done'
      try {
        writeTodos(sessionId, state.items)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    }
  )
}

/** 供单测复用的纯函数（不含 electron 依赖的部分） */
export const __testables = { safeJoin, listDir, readForPreview }
