/**
 * 自动更新。
 *
 * 现实约束（评估结论）：
 * · 渠道 = 发布库 taoser258/AemeathAgent（public）的 GitHub Releases，publish 配置
 *   写在 package.json 的 build 段（github provider），代码侧无需改动。
 *   2026-09-17 实测：v0.3.1 打包版 updateCheck() 由 not-available → available
 *   0.3.2-alpha，链路通。（此前注释里"仓库是私有库、本机无 gh/PAT，渠道要等条件
 *   成熟"的顾虑已随仓库公开作废。）
 * · 「失败静默降级不弹窗骚扰」：启动后延迟自动检查一次，任何失败
 * （404/断网/无 latest.yml）只记状态、不弹任何窗；「检查更新」按钮在关于页，
 * 用户主动触发才有反馈。
 * · autoDownload=false：发现新版本先问（渲染层出「下载」按钮），下载完成后
 * 再问「重启安装」——改用户机器的动作一律过用户的手（红线②同款精神）。
 * · dev（未打包）不初始化：electron-updater 在 dev 下拿不到安装器语义；关于页
 * 据此显示「仅安装版可用」。
 *
 * 演练通道：环境变量 AEMEATH_UPDATE_FEED=generic:<url> 把源指到本地假服务器
 * （验收用假源演练；正常发布不设这个变量，走 package.json build 里的 github 配置）。
 */
import { app, ipcMain, shell, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import {
  UPDATE_CHECK,
  UPDATE_DOWNLOAD,
  UPDATE_OPEN_RELEASES,
  UPDATE_QUIT_INSTALL,
  UPDATE_STATUS,
  UPDATE_STATUS_GET
} from '@shared/ipc-channels'
import type { UpdateStatus } from '@shared/types'

let lastStatus: UpdateStatus = { state: 'idle' }
let availableVersion: string | null = null

/** 状态广播给所有窗口（关于页在设置窗；autoUpdater 事件不来自任何 IPC 调用，需持久广播） */
function broadcast(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(UPDATE_STATUS, lastStatus)
  }
}

function setStatus(next: UpdateStatus): void {
  lastStatus = next
  broadcast()
}

export function registerUpdaterIpc(): void {
  // 假源演练通道：AEMEATH_UPDATE_FEED=generic:http://127.0.0.1:8123/
  const feed = process.env.AEMEATH_UPDATE_FEED
  if (typeof feed === 'string' && feed.startsWith('generic:')) {
    autoUpdater.setFeedURL({ provider: 'generic', url: feed.slice('generic:'.length) })
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.disableWebInstaller = true // Windows NSIS：用原生安装器而非自带 web 安装
  // 对齐发布库 taoser258/AemeathAgent 的 release（只挂 latest.yml + setup.exe）：
  // ① 当前版本带 -alpha 预发布后缀时，electron-updater 默认按预发布名找渠道文件
  //   （alpha.yml），发布库上没有 → 永远 404。显式锁回 latest.yml。
  // ② latest.yml 里的候选版本同样是预发布版，默认会被过滤掉，allowPrerelease 放行。
  autoUpdater.channel = 'latest'
  autoUpdater.allowPrerelease = true

  autoUpdater.on('error', (err) => {
    // 静默降级：状态记给关于页，不弹窗（启动自动检查失败也走这里）
    setStatus({ state: 'error', error: String(err?.message ?? err).slice(0, 200) })
  })
  autoUpdater.on('update-available', (info) => {
    availableVersion = info.version
    setStatus({ state: 'available', version: info.version })
  })
  autoUpdater.on('update-not-available', () => setStatus({ state: 'not-available' }))
  autoUpdater.on('download-progress', (p) => {
    setStatus({
      state: 'downloading',
      version: availableVersion ?? undefined,
      percent: Math.round(p.percent)
    })
  })
  autoUpdater.on('update-downloaded', (info) =>
    setStatus({ state: 'downloaded', version: info.version })
  )

  // 只读对账：渲染层挂载时问一次当前状态（主窗设置入口的「有新版本」角标靠它），
  // 这里**不做任何网络检查**——真正的检查只有启动后那一次和关于页用户主动点。
  ipcMain.handle(UPDATE_STATUS_GET, (): UpdateStatus => lastStatus)

  ipcMain.handle(UPDATE_CHECK, async (): Promise<UpdateStatus> => {
    if (!app.isPackaged) {
      setStatus({ state: 'idle', dev: true })
      return lastStatus
    }
    setStatus({ state: 'checking' })
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      // checkForUpdates 抛错（网络/404）时 error 事件未必触发，这里兜底记状态
      if (lastStatus.state === 'checking') {
        setStatus({ state: 'error', error: String(err).slice(0, 200) })
      }
    }
    return lastStatus
  })

  ipcMain.handle(UPDATE_DOWNLOAD, async (): Promise<UpdateStatus> => {
    if (!app.isPackaged) return { state: 'idle', dev: true }
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      if (lastStatus.state !== 'downloading' && lastStatus.state !== 'downloaded') {
        setStatus({ state: 'error', error: String(err).slice(0, 200) })
      }
    }
    return lastStatus
  })

  ipcMain.handle(UPDATE_QUIT_INSTALL, (): { ok: boolean } => {
    // quitAndInstall 触发 before-quit → markAppQuitting 已接线（app-quit.ts），
    // 桌宠窗的 close 拦截不会卡住退出
    try {
      autoUpdater.quitAndInstall(false, true)
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  // 无新动作可点时的出口：打开 Releases 页手动下载
  ipcMain.handle(UPDATE_OPEN_RELEASES, (): { ok: boolean } => {
    void shell.openExternal('https://github.com/taoser258/AemeathAgent/releases')
    return { ok: true }
  })
}

/** 打包态下启动后延迟自动检查一次（静默；失败不留状态给 UI） */
export function scheduleStartupUpdateCheck(): void {
  if (!app.isPackaged) return
  setTimeout(() => {
    autoUpdater
      .checkForUpdates()
      .then(() => {
        // 无新版本且无 error 事件时，把 checking 归一回 idle（不打扰）
        if (lastStatus.state === 'checking') setStatus({ state: 'idle' })
      })
      .catch(() => {
        // 静默：启动自动检查失败不留任何状态给 UI
        if (lastStatus.state === 'checking') lastStatus = { state: 'idle' }
      })
  }, 8_000)
}
