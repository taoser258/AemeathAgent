// 右侧边栏（学 成熟实现better-sidebar）后端单测：**路径越界防护是安全边界**，必须守护。
// 覆盖：正常列目录/读文件、`..` 越狱、工作区外绝对路径、符号链接不逃逸、
// 图片走 dataUrl、二进制嗅探、超大拒绝、产出文件解析（相对路径认、绝对路径主进程认）。

import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { __testables, __testables2 } from '../src/main/workspace/workspace-ipc'
import { fileRefFromCall, producedFileFromCall } from '../src/shared/produced-file'
import { countLineDiff, diffFromToolArgs } from '../src/shared/diff-stat'
import { resolveProducedFile } from '../src/main/chat/produced-file'
import { producedFileFromCall } from '../src/shared/produced-file'

const { safeJoin, listDir, readForPreview } = __testables
const { parsePorcelainEntry } = __testables2

let root = ''
let outside = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ws-root-'))
  outside = mkdtempSync(join(tmpdir(), 'ws-out-'))
  writeFileSync(join(root, 'a.txt'), 'hello\nworld\n', 'utf8')
  writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET', 'utf8')
  mkdirSync(join(root, 'sub'))
  writeFileSync(join(root, 'sub', 'b.md'), '# 标题', 'utf8')
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, '.git', 'config'), 'x', 'utf8')
  // 1×1 PNG（含 NUL 之外的二进制头）
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  writeFileSync(join(root, 'pic.png'), png)
  // 伪二进制（含 NUL 字节）→ 应判 binary
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0x41, 0x00, 0x42]))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('safeJoin（越界防护）', () => {
  it('工作区内相对路径 → 解析成功', () => {
    expect(safeJoin(root, 'a.txt')).not.toBeNull()
    expect(safeJoin(root, 'sub/b.md')).not.toBeNull()
  })

  it('`..` 越狱 → 拒绝（核心安全断言）', () => {
    expect(safeJoin(root, '../secret.txt')).toBeNull()
    expect(safeJoin(root, 'sub/../../secret.txt')).toBeNull()
    expect(safeJoin(root, '..\\..\\secret.txt')).toBeNull()
  })

  it('绝对路径越界 → 拒绝（渲染层传不进任意根）', () => {
    expect(safeJoin(root, join(outside, 'secret.txt'))).toBeNull()
    expect(safeJoin(root, 'C:/Windows/System32/drivers/etc/hosts')).toBeNull()
  })

  it('符号链接指向工作区外 → 拒绝（realpath 比对）', () => {
    const link = join(root, 'escape.txt')
    try {
      symlinkSync(join(outside, 'secret.txt'), link, 'file')
    } catch {
      return // Windows 无权限建符号链接时跳过（不能因环境失败）
    }
    expect(safeJoin(root, 'escape.txt')).toBeNull()
  })

  it('不存在的路径 → null（不抛异常）', () => {
    expect(safeJoin(root, 'nope.txt')).toBeNull()
  })
})

describe('listDir（目录树）', () => {
  it('列根目录：目录在前、隐藏项不进树', () => {
    const res = listDir(root, '')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const names = res.entries.map((e) => e.name)
    expect(names).toContain('a.txt')
    expect(names).toContain('sub')
    expect(names).not.toContain('.git') // 隐藏目录不进树
    expect(res.entries[0].kind).toBe('dir') // 目录排在文件前
  })

  it('列子目录（懒加载用）', () => {
    const res = listDir(root, 'sub')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.entries.map((e) => e.rel)).toContain('sub/b.md')
  })

  it('越界路径 → ok:false（不泄露工作区外目录）', () => {
    const res = listDir(root, '..')
    expect(res.ok).toBe(false)
  })

  it('文件当目录列 → ok:false', () => {
    const res = listDir(root, 'a.txt')
    expect(res.ok).toBe(false)
  })
})

describe('readForPreview（文件预览）', () => {
  it('文本文件 → kind:text + 原文', () => {
    const res = readForPreview(root, 'a.txt')
    expect(res.ok).toBe(true)
    if (!res.ok || res.kind !== 'text') return
    expect(res.text).toContain('hello')
  })

  it('图片 → kind:image + dataUrl', () => {
    const res = readForPreview(root, 'pic.png')
    expect(res.ok).toBe(true)
    if (!res.ok || res.kind !== 'image') return
    expect(res.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('含 NUL 的文件 → kind:binary（不硬塞进文本预览）', () => {
    const res = readForPreview(root, 'blob.bin')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.kind).toBe('binary')
  })

  it('越界读取 → ok:false（核心安全断言）', () => {
    const res = readForPreview(root, '../secret.txt')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('工作区')
  })

  it('目录 → ok:false 并提示展开', () => {
    const res = readForPreview(root, 'sub')
    expect(res.ok).toBe(false)
  })
})

describe('产出文件解析（文件卡片数据源）', () => {
  it('相对路径写入 → 生成卡片信息', () => {
    const f = producedFileFromCall('write_file', JSON.stringify({ path: 'src/a.ts', content: 'x' }))
    expect(f).toEqual({ rel: 'src/a.ts', name: 'a.ts', action: '已写入' })
  })

  it('反斜杠与 ./ 前缀归一化', () => {
    const f = producedFileFromCall('edit_file', JSON.stringify({ path: '.\\src\\b.ts' }))
    expect(f?.rel).toBe('src/b.ts')
  })

  it('绝对路径 → 渲染层不认（无工作区上下文，宁可不给假入口）', () => {
    expect(producedFileFromCall('write_file', '{"path":"E:/ws/a.ts"}')).toBeNull()
    expect(producedFileFromCall('write_file', '{"path":"/home/u/a.ts"}')).toBeNull()
  })

  it('绝对路径 + 已知工作区根 → 换算成 rel（历史会话的卡片靠它）', () => {
    const f = producedFileFromCall(
      'write_file',
      JSON.stringify({ path: 'E:\\ws\\notes\\x.md' }),
      'E:/ws'
    )
    expect(f).toEqual({ rel: 'notes/x.md', name: 'x.md', action: '已写入' })
  })

  it('绝对路径在工作区外 → null（即使给了根）', () => {
    expect(producedFileFromCall('write_file', '{"path":"E:/other/a.ts"}', 'E:/ws')).toBeNull()
  })

  it('路径越界 → null', () => {
    expect(producedFileFromCall('write_file', '{"path":"../a.ts"}')).toBeNull()
  })

  it('非产出工具 / 参数非法 → null', () => {
    expect(producedFileFromCall('read_file', '{"path":"a.ts"}')).toBeNull()
    expect(producedFileFromCall('write_file', 'not-json')).toBeNull()
    expect(producedFileFromCall('write_file', '{}')).toBeNull()
  })

  it('主进程版：绝对路径在工作区内 → 换算成 rel', () => {
    const f = resolveProducedFile(
      'write_file',
      JSON.stringify({ path: join(root, 'sub', 'c.md') }),
      root
    )
    expect(f?.rel).toBe('sub/c.md')
    expect(f?.name).toBe('c.md')
  })

  it('主进程版：绝对路径在工作区外 → null', () => {
    const f = resolveProducedFile(
      'write_file',
      JSON.stringify({ path: join(outside, 'evil.txt') }),
      root
    )
    expect(f).toBeNull()
  })

  it('主进程版：没工作区 → null', () => {
    expect(resolveProducedFile('write_file', '{"path":"a.ts"}', null)).toBeNull()
  })

  it('download_file 用 dest 键也能识别', () => {
    const f = resolveProducedFile('download_file', '{"dest":"files/x.zip"}', root)
    expect(f?.name).toBe('x.zip')
    expect(f?.action).toBe('已下载')
  })
})

describe('Git 面板解析（v15）', () => {
  it('porcelain 单条：普通修改', () => {
    expect(parsePorcelainEntry(' M src/a.ts')).toEqual({ code: ' M', rel: 'src/a.ts' })
  })

  it('porcelain 单条：未跟踪与删除', () => {
    expect(parsePorcelainEntry('?? new-file.md')).toEqual({ code: '??', rel: 'new-file.md' })
    expect(parsePorcelainEntry('D  old.txt')).toEqual({ code: 'D ', rel: 'old.txt' })
  })

  it('porcelain：重命名 -> 形式取新名', () => {
    const ch = parsePorcelainEntry('R  new-name.ts -> old-name.ts')
    expect(ch?.rel).toBe('old-name.ts')
  })

  it('porcelain：中文文件名原样保留（quotepath=false）', () => {
    const ch = parsePorcelainEntry(' M notes/南京天气.md')
    expect(ch?.rel).toBe('notes/南京天气.md')
  })

  it('脏数据/空串 → null', () => {
    expect(parsePorcelainEntry('')).toBeNull()
    expect(parsePorcelainEntry('ab')).toBeNull()
    expect(parsePorcelainEntry('M  ')).toBeNull()
  })
})

describe('fileRefFromCall（v16d 过程文件行：读写类都给引用）', () => {
  it('read_file → 动作标签=读取，rel 归一化', () => {
    const ref = fileRefFromCall('read_file', '{"path":"notes/天气.md"}')
    expect(ref).toEqual({ rel: 'notes/天气.md', name: '天气.md', action: '读取' })
  })

  it('write_file → 沿用产出动作（已写入）', () => {
    const ref = fileRefFromCall('write_file', '{"path":"a/b.ts"}')
    expect(ref?.action).toBe('已写入')
  })

  it('非文件类工具 → null', () => {
    expect(fileRefFromCall('search_files', '{"query":"x"}')).toBeNull()
    expect(fileRefFromCall('todo_write', '{}')).toBeNull()
  })

  it('绝对路径在工作区内 → 换算 rel；区外 → null', () => {
    const root = 'E:/ws'
    expect(fileRefFromCall('read_file', '{"path":"E:/ws/x/y.md"}', root)?.rel).toBe('x/y.md')
    expect(fileRefFromCall('read_file', '{"path":"E:/other/y.md"}', root)).toBeNull()
  })

  it('producedFileFromCall 不受读取类影响（回复末尾卡片只认产出）', () => {
    expect(producedFileFromCall('read_file', '{"path":"a.md"}')).toBeNull()
  })
})

describe('diff 徽标（同款口径）', () => {
  it('新建文件：全部计新增', () => {
    expect(countLineDiff(null, 'a\nb\nc')).toEqual({ added: 3, removed: 0 })
  })

  it('局部修改：同名行互抵，只算真实增删', () => {
    const oldText = 'const a = 1\nconst b = 2\nconst c = 3'
    const newText = 'const a = 1\nconst b = 22\nconst c = 3\nconst d = 4'
    expect(countLineDiff(oldText, newText)).toEqual({ added: 2, removed: 1 })
  })

  it('纯重排（行集合不变）→ +0 -0（可接受近似）', () => {
    expect(countLineDiff('a\nb', 'b\na')).toEqual({ added: 0, removed: 0 })
  })

  it('edit_file 参数 → 精确累加（历史重建）', () => {
    const args = JSON.stringify({
      path: 'a.ts',
      edits: [
        { old_string: 'x\ny', new_string: 'x2' },
        { old_string: 'z', new_string: 'z1\nz2\nz3' }
      ]
    })
    expect(diffFromToolArgs('edit_file', args)).toEqual({ added: 4, removed: 3 })
  })

  it('write_file 历史：旧内容不可得，只报新增行数', () => {
    expect(
      diffFromToolArgs('write_file', JSON.stringify({ path: 'a', content: '1\n2\n3' }))
    ).toEqual({
      added: 3,
      removed: 0
    })
    expect(diffFromToolArgs('read_file', '{"path":"a"}')).toBeNull()
  })
})
