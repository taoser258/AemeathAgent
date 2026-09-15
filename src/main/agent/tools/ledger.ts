// 副作用账本：变更类工具写前快照 + 只追加账本。
// 语义：任何 write_file / mkdir 落盘前先 recordChange——目标已存在则原内容
// 拷入 snapshots/（快照本体），不存在记 create；随后才能真正写入。
// 无 electron 依赖：账本根目录由 main 注入（setLedgerBase），vitest 可直接单测。

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { dirname, join } from 'path'

export interface LedgerEntry {
  /** 条目生成时间（毫秒） */
  ts: number
  sessionId: string
  tool: string
  /** 工具入参的原始路径（相对/绝对原样保留） */
  targetPath: string
  /** 解析后的绝对路径（与工具实际操作的目标一致） */
  targetAbsPath: string
  /** create = 原目标不存在；update = 已快照原内容 */
  action: 'create' | 'update'
  /** 变更前字节数（create 恒为 0） */
  bytesBefore: number
  /** 快照文件名（相对 snapshots/ 目录）；create 为 null */
  snapshotRef: string | null
  /** ：change = 普通变更（缺省兼容旧条目）；undo = 回滚记录 */
  kind?: 'change' | 'undo'
  /** 仅 undo 条目：被回滚的原条目文件名 */
  undoesFile?: string
}

let ledgerBase = ''

/** 注入账本根目录（userData/ledger）；测试注入临时目录 */
export function setLedgerBase(dir: string): void {
  ledgerBase = dir
}

export function getLedgerBase(): string {
  return ledgerBase
}

function newLedgerId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 写前记账：目标已存在 → 原内容快照入 snapshots/；随后追加账本条目。
 * 必须在真正写入之前调用——本函数抛异常时调用方不得继续写入（红线②）。
 */
export function recordChange(
  sessionId: string,
  tool: string,
  targetPath: string,
  targetAbsPath: string
): LedgerEntry {
  if (ledgerBase === '') {
    throw new Error('账本未初始化（应用尚未就绪），拒绝执行变更类操作。')
  }
  // 先校验目标、后建目录：异常路径不留下空账本目录
  let entry: LedgerEntry
  if (existsSync(targetAbsPath)) {
    const info = statSync(targetAbsPath)
    if (!info.isFile()) {
      throw new Error(`目标已存在且不是文件：${targetAbsPath}（目录不支持 write_file 覆盖）`)
    }
  }
  const sessionDir = join(ledgerBase, sessionId)
  const snapshotsDir = join(sessionDir, 'snapshots')
  mkdirSync(snapshotsDir, { recursive: true })

  if (existsSync(targetAbsPath)) {
    const info = statSync(targetAbsPath)
    const snapshotRef = `${newLedgerId()}.bin`
    copyFileSync(targetAbsPath, join(snapshotsDir, snapshotRef))
    entry = {
      ts: Date.now(),
      sessionId,
      tool,
      targetPath,
      targetAbsPath,
      action: 'update',
      bytesBefore: info.size,
      snapshotRef
    }
  } else {
    entry = {
      ts: Date.now(),
      sessionId,
      tool,
      targetPath,
      targetAbsPath,
      action: 'create',
      bytesBefore: 0,
      snapshotRef: null
    }
  }

  // 账本只追加：一个变更一个 JSON 文件（原子性好，T3 撤销按条目回放）
  const entryPath = join(sessionDir, `${entry.ts.toString(36)}-${newLedgerId()}-${tool}.json`)
  writeFileSync(entryPath, JSON.stringify(entry, null, 2), 'utf8')
  return entry
}

// ── ：账本查询与撤销 ──────────────────────────────────────────────

export interface LedgerEntryView extends LedgerEntry {
  /** 条目文件名（会话目录内），撤销定位用 */
  file: string
  kind: 'change' | 'undo'
  /** 仅 change 条目：是否已被某条 undo 回滚（回滚后不再是"可撤销的最近变更"） */
  undone: boolean
}

/** 读取账本条目（ts 倒序）。sessionId 缺省 = 全部会话（设置页全局视图）。解析失败的条目跳过不抛。 */
export function listChanges(sessionId?: string): LedgerEntryView[] {
  if (ledgerBase === '') return []
  const dirs = sessionId
    ? [join(ledgerBase, sessionId)]
    : existsSync(ledgerBase)
      ? readdirSync(ledgerBase, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => join(ledgerBase, d.name))
      : []
  const out: LedgerEntryView[] = []
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const entry = JSON.parse(readFileSync(join(dir, f), 'utf8')) as LedgerEntry
        out.push({ ...entry, file: f, kind: entry.kind ?? 'change', undone: false })
      } catch {
        // 损坏条目跳过（账本是排查用的旁路数据，不值得为它抛错）
      }
    }
  }
  // undo 条目把对应原条目标记为已撤销
  for (const v of out) {
    if (v.kind === 'undo' && v.undoesFile !== undefined) {
      const origin = out.find((o) => o.file === v.undoesFile && o.sessionId === v.sessionId)
      if (origin) origin.undone = true
    }
  }
  return out.sort((a, b) => b.ts - a.ts)
}

/**
 * 线性回滚最近一笔未被撤销的变更（只追加账本语义下天然安全：总是从最新往回）。
 * - update：用快照还原原内容（父目录缺失自动补建）
 * - create + write_file：删除该文件
 * - create + mkdir：删除该目录（必须为空——里面后来被塞了东西就拒绝，防误删）
 * 回滚成功后追加一条 undo 条目（kind:'undo'）留痕；失败抛异常不产生任何副作用。
 */
export function undoLastChange(sessionId: string): LedgerEntry {
  const candidates = listChanges(sessionId).filter((v) => v.kind === 'change' && !v.undone)
  const target = candidates[0]
  if (!target) {
    throw new Error('当前会话没有可撤销的变更记录')
  }

  if (target.action === 'update') {
    const snapshotPath = join(ledgerBase, sessionId, 'snapshots', target.snapshotRef ?? '')
    if (!existsSync(snapshotPath)) {
      throw new Error('快照文件丢失（' + (target.snapshotRef ?? '') + '），无法安全回滚这笔变更')
    }
    mkdirSync(dirname(target.targetAbsPath), { recursive: true })
    copyFileSync(snapshotPath, target.targetAbsPath)
  } else if (target.tool === 'mkdir') {
    if (!existsSync(target.targetAbsPath)) {
      throw new Error('目录 ' + target.targetAbsPath + ' 已不存在，无需撤销')
    }
    const rest = readdirSync(target.targetAbsPath)
    if (rest.length > 0) {
      throw new Error(
        '目录 ' +
          target.targetAbsPath +
          ' 在创建后又被写入了 ' +
          rest.length +
          ' 项内容，拒绝撤销以防误删；请先清理目录内文件'
      )
    }
    rmSync(target.targetAbsPath, { recursive: true })
  } else {
    // create + write_file：线性语义下此后不应再被本账本改过，直接删除
    if (!existsSync(target.targetAbsPath)) {
      throw new Error('文件 ' + target.targetAbsPath + ' 已不存在，无需撤销')
    }
    rmSync(target.targetAbsPath, { force: true })
  }

  const undoEntry: LedgerEntry = {
    ts: Date.now(),
    sessionId,
    tool: 'undo_last_change',
    targetPath: target.targetPath,
    targetAbsPath: target.targetAbsPath,
    action: target.action,
    bytesBefore: 0,
    snapshotRef: null,
    kind: 'undo',
    undoesFile: target.file
  }
  const entryPath = join(
    ledgerBase,
    sessionId,
    undoEntry.ts.toString(36) + '-' + newLedgerId() + '-undo_last_change.json'
  )
  writeFileSync(entryPath, JSON.stringify(undoEntry, null, 2), 'utf8')
  return undoEntry
}
