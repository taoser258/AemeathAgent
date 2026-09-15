// 桌宠窗：透明 / 无边框 / 置顶 / skipTaskbar / 手动拖拽 / 点击穿透可切 / 位置与尺寸记忆。
// 右键菜单：打开主窗 / 隐藏桌宠 / 尺寸调节（持久化）/ 回到右下角 / 切换穿透 / 退出。
// 已经踩过的坑（都有对应防御，别删）：
// - 原生 -webkit-app-region: drag 会把右键吞成 Windows 系统菜单 → 拖拽走指针事件 + IPC（见渲染层）
// - skipTaskbar 的窗一旦被最小化/关闭就没有任何恢复入口 → minimizable:false + close 事件拦截
// - 高 DPI 下 setPosition 把换算误差累积进尺寸（"越拖越大"）→ 每次移动都用配置里的
// 档位尺寸显式 setBounds（min/max 钳制方案会反过来把缩放夹死，已废弃）
// - 程序化 setBounds 在 Windows 不触发 moved → 位置记忆监听 move + 防抖

import { join } from 'path'
import { app, ipcMain, Menu, screen, BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import { APP_NAME } from '@shared/brand'
import {
  WIN_PET_MOVE,
  WIN_PET_SCALE,
  WIN_SHOW_PET,
  WIN_SHOW_PET_MENU,
  WIN_TOGGLE_CLICK_THROUGH
} from '@shared/ipc-channels'
import { configDir } from '../paths'
import { readAppConfig, writeAppConfig } from '../settings/app-config'
import { isAppQuitting } from './app-quit'
import { openScalePanelWindow, placeScalePanelWindow, showMainWindow } from './main-window'
import {
  PET_SCALE_DEFAULT,
  petWindowSize,
  resolvePetPosition,
  type WindowSize
} from './pet-position'

let petWindow: BrowserWindow | null = null

/** 当前档位的窗口尺寸（createPetWindow / applyPetScale 维护；移动时用它钉回尺寸） */
let petSize: WindowSize = petWindowSize(PET_SCALE_DEFAULT)

/** 切换点击穿透：改窗口行为 + 落盘 app.json，返回切换后的状态（右键菜单与设置页共用） */
function toggleClickThrough(): boolean {
  const config = readAppConfig(configDir())
  config.pet.clickThrough = !config.pet.clickThrough
  writeAppConfig(configDir(), config)
  petWindow?.setIgnoreMouseEvents(config.pet.clickThrough)
  return config.pet.clickThrough
}

/** 调整桌宠尺寸：窗口尺寸 = 基础尺寸 × scale，左上角位置保持不变；配置写盘做防抖 */
function applyPetScale(scale: number): void {
  if (!petWindow) return
  const { width, height } = petWindowSize(scale)
  const [x, y] = petWindow.getPosition()
  petSize = { width, height }
  petWindow.setBounds({ x, y, width, height })
  // 面板浮窗跟随钉回桌宠正上方
  placeScalePanelWindow(x, y, width)
  if (saveScaleTimer !== null) clearTimeout(saveScaleTimer)
  saveScaleTimer = setTimeout(() => {
    if (petWindow === null || petWindow.isDestroyed()) return
    const config = readAppConfig(configDir())
    config.pet.scale = scale
    writeAppConfig(configDir(), config)
  }, 300)
}

let saveScaleTimer: NodeJS.Timeout | null = null

/** 把桌宠送回默认的右下角（拖丢了、拖出屏幕边缘时的自救入口） */
function returnPetToCorner(): void {
  if (!petWindow) return
  const config = readAppConfig(configDir())
  const size = petWindowSize(config.pet.scale)
  const position = resolvePetPosition(
    { x: null, y: null },
    size,
    screen.getAllDisplays().map((d) => d.workArea)
  )
  petWindow.setBounds({ x: position.x, y: position.y, width: size.width, height: size.height })
}

function popupPetMenu(): void {
  if (!petWindow) return
  const config = readAppConfig(configDir())
  const menu = Menu.buildFromTemplate([
    {
      label: '打开主窗',
      click: () => {
        showMainWindow()
      }
    },
    {
      label: '隐藏桌宠',
      click: () => {
        petWindow?.hide()
      }
    },
    { type: 'separator' },
    {
      label: '调整大小',
      click: () => {
        // 独立浮窗承载滑杆：不跟随桌宠缩放
        if (petWindow === null) return
        const [px, py] = petWindow.getPosition()
        openScalePanelWindow(px, py, petWindow.getBounds().width)
      }
    },
    {
      label: '回到右下角',
      click: () => {
        returnPetToCorner()
      }
    },
    { type: 'separator' },
    {
      label: config.pet.clickThrough ? '关闭点击穿透' : '开启点击穿透',
      click: () => {
        toggleClickThrough()
      }
    },
    { type: 'separator' },
    {
      label: '重启应用',
      click: () => {
        restartApp()
      }
    },
    { type: 'separator' },
    {
      label: `退出 ${APP_NAME}`,
      click: () => {
        app.quit()
      }
    }
  ])
  menu.popup({ window: petWindow })
}

/**
 * 重启应用。
 * 打包后：app.relaunch + quit = 真正的重启。
 * 开发模式：npm run dev 管着主进程，relaunch 拉起的孤立实例抢不到单实例锁、
 * 也没有热更服务器可加载→ 降级为全窗口刷新式软重启：
 * 渲染层整体重载、内存态归零，主进程与桌宠位置保持。
 */
function restartApp(): void {
  if (is.dev) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.reload()
    }
    return
  }
  app.relaunch()
  app.quit()
}

/** 位置记忆：窗口移动停止后防抖写回 app.json，避免拖动过程中高频写盘 */
let savePositionTimer: NodeJS.Timeout | null = null
function schedulePositionSave(win: BrowserWindow): void {
  if (savePositionTimer) clearTimeout(savePositionTimer)
  savePositionTimer = setTimeout(() => {
    if (win.isDestroyed()) return
    const [x, y] = win.getPosition()
    const config = readAppConfig(configDir())
    config.pet.x = x
    config.pet.y = y
    writeAppConfig(configDir(), config)
  }, 400)
}

export function createPetWindow(): BrowserWindow {
  const config = readAppConfig(configDir())
  const size = petWindowSize(config.pet.scale)
  petSize = size
  const position = resolvePetPosition(
    config.pet,
    size,
    screen.getAllDisplays().map((d) => d.workArea)
  )

  const pet = new BrowserWindow({
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
    // 透明窗三件套：transparent + frame:false + 渲染层 body 背景透明
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    // 桌宠 skipTaskbar：一旦被最小化就没有任务栏图标可以恢复（窗口会藏到 -32000,-32000），
    // 所以直接禁用最小化，堵死这条丢失路径
    minimizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // 系统阴影对异形透明窗是一圈方框阴影，关掉后由 CSS drop-shadow 自绘
    hasShadow: false,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // 恢复记忆的穿透状态（上次退出前若开着，启动即生效）
  pet.setIgnoreMouseEvents(config.pet.clickThrough)
  pet.once('ready-to-show', () => pet.show())
  // 位置记忆监听 'move' 而不是 'moved'：手动拖拽走程序化 setBounds，
  // Windows 上它不触发 'moved'；'move' 对两种来源都生效，高频由防抖消化
  pet.on('move', () => schedulePositionSave(pet))
  // 拦截一切"单独关掉桌宠"的路径（Alt+F4、系统菜单关闭）：桌宠 skipTaskbar，
  // 被关掉后没有任何恢复入口。真正的退出走 app.quit() → before-quit → 放行。
  pet.on('close', (event) => {
    if (!isAppQuitting()) event.preventDefault()
  })
  pet.on('closed', () => {
    petWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    pet.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/pet.html`)
  } else {
    pet.loadFile(join(__dirname, '../renderer/pet.html'))
  }

  petWindow = pet
  return pet
}

/** 把桌宠窗找回并显示（设置页按钮、二次启动共用）；理论上不会走到重建分支，防御式兜底 */
export function showPetWindow(): void {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.show()
  } else {
    createPetWindow()
  }
}

/** 桌宠相关 IPC：右键菜单请求 + 手动拖拽移动 + 找回桌宠 + 穿透切换 */
export function registerPetIpc(): void {
  ipcMain.on(WIN_SHOW_PET_MENU, () => popupPetMenu())
  ipcMain.on(WIN_SHOW_PET, () => {
    showPetWindow()
  })
  ipcMain.on(WIN_PET_MOVE, (_event, x: unknown, y: unknown) => {
    if (!petWindow) return
    if (typeof x !== 'number' || !Number.isFinite(x)) return
    if (typeof y !== 'number' || !Number.isFinite(y)) return
    // 高 DPI 防线：不用 setPosition（它只改位置，DPI 误差会累积进尺寸），
    // 而是显式把宽高一起钉回当前档位尺寸。setBounds 触发 move → 位置记忆照常工作。
    petWindow.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: petSize.width,
      height: petSize.height
    })
  })
  ipcMain.handle(WIN_TOGGLE_CLICK_THROUGH, () => toggleClickThrough())
  ipcMain.on(WIN_PET_SCALE, (_event, scale: unknown) => {
    if (typeof scale !== 'number' || !Number.isFinite(scale)) return
    applyPetScale(scale)
  })
}
