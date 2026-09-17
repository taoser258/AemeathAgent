// 会话注册表：会话元信息（标题/时间/隐藏标记）的跨窗口事实源。
// 消息正文仍在主窗渲染层内存；这里只管"有哪些会话、哪些被隐藏"，
// 让 设置页（独立窗口）能做 隐藏会话的恢复/删除，并广播变更让主窗实时跟随。
// 读写均为纯 Node 代码（目录由调用方传入），vitest 可直接单测。

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { ipcMain, BrowserWindow } from 'electron'
import {
  SESSION_DELETE,
  SESSION_MESSAGES_GET,
  SESSION_SET_HIDDEN,
  SESSION_SYNC,
  SESSIONS_CHANGED,
  SESSION_LIST,
  SESSION_TOKEN_USAGE
} from '@shared/ipc-channels'
import type { SessionMeta, SessionMessagesResult, TokenUsageResult } from '@shared/types'
import { readUsage } from '../usage/usage-log'
import { deleteSessionData, loadSessionMessages, pruneOrphanSessionData } from './session-store'
import { abortRunsForSession, abortRunsNotInSessions } from '../chat/run'

const REGISTRY_FILE = 'index.json'

function registryPath(dir: string): string {
  return join(dir, REGISTRY_FILE)
}

/** 单条会话元信息防御校验（id/时间必需，其余补默认） */
export function sanitizeSessionMeta(raw: unknown): SessionMeta | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id.trim() === '') return null
  if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt)) return null
  if (typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt)) return null
  return {
    id: r.id.trim(),
    title: typeof r.title === 'string' && r.title.trim() !== '' ? r.title.trim() : '未命名会话',
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    hidden: r.hidden === true,
    titleIsCustom: r.titleIsCustom === true,
    // 模式：非法值不落字段（读取侧按 'work' 处理）
    ...(r.mode === 'chat' || r.mode === 'work' || r.mode === 'learn' ? { mode: r.mode } : {}),
    // 置顶：只透传显式 true（缺省/脏值 = 不置顶）
    ...(r.pinned === true ? { pinned: true } : {})
  }
}

/** 读取注册表；文件缺失/损坏返回空表（不抛异常） */
export function loadSessions(dir: string): SessionMeta[] {
  try {
    if (!existsSync(registryPath(dir))) return []
    const parsed = JSON.parse(readFileSync(registryPath(dir), 'utf8')) as unknown
    const list =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>).sessions
        : null
    if (!Array.isArray(list)) return []
    const seen = new Set<string>()
    return list
      .map(sanitizeSessionMeta)
      .filter((s): s is SessionMeta => s !== null)
      .filter((s) => {
        if (seen.has(s.id)) return false
        seen.add(s.id)
        return true
      })
  } catch {
    return []
  }
}

/** 写入注册表；目录不存在则创建 */
export function saveSessions(dir: string, sessions: SessionMeta[]): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(registryPath(dir), `${JSON.stringify({ v: 1, sessions }, null, 2)}\n`, 'utf8')
}

export interface SweepResult {
  /** 清掉的孤儿注册表条目（有注册无数据文件且过期的空会话） */
  prunedRegistry: string[]
  /** 清掉的数据目录残留（.bak/.tmp 原子写残骸） */
  removedResiduals: number
  /** 清掉的孤儿旁路档（ledger/todos/notes/checkpoint 里已无会话的档） */
  cleanedArchives: number
}

/**
 * 会话存储一致性清扫。启动时执行一次：
 * 1. 孤儿注册表条目：注册表里有、数据文件没有、且 updatedAt 早于 maxEmptyAgeMs 的空会话
 * ——新建未发言的空会话属正常态（数据文件首条消息才落），只有长期无文件的才判孤儿；
 * 2. 数据目录残留：.bak / .tmp（原子写中断的残骸）一律清除；
 * 3. 孤儿旁路档：ledger / todos / notes / checkpoint 里已不在注册表的会话档清除。
 * 纯 Node 同步实现，vitest 可直接单测（now/maxEmptyAgeMs 注入）。
 */
export function sweepSessionStore(
  dir: string,
  archives: {
    ledger?: string
    todos?: string
    notes?: string
    checkpoint?: string
    /** 上下文摘要档（P8-T1）：会话没了就清掉 */
    compact?: string
  },
  options?: { now?: number; maxEmptyAgeMs?: number }
): SweepResult {
  const now = options?.now ?? Date.now()
  const maxEmptyAgeMs = options?.maxEmptyAgeMs ?? 48 * 60 * 60 * 1000
  const result: SweepResult = { prunedRegistry: [], removedResiduals: 0, cleanedArchives: 0 }

  const sessions = loadSessions(dir)
  const dataD = join(dir, 'data')
  const keep: SessionMeta[] = []
  for (const s of sessions) {
    const hasData = existsSync(join(dataD, `${s.id}.json`))
    if (!hasData && now - s.updatedAt > maxEmptyAgeMs) {
      result.prunedRegistry.push(s.id) // 长期空壳：判孤儿
    } else {
      keep.push(s)
    }
  }
  if (result.prunedRegistry.length > 0) {
    saveSessions(dir, keep)
  }
  const keepIds = new Set(keep.map((s) => s.id))

  // 数据目录残留（.bak/.tmp）
  if (existsSync(dataD)) {
    for (const name of readdirSync(dataD)) {
      if (/\.bak|\.tmp/i.test(name)) {
        try {
          unlinkSync(join(dataD, name))
          result.removedResiduals += 1
        } catch {
          /* 忽略单个失败 */
        }
      }
    }
  }

  // 孤儿旁路档
  for (const archiveDir of [
    archives.ledger,
    archives.todos,
    archives.notes,
    archives.checkpoint,
    archives.compact
  ]) {
    if (archiveDir === undefined || !existsSync(archiveDir)) continue
    for (const name of readdirSync(archiveDir)) {
      const m = /^([A-Za-z0-9-]+)\.json$/.exec(name)
      if (m !== null && !keepIds.has(m[1])) {
        try {
          rmSync(join(archiveDir, name), { force: true })
          result.cleanedArchives += 1
        } catch {
          /* 忽略单个失败 */
        }
      }
    }
  }
  return result
}

/** 变更广播：让所有窗口（主窗 store、设置页）知道会话注册表变了 */
function broadcastChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(SESSIONS_CHANGED)
  }
}

export function registerSessionsIpc(sessionsDir: string): void {
  // 渲染层（主窗 store）每次变更后全量同步：主进程落盘 + 广播 + 孤儿数据清理
  ipcMain.on(SESSION_SYNC, (_event, list: unknown) => {
    if (!Array.isArray(list)) return
    const sessions = list.map(sanitizeSessionMeta).filter((s): s is SessionMeta => s !== null)
    saveSessions(sessionsDir, sessions)
    // 元信息里已消失的会话 = 已被删除：先掐断其仍在途的流（防继续烧 token / 落僵尸文件，T6.5）
    try {
      abortRunsNotInSessions(sessions.map((s) => s.id))
    } catch {
      /* 掐流失败不阻塞同步 */
    }
    // 元信息里已消失的会话，其数据文件一并清理（侧栏删除 / 硬删都走这里收敛）
    try {
      pruneOrphanSessionData(
        sessionsDir,
        sessions.map((s) => s.id)
      )
    } catch {
      /* 清理失败不阻塞同步 */
    }
    broadcastChanged()
  })

  // 设置页等读取全量（含已隐藏）
  ipcMain.handle(SESSION_LIST, (): SessionMeta[] => loadSessions(sessionsDir))

  // Token 用量汇总（设置页「用量」分区）：轻量遍历全部会话档的累计遥测。
  // 只取 stats 字段不读消息体（一个大档可能几 MB，全读会卡设置窗）。
  ipcMain.handle(SESSION_TOKEN_USAGE, (): TokenUsageResult => {
    const metas = loadSessions(sessionsDir)
    const byId = new Map(metas.map((m) => [m.id, m]))
    const dataDir = join(sessionsDir, 'data')
    const rows: TokenUsageResult['rows'] = []
    if (existsSync(dataDir)) {
      for (const file of readdirSync(dataDir)) {
        if (!file.endsWith('.json')) continue
        try {
          const parsed = JSON.parse(readFileSync(join(dataDir, file), 'utf8')) as {
            stats?: Record<string, unknown>
          }
          const st = parsed.stats
          if (st === undefined) continue
          const id = file.replace(/\.json$/, '')
          const meta = byId.get(id)
          const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
          rows.push({
            sessionId: id,
            title: meta?.title ?? '(未命名会话)',
            mode: meta?.mode ?? 'work',
            updatedAt: meta?.updatedAt ?? 0,
            rounds: num(st.rounds),
            samples: num(st.samples),
            inputTok: num(st.inputTok),
            outputTok: num(st.outputTok),
            cachedTok: num(st.cachedTok),
            cacheKnown: st.cacheKnown === true,
            llmMs: num(st.llmMs)
          })
        } catch {
          // 单档损坏跳过（与 loadSessionMessages 的容错口径一致）
        }
      }
    }
    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    // 每轮明细流水（时间范围图表/按模型分组用）；坏行已在 readUsage 内跳过
    const points = readUsage(sessionsDir)
    const totals = rows.reduce(
      (acc, r) => ({
        inputTok: acc.inputTok + r.inputTok,
        outputTok: acc.outputTok + r.outputTok,
        cachedTok: acc.cachedTok + r.cachedTok,
        rounds: acc.rounds + r.rounds,
        samples: acc.samples + r.samples,
        llmMs: acc.llmMs + r.llmMs
      }),
      { inputTok: 0, outputTok: 0, cachedTok: 0, rounds: 0, samples: 0, llmMs: 0 }
    )
    // 明细最多回 100 条（排序已按最近优先），总量仍为全量聚合
    return { totals, rows: rows.slice(0, 100), points }
  })

  // 主窗渲染层：读取指定会话的持久化消息
  ipcMain.handle(SESSION_MESSAGES_GET, (_event, id: unknown): SessionMessagesResult => {
    const MAX_LOAD = 200
    if (typeof id !== 'string' || id === '') {
      return { messages: [], truncated: false, corrupted: false }
    }
    const loaded = loadSessionMessages(sessionsDir, id)
    if (!loaded.ok) {
      return { messages: [], truncated: false, corrupted: loaded.reason === 'corrupt' }
    }
    const truncated = loaded.messages.length > MAX_LOAD
    return {
      messages: truncated ? loaded.messages.slice(-MAX_LOAD) : loaded.messages,
      truncated,
      corrupted: false,
      usage: loaded.usage,
      stats: loaded.stats
    }
  })

  // 设置页：恢复 / 隐藏（hidden=false 即恢复到侧栏）
  ipcMain.on(SESSION_SET_HIDDEN, (_event, payload: unknown): void => {
    if (!isRecord(payload)) return
    if (typeof payload.id !== 'string' || payload.id === '') return
    setSessionHidden(sessionsDir, payload.id, payload.hidden === true)
  })

  // 设置页：永久删除（注册表移除 + 数据文件清理 + 广播；主窗 store 监听后清掉本地消息）
  ipcMain.on(SESSION_DELETE, (_event, id: unknown): void => {
    if (typeof id !== 'string' || id === '') return
    deleteSessionHard(sessionsDir, id)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 设置页动作：恢复 / 永久删除（直接改注册表并广播，主窗 store 监听后自动跟随） */
export function setSessionHidden(sessionsDir: string, id: string, hidden: boolean): void {
  const sessions = loadSessions(sessionsDir).map((s) => (s.id === id ? { ...s, hidden } : s))
  saveSessions(sessionsDir, sessions)
  broadcastChanged()
}

export function deleteSessionHard(sessionsDir: string, id: string): void {
  saveSessions(
    sessionsDir,
    loadSessions(sessionsDir).filter((s) => s.id !== id)
  )
  // 该会话若还有在途流先掐断，再清数据文件（验收：删除会话后磁盘无残留）
  abortRunsForSession(id)
  deleteSessionData(sessionsDir, id)
  broadcastChanged()
}
