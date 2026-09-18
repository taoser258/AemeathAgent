// 主窗 + 独立设置窗：透明窗体 + CSS 大圆角（28px/24px，四角平滑，radius 画在
// 各页面根元素上：主窗 .chat-page、设置窗 .settings-shell，见各 css 文件）。
// 关闭行为：关闭 = 隐藏不退出；桌宠常驻，从桌宠右键菜单"打开主窗"唤回。
// 透明窗铁律：窗体参数与渲染层 body 都不得有不透明背景，
// 否则整窗变实心、四角只剩系统 ~8px 圆角。

import { join } from 'path'
import { ipcMain, screen, shell, BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import {
  WIN_OPEN_SETTINGS,
  WIN_WINDOW_CONTROL,
  WIN_WINDOW_DRAG_BEGIN,
  WIN_WINDOW_MAXIMIZED,
  WIN_WINDOW_MAXIMIZED_GET,
  WIN_WINDOW_MOVE_TO,
  WIN_WINDOW_SET_BOUNDS,
  BROWSER_OPEN_LINK
} from '@shared/ipc-channels'
import { isAppQuitting } from './app-quit'
import { maximizedBounds } from './maximize-bounds'
import { appendDebugLog } from '../log'
import { appIconPath, logsDir } from '../paths'
import { attachEditContextMenu } from './edit-menu'

// 应用图标（窗口 / 任务栏）统一走 paths.appIconPath()：dev 与打包态的资源基准分叉见 paths.ts 的 appRoot 注释

let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let scalePanelWindow: BrowserWindow | null = null

/** 滑动面板浮窗尺寸（导出给 pet.ts 计算定位） */
export const SCALE_PANEL_WIDTH = 260
export const SCALE_PANEL_HEIGHT = 110

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 940,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    icon: appIconPath(),
    // 透明窗体：radius 由 .chat-page 根元素自绘；这里绝不能设 backgroundColor
    // （'#fbf7f9' 之类会把整窗涂成不透明白底），渲染层 body 也必须透明（global.css）
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false, // 系统边缘缩放在透明窗不可用，缩放区在渲染层
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // 右侧栏内嵌浏览器（v16，学 成熟实现-better-sidebar）：<webview> 标签需要显式开启
      webviewTag: true
    }
  })

  // 右键编辑菜单（反馈批次②）：选中文字后右键可复制/全选
  attachEditContextMenu(window)

  window.on('ready-to-show', () => {
    window.show()
    // 冷启动 / 桌宠菜单「重启应用」后：把主窗提到「普通窗口层」的最前 + 拿焦点。
    //
    // ★ 旧实现是 setAlwaysOnTop(true, 'screen-saver') 再 2 秒后 setAlwaysOnTop(false)
    //   释放。实测（owner 报告 + 复现）：**释放后 Z 序没有真正降回桌宠之下**——
    //   桌宠（topmost）被主窗（非 topmost）压住，之后无论 setAlwaysOnTop(true) 还是
    //   Win32 SetWindowPos(HWND_TOPMOST) 都压不回来，只有 hide/show 主窗触发 Z 序
    //   重排才恢复。moveTop() 等价 SetWindowPos(HWND_TOP)：只在自身层级内提升，
    //   不会越到置顶的桌宠之上——桌宠恒定可见（这正是桌宠该有的行为）。
    window.moveTop()
    window.focus()
  })

  // 关闭 = 隐藏：会话与输入内容不销毁，重开秒回
  window.on('close', (event) => {
    if (!isAppQuitting()) {
      event.preventDefault()
      window.hide()
    }
  })

  // 主窗最小化挂钩不在这：由 pet/bubble-scheduler 的 attachMainWindowHooks 显式
  // 附着（避免 main-window ↔ bubble-scheduler 循环依赖）。

  // 渲染进程崩溃自恢复：
  // 崩溃记 debug 日志（与人为关窗可区分），自动 reload 一次；连续崩溃不循环重载（防崩溃风暴）
  let crashReloads = 0
  window.webContents.on('render-process-gone', (_event, details) => {
    const line = `[main-window] 渲染进程异常退出：reason=${details.reason} exitCode=${details.exitCode}（已自动重载第 ${crashReloads + 1} 次）`
    try {
      appendDebugLog(logsDir(), line)
    } catch {
      /* 日志失败不阻塞恢复 */
    }
    if (crashReloads < 1 && details.reason !== 'clean-exit') {
      crashReloads += 1
      setTimeout(() => {
        if (!window.isDestroyed()) window.webContents.reload()
      }, 300)
    }
  })

  // 外部链接一律交给系统浏览器，不在应用内开新窗
  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // ★ 站内导航兜底：<a href> 漏网（未经渲染层拦截）时默认会让整个主窗跳走、
  // 应用被网页覆盖且退不回来（实测事故）。这里拦下外链，转发渲染层走右侧栏浏览器；
  // 应用自身加载（dev 热更新 / file://）保持放行。
  window.webContents.on('will-navigate', (e, url) => {
    const current = window.webContents.getURL()
    if (url === current) return
    if (!/^https?:\/\//i.test(url)) return // file:// 与 dev 内部跳转不管
    e.preventDefault()
    if (!window.isDestroyed()) window.webContents.send(BROWSER_OPEN_LINK, url)
  })

  window.on('closed', () => {
    mainWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow = window
  return window
}

/** 把主窗拉到前台；已销毁（被关闭）则重建。桌宠右键菜单与二次启动共用 */
export function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  } else {
    createMainWindow()
  }
}

/** 桌宠尺寸滑动面板：独立小浮窗（避免面板跟随桌宠缩放），定位在桌宠上方 */
export function openScalePanelWindow(petX: number, petY: number, petWidth: number): void {
  if (scalePanelWindow && !scalePanelWindow.isDestroyed()) {
    // 关闭 = 隐藏（close 拦截），所以"再次打开"必须 show + focus；
    // 只 focus 一个隐藏窗口等于什么都不发生（实测踩过：面板关一次就再也打不开）
    scalePanelWindow.show()
    scalePanelWindow.focus()
    return
  }
  const panelW = SCALE_PANEL_WIDTH
  const panelH = SCALE_PANEL_HEIGHT
  const win = new BrowserWindow({
    width: panelW,
    height: panelH,
    x: Math.max(0, Math.round(petX + (petWidth - panelW) / 2)),
    y: Math.max(0, Math.round(petY - panelH - 10)),
    show: false,
    autoHideMenuBar: true,
    // 透明三件套：transparent + frame:false + 渲染层 body 透明（global.css 已改）。
    // 此前的 backgroundColor: '#fbf7f9' 把整个窗矩形涂成不透明白底（正是"白圈"的来源），
    // 系统阴影（hasShadow 默认 true）又会在矩形外再画一圈方形光晕——两者都必须去掉。
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: '调整大小',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  win.once('ready-to-show', () => win.show())
  win.on('close', (event) => {
    if (!isAppQuitting()) {
      event.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    scalePanelWindow = null
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/scale-panel.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/scale-panel.html'))
  }
  scalePanelWindow = win
}

/** 把面板浮窗钉在桌宠正上方（桌宠尺寸变化时调用，保持"固定在桌宠正上方"） */
export function placeScalePanelWindow(petX: number, petY: number, petWidth: number): void {
  if (scalePanelWindow === null || scalePanelWindow.isDestroyed()) return
  const x = Math.max(0, Math.round(petX + (petWidth - SCALE_PANEL_WIDTH) / 2))
  const y = Math.max(0, Math.round(petY - SCALE_PANEL_HEIGHT - 10))
  scalePanelWindow.setBounds({ x, y, width: SCALE_PANEL_WIDTH, height: SCALE_PANEL_HEIGHT })
}

/** 独立设置窗口：单例；关闭 = 隐藏（保留状态），再次打开只聚焦 */
export function createSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore()
    settingsWindow.show()
    settingsWindow.focus()
    return settingsWindow
  }

  const win = new BrowserWindow({
    // 默认与主窗同级
    width: 1240,
    height: 800,
    minWidth: 940,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    frame: false,
    transparent: true,
    hasShadow: false,
    // resizable:true：边缘/四角的系统缩放与内部手动拖动天然共存——
    // 指针按下落在边缘命中区时归系统缩放（不进页面），落在内部时走 win:window-move-to。
    // 之前二者"打架抽搐"的真因是 screenX 物理像素当 DIP 用的坐标 bug（已修，见 git 历史）。
    resizable: true,
    icon: appIconPath(),
    title: '设置',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // 右键编辑菜单（反馈批次②）：模型名/Key/MCP 参数等输入框需要剪切/粘贴
  attachEditContextMenu(win)

  win.once('ready-to-show', () => win.show())
  win.on('close', (event) => {
    if (!isAppQuitting()) {
      event.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    settingsWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/settings.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/settings.html'))
  }

  settingsWindow = win
  return win
}

/**
 * 手动最大化（透明无边框窗专用，主窗/设置窗共用一张表）：
 * 不用 win.maximize()——OS 最大化对 transparent 窗有两个 坑：① 最大化后
 * 窗口框按「显示器全幅」而非工作区摆放，任务栏遮挡 + 28px 圆角根元素四角露底，
 * 顶栏按钮看起来"不齐"（DPI≠100% 的电脑更明显）；② 部分机器 unmaximize 不回到
 * 原框（"放大后回不去"）。自管方案：记原框 → setBounds(workArea)，还原就是普通
 * setBounds——同步、精确、跨 DPI 稳。状态经 win:window-maximized 广播给渲染层
 * （图标切还原态、拖拽/缩放分支读它）。
 */
const manualMaximized = new WeakMap<
  BrowserWindow,
  { x: number; y: number; width: number; height: number }
>()

function isManualMaximized(win: BrowserWindow): boolean {
  return manualMaximized.has(win)
}

/** 把"是否最大化"广播给该窗渲染层（图标/拖拽分支的唯一状态源） */
function notifyMaximized(win: BrowserWindow): void {
  if (!win.isDestroyed()) win.webContents.send(WIN_WINDOW_MAXIMIZED, isManualMaximized(win))
}

function toggleManualMaximize(win: BrowserWindow): void {
  const saved = manualMaximized.get(win)
  if (saved !== undefined) {
    manualMaximized.delete(win)
    win.setBounds(saved)
  } else {
    const bounds = win.getBounds()
    manualMaximized.set(win, bounds)
    // 目标框见 maximize-bounds：任务栏自动隐藏时底部留 1px，避免被 shell 当成
    // 全屏应用而抑制任务栏弹出（owner 实测：贴底唤不出任务栏）
    win.setBounds(maximizedBounds(screen.getDisplayMatching(bounds)))
  }
  notifyMaximized(win)
}

/**
 * 窗口控制（主窗/设置窗共用通道，按来源窗口生效）：
 * minimize / maximize / close 走关闭拦截（=隐藏），退出时由 before-quit 放行；
 * set-bounds 是透明窗的自研边缘缩放（渲染层缩放区提交新 bounds，含最小尺寸钳制）。
 */
export function registerMainWindowIpc(): void {
  ipcMain.on(WIN_WINDOW_CONTROL, (event, action: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win === null || win.isDestroyed()) return
    switch (action) {
      case 'minimize':
        win.minimize()
        break
      case 'maximize':
        toggleManualMaximize(win)
        break
      case 'close':
        win.close()
        break
      default:
        break
    }
  })
  // 渲染层挂载首帧对账（广播早于订阅会丢，invoke 拉一次真值）
  ipcMain.handle(WIN_WINDOW_MAXIMIZED_GET, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win !== null && !win.isDestroyed() && isManualMaximized(win)
  })
  ipcMain.on(WIN_OPEN_SETTINGS, () => {
    createSettingsWindow()
  })
  // 顶条手动拖拽起帧：最大化状态下先还原（unmaximize 回到最大化前的窗口框），
  // 再回传当前 bounds——渲染层拿它算抓取点偏移，之后拖到的位置就是"还原后的尺寸跟随光标"，
  // 等价于原生标题栏"拖出即还原"的行为（app-region:drag 没有这个行为）。
  ipcMain.handle(WIN_WINDOW_DRAG_BEGIN, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win === null || win.isDestroyed()) return null
    // 手动最大化态：先同步还原原框再回传（setBounds 即刻生效，不需要等 restore 事件——
    // 这是自管方案比 win.unmaximize 稳的第二个红利：无异步竞态、无 150ms 兜底）
    if (isManualMaximized(win)) {
      toggleManualMaximize(win)
      if (win.isDestroyed()) return null
    }
    return win.getBounds()
  })
  // 手动拖拽：把"发送方窗口"移动到渲染层指定的绝对屏幕位置（DIP）。
  // 渲染层每帧都发"光标 − 抓取点偏移"，绝对定位没有累积反馈误差——
  // 就算某帧事件丢了，下一帧也会自动校正，抓取点始终钉在光标下
  // （clientX 相对方案会随窗口移动反馈 oscillate，±交替抽搐，实测踩坑）。
  // 尺寸用按下时锁定的值而非 getBounds 读回值：DIP/物理像素往返取整有 ±1 偏差，
  // 读回值回喂会棘轮式越拖越大（实测踩坑）。
  ipcMain.on(
    WIN_WINDOW_MOVE_TO,
    (event, x: unknown, y: unknown, width: unknown, height: unknown) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win === null || win.isDestroyed()) return
      if (typeof x !== 'number' || typeof y !== 'number') return
      if (!Number.isFinite(x) || !Number.isFinite(y)) return
      const bounds = win.getBounds()
      const display = screen.getDisplayMatching(bounds)
      const lockW =
        typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : bounds.width
      const lockH =
        typeof height === 'number' && Number.isFinite(height) && height > 0 ? height : bounds.height
      // 窗口上缘不低于工作区顶部（标题区保持在可达范围内）
      win.setBounds({
        x: Math.round(x),
        y: Math.round(Math.max(display.workArea.y, y)),
        width: lockW,
        height: lockH
      })
    }
  )
  ipcMain.on(WIN_WINDOW_SET_BOUNDS, (event, bounds: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win === null || win.isDestroyed()) return
    if (typeof bounds !== 'object' || bounds === null) return
    const b = bounds as Record<string, unknown>
    const width =
      typeof b.width === 'number' && Number.isFinite(b.width)
        ? Math.round(b.width)
        : win.getBounds().width
    const height =
      typeof b.height === 'number' && Number.isFinite(b.height)
        ? Math.round(b.height)
        : win.getBounds().height
    const x =
      typeof b.x === 'number' && Number.isFinite(b.x) ? Math.round(b.x) : win.getPosition()[0]
    const y =
      typeof b.y === 'number' && Number.isFinite(b.y) ? Math.round(b.y) : win.getPosition()[1]
    // 最小尺寸钳制（透明窗 resizable:false 时系统不再帮我们夹）
    win.setBounds({
      x,
      y,
      width: Math.max(940, width),
      height: Math.max(640, height)
    })
    // 缩放即退出手动最大化态（渲染层从当前框算出的新框已含"比工作区小"的语义）
    if (manualMaximized.delete(win)) notifyMaximized(win)
  })
}
