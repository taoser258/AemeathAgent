// 内置 MCP 自愈同步的接线层。
// 与 builtin.ts 分开的原因：builtin.ts 是纯函数（可单测），这里要碰 electron（路径）与磁盘。
//
// 事实源是 **持久化配置**，不是运行时连接状态。启动时调用一次：
// - 缺失的内置项补上（默认关）
// - 命令/参数过期的（应用升级、安装位置变化）就地校正
// - 已下架的内置项清理
// - 用户主动删过的（removedBuiltins）不再补
// 用户自配的 server 一律不动。

import { join } from 'path'
import { configDir, logsDir, userDataDir } from '../paths'
import { appendDebugLog } from '../log'
import { readAppConfig, writeAppConfig } from '../settings/app-config'
import { ensureBuiltinServers, type BuiltinContext } from './builtin'

/** 浏览器产出的产物目录：放 userData 下，避免污染工作目录 */
function builtinContext(): BuiltinContext {
  return { outputDir: join(userDataDir(), 'mcp-output', 'playwright') }
}

/**
 * 启动时同步内置 MCP 服务器。
 * 返回是否改动了配置（改了就写盘）。任何异常都吞掉并记日志——
 * 内置项出问题不该让应用起不来。
 */
export function syncBuiltinServers(): boolean {
  try {
    const config = readAppConfig(configDir())
    const removed = config.mcp.removedBuiltins ?? []
    const { servers, changed } = ensureBuiltinServers(config.mcp.servers, removed, builtinContext())
    if (!changed) return false
    writeAppConfig(configDir(), { ...config, mcp: { ...config.mcp, servers } })
    appendDebugLog(logsDir(), `[mcp] 内置服务器已按当前环境同步（共 ${servers.length} 条）`)
    return true
  } catch (err) {
    appendDebugLog(
      logsDir(),
      `[mcp] 内置服务器同步失败（忽略）：${err instanceof Error ? err.message : String(err)}`
    )
    return false
  }
}

/**
 * 把某个内置项从"已删除"名单里移回并立即补齐（设置页「恢复」按钮用）。
 * 返回 true 表示确实做了恢复。恢复后仍需由调用方触发 mcpManager.sync。
 */
export function restoreBuiltinServer(key: string): boolean {
  try {
    const config = readAppConfig(configDir())
    const removed = (config.mcp.removedBuiltins ?? []).filter((k) => k !== key)
    if (removed.length === (config.mcp.removedBuiltins ?? []).length) return false
    const { servers } = ensureBuiltinServers(config.mcp.servers, removed, builtinContext())
    const next: typeof config = { ...config, mcp: { ...config.mcp, servers } }
    // 名单清空就删字段（保持配置干净，也让"没有删过任何内置项"有唯一表示）
    if (removed.length > 0) next.mcp.removedBuiltins = removed
    else delete next.mcp.removedBuiltins
    writeAppConfig(configDir(), next)
    appendDebugLog(logsDir(), `[mcp] 已恢复内置服务器：${key}`)
    return true
  } catch (err) {
    appendDebugLog(
      logsDir(),
      `[mcp] 恢复内置服务器失败：${err instanceof Error ? err.message : String(err)}`
    )
    return false
  }
}
