// 主动招呼调度器（P9-T5）：决定"什么时候想冒泡"，能不能冒泡由 bubble-policy 判。
// 触发源：启动延迟问候 / 早中晚时段 / 系统空闲 / 被点 / 被拖 / 主窗收起 /
// 任务完成失败（run.ts 直接调 notifyBubble）。
//
// 红线（owner 拍板）：主动说话必须可关、有频率上限、有免打扰时段——
// 桌宠一旦变话痨就是负资产。所有硬门槛都在纯函数模块里单测，这里只做编排。
//
// 依赖方向（两处刻意设计，别改回去）：
// ① 本模块不许 import windows/pet——它会拉入 @electron-toolkit/utils，
//   而 vitest 在纯 Node 下链接该包的 ESM 会报"electron 命名导出不存在"，
//   run.ts 又被会话存储测试经依赖图加载，会把整个测试套件带挂。
//   发送函数改由主进程入口注入（setBubbleSender）。
// ② tap/drag 的 IPC 注册放在这里，不放进 registerPetIpc，同样为避免 pet.ts 反向依赖本模块。

import { ipcMain, powerMonitor, screen, type BrowserWindow } from 'electron'
import { PET_DRAGGED, PET_TAP } from '@shared/ipc-channels'
import { readAppConfig } from '../settings/app-config'
import { configDir } from '../paths'
import { isForegroundFullscreen } from './fullscreen'
import { pickBubbleLine } from './bubble-lines'
import {
  configBubbleSettings,
  createBubbleRuntime,
  dayPart,
  decideBubble,
  greetingAlreadyFired,
  noteBubbleShown,
  resetIdleFired,
  type BubbleKind,
  type BubbleRuntimeState
} from './bubble-policy'

/** 启动问候延迟：避开开窗动画 */
const STARTUP_DELAY_MS = 4000
/** 巡检间隔：时段问候补发 + 空闲检测 */
const TICK_MS = 30_000
/** 回到活跃的判定：系统空闲低于这个秒数视为"回来了"，复位 idle 已发标记 */
const ACTIVE_IDLE_SEC = 30

let rt: BubbleRuntimeState = createBubbleRuntime(new Date())
let started = false

/**
 * 气泡出口：由主进程入口注入 windows/pet 的 sendPetBubble。
 * 未注入（单测）时冒泡静默丢弃——策略本身仍照常判定。
 */
let sender: ((text: string) => void) | null = null
export function setBubbleSender(fn: (text: string) => void): void {
  sender = fn
}

/**
 * 想冒泡时调这里。策略不过（关/档低/免打扰/全屏/冷却/每小时上限）就静默放弃，
 * 不排队、不补播——错过的招呼不补，这本身就是防打扰。
 */
export async function notifyBubble(kind: BubbleKind): Promise<void> {
  const now = new Date()
  const config = readAppConfig(configDir())
  const { level, dndStartMin, dndEndMin, idleMs } = configBubbleSettings(config.pet)
  if (kind === 'idle' && idleMs === 0) return // 设置里关了空闲冒泡
  const fullscreen = await isForegroundFullscreen(
    screen.getAllDisplays().map((d) => ({
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height
    }))
  )
  const decision = decideBubble({
    kind,
    level,
    now,
    dndStartMin,
    dndEndMin,
    fullscreen,
    rt
  })
  if (!decision.allow) return
  sender?.(pickBubbleLine(kind, now))
  rt = noteBubbleShown(rt, kind, now)
}

/**
 * 软重启后重跑一轮启动问候（dev 模式下「重启应用」是全窗口 reload 式软重启，
 * 主进程不重启、startBubbleScheduler 不会重跑——用户点了"重启"却看不到启动气泡，
 * 实测困惑）。语义 = 重新打开应用：复位运行时（冷却/配额归零）+ 延迟问候。
 * 由 index.ts 注入进 pet.ts 的软重启钩子调用。
 */
export function restartBubbleCycle(): void {
  rt = createBubbleRuntime(new Date())
  setTimeout(() => void notifyBubble('startup'), STARTUP_DELAY_MS)
}

/** 启动调度：启动问候 + 巡检（时段问候 / 空闲）。幂等，只起一份。 */
export function startBubbleScheduler(): void {
  if (started) return
  started = true
  rt = createBubbleRuntime(new Date())

  setTimeout(() => void notifyBubble('startup'), STARTUP_DELAY_MS)

  setInterval(() => {
    const now = new Date()
    const config = readAppConfig(configDir())
    const settings = configBubbleSettings(config.pet)

    // ① 时段问候：当前时段今天还没发过
    if (dayPart(now) !== null && !greetingAlreadyFired(rt, now) && settings.level !== 'off') {
      void notifyBubble('greeting')
    }

    // ② 系统空闲：超过设置的分钟数发一次；回来后复位
    if (settings.level === 'all' && settings.idleMs > 0) {
      const idleSec = powerMonitor.getSystemIdleTime()
      if (idleSec >= settings.idleMs / 1000 && !rt.idleFired) {
        void notifyBubble('idle')
      } else if (idleSec < ACTIVE_IDLE_SEC && rt.idleFired) {
        rt = resetIdleFired(rt)
      }
    }
  }, TICK_MS)

  // ③ 点 / 拖：回应型，门槛（冷却等）仍由策略统一把守
  ipcMain.on(PET_TAP, () => void notifyBubble('pet_tap'))
  ipcMain.on(PET_DRAGGED, () => void notifyBubble('pet_drag'))
}

/**
 * 把气泡挂钩显式附着到主窗（在 index.ts 建窗后调一次）。
 * 主窗收起 → "报个平安"（回应型）。两条路径都要挂（用户实测反馈②：关窗没气泡）：
 * · 最小化按钮 → 'minimize'；
 * · 关闭按钮（X）= close 被拦后 hide() → 'hide'。
 * 放这里而不是 main-window 里，是为了切断 main-window → scheduler → windows/* → main-window 的循环依赖。
 */
export function attachMainWindowHooks(win: BrowserWindow): void {
  win.on('minimize', () => void notifyBubble('minimize'))
  win.on('hide', () => void notifyBubble('minimize'))
}
