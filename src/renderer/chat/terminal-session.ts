/**
 * 终端 v2 渲染层会话底座。
 *
 * 为什么是模块级单例而非组件 state：真 PTY 会话在主进程常驻（activePty），
 * 切走页签/收起侧栏都不该杀掉它——cd 状态、正在跑的 REPL 都要跨挂载存活。
 * 于是把「ANSI 解析结果 + 订阅」也放模块级：主进程 onTerminalStream 只注册一次，
 * 数据永远喂同一个 screen；面板挂载时读快照 + 订阅增量。
 *
 * 流式性能（三层防护同款思路）：高频 pty chunk 经 50ms 节流合并成一次重绘，
 * 避免每个字符触发 React 渲染。
 */
import { AnsiScreen, type AnsiChar } from '@shared/ansi'

const screen = new AnsiScreen({ maxLines: 2000 })
const listeners = new Set<() => void>()
let started = false
let attached = false
let notifyTimer: number | null = null

function notify(): void {
  if (notifyTimer !== null) return
  notifyTimer = window.setTimeout(() => {
    notifyTimer = null
    for (const l of listeners) l()
  }, 50)
}

/** 主进程输出流订阅：全局只挂一次（模块生命周期 = 应用生命周期） */
function ensureAttached(): void {
  if (attached) return
  attached = true
  window.petAPI.onTerminalStream((d) => {
    screen.feed(d.chunk)
    if (d.exit === true) started = false
    notify()
  })
}

export interface TerminalSession {
  lines(): AnsiChar[][]
  isStarted(): boolean
  subscribe(cb: () => void): () => void
  start(cols: number, rows: number): Promise<{ ok: boolean; error?: string }>
  write(data: string): void
  resize(cols: number, rows: number): void
  clear(): void
  restart(cols: number, rows: number): Promise<{ ok: boolean; error?: string }>
}

export const terminalSession: TerminalSession = {
  lines: () => screen.render(),
  isStarted: () => started,
  subscribe(cb) {
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  },
  async start(cols, rows) {
    ensureAttached()
    const res = await window.petAPI.terminalSpawn(cols, rows)
    if (res.ok) {
      started = true
      screen.clearScreen()
      notify()
    }
    return res
  },
  write(data) {
    void window.petAPI.terminalWrite(data)
  },
  resize(cols, rows) {
    if (started) void window.petAPI.terminalResize(cols, rows)
  },
  clear() {
    screen.clearScreen()
    notify()
  },
  async restart(cols, rows) {
    await window.petAPI.terminalKill()
    started = false
    return this.start(cols, rows)
  }
}

/** 把一行字符按相同样式合并成若干段（避免逐字符 span 打爆 DOM） */
export function coalesceRuns(line: AnsiChar[]): Array<{ text: string; cls: string }> {
  const runs: Array<{ text: string; cls: string }> = []
  for (const c of line) {
    const last = runs[runs.length - 1]
    if (last !== undefined && last.cls === c.cls) last.text += c.ch
    else runs.push({ text: c.ch, cls: c.cls })
  }
  return runs
}
