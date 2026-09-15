// 屏幕感知：active_window 工具的探测实现。
// 隐私红线：默认关——仅当用户在设置页显式开启后才进入 LLM 工具注册表。
// 实现自研（禁装包）：PowerShell + user32 GetForegroundWindow，base64 输出绕开
// 控制台编码坑（中文窗口标题在 GBK 控制台下易乱码）；结果缓存 3 秒避免连击拉起进程。

import { spawn } from 'child_process'

const PROBE_TIMEOUT_MS = 8_000
const CACHE_TTL_MS = 3_000

let enabled = false
let probe: (() => Promise<string>) | null = null
let cache: { at: number; value: string } | null = null

/** 隐私开关（主进程持有；启动读配置、设置页保存后即时同步） */
export function setScreenEnabled(value: boolean): void {
  enabled = value
  if (!value) cache = null
}

export function isScreenEnabled(): boolean {
  return enabled
}

/** 注入真实探针（main ready 时注入 PowerShell 实现；单测注入假探针） */
export function setScreenProbe(fn: (() => Promise<string>) | null): void {
  probe = fn
  cache = null
}

/**
 * 取前台窗口信息："进程名|窗口标题"。未开启 / 探针不可用 / 超时都以异常收敛，
 * 错误文案会回灌给模型（executeToolCall 统一转 failed 态）。
 */
export async function getActiveWindow(): Promise<string> {
  if (!enabled) {
    throw new Error(
      '屏幕感知未开启：用户尚未在设置中授权读取前台窗口，请告知用户可到「设置 → 桌宠」开启。'
    )
  }
  if (probe === null) {
    throw new Error('屏幕感知探针不可用（应用尚未就绪）。')
  }
  if (cache !== null && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value
  }
  const value = await probe()
  cache = { at: Date.now(), value }
  return value
}

const PS_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -TypeDefinition @\'\nusing System;using System.Text;using System.Runtime.InteropServices;\npublic class AW {\n [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();\n [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);\n [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);\n}\n\'@',
  '$h=[AW]::GetForegroundWindow()',
  '$sb=New-Object System.Text.StringBuilder 1024',
  '[void][AW]::GetWindowText($h,$sb,1024)',
  '$p=[uint32]0',
  '[void][AW]::GetWindowThreadProcessId($h,[ref]$p)',
  '$proc=(Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName',
  '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$proc|$($sb.ToString())"))'
].join('; ')

/** Windows 真实探针：拉起 PowerShell 查 user32 前台窗口；输出 base64（UTF8）规避编码问题 */
export function windowsProbe(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
      { windowsHide: true }
    )
    let stdout = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill()
        reject(new Error('读取前台窗口超时'))
      }
    }, PROBE_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`无法启动屏幕探测（${err.message}）`))
      }
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`屏幕探测失败（退出码 ${code}）`))
        return
      }
      try {
        const b64 = stdout.trim().split(/\r?\n/).pop() ?? ''
        const decoded = Buffer.from(b64, 'base64').toString('utf8')
        const sep = decoded.indexOf('|')
        if (sep === -1) {
          reject(new Error('屏幕探测输出格式异常'))
          return
        }
        const procName = decoded.slice(0, sep) || '未知应用'
        const title = decoded.slice(sep + 1).trim()
        resolve(title === '' ? `「${procName}」（窗口标题为空）` : `${procName}｜「${title}」`)
      } catch (err) {
        reject(
          new Error(`屏幕探测输出解析失败：${err instanceof Error ? err.message : String(err)}`)
        )
      }
    })
  })
}
