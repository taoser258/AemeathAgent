// 副作用账本单测（红线②）：写前快照 + 只追加账本。
// 覆盖：create（无快照）/ update（快照内容还原一致）/ 只追加 / 未初始化拒绝。

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import {
  getLedgerBase,
  listChanges,
  recordChange,
  setLedgerBase,
  undoLastChange
} from '../src/main/agent/tools/ledger'

let root = ''
const FILE = 'doc.txt'

beforeEach(() => {
  root = join(tmpdir(), `aemeath-ledger-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(root, { recursive: true })
  setLedgerBase(join(root, 'ledger'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ledger.recordChange', () => {
  it('create：目标不存在 → 无快照、bytesBefore=0、账本条目落盘', () => {
    const target = join(root, FILE)
    const entry = recordChange('s1', 'write_file', FILE, target)
    expect(entry.action).toBe('create')
    expect(entry.bytesBefore).toBe(0)
    expect(entry.snapshotRef).toBeNull()
    expect(entry.sessionId).toBe('s1')
    expect(entry.targetAbsPath).toBe(target)
    // 账本条目 JSON 落盘且内容可读
    const sessionDir = join(getLedgerBase(), 's1')
    const files = readdirSync(sessionDir).filter((f) => f.endsWith('.json'))
    expect(files).toHaveLength(1)
    const persisted = JSON.parse(readFileSync(join(sessionDir, files[0]), 'utf8'))
    expect(persisted.action).toBe('create')
    expect(persisted.tool).toBe('write_file')
    // snapshots 目录存在但为空（无快照）
    expect(existsSync(join(sessionDir, 'snapshots'))).toBe(true)
  })

  it('update：目标已存在 → 原内容快照，快照还原后与原文一致（撤销能力的数据基础）', () => {
    const target = join(root, FILE)
    writeFileSync(target, '原始内容 v1', 'utf8')
    const entry = recordChange('s1', 'write_file', FILE, target)
    expect(entry.action).toBe('update')
    expect(entry.bytesBefore).toBe(Buffer.byteLength('原始内容 v1', 'utf8'))
    expect(entry.snapshotRef).toBeTruthy()
    // 快照内容 === 原内容（撤销时用它还原）
    const snap = readFileSync(
      join(getLedgerBase(), 's1', 'snapshots', entry.snapshotRef ?? ''),
      'utf8'
    )
    expect(snap).toBe('原始内容 v1')
  })

  it('只追加：两次记账产生两个独立条目，互不覆盖', () => {
    const target = join(root, FILE)
    recordChange('s1', 'write_file', FILE, target)
    recordChange('s1', 'mkdir', 'sub', join(root, 'sub'))
    const sessionDir = join(getLedgerBase(), 's1')
    const entries = readdirSync(sessionDir).filter((f) => f.endsWith('.json'))
    expect(entries).toHaveLength(2)
  })

  it('会话隔离：不同 sessionId 各自成目录；目标为目录时拒绝（不可覆盖）', () => {
    const dirTarget = join(root, 'adir')
    mkdirSync(dirTarget)
    expect(() => recordChange('sA', 'write_file', 'adir', dirTarget)).toThrow(/不是文件/)
    recordChange('sB', 'mkdir', 'x', join(root, 'x'))
    expect(existsSync(join(getLedgerBase(), 'sA'))).toBe(false)
    expect(existsSync(join(getLedgerBase(), 'sB'))).toBe(true)
  })

  it('未初始化（base 为空）时拒绝变更（防线：主进程未 ready 不可能写）', () => {
    setLedgerBase('')
    expect(() => recordChange('s1', 'write_file', FILE, join(root, FILE))).toThrow(/未初始化/)
  })
})

describe('listChanges / undoLastChange', () => {
  it('listChanges：ts 倒序、file 名携带；undo 条目自动标记原条目 undone', () => {
    const target = join(root, FILE)
    writeFileSync(target, 'v1', 'utf8')
    recordChange('s1', 'write_file', FILE, target) // update
    const list1 = listChanges('s1')
    expect(list1).toHaveLength(1)
    expect(list1[0].kind).toBe('change')
    expect(list1[0].undone).toBe(false)

    undoLastChange('s1') // 回滚 → 文件还原 v1 + undo 条目
    const list2 = listChanges('s1')
    expect(list2).toHaveLength(2)
    expect(list2[0].kind).toBe('undo') // 最新在前
    expect(list2[1].kind).toBe('change')
    expect(list2[1].undone).toBe(true) // 已被回滚
  })

  it('update 回滚：内容用快照还原，回滚本身留 undo 条目', () => {
    const target = join(root, FILE)
    writeFileSync(target, 'v1', 'utf8')
    recordChange('s1', 'write_file', FILE, target)
    writeFileSync(target, 'v2 改坏了', 'utf8')
    undoLastChange('s1')
    expect(readFileSync(target, 'utf8')).toBe('v1') // 还原
    expect(listChanges('s1')[0].kind).toBe('undo')
  })

  it('create(write_file) 回滚：删除新建的文件；再撤销报"没有可撤销"', () => {
    const target = join(root, FILE)
    recordChange('s1', 'write_file', FILE, target) // create
    writeFileSync(target, '内容', 'utf8')
    undoLastChange('s1')
    expect(existsSync(target)).toBe(false)
    expect(() => undoLastChange('s1')).toThrow(/没有可撤销/)
  })

  it('create(mkdir) 回滚：空目录删除；被写入内容后拒绝撤销', () => {
    const dir = join(root, 'newdir')
    recordChange('s1', 'mkdir', 'newdir', dir)
    mkdirSync(dir) // 工具 execute 顺序：先记账后建目录
    undoLastChange('s1')
    expect(existsSync(dir)).toBe(false)

    recordChange('s1', 'mkdir', 'full', join(root, 'full'))
    mkdirSync(join(root, 'full')) // 先记账后建目录（工具顺序）
    writeFileSync(join(root, 'full', 'x.txt'), 'x', 'utf8')
    expect(() => undoLastChange('s1')).toThrow(/拒绝撤销/)
    expect(existsSync(join(root, 'full', 'x.txt'))).toBe(true) // 内容无损
  })

  it('线性安全：update 回滚只动最近一笔，更早的条目保持可撤销', () => {
    const a = join(root, 'a.txt')
    const b = join(root, 'b.txt')
    writeFileSync(a, 'A1', 'utf8')
    writeFileSync(b, 'B1', 'utf8')
    recordChange('s1', 'write_file', 'a.txt', a) // update A
    recordChange('s1', 'write_file', 'b.txt', b) // update B（最新）
    writeFileSync(a, 'A2', 'utf8')
    writeFileSync(b, 'B2', 'utf8')
    undoLastChange('s1') // 只回滚 B
    expect(readFileSync(b, 'utf8')).toBe('B1')
    expect(readFileSync(a, 'utf8')).toBe('A2') // 更早的变更不受影响
    const view = listChanges('s1').filter((v) => v.kind === 'change')
    expect(view.find((v) => v.targetPath === 'a.txt')?.undone).toBe(false)
    expect(view.find((v) => v.targetPath === 'b.txt')?.undone).toBe(true)
  })

  it('listChanges 全局视图（不传 sessionId）聚合多会话', () => {
    recordChange('sX', 'write_file', 'x', join(root, 'x'))
    recordChange('sY', 'mkdir', 'y', join(root, 'y'))
    expect(listChanges().map((v) => v.sessionId)).toEqual(['sY', 'sX'])
  })
})
