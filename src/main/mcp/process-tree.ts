// 子进程树清理。
//
// 为什么需要它：MCP server 常配 `npx`。SDK 用 cross-spawn spawn 命令，在 Windows 上
// `npx` 会经 `npx.cmd` 起一个 cmd.exe，再由它拉起真正的 node 进程——即
// Aemeath.exe → cmd.exe(npx.cmd) → node.exe(真正的 MCP server)
// 而 SDK 的 transport.close() 只对**直接子进程** kill('SIGTERM')（源码：
// @modelcontextprotocol/sdk/dist/cjs/client/stdio.js 的 close()）。
// 结果：cmd.exe 死了，孙进程 node.exe 成了孤儿——应用退出后任务管理器里残留一堆 node。
//
// 修法：Windows 上按 pid 整树终结（taskkill /T）。非 Windows 平台不处理：
// POSIX 下父进程退出后子进程会收到 SIGHUP，且进程组语义与 Windows 不同，不在这里猜。

import { spawnSync } from 'child_process'

/** taskkill 超时：它本身很快，给 5s 足够；卡住也不能拖住应用退出 */
const TASKKILL_TIMEOUT_MS = 5000

/**
 * 终结以 pid 为根的整个进程树。
 *
 * 失败一律静默——这个函数的调用点都是"清理收尾"，清理失败不应让应用报错，
 * 更不该阻塞退出。返回是否成功仅用于测试与日志。
 */
export function killProcessTree(pid: number): boolean {
  if (process.platform !== 'win32') return false
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      timeout: TASKKILL_TIMEOUT_MS,
      windowsHide: true,
      stdio: 'ignore'
    })
    // 进程已不在时 taskkill 返回非 0，这是正常的
    return result.status === 0
  } catch {
    return false
  }
}
