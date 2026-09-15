// 右侧栏内嵌浏览器（v17）：**独立无框子窗**方案。
//
// 踩坑史（都在本机实测过，别再走回头路）：
// 1. <webview> 标签：guest 视口高度永远卡死在默认 150px——CSS（absolute/flex/显式
// 宽高）、autosize 属性、内联像素全部无效；裸 webview 对照实验连 guest 都不建。
// 2. WebContentsView：主窗是 transparent:true（桌宠同窗的设计前提），透明窗口上
// contentView 的子 view 被合成器丢弃（bounds 正确、backgroundColor 不透明也白屏）。
// 3. 本方案：独立 BrowserWindow（非透明、frameless、parent=主窗）。父子 z 序锁定——
// 浏览器永远浮在主窗之上；位置由我们每次布局变化时显式同步，
// 不存在 guest 视口同步问题。渲染层接口（browserSetBounds 等）保持不变。
//
// 坐标系：主窗 frame:false（自定义标题栏画在渲染层），窗口 bounds = 渲染层 viewport，
// 子窗位置 = 主窗原点 + 渲染层 rect。

import { BrowserWindow, ipcMain } from 'electron'
import {
  BROWSER_GO_BACK,
  BROWSER_GO_FORWARD,
  BROWSER_NAVIGATE,
  BROWSER_RELOAD,
  BROWSER_SET_BOUNDS,
  BROWSER_STATE
} from '@shared/ipc-channels'

const START_URL = 'https://www.bing.com'

let browserWin: BrowserWindow | null = null
let parentWin: BrowserWindow | null = null
/** 最近一次上报的 rect（相对主窗 viewport）——主窗移动/缩放时用它重新定位 */
let lastRect: { x: number; y: number; width: number; height: number } | null = null

function reportState(): void {
  if (
    browserWin === null ||
    browserWin.isDestroyed() ||
    parentWin === null ||
    parentWin.isDestroyed()
  ) {
    return
  }
  const wc = browserWin.webContents
  parentWin.webContents.send(BROWSER_STATE, {
    url: wc.getURL(),
    loading: wc.isLoading(),
    canBack: wc.navigationHistory.canGoBack(),
    canForward: wc.navigationHistory.canGoForward()
  })
}

/**
 * 把「相对主窗的占位 rect」换算成子窗绝对 bounds，并钉死在主窗内。
 * 占位 rect 因布局竞态短暂越界（比如比主窗还宽）时，子窗也绝不脱出主窗。
 * 纯函数导出供单测（OS 级拖窗边缘 CDP 模拟不了，钳制逻辑靠测试兜底）。
 */
export function clampChildBounds(
  parent: { x: number; y: number; width: number; height: number },
  rect: { x: number; y: number; width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const width = Math.min(rect.width, parent.width)
  const height = Math.min(rect.height, parent.height)
  const x = Math.min(parent.x + rect.x, parent.x + parent.width - width)
  const y = Math.min(parent.y + rect.y, parent.y + parent.height - height)
  return {
    x: Math.round(Math.max(parent.x, x)),
    y: Math.round(Math.max(parent.y, y)),
    width: Math.round(width),
    height: Math.round(height)
  }
}

function syncPosition(): void {
  if (browserWin === null || browserWin.isDestroyed() || parentWin === null || lastRect === null) {
    return
  }
  if (parentWin.isDestroyed() || parentWin.isMinimized()) return
  browserWin.setBounds(clampChildBounds(parentWin.getBounds(), lastRect))
}

export function registerBrowserIpc(): void {
  // bounds = 渲染层占位元素的 rect；null = 浏览器不可见（切 tab/收侧栏）→ 隐藏子窗
  ipcMain.on(BROWSER_SET_BOUNDS, (event, rect: unknown): void => {
    const sender = BrowserWindow.fromWebContents(event.sender)
    if (sender === null || sender.isDestroyed()) return

    if (rect === null || typeof rect !== 'object') {
      lastRect = null
      if (browserWin !== null && !browserWin.isDestroyed()) browserWin.hide()
      return
    }
    const r = rect as { x: number; y: number; width: number; height: number }
    if (!(r.width > 0 && r.height > 0)) {
      lastRect = null
      if (browserWin !== null && !browserWin.isDestroyed()) browserWin.hide()
      return
    }

    lastRect = { x: r.x, y: r.y, width: r.width, height: r.height }

    if (browserWin === null || browserWin.isDestroyed()) {
      browserWin = new BrowserWindow({
        width: Math.round(r.width),
        height: Math.round(r.height),
        show: false,
        frame: false,
        // 主窗是透明的，子窗必须不透明（白底）
        backgroundColor: '#ffffff',
        // parent 锁 z 序：永远浮在主窗之上
        parent: sender,
        // 必须禁 resize：frameless 窗默认 resizable=true，Windows 会给它一圈隐形
        // resize 边框——用户拉子窗左右缘会直接改顶层窗尺寸，脱出主窗占位区
        // （主窗 ResizeObserver 只盯占位 div，感知不到）。尺寸唯一来源=占位 rect。
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        title: '爱弥斯 · 浏览',
        webPreferences: {
          // 独立分区：与主窗 cookie/存储隔离
          partition: 'persist:rs-browser'
        }
      })
      browserWin.setMenu(null)
      browserWin.on('closed', () => {
        browserWin = null
      })
      const wc = browserWin.webContents
      wc.on('did-start-loading', () => reportState())
      wc.on('did-stop-loading', () => reportState())
      wc.on('did-navigate', () => reportState())
      wc.on('did-navigate-in-page', () => reportState())
      // 外链弹窗（target=_blank）交给系统浏览器，不在内嵌层开新窗
      wc.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) {
          void import('electron').then(({ shell }) => shell.openExternal(url))
        }
        return { action: 'deny' }
      })
      void wc.loadURL(START_URL)
    }

    parentWin = sender
    // 父窗移动/缩放 → 跟随（幂等绑定）
    if (!sender.listeners('move').includes(syncPosition)) {
      sender.on('move', syncPosition)
      sender.on('resize', syncPosition)
      sender.on('closed', () => {
        parentWin = null
        lastRect = null
      })
    }

    syncPosition()
    // showInactive：不抢焦点——用户正在聊天窗打字时开浏览器不该被踢出输入法
    if (!browserWin.isVisible()) browserWin.showInactive()
  })

  ipcMain.handle(BROWSER_NAVIGATE, (_e, raw: unknown): void => {
    if (browserWin === null || browserWin.isDestroyed()) return
    if (typeof raw !== 'string' || raw.trim() === '') return
    let target = raw.trim()
    // 与渲染层 normalize 同规则：无协议像域名补 https，否则当搜索词
    if (!/^https?:\/\//i.test(target)) {
      target = /^[\w-]+(\.[\w-]+)+(\/|$)/.test(target)
        ? `https://${target}`
        : `https://www.bing.com/search?q=${encodeURIComponent(target)}`
    }
    void browserWin.webContents.loadURL(target)
  })

  ipcMain.on(BROWSER_GO_BACK, () => {
    if (
      browserWin !== null &&
      !browserWin.isDestroyed() &&
      browserWin.webContents.navigationHistory.canGoBack()
    ) {
      browserWin.webContents.navigationHistory.goBack()
    }
  })

  ipcMain.on(BROWSER_GO_FORWARD, () => {
    if (
      browserWin !== null &&
      !browserWin.isDestroyed() &&
      browserWin.webContents.navigationHistory.canGoForward()
    ) {
      browserWin.webContents.navigationHistory.goForward()
    }
  })

  ipcMain.on(BROWSER_RELOAD, () => {
    if (browserWin !== null && !browserWin.isDestroyed()) browserWin.webContents.reload()
  })
}

/** 主窗关闭时清理（子窗随 parent 自动关，这里只清引用） */
export function disposeBrowserView(): void {
  browserWin = null
  parentWin = null
  lastRect = null
}
