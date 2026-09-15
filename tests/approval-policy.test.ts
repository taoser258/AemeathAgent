// 审批判定单测。
//
// 这是安全语义的核心判定，因此覆盖重点在"边界"上：
// 路径包含关系（前缀陷阱）、未绑定工作区的 fail-closed、MCP 不进审批、豁免工具。

import { describe, expect, it } from 'vitest'
import { decideToolApproval, isPathInside } from '../src/main/chat/approval-policy'

describe('approval-policy · isPathInside（路径包含判定）', () => {
  it('自身算在内部', () => {
    expect(isPathInside('E:\\proj', 'E:\\proj')).toBe(true)
    expect(isPathInside('E:\\proj\\a.txt', 'E:\\proj')).toBe(true)
    expect(isPathInside('E:\\proj\\sub\\deep\\a.txt', 'E:\\proj')).toBe(true)
  })

  it('★ 前缀陷阱：E:\\proj2 不在 E:\\proj 之内（不能用 startsWith 判定）', () => {
    expect(isPathInside('E:\\proj2', 'E:\\proj')).toBe(false)
    expect(isPathInside('E:\\proj2\\a.txt', 'E:\\proj')).toBe(false)
    expect(isPathInside('E:\\project-x\\a.txt', 'E:\\proj')).toBe(false)
  })

  it('父目录与同盘其它位置都在外部', () => {
    expect(isPathInside('E:\\', 'E:\\proj')).toBe(false)
    expect(isPathInside('E:\\other\\a.txt', 'E:\\proj')).toBe(false)
  })

  it('跨盘在外部', () => {
    expect(isPathInside('D:\\proj\\a.txt', 'E:\\proj')).toBe(false)
  })

  it('★ 用 .. 绕出去的要判为外部（规范化后判定）', () => {
    expect(isPathInside('E:\\proj\\..\\outside\\a.txt', 'E:\\proj')).toBe(false)
    expect(isPathInside('E:\\proj\\sub\\..\\a.txt', 'E:\\proj')).toBe(true)
  })

  it('Windows 下大小写不敏感（同一目录的大小写变体算内部）', () => {
    // win32 的 path.relative 本身忽略大小写；这条防的是将来换成字符串比较
    expect(isPathInside('E:\\PROJ\\a.txt', 'e:\\proj')).toBe(true)
  })
})

describe('approval-policy · decideToolApproval', () => {
  const WS = 'E:\\proj'
  const base = {
    toolName: 'write_file',
    mutating: true,
    targetPath: 'E:\\proj\\a.md',
    workspace: WS
  }

  it('只读工具：任何情况都不问（权限只管变更）', () => {
    expect(
      decideToolApproval({ ...base, mutating: false, targetPath: 'D:\\x', workspace: null })
    ).toEqual({ required: false })
  })

  it('★ MCP 工具完全不进审批', () => {
    // 即使它被标成变更类、目标在工作区外、甚至没绑工作区 —— 都不问
    expect(
      decideToolApproval({
        toolName: 'mcp__browser__browser_navigate',
        mutating: true,
        targetPath: null,
        workspace: null
      })
    ).toEqual({ required: false })
    expect(
      decideToolApproval({
        toolName: 'mcp__fs__write_file',
        mutating: true,
        targetPath: 'D:\\outside',
        workspace: WS
      })
    ).toEqual({ required: false })
  })

  it('豁免工具（撤销上一步）不问：它是恢复路径，不该被安全机制拦住', () => {
    expect(
      decideToolApproval({ ...base, toolName: 'undo_last_change', targetPath: null, exempt: true })
    ).toEqual({ required: false })
  })

  it('★ 工作区内的变更直接执行（等价 成熟实现的 workspace-write 沙箱内）', () => {
    expect(decideToolApproval(base)).toEqual({ required: false })
    expect(decideToolApproval({ ...base, targetPath: 'E:\\proj\\sub\\b.txt' })).toEqual({
      required: false
    })
  })

  it('★ 越界写入要问，且 reason 里带上目标路径与工作区', () => {
    const need = decideToolApproval({ ...base, targetPath: 'D:\\outside\\a.txt' })
    expect(need.required).toBe(true)
    expect(need.reason).toContain('D:\\outside\\a.txt')
    expect(need.reason).toContain(WS)
  })

  it('★ 未绑定工作区 → 问（无边界可判越界，fail-closed），且 reason 教用户怎么免问', () => {
    const need = decideToolApproval({ ...base, workspace: null })
    expect(need.required).toBe(true)
    expect(need.reason).toContain('绑定')
  })

  it('空白工作区串视为未绑定（脏配置不放开边界）', () => {
    expect(decideToolApproval({ ...base, workspace: '   ' }).required).toBe(true)
  })

  it('变更类但拿不到目标路径 → 问（fail-closed，宁可多问一次）', () => {
    const need = decideToolApproval({ ...base, targetPath: null })
    expect(need.required).toBe(true)
    expect(need.reason).toContain('路径')
  })

  it('reason 一律不写空话：必须含可操作信息', () => {
    const cases = [
      decideToolApproval({ ...base, targetPath: 'D:\\x' }),
      decideToolApproval({ ...base, workspace: null }),
      decideToolApproval({ ...base, targetPath: null })
    ]
    for (const need of cases) {
      expect(need.required).toBe(true)
      expect(need.reason).toBeTruthy()
      expect((need.reason ?? '').length).toBeGreaterThan(10)
    }
  })
})
