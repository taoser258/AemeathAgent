// 全屏应用检测（P9-T5 免打扰硬约束）：全屏游戏/视频时不冒泡。
// Electron 没有"前台窗口是否全屏"的直接 API，Windows 上用 user32
// GetForegroundWindow + GetWindowRect 拿前台窗口矩形，与显示器框比较。
//
// 实现注意（实测学费）：脚本必须落到临时 .ps1 用 -File 跑——
// `powershell -Command "<含双引号的脚本>"` 经 Node/Windows 参数传递后，
// PowerShell 5.1 会把内嵌 " 吃掉，Add-Type 编译报 "user32 不存在"。
//
// 探测失败一律 fail-open（返回 false = 放行气泡）——探测只是免打扰增强，
// 绝不能因为 PowerShell 抽风就把气泡永久憋死。

import { execFile } from 'child_process'
import { existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface SimpleRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface SimpleDisplay {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 矩形是否完整铺满任一显示器（容差 1px：DPI 取整误差）。
 * 普通"最大化"窗口因为任务栏（含我们自绘的 1px 留缝）盖不满，不会误判；
 * 独占全屏游戏与全屏视频精确覆盖整屏，会命中。
 */
export function rectCoversDisplay(rect: SimpleRect, displays: SimpleDisplay[]): boolean {
  return displays.some(
    (d) =>
      rect.left <= d.x + 1 &&
      rect.top <= d.y + 1 &&
      rect.right >= d.x + d.width - 1 &&
      rect.bottom >= d.y + d.height - 1
  )
}

/** 解析 "left,top,right,bottom"；非法返回 null */
export function parseRect(raw: string): SimpleRect | null {
  const m = raw.trim().match(/^(-?\d+),(-?\d+),(-?\d+),(-?\d+)$/)
  if (m === null) return null
  const nums = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  if (nums.some((n) => !Number.isFinite(n))) return null
  return { left: nums[0], top: nums[1], right: nums[2], bottom: nums[3] }
}

const PS1_PATH = join(tmpdir(), 'aemeath-fullscreen.ps1')

const PS1_BODY = `Add-Type -Namespace Aemeath -Name WinApi -MemberDefinition @'
[DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")]
public static extern bool GetWindowRect(System.IntPtr h, out RECT r);
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@
$h=[Aemeath.WinApi]::GetForegroundWindow()
$r=New-Object Aemeath.WinApi+RECT
[void][Aemeath.WinApi]::GetWindowRect($h,[ref]$r)
Write-Output "$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)"
`

/** 懒写一次探针脚本（纯 ASCII，系统 temp，不进仓库） */
function ensureScript(): void {
  if (!existsSync(PS1_PATH)) writeFileSync(PS1_PATH, PS1_BODY, 'utf8')
}

/** 10 秒缓存：气泡判定不必每次都拉 PowerShell */
let cache: { at: number; value: boolean } | null = null
const CACHE_MS = 10_000

/**
 * 探测前台是否有全屏应用。非 Windows / 探测出错 / 超时 → false（放行）。
 */
export async function isForegroundFullscreen(displays: SimpleDisplay[]): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const now = Date.now()
  if (cache !== null && now - cache.at < CACHE_MS) return cache.value
  let value = false
  try {
    ensureScript()
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1_PATH],
      { timeout: 4000, windowsHide: true, maxBuffer: 1024 * 64 }
    )
    const rect = parseRect(stdout)
    value = rect !== null && rectCoversDisplay(rect, displays)
  } catch {
    value = false
  }
  cache = { at: now, value }
  return value
}
