// 系统托盘（owner 需求④）：右下角常驻图标 + 右键常用菜单。
//
// 关闭主窗本就是"隐藏不退出"（见 main-window 的 close 拦截），托盘补上可见入口：
// 双击/单击 → 唤回主窗；右键 → 显示主窗 / 设置 / 退出。
// tray 实例必须被模块级变量持有——被 GC 回收后图标会神秘消失。

import { app, Menu, nativeImage, Tray } from 'electron'
import { appIconPath } from '../paths'
import { createSettingsWindow, showMainWindow } from './main-window'

let tray: Tray | null = null
/** 本次运行是否已提示过"已最小化到托盘"（每次关窗都弹会很烦） */
let closeHintShown = false

export function createTray(): void {
  if (tray !== null) return
  const image = nativeImage.createFromPath(appIconPath()).resize({ width: 16, height: 16 })
  tray = new Tray(image)
  tray.setToolTip('Aemeath 爱弥斯')
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showMainWindow() },
    { label: '设置…', click: () => createSettingsWindow() },
    { type: 'separator' },
    {
      label: '退出爱弥斯',
      click: () => {
        // before-quit 会置退出标记，主窗/桌宠的 close 拦截随即放行
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
  // 双击唤回（Windows 惯例；单击在部分系统会吞菜单，故只挂双击）
  tray.on('double-click', () => showMainWindow())
}

/** 主窗关闭（=隐藏）到托盘时弹一次提示，告诉用户程序还在跑、去哪找回 */
export function notifyHiddenToTray(): void {
  if (tray === null || closeHintShown) return
  closeHintShown = true
  tray.displayBalloon({
    title: '爱弥斯仍在运行',
    content: '主窗口已最小化到托盘，双击右下角图标即可唤回；右键图标可退出。'
  })
}
