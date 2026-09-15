// MCP 测试连接：按一份**未保存的**配置临时连一次，列出工具后立刻断开。
// 为什么不复用 mcpManager：用户点"测试连接"时配置往往还没保存（甚至故意保留坏的配置），
// 若走管理器就会真的启停已连接的 server，把"试一下"变成"改了运行时状态"。
// 这里用完即关，对运行中的连接零影响。

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpTestResult } from '@shared/types'
import { effectiveNamespace } from '@shared/mcp-presets'
import {
  missingSecretRefs,
  resolveEnvValues,
  type McpEnvResolver,
  type McpServerConfig
} from './env'
import { killProcessTree } from './process-tree'

/** 测试连接的超时：比正常握手更短——用户在等，不能卡 15 秒 */
const TEST_TIMEOUT_MS = 12_000
/** 工具名最多回报几条（给用户"看到了什么"的直观感受，不是给机器解析） */
const MAX_TOOL_NAMES = 12

/** 把底层错误翻译成用户能照做的中文提示 */
function readableError(raw: string, missing: string[]): string {
  if (/ENOENT|not recognized|不是内部或外部命令/i.test(raw)) {
    return '找不到命令。请确认命令名正确，且该命令已安装（npx / node / uvx 等需要在 PATH 里）。'
  }
  if (/超时|timeout/i.test(raw)) {
    return '连接超时。常见原因：首次运行需要联网下载这个 server（npx 会现装），或命令写错导致进程卡住。'
  }
  if (missing.length > 0) {
    return `缺少密钥：${missing.join('、')}。请在下方"环境变量密钥"里填入并保存后再测试。`
  }
  if (/401|403|unauthorized|forbidden|bad credentials/i.test(raw)) {
    return '认证失败。密钥可能填错或已过期，请重新填写。'
  }
  if (/EACCES|EPERM/i.test(raw)) {
    return '权限不足。换个目录作为工作目录，或用管理员身份运行应用后重试。'
  }
  return `连接失败：${raw}`
}

export async function testMcpServer(
  cfg: McpServerConfig,
  resolver: McpEnvResolver
): Promise<McpTestResult> {
  const namespace = effectiveNamespace(cfg)
  const missing = missingSecretRefs(cfg, namespace, resolver)
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    ...(Object.keys(resolveEnvValues(cfg, namespace, resolver)).length > 0
      ? { env: resolveEnvValues(cfg, namespace, resolver) }
      : {}),
    ...(cfg.cwd !== undefined && cfg.cwd.trim() !== '' ? { cwd: cfg.cwd.trim() } : {})
  })
  const client = new Client({ name: 'aemeath-agent', version: '0.1.0' })
  const timeout = (label: string): Promise<never> =>
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}超时`)), TEST_TIMEOUT_MS))
  try {
    await Promise.race([client.connect(transport), timeout('连接')])
    const listed = await Promise.race([client.listTools(), timeout('获取工具清单')])
    const names = listed.tools.map((t) => t.name)
    return {
      ok: true,
      namespace,
      toolCount: names.length,
      toolNames: names.slice(0, MAX_TOOL_NAMES),
      // 工具数为 0 仍算连接成功，但要把"缺密钥"的话说出来，否则用户会以为工具消失了
      ...(missing.length > 0
        ? { error: `已连接，但缺少密钥：${missing.join('、')}——部分工具可能不可用。` }
        : {})
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    return { ok: false, namespace, error: readableError(raw, missing) }
  } finally {
    // 无论成败都要关干净：
    // 1) client.close() 关掉协议层与直接子进程
    // 2) killProcessTree 收拾孙进程——npx（以及 Playwright 拉起的浏览器）都会产生孙进程，
    // SDK 的 close 只 kill 直接子进程（见 process-tree.ts 注释）。
    // 不收拾的话每点一次「测试连接」都会在任务管理器里多留一堆 node / msedge。
    const pid = transport.pid
    try {
      await client.close()
    } catch {
      /* 已死或未连上：忽略 */
    }
    if (pid !== null) killProcessTree(pid)
  }
}
