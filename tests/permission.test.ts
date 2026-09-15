// 权限门禁单测（chat/permission.ts）：三模式决策 + allow-always 会话记忆。
//
// ★ 重做权限模型后，语义变化很大，测试随之改写：
// confirm 不再"变更类一律询问"，而是**按是否越出工作区**判定
// （工作区内直放 / 越界才问 / MCP 完全不进门禁）。判定细节在 approval-policy.test.ts。
//
// registry 经 vi.mock 注入：registry 本身依赖 mcpManager 等运行时，单测只关心判定链路。

import { beforeEach, describe, expect, it, vi } from 'vitest'

/** 简化的工作区串（用 / 便于断言；判定逻辑本身在 approval-policy 测） */
const WS = '/ws'

vi.mock('../src/main/agent/tools/registry', () => ({
  // 变更类：write_file / send_email；MCP 工具**不是**变更类（新语义）
  isMutatingTool: (name: string): boolean => name === 'write_file' || name === 'send_email',
  // 目标路径解析：write_file 取 args.path；绝对路径原样、相对路径拼工作区；无工作区则无法解析
  approvalTargetPath: (name: string, argsJson: string, workspace: string | null): string | null => {
    if (name !== 'write_file') return null
    let raw = 'a.txt'
    try {
      raw = String((JSON.parse(argsJson) as { path?: string }).path ?? 'a.txt')
    } catch {
      /* 保持默认 */
    }
    if (raw.startsWith('/')) return raw
    return workspace === null ? null : `${workspace}/${raw}`
  },
  // 撤销上一步：显式豁免
  isApprovalExempt: (name: string): boolean => name === 'undo_last_change',
  // run_shell 命令分类（门禁与执行共用口径）：这里给三态各一个代表命令
  classifyShellCommand: (command: string): 'blocked' | 'allowed' | 'ask' => {
    if (/^(rm|del|format)\b/.test(command)) return 'blocked'
    if (/^git status\b/.test(command)) return 'allowed'
    return 'ask'
  }
}))

import {
  allowSessionTool,
  clearSessionAllowedTools,
  createToolGate,
  isSessionToolAllowed,
  setPermissionMode,
  type GateContext
} from '../src/main/chat/permission'
import type { ToolCallDraft } from '../src/main/llm/client'

function tc(id: string, name: string, argsJson = '{}'): ToolCallDraft {
  return { id, name, argsJson }
}

type Decision = 'allow' | 'allow-always' | 'deny'

/** 已绑定工作区的门禁上下文 */
const BOUND: GateContext = { workspace: WS }
/** 未绑定工作区 */
const UNBOUND: GateContext = { workspace: null }

/** mock 审批入口：记录每次询问（kind + 工具名 + reason），按脚本逐次给决策 */
function makeAsker(decisions: Decision[]): {
  ask: (kind: 'tool' | 'plan', calls: ToolCallDraft[], reason?: string) => Promise<Decision>
  asked: Array<{ kind: 'tool' | 'plan'; names: string[]; reason?: string }>
} {
  const asked: Array<{ kind: 'tool' | 'plan'; names: string[]; reason?: string }> = []
  const ask = vi.fn(
    async (kind: 'tool' | 'plan', calls: ToolCallDraft[], reason?: string): Promise<Decision> => {
      asked.push({ kind, names: calls.map((c) => c.name), ...(reason ? { reason } : {}) })
      return decisions[Math.min(asked.length - 1, decisions.length - 1)]
    }
  )
  return { ask, asked }
}

beforeEach(() => {
  clearSessionAllowedTools()
})

describe('createToolGate · full 模式', () => {
  // full 不再"提前返回空 gate"——那样"从 full 切回
  // confirm"在本次 run 里就永远不再拦（方向性失效）。现在钩子恒挂、内部按当前模式放行，
  // 所以断言改成"**调用也不问**"，而不是"钩子不存在"。
  it('所有工具直接放行，不发起任何询问', async () => {
    const { ask, asked } = makeAsker([])
    const gate = createToolGate('full', 's1', ask)
    expect(await gate.beforeTool?.(tc('c1', 'write_file', '{"path":"a.txt","content":"x"}'))).toBe(
      'allow'
    )
    expect(await gate.beforeTool?.(tc('c2', 'run_shell', '{"command":"dir /s /b E:\\\\x"}'))).toBe(
      'allow'
    )
    expect(asked).toHaveLength(0)
  })

  it('★ 运行中从 confirm 切到 full：剩余调用立即不再询问', async () => {
    // 模拟生产接线（index.ts / settings-ipc.ts 写入 liveMode）；用 finally 复原，避免串台
    const { ask, asked } = makeAsker(['deny'])
    setPermissionMode('confirm')
    try {
      const gate = createToolGate('confirm', 's1', ask, BOUND)
      // 越界写入 → confirm 下要问
      await gate.beforeTool?.(tc('c1', 'write_file', '{"path":"/outside/a.txt"}'))
      expect(asked).toHaveLength(1)
      // 用户在弹卡期间切到「完全访问」→ 剩下的调用立即放行，不再弹第二张
      setPermissionMode('full')
      expect(await gate.beforeTool?.(tc('c2', 'write_file', '{"path":"/outside/b.txt"}'))).toBe(
        'allow'
      )
      expect(asked).toHaveLength(1)
    } finally {
      setPermissionMode('confirm')
    }
  })

  it('★ plan 档运行中切到 full：不再弹计划卡', async () => {
    const { ask, asked } = makeAsker(['deny'])
    setPermissionMode('full')
    try {
      const gate = createToolGate('plan', 's1', ask, BOUND)
      const verdict = await gate.beforeRound?.([tc('c1', 'write_file', '{"path":"/ws/a.txt"}')])
      expect(verdict).toBe('go')
      expect(asked).toHaveLength(0)
    } finally {
      setPermissionMode('confirm')
    }
  })
})

describe('createToolGate · confirm 模式（按是否越界判定）', () => {
  it('只读工具直接 allow，不询问', async () => {
    const { ask, asked } = makeAsker([])
    const gate = createToolGate('confirm', 's1', ask, BOUND)
    const verdict = await gate.beforeTool?.(tc('c1', 'read_file', '{"path":"a.txt"}'))
    expect(verdict).toBe('allow')
    expect(asked).toHaveLength(0)
  })

  it('★ 工作区内的写入直接 allow，不询问（对齐 成熟实现的 workspace-write 沙箱内）', async () => {
    const { ask, asked } = makeAsker([])
    const gate = createToolGate('confirm', 's1', ask, BOUND)
    const verdict = await gate.beforeTool?.(tc('c1', 'write_file', '{"path":"sub/a.md"}'))
    expect(verdict).toBe('allow')
    expect(asked).toHaveLength(0)
  })

  it('★ 越界写入要询问，并把 reason 透传给审批卡', async () => {
    const { ask, asked } = makeAsker(['allow'])
    const gate = createToolGate('confirm', 's1', ask, BOUND)
    const verdict = await gate.beforeTool?.(tc('c1', 'write_file', '{"path":"/outside/x.md"}'))
    expect(verdict).toBe('allow')
    expect(asked).toHaveLength(1)
    expect(asked[0].reason).toContain('/outside/x.md')
  })

  it('★ 未绑定工作区 → 变更类一律询问（无边界可判越界，fail-closed）', async () => {
    const { ask, asked } = makeAsker(['allow', 'deny'])
    const gate = createToolGate('confirm', 's1', ask, UNBOUND)
    expect(await gate.beforeTool?.(tc('c1', 'write_file', '{"path":"a.txt"}'))).toBe('allow')
    expect(await gate.beforeTool?.(tc('c2', 'write_file', '{"path":"b.txt"}'))).toBe('deny')
    expect(asked).toHaveLength(2)
    expect(asked[0].reason).toContain('绑定')
  })

  it('★ MCP 工具完全不进门禁：工作区外、未绑定都不询问', async () => {
    const { ask, asked } = makeAsker([])
    const gate = createToolGate('confirm', 's1', ask, UNBOUND)
    expect(await gate.beforeTool?.(tc('c1', 'mcp__browser__browser_navigate', '{"url":"x"}'))).toBe(
      'allow'
    )
    expect(await gate.beforeTool?.(tc('c2', 'mcp__fs__write_file', '{"path":"/anywhere"}'))).toBe(
      'allow'
    )
    expect(asked).toHaveLength(0)
  })

  it('★ 撤销上一步不问：它是恢复路径，不该被安全机制拦住', async () => {
    const { ask, asked } = makeAsker([])
    const gate = createToolGate('confirm', 's1', ask, BOUND)
    expect(await gate.beforeTool?.(tc('c1', 'undo_last_change'))).toBe('allow')
    expect(asked).toHaveLength(0)
  })

  it('allow-always：越界写入首次询问后记入会话，同工具后续免询问', async () => {
    const { ask, asked } = makeAsker(['allow-always', 'deny'])
    const gate = createToolGate('confirm', 's1', ask, BOUND)
    expect(await gate.beforeTool?.(tc('c1', 'write_file', '{"path":"/out/a"}'))).toBe('allow')
    // 第二次同样是越界：记忆命中，不再询问
    expect(await gate.beforeTool?.(tc('c2', 'write_file', '{"path":"/out/b"}'))).toBe('allow')
    expect(asked).toHaveLength(1)
    expect(isSessionToolAllowed('s1', 'write_file')).toBe(true)
    // 其他工具不受影响
    expect(await gate.beforeTool?.(tc('c3', 'send_email'))).toBe('deny')
    expect(asked).toHaveLength(2)
  })

  it('单次 allow 不留记忆：下次越界仍会询问', async () => {
    const { ask, asked } = makeAsker(['allow', 'allow'])
    const gate = createToolGate('confirm', 's1', ask, BOUND)
    await gate.beforeTool?.(tc('c1', 'write_file', '{"path":"/out/a"}'))
    await gate.beforeTool?.(tc('c2', 'write_file', '{"path":"/out/b"}'))
    expect(asked).toHaveLength(2)
    expect(isSessionToolAllowed('s1', 'write_file')).toBe(false)
  })

  it('deny：裁决为 deny（循环侧回灌"用户拒绝"，不执行）', async () => {
    const { ask, asked } = makeAsker(['deny'])
    const gate = createToolGate('confirm', 's1', ask, BOUND)
    expect(await gate.beforeTool?.(tc('c1', 'write_file', '{"path":"/out/x"}'))).toBe('deny')
    expect(asked).toHaveLength(1)
  })

  it('会话隔离：s1 的 allow-always 不影响 s2；clearSessionAllowedTools 只清指定会话', async () => {
    const { ask: ask1 } = makeAsker(['allow-always'])
    const g1 = createToolGate('confirm', 's1', ask1, BOUND)
    expect(await g1.beforeTool?.(tc('c1', 'write_file', '{"path":"/out/x"}'))).toBe('allow')
    const { ask: ask2 } = makeAsker(['allow-always'])
    const g2 = createToolGate('confirm', 's2', ask2, BOUND)
    expect(await g2.beforeTool?.(tc('c2', 'write_file', '{"path":"/out/x"}'))).toBe('allow')
    expect(ask2).toHaveBeenCalledTimes(1) // s2 未继承 s1 的记忆

    clearSessionAllowedTools('s1')
    expect(isSessionToolAllowed('s1', 'write_file')).toBe(false)
    expect(isSessionToolAllowed('s2', 'write_file')).toBe(true)
  })

  it('默认不传上下文时按未绑定处理（调用方漏传不会静默放开边界）', async () => {
    const { ask, asked } = makeAsker(['allow'])
    const gate = createToolGate('confirm', 's1', ask)
    expect(await gate.beforeTool?.(tc('c1', 'write_file', '{"path":"a.txt"}'))).toBe('allow')
    expect(asked).toHaveLength(1)
  })
})

describe('createToolGate · plan 模式（计划确认）', () => {
  it('本轮全为只读调用：直接 go，不弹计划', async () => {
    const { ask, asked } = makeAsker([])
    const gate = createToolGate('plan', 's1', ask, BOUND)
    const verdict = await gate.beforeRound?.([tc('c1', 'read_file'), tc('c2', 'current_time')])
    expect(verdict).toBe('go')
    expect(asked).toHaveLength(0)
  })

  it('★ 本轮只有 MCP 工具：不弹计划（MCP 已不算变更类）', async () => {
    const { ask, asked } = makeAsker([])
    const gate = createToolGate('plan', 's1', ask, BOUND)
    const verdict = await gate.beforeRound?.([
      tc('c1', 'mcp__browser__browser_navigate'),
      tc('c2', 'mcp__browser__browser_snapshot')
    ])
    expect(verdict).toBe('go')
    expect(asked).toHaveLength(0)
  })

  it('含变更类：询问一次，allow 后本轮及后续轮全部 go（计划只确认一次）', async () => {
    const { ask, asked } = makeAsker(['allow'])
    const gate = createToolGate('plan', 's1', ask, BOUND)
    const calls = [tc('c1', 'read_file'), tc('c2', 'write_file', '{"path":"a.txt"}')]
    expect(await gate.beforeRound?.(calls)).toBe('go')
    expect(await gate.beforeRound?.(calls)).toBe('go')
    expect(asked).toHaveLength(1)
    expect(asked[0].kind).toBe('plan')
    expect(asked[0].names).toEqual(['read_file', 'write_file'])
  })

  it('★ plan 比 confirm 更严：工作区内的写入也要先看计划', async () => {
    const { ask, asked } = makeAsker(['allow'])
    const gate = createToolGate('plan', 's1', ask, BOUND)
    const verdict = await gate.beforeRound?.([tc('c1', 'write_file', '{"path":"inside.md"}')])
    expect(verdict).toBe('go')
    expect(asked).toHaveLength(1) // 若按 confirm 判定，工作区内本可不问
  })

  it('deny：本轮 block；后续含变更类的轮持续 block（不再询问）；全只读轮仍 go', async () => {
    const { ask, asked } = makeAsker(['deny'])
    const gate = createToolGate('plan', 's1', ask, BOUND)
    const mutating = [tc('c1', 'write_file', '{"path":"a.txt"}')]
    expect(await gate.beforeRound?.(mutating)).toBe('block')
    expect(await gate.beforeRound?.(mutating)).toBe('block')
    expect(asked).toHaveLength(1)
    expect(await gate.beforeRound?.([tc('c2', 'read_file')])).toBe('go')
    expect(asked).toHaveLength(1)
  })
})

describe('会话级允许记忆（基础 API）', () => {
  it('allowSessionTool 记录后 isSessionToolAllowed 命中；未记录不命中', () => {
    expect(isSessionToolAllowed('s9', 'write_file')).toBe(false)
    allowSessionTool('s9', 'write_file')
    expect(isSessionToolAllowed('s9', 'write_file')).toBe(true)
    expect(isSessionToolAllowed('s9', 'send_email')).toBe(false)
  })
})

// ── run_shell 特判────────────────────────────────────────────────
// 抓到：硬拦截命令此前也会弹审批卡（还带"批准也不会执行"的自相矛盾文案）——
// 语义应为「blocked 连问都不问，放行到执行层直接拒绝」。
describe('createToolGate · run_shell 特判', () => {
  it('白名单命令直放，不弹卡', async () => {
    const { ask, asked } = makeAsker([])
    const gate = createToolGate('confirm', 's1', ask, BOUND)
    expect(await gate.beforeTool?.(tc('c1', 'run_shell', '{"command":"git status"}'))).toBe('allow')
    expect(asked).toHaveLength(0)
  })

  it('硬拦截命令：放行到执行层（由工具自己回灌"被安全策略拒绝"），**不弹卡**', async () => {
    const { ask, asked } = makeAsker([])
    const gate = createToolGate('confirm', 's1', ask, BOUND)
    expect(await gate.beforeTool?.(tc('c2', 'run_shell', '{"command":"rm -rf x"}'))).toBe('allow')
    expect(asked).toHaveLength(0) // 核心断言：连问都不问
  })

  it('非白名单命令：弹卡；allow-always 只记住该条命令原文，其他命令仍弹卡', async () => {
    const { ask, asked } = makeAsker(['allow-always', 'deny'])
    const gate = createToolGate('confirm', 's2', ask, BOUND)
    expect(await gate.beforeTool?.(tc('c3', 'run_shell', '{"command":"npm install lodash"}'))).toBe(
      'allow'
    )
    expect(asked).toHaveLength(1)
    // 同一条命令原文：不再问（命中小表）
    expect(await gate.beforeTool?.(tc('c4', 'run_shell', '{"command":"npm install lodash"}'))).toBe(
      'allow'
    )
    expect(asked).toHaveLength(1)
    // 别的命令：还要问
    expect(await gate.beforeTool?.(tc('c5', 'run_shell', '{"command":"npm install vite"}'))).toBe(
      'deny'
    )
    expect(asked).toHaveLength(2)
  })
})
