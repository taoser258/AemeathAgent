/**
 * 右侧栏终端 v2：node-pty 常驻交互式会话。
 *
 * 与 v1（workspace-ipc 里的一次性 spawn）的本质区别：
 * · 常驻 shell——cd/环境变量跨命令保持，python REPL 等交互程序可用；
 * · ConPTY 把输出统一成 UTF-8——v1 的 GBK 解码坑天然消失；
 * · 无 60s 超时（验收口径：交互式常驻不受误杀）；Ctrl+C 由渲染层发 \x03。
 * 安全边界不变：shell 的 cwd 固定为工作区根（渲染层传不了任意 cwd）；
 * 本应用本来就给用户跑命令的入口（v1 同款信任模型），PTY 不扩大权限面。
 *
 * 单会话（activePty）：与 v1 的 activeTerminal 一致的心智模型，够用。
 */
import { statSync } from 'fs'
import { ipcMain } from 'electron'
import * as pty from 'node-pty'
import {
  TERMINAL_DATA,
  TERMINAL_KILL,
  TERMINAL_RESIZE,
  TERMINAL_SPAWN,
  TERMINAL_WRITE
} from '@shared/ipc-channels'
import { boundWorkspace } from '@shared/workspace'
import { readAppConfig } from '../settings/app-config'
import { configDir } from '../paths'

let activePty: pty.IPty | null = null

function workspaceRoot(): string | null {
  const config = readAppConfig(configDir())
  const ws = boundWorkspace(config.workspace, 'work') ?? boundWorkspace(config.workspace, 'learn')
  if (ws === null || ws === '') return null
  try {
    if (!statSync(ws).isDirectory()) return null
  } catch {
    return null
  }
  return ws
}

function killActive(): void {
  if (activePty === null) return
  try {
    activePty.kill()
  } catch {
    // 已退出的进程 kill 会抛，忽略
  }
  activePty = null
}

export function registerTerminalIpc(): void {
  // 开一个常驻 shell（重复 spawn = 先杀旧再开新——面板重挂载/换工作区的自然语义）
  ipcMain.handle(
    TERMINAL_SPAWN,
    (event, cols: unknown, rows: unknown): { ok: boolean; error?: string; cwd?: string } => {
      const root = workspaceRoot()
      if (root === null) return { ok: false, error: '当前还没有绑定工作区' }
      const c = typeof cols === 'number' && cols > 0 ? Math.min(500, Math.round(cols)) : 80
      const r = typeof rows === 'number' && rows > 0 ? Math.min(200, Math.round(rows)) : 24
      const sender = event.sender
      killActive()
      try {
        // ConPTY（Windows 10+）：cmd.exe 经伪终端跑，输出 UTF-8、支持光标控制。
        // 不用 PowerShell 默认——cmd 更轻、 的 v1 习惯一致，且避免 PS profile 拖慢启动。
        activePty = pty.spawn('cmd.exe', [], {
          name: 'xterm-256color',
          cols: c,
          rows: r,
          cwd: root,
          env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
        })
      } catch (err) {
        return { ok: false, error: `终端启动失败：${String(err)}` }
      }
      const child = activePty
      child.onData((data) => {
        if (!sender.isDestroyed()) sender.send(TERMINAL_DATA, { chunk: data })
      })
      child.onExit(({ exitCode }) => {
        if (activePty === child) activePty = null
        if (!sender.isDestroyed())
          sender.send(TERMINAL_DATA, {
            chunk: `\r\n[shell 已退出（${exitCode}）——重新切到终端页签可再开一个]\r\n`,
            exit: true
          })
      })
      return { ok: true, cwd: root }
    }
  )

  // 键入（渲染层把按键/粘贴原文转发；Ctrl+C = \x03 由按键映射带过来）
  ipcMain.handle(TERMINAL_WRITE, (_event, data: unknown): { ok: boolean } => {
    if (activePty === null) return { ok: false }
    if (typeof data !== 'string' || data === '') return { ok: false }
    // 单帧写入上限 64KB（防渲染层 bug 刷爆管道；正常键入远小于此）
    activePty.write(data.length > 65536 ? data.slice(0, 65536) : data)
    return { ok: true }
  })

  ipcMain.handle(TERMINAL_RESIZE, (_event, cols: unknown, rows: unknown): { ok: boolean } => {
    if (activePty === null) return { ok: false }
    const c = typeof cols === 'number' && cols > 0 ? Math.min(500, Math.round(cols)) : 80
    const r = typeof rows === 'number' && rows > 0 ? Math.min(200, Math.round(rows)) : 24
    try {
      activePty.resize(c, r)
    } catch {
      // 进程刚好退出时 resize 会抛，忽略
    }
    return { ok: true }
  })

  ipcMain.handle(TERMINAL_KILL, (): { ok: boolean } => {
    killActive()
    return { ok: true }
  })
}

/** 应用退出时兜底杀 shell（main/index.ts 的 before-quit 调用） */
export function shutdownTerminal(): void {
  killActive()
}
