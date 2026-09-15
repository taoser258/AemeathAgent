// 工作区辅助单测：learn vault 初始化的幂等与防御。

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { ensureLearnVault } from '../src/main/agent/workspace'

function tempDir(name: string): string {
  const dir = join(
    tmpdir(),
    `aemeath-vault-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('agent/workspace · ensureLearnVault', () => {
  it('空目录 → 初始化 notes/index.md；重复执行不动已有内容（幂等不报错）', () => {
    const dir = tempDir('empty')
    const first = ensureLearnVault(dir)
    expect(first.initialized).toBe(true)
    expect(existsSync(join(dir, 'notes', 'index.md'))).toBe(true)

    const second = ensureLearnVault(dir)
    expect(second.initialized).toBe(false) // 非空 → 保持原样
    expect(second.message).toContain('非空')
    rmSync(dir, { recursive: true, force: true })
  })

  it('目录不存在 → 不静默建目录，给可读结论', () => {
    const result = ensureLearnVault(join(tmpdir(), `aemeath-missing-${Date.now()}`))
    expect(result.initialized).toBe(false)
    expect(result.message).toContain('不存在')
  })

  it('非空目录 → 保持原样（绝不覆盖用户已有内容）', () => {
    const dir = tempDir('occupied')
    writeFileSync(join(dir, '已有文件.txt'), '用户内容', 'utf8')
    const result = ensureLearnVault(dir)
    expect(result.initialized).toBe(false)
    expect(existsSync(join(dir, 'notes'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})
