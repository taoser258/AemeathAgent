// 审批 diff 单测：自研 LCS unified diff + buildApprovalDetail 防御。
// 覆盖：增/删/改/无变化/超长截断/上下文行；write_file 存在与否分支、坏参数防御。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApprovalDetail, unifiedDiff } from '../src/main/agent/tools/diff'
import { setToolPathBase } from '../src/main/agent/tools/registry'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aemeath-diff-'))
  setToolPathBase(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('unifiedDiff（自研 LCS）', () => {
  it('相同文本返回空串', () => {
    expect(unifiedDiff('a\nb', 'a\nb')).toBe('')
  })

  it('纯新增：hunk 含 + 行与上下文，行计数正确', () => {
    const d = unifiedDiff('a\nb', 'a\nb\nc')
    expect(d).toContain('+ c')
    expect(d).toContain('  a')
    expect(d).toMatch(/@@ -1,2 \+1,3 @@/)
  })

  it('纯删除：hunk 含 - 行', () => {
    const d = unifiedDiff('a\nb\nc', 'a\nc')
    expect(d).toContain('- b')
    expect(d).not.toContain('+ ')
    expect(d).toMatch(/@@ -1,3 \+1,2 @@/)
  })

  it('修改：- 旧 + 新相邻成对', () => {
    const d = unifiedDiff('hello\nworld', 'hello\nworld!')
    expect(d).toContain('- world')
    expect(d).toContain('+ world!')
  })

  it('空原文 → 全部为新增；新空文本 → 全部为删除', () => {
    expect(
      unifiedDiff('', 'x\ny')
        .split('\n')
        .filter((l) => l.startsWith('+'))
    ).toHaveLength(2)
    expect(
      unifiedDiff('x\ny', '')
        .split('\n')
        .filter((l) => l.startsWith('-'))
    ).toHaveLength(2)
  })

  it('超长文本：放弃精细 diff 给提示（防 O(n*m) 爆内存）', () => {
    const big = Array.from({ length: 2500 }, (_, i) => `line-${i}`).join('\n')
    const d = unifiedDiff(big, `${big}\nextra`)
    expect(d).toContain('diff 省略')
  })
})

describe('buildApprovalDetail（审批载荷增强）', () => {
  it('write_file 改既有文件 → diff 含 - 旧 + 新', () => {
    writeFileSync(join(root, 'f.txt'), 'old\n', 'utf8')
    const d = buildApprovalDetail('write_file', JSON.stringify({ path: 'f.txt', content: 'new\n' }))
    expect(d.diff).toBeTruthy()
    expect(d.diff).toContain('- old')
    expect(d.diff).toContain('+ new')
    expect(d.preview).toBeUndefined()
  })

  it('write_file 新建文件 → preview 全文（旧路径无 diff）', () => {
    const d = buildApprovalDetail('write_file', JSON.stringify({ path: 'g.txt', content: 'hello' }))
    expect(d.preview).toBe('hello')
    expect(d.diff).toBeUndefined()
  })

  it('新建预览超长截断并注明总字符数', () => {
    const long = 'x'.repeat(2500)
    const d = buildApprovalDetail('write_file', JSON.stringify({ path: 'big.txt', content: long }))
    expect(d.preview).toContain('…[预览已截断，共 2500 字符]')
    expect((d.preview ?? '').length).toBeLessThan(2600)
  })

  it('内容无变化 → 空对象（不弹无意义的 diff）', () => {
    writeFileSync(join(root, 'same.txt'), 'same', 'utf8')
    const d = buildApprovalDetail(
      'write_file',
      JSON.stringify({ path: 'same.txt', content: 'same' })
    )
    expect(d).toEqual({})
  })

  it('非 write_file / 坏 JSON / 缺字段 → 空对象（绝不挡审批）', () => {
    expect(buildApprovalDetail('read_file', '{}')).toEqual({})
    expect(buildApprovalDetail('write_file', '{oops')).toEqual({})
    expect(buildApprovalDetail('write_file', JSON.stringify({ path: 'x' }))).toEqual({})
  })

  it('相对路径按注入基准解析（与工具执行同一基准）', () => {
    mkdirSync(join(root, 'nested'), { recursive: true })
    writeFileSync(join(root, 'nested', 'n.txt'), 'v1', 'utf8')
    const d = buildApprovalDetail(
      'write_file',
      JSON.stringify({ path: 'nested/n.txt', content: 'v2' })
    )
    expect(d.diff).toContain('- v1')
  })
})
