// 分层记忆数据层单测：shared/memory.ts 纯函数 + main/memory/memory-store.ts IO。
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildMemoryAppendix,
  mergeInto,
  MEMORY_MERGE_THRESHOLD,
  MEMORY_MAX_ENTRIES,
  pickForInjection,
  scoreEntries,
  tokenize,
  type MemoryEntry
} from '../src/shared/memory'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { searchWorkspaceContent } from '../src/main/search/content-search'
import {
  addEntry,
  clearAll,
  deleteEntry,
  readEntries,
  setMemoryBase
} from '../src/main/memory/memory-store'

function entry(partial: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    kind: 'fact',
    content: partial.id,
    keywords: [],
    sourceSessionId: 's1',
    createdAt: 1000,
    updatedAt: 1000,
    hits: 0,
    ...partial
  }
}

describe('tokenize（中英混合简易切词）', () => {
  it('中文 2-gram + 英文整词小写', () => {
    const t = tokenize('我喜欢 VSCode 写代码')
    expect(t).toContain('喜欢')
    expect(t).toContain('vscode')
    expect(t).toContain('写代')
    expect(t).toContain('代码')
  })

  it('停用词被过滤', () => {
    expect(tokenize('我的')).not.toContain('我')
    expect(tokenize('的')).toHaveLength(0)
  })
})

describe('scoreEntries / pickForInjection（检索打分）', () => {
  const entries: MemoryEntry[] = [
    entry({ id: 'a', content: '用户喜欢简洁回复', keywords: ['喜欢', '简洁', '回复'] }),
    entry({ id: 'b', content: '用户在云澜大学读书', keywords: ['云澜大学', '读书', '学生'] }),
    entry({ id: 'c', content: '无关条目', keywords: ['天气', '南京'] })
  ]

  it('按关键词命中数降序，零命中被过滤', () => {
    const scored = scoreEntries(entries, '云澜大学的学生')
    expect(scored[0]?.entry.id).toBe('b')
    expect(scored.some((s) => s.entry.id === 'c')).toBe(false)
  })

  it('pickForInjection 截断到 8 条并返回 hitIds', () => {
    const many: MemoryEntry[] = Array.from({ length: 12 }, (_, i) =>
      entry({ id: `m${i}`, keywords: [`kw${i}`] })
    )
    const q = Array.from({ length: 12 }, (_, i) => `kw${i}`).join(' ')
    const { memories, hitIds } = pickForInjection(many, q)
    expect(memories).toHaveLength(8)
    expect(hitIds).toHaveLength(8)
  })

  it('空查询 → 空结果（不注入）', () => {
    expect(scoreEntries(entries, '的')).toEqual([])
  })
})

describe('buildMemoryAppendix（注入附录格式）', () => {
  it('带类型标签；空数组返回空串', () => {
    const text = buildMemoryAppendix([
      { kind: 'preference', content: '喜欢简洁回复' },
      { kind: 'fact', content: '云澜大学大二' }
    ])
    expect(text).toContain('## 关于用户的长期记忆')
    expect(text).toContain('- [偏好] 喜欢简洁回复')
    expect(text).toContain('- [事实] 云澜大学大二')
    expect(buildMemoryAppendix([])).toBe('')
  })
})

describe('mergeInto（去重合并 + 容量淘汰）', () => {
  it('重合 ≥60% 且同 kind → 更新（保 id/createdAt）', () => {
    const existing = entry({
      id: 'old',
      kind: 'preference',
      content: '喜欢简洁',
      keywords: ['喜欢', '简洁', '回复'],
      createdAt: 1,
      updatedAt: 1
    })
    const { entries, mergedId } = mergeInto(
      [existing],
      { kind: 'preference', content: '喜欢极简的回复风格', keywords: ['喜欢', '简洁', '风格'] },
      's2',
      999
    )
    expect(entries).toHaveLength(1)
    expect(mergedId).toBe('old')
    expect(entries[0].content).toBe('喜欢极简的回复风格')
    expect(entries[0].createdAt).toBe(1)
    expect(entries[0].updatedAt).toBe(999)
  })

  it('不同 kind 不合并（即使关键词相同）', () => {
    const existing = entry({ id: 'f1', kind: 'fact', keywords: ['云澜大学', '学生'] })
    const { entries, mergedId } = mergeInto(
      [existing],
      { kind: 'preference', content: 'x', keywords: ['云澜大学', '学生'] },
      's'
    )
    expect(entries).toHaveLength(2)
    expect(mergedId).not.toBe('f1')
  })

  it('超过 500 条 → 淘汰 hits 最低且最旧', () => {
    const entries: MemoryEntry[] = Array.from({ length: MEMORY_MAX_ENTRIES }, (_, i) =>
      entry({ id: `e${i}`, hits: i % 3, createdAt: 1000 + i })
    )
    // e0 hits=0 最旧 → 应被淘汰
    const { entries: next, mergedId } = mergeInto(
      entries,
      { kind: 'fact', content: '新条目', keywords: ['全新'] },
      's'
    )
    expect(next).toHaveLength(MEMORY_MAX_ENTRIES)
    expect(next.some((e) => e.id === 'e0')).toBe(false)
    expect(next.some((e) => e.id === mergedId)).toBe(true)
  })

  it('阈值常量 = 0.6', () => {
    expect(MEMORY_MERGE_THRESHOLD).toBe(0.6)
  })
})

describe('memory-store（IO：整写 + 快照）', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aemeath-memory-'))
    setMemoryBase(dir)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    setMemoryBase('')
  })

  it('add → read 往返；文件确实落盘', () => {
    expect(addEntry({ kind: 'fact', content: '用户在云澜大学', keywords: ['云澜大学'] }, 's1')).toBe(
      'added'
    )
    expect(readEntries()).toHaveLength(1)
    expect(existsSync(join(dir, 'entries.json'))).toBe(true)
  })

  it('重复合并：第二次同关键词 → updated 且仍 1 条', () => {
    addEntry({ kind: 'fact', content: '用户在云澜大学', keywords: ['云澜大学', '学生'] }, 's1')
    expect(
      addEntry({ kind: 'fact', content: '用户在云澜大学读书', keywords: ['云澜大学', '学生'] }, 's2')
    ).toBe('updated')
    expect(readEntries()).toHaveLength(1)
  })

  it('delete 先快照：backups 里留档且条目消失', () => {
    addEntry({ kind: 'fact', content: '要被删的', keywords: ['删除测试'] }, 's1')
    const id = readEntries()[0].id
    expect(deleteEntry(id)).toBe(true)
    expect(deleteEntry(id)).toBe(false)
    expect(readEntries()).toHaveLength(0)
    const backups = readdirSync(join(dir, 'backups'))
    expect(backups.length).toBe(1)
  })

  it('clearAll 清空但留快照', () => {
    addEntry({ kind: 'fact', content: 'a', keywords: ['a'] }, 's')
    addEntry({ kind: 'preference', content: 'b', keywords: ['b'] }, 's')
    clearAll()
    expect(readEntries()).toHaveLength(0)
    expect(readdirSync(join(dir, 'backups')).length).toBe(1)
  })
})

describe('searchWorkspaceContent', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aemeath-content-'))
    writeFileSync(join(root, 'notes.md'), '# 笔记\n今天研究了鹈鹕自行车的传动结构。')
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(
      join(root, 'docs', 'spec.ts'),
      'export const theme = "dark"\n// 传动结构见 notes.md\n'
    )
    writeFileSync(join(root, 'pic.bin'), Buffer.from([0x00, 0x01, 0x02, 0x74, 0x65, 0x73, 0x74])) // 含 NUL：二进制跳过
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'x.js'), '传动结构 噪声文件（应被忽略目录跳过）')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('跨文件命中：文件级聚合 + 行号 + 摘要', () => {
    const { hits, truncated } = searchWorkspaceContent(root, '传动结构')
    expect(truncated).toBe(false)
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(hits.some((h) => h.rel === 'notes.md' && h.line === 2)).toBe(true)
    expect(hits.some((h) => h.rel === 'docs/spec.ts' && h.line === 2)).toBe(true)
    expect(hits[0].snippet).toContain('传动结构')
  })

  it('忽略目录与二进制不进结果', () => {
    const { hits } = searchWorkspaceContent(root, '传动结构')
    expect(hits.some((h) => h.rel.startsWith('node_modules'))).toBe(false)
    const bin = searchWorkspaceContent(root, 'test')
    expect(bin.hits.some((h) => h.rel === 'pic.bin')).toBe(false)
  })

  it('零命中与空查询', () => {
    expect(searchWorkspaceContent(root, '不存在的词组xyz').hits).toHaveLength(0)
    expect(searchWorkspaceContent(root, '').hits).toHaveLength(0)
  })
})
