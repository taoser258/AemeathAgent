// MCPManager 集成单测：用真实 echo server 夹具验证连接/清单/调用/崩溃隔离。
// 这是真实 MCP 协议集成测试（stdio 子进程），不是 mock。
// 扩展：annotations.readOnlyHint → 工具只读分级（对齐 CodeBuddy 语义「只读放行，非只读才问」）。

import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { mcpManager } from '../src/main/mcp/manager'
import { isMutatingTool } from '../src/main/agent/tools/registry'

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'mcp-echo-server.mjs')
const CFG = {
  id: 'echo-test',
  name: 'Echo 夹具',
  command: process.execPath,
  args: [FIXTURE],
  enabled: true
}

describe('mcpManager', () => {
  it('sync → 连接 + 工具清单（mcp__ 前缀）→ 调用成功', async () => {
    await mcpManager.sync([CFG])
    const tools = mcpManager.listTools()
    const echo = tools.find((t) => t.prefixedName === 'mcp__echo-test__echo')
    expect(echo).toBeTruthy()
    expect(echo?.serverName).toBe('Echo 夹具')

    const r = await mcpManager.callTool('echo-test', 'echo', JSON.stringify({ text: '你好 MCP' }))
    expect(r.ok).toBe(true)
    expect(r.result).toBe('echo: 你好 MCP')
    await mcpManager.sync([]) // 清场
  })

  it('注解元数据照旧暴露（readOnly/destructive），但已不用于审批门禁', async () => {
    await mcpManager.sync([CFG])
    const tools = mcpManager.listTools()
    // 注解仍从 server 透传出来：它进工具描述（帮模型判断怎么用），只是不再决定"要不要问用户"
    expect(tools.find((t) => t.prefixedName === 'mcp__echo-test__read_info')?.readOnly).toBe(true)
    expect(tools.find((t) => t.prefixedName === 'mcp__echo-test__echo')?.readOnly).toBe(false)
    // ★ （对齐成熟 Agent 的权限模型）：MCP 工具完全不进审批门禁
    expect(isMutatingTool('mcp__echo-test__read_info')).toBe(false)
    expect(isMutatingTool('mcp__echo-test__echo')).toBe(false)
    expect(isMutatingTool('mcp__no-such__tool')).toBe(false)
    // 门禁变化不影响执行正确性
    const r = await mcpManager.callTool('echo-test', 'read_info', '{}')
    expect(r.ok).toBe(true)
    expect(r.result).toContain('只读信息')
    await mcpManager.sync([]) // 清场
  })

  it('禁用/移除后工具消失；崩溃隔离：server 死后调用返回可读错误不抛异常', async () => {
    await mcpManager.sync([CFG])
    expect(mcpManager.listTools().length).toBeGreaterThan(0)
    // 禁用（enabled=false → sync 移除）
    await mcpManager.sync([{ ...CFG, enabled: false }])
    expect(mcpManager.listTools()).toHaveLength(0)
    // 已死 server 调用：可读错误，不抛
    const r = await mcpManager.callTool('echo-test', 'echo', JSON.stringify({ text: 'x' }))
    expect(r.ok).toBe(false)
    expect(r.result).toContain('不可用')
    await mcpManager.sync([])
  })

  it('启动失败隔离：不存在的命令 → 无工具、主进程无恙', async () => {
    await mcpManager.sync([
      {
        id: 'bad',
        name: '坏 server',
        command: 'definitely-not-exist-cmd-xyz',
        args: [],
        enabled: true
      }
    ])
    expect(mcpManager.listTools()).toHaveLength(0) // 启动失败的 server 工具不出现
    await mcpManager.sync([])
  })
})

// ── ：稳定性与权限补强（真实 stdio 集成） ──────────────────────────────
const FEATURES = join(process.cwd(), 'tests', 'fixtures', 'mcp-features-server.mjs')
const FEATURES_CFG = {
  id: 'feat',
  name: '特性夹具',
  serverName: 'feat',
  command: process.execPath,
  args: [FEATURES],
  enabled: true
}

/** 轮询等待条件成立（自动重连/热更新都是异步的，没法用固定 sleep 精确断言） */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 6000,
  intervalMs = 100
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return predicate()
}

describe('mcpManager ·  稳定性', () => {
  it('env 真的传给了子进程', async () => {
    await mcpManager.sync([{ ...FEATURES_CFG, env: { AEMEATH_TEST_VAR: 'hello-mcp' } }])
    const r = await mcpManager.callTool(
      'feat',
      'report_env',
      JSON.stringify({ name: 'AEMEATH_TEST_VAR' })
    )
    expect(r.ok).toBe(true)
    expect(r.result).toContain('hello-mcp')
    await mcpManager.sync([])
  })

  it('★ 注解自相矛盾（readOnly + destructive 同时为真）不再影响门禁；元数据仍如实透传', async () => {
    await mcpManager.sync([FEATURES_CFG])
    const tools = mcpManager.listTools()
    const danger = tools.find((t) => t.prefixedName === 'mcp__feat__danger')
    expect(danger?.readOnly).toBe(true) // server 自报只读
    expect(danger?.destructive).toBe(true) // 但也自报破坏性
    // 曾按 destructive 升级为"要审批"； 改为一律不问。
    // 注解本身仍如实保留在工具视图里（进描述供模型参考），只是不再当门禁用。
    expect(isMutatingTool('mcp__feat__danger')).toBe(false)
    expect(isMutatingTool('mcp__feat__read_info')).toBe(false)
    // 执行链路不受影响
    const r = await mcpManager.callTool('feat', 'danger', '{}')
    expect(r.ok).toBe(true)
    await mcpManager.sync([])
  })

  it('★ ：连上过的 server 崩溃后自动重连并恢复工具', async () => {
    await mcpManager.sync([FEATURES_CFG])
    expect(mcpManager.listTools().some((t) => t.name === 'crash')).toBe(true)

    // 触发崩溃
    await mcpManager.callTool('feat', 'crash', '{}')
    // 崩溃后工具应当消失（进程死了）
    const gone = await waitFor(() => !mcpManager.listTools().some((t) => t.name === 'crash'), 3000)
    expect(gone).toBe(true)

    // 退避首次 1s → 应在数秒内自动恢复
    const back = await waitFor(() => mcpManager.listTools().some((t) => t.name === 'crash'), 8000)
    expect(back).toBe(true)
    await mcpManager.sync([])
  })

  it('★ ：首次就连不上的 server 不会被反复重连（避免无意义地反复起失败进程）', async () => {
    await mcpManager.sync([
      {
        id: 'never',
        name: '起不来的',
        command: 'definitely-not-exist-cmd-xyz',
        args: [],
        enabled: true
      }
    ])
    // 立刻与稍后都应保持"无工具"，且不应出现连接尝试带来的工具
    expect(mcpManager.listTools()).toHaveLength(0)
    await new Promise((r) => setTimeout(r, 1500))
    expect(mcpManager.listTools()).toHaveLength(0)
    await mcpManager.sync([])
  })

  it('★ ：tools/list_changed 后新工具进入清单（热更新）', async () => {
    await mcpManager.sync([FEATURES_CFG])
    expect(mcpManager.listTools().some((t) => t.name === 'dynamic_tool')).toBe(false)

    const r = await mcpManager.callTool('feat', 'add_dynamic', '{}')
    expect(r.ok).toBe(true)

    // 通知 → 防抖 300ms → 重新 listTools
    const appeared = await waitFor(
      () => mcpManager.listTools().some((t) => t.name === 'dynamic_tool'),
      5000
    )
    expect(appeared).toBe(true)
    await mcpManager.sync([])
  })

  it('工具级错误（isError）不把连接标记为不可用（否则会误判掉线并触发重连）', async () => {
    await mcpManager.sync([FEATURES_CFG])
    const r = await mcpManager.callTool('feat', 'no_such_tool', '{}')
    expect(r.ok).toBe(false)
    // 连接仍健康：工具清单还在、后续调用仍可用
    expect(mcpManager.listTools().some((t) => t.name === 'read_info')).toBe(true)
    const ok = await mcpManager.callTool('feat', 'read_info', '{}')
    expect(ok.ok).toBe(true)
    await mcpManager.sync([])
  })

  it('：stopAll 后子进程确实退出（不留孤儿）', async () => {
    await mcpManager.sync([FEATURES_CFG])
    expect(mcpManager.listTools().length).toBeGreaterThan(0)
    await mcpManager.stopAll()
    expect(mcpManager.listTools()).toHaveLength(0)
    // 停用后调用返回可读错误（而不是抛异常）
    const r = await mcpManager.callTool('feat', 'read_info', '{}')
    expect(r.ok).toBe(false)
    expect(r.result).toContain('不可用')
  })

  it('★ 重连窗口期内被停用 → 不许"偷偷复活"（回归：异步写回曾无条件覆盖）', async () => {
    await mcpManager.sync([FEATURES_CFG])
    expect(mcpManager.listTools().some((t) => t.name === 'crash')).toBe(true)

    // 触发崩溃，进入重连退避窗口（首次退避 1s）
    await mcpManager.callTool('feat', 'crash', '{}')
    // 立刻停用该 server —— 此时重连还没跑完/还没开始
    await mcpManager.sync([{ ...FEATURES_CFG, enabled: false }])
    expect(mcpManager.listTools()).toHaveLength(0)

    // 等过整个退避窗口：不该有任何连接被写回
    await new Promise((r) => setTimeout(r, 2500))
    expect(mcpManager.listTools()).toHaveLength(0)
    await mcpManager.sync([])
  })
})
