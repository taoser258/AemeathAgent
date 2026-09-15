// edit_file / search_files 单测。
// edit_file 走真实账本（setLedgerBase 指到临时目录，快照/撤销链路一并验证）；
// search_files 用临时文件树验证通配、内容匹配、跳过目录与上限。

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getToolDefinitions } from '../src/main/agent/tools/registry'
import { setLedgerBase, undoLastChange } from '../src/main/agent/tools/ledger'
import type { ToolDef } from '../src/main/agent/tools/registry'

const defs = getToolDefinitions()
const editTool = defs.find((d) => d.name === 'edit_file') as ToolDef
const searchTool = defs.find((d) => d.name === 'search_files') as ToolDef

let root: string
let ledgerDir: string
const ctx = (workspace: string): { signal: AbortSignal; sessionId: string; workspace: string } => ({
  signal: new AbortController().signal,
  sessionId: 'test-session',
  workspace
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aemeath-tools-'))
  ledgerDir = mkdtempSync(join(tmpdir(), 'aemeath-ledger-'))
  setLedgerBase(ledgerDir)
})
afterEach(() => {
  setLedgerBase('')
})

describe('edit_file（锚点精确替换）', () => {
  it('单处替换生效，返回快照引用；undo 一键还原', async () => {
    const file = join(root, 'a.txt')
    writeFileSync(file, 'hello world\nsecond line', 'utf8')
    const out = await editTool.execute(
      { path: file, edits: [{ old_string: 'world', new_string: 'there' }] },
      ctx(root)
    )
    expect(String(out)).toContain('已编辑')
    expect(String(out)).toContain('可撤销')
    expect(readFileSync(file, 'utf8')).toBe('hello there\nsecond line')
    // 账本撤销闭环：与 write_file 同一条链路
    undoLastChange('test-session')
    expect(readFileSync(file, 'utf8')).toBe('hello world\nsecond line')
  })

  it('多处批量按顺序应用', async () => {
    const file = join(root, 'b.txt')
    writeFileSync(file, 'alpha beta gamma', 'utf8')
    await editTool.execute(
      {
        path: file,
        edits: [
          { old_string: 'alpha', new_string: 'ALPHA' },
          { old_string: 'gamma', new_string: 'GAMMA' }
        ]
      },
      ctx(root)
    )
    expect(readFileSync(file, 'utf8')).toBe('ALPHA beta GAMMA')
  })

  it('锚点不存在 → 拒绝并提示先 read_file；文件未被改动', async () => {
    const file = join(root, 'c.txt')
    writeFileSync(file, 'unchanged', 'utf8')
    await expect(
      editTool.execute({ path: file, edits: [{ old_string: 'nope', new_string: 'x' }] }, ctx(root))
    ).rejects.toThrow('不存在')
    expect(readFileSync(file, 'utf8')).toBe('unchanged')
  })

  it('锚点不唯一 → 拒绝并要求补上下文', async () => {
    const file = join(root, 'd.txt')
    writeFileSync(file, 'dup dup unique', 'utf8')
    await expect(
      editTool.execute({ path: file, edits: [{ old_string: 'dup', new_string: 'x' }] }, ctx(root))
    ).rejects.toThrow('不唯一')
  })

  it('new_string 里的 $& 等替换模式不被展开（字面量写入）', async () => {
    const file = join(root, 'e.txt')
    writeFileSync(file, 'price', 'utf8')
    await editTool.execute(
      { path: file, edits: [{ old_string: 'price', new_string: '$& $` $1' }] },
      ctx(root)
    )
    expect(readFileSync(file, 'utf8')).toBe('$& $` $1')
  })

  it('文件不存在 → 提示改用 write_file', async () => {
    await expect(
      editTool.execute(
        { path: join(root, 'ghost.txt'), edits: [{ old_string: 'a', new_string: 'b' }] },
        ctx(root)
      )
    ).rejects.toThrow('write_file')
  })
})

describe('search_files（文件名通配 + 内容匹配）', () => {
  beforeEach(() => {
    writeFileSync(join(root, 'a.ts'), 'const alpha = 1\nconst beta = 2', 'utf8')
    mkdirSync(join(root, 'sub'), { recursive: true })
    writeFileSync(join(root, 'sub', 'b.ts'), 'export const gamma = 3', 'utf8')
    writeFileSync(join(root, 'README.md'), '# demo alpha doc', 'utf8')
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'x', 'c.ts'), 'const alpha = hidden', 'utf8')
  })

  it('pattern 通配命中（含子目录），跳过 node_modules', async () => {
    const out = String(await searchTool.execute({ pattern: '*.ts' }, ctx(root)))
    expect(out).toContain('a.ts')
    expect(out).toContain('sub/b.ts')
    expect(out).not.toContain('node_modules')
    expect(out).not.toContain('README.md')
  })

  it('query 内容匹配：返回 文件:行: 预览；node_modules 被跳过', async () => {
    const out = String(await searchTool.execute({ query: 'alpha' }, ctx(root)))
    expect(out).toContain('a.ts:1')
    expect(out).toContain('README.md')
    expect(out).not.toContain('hidden')
  })

  it('pattern + query 组合：只在匹配文件里搜内容', async () => {
    const out = String(await searchTool.execute({ pattern: '*.ts', query: 'alpha' }, ctx(root)))
    expect(out).toContain('a.ts:1')
    expect(out).not.toContain('README.md')
  })

  it('正则语法可用；非法正则按字面量处理不抛异常', async () => {
    const regex = String(await searchTool.execute({ query: 'al\\w+' }, ctx(root)))
    expect(regex).toContain('a.ts:1')
    const literal = String(await searchTool.execute({ query: 'const ([bad' }, ctx(root)))
    expect(literal).toContain('扫描')
  })

  it('无命中 → 扫描计数 + 无命中文案', async () => {
    const out = String(await searchTool.execute({ query: '绝对不存在的内容xyz' }, ctx(root)))
    expect(out).toContain('无命中')
    expect(out).toMatch(/扫描 \d+ 个文件/)
  })

  it('pattern 与 query 都缺 → 提示改用 list_dir', async () => {
    await expect(searchTool.execute({}, ctx(root))).rejects.toThrow('list_dir')
  })
})
