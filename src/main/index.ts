// 主进程入口：应用生命周期、窗口装配、单实例锁。
// 单实例：二次启动不产生新进程，而是把已有主窗拉到前台。
// 职责边界：本文件只做"装配"，窗口创建逻辑在 windows/ 下；
// 业务能力（llm / agent / sessions / settings）由 T4–T5 逐个落地，不在此提前实现。

import { app, BrowserWindow, net } from 'electron'
import { join } from 'path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { markAppQuitting } from './windows/app-quit'
import { createMainWindow, registerMainWindowIpc, showMainWindow } from './windows/main-window'
import { createPetWindow, registerPetIpc, showPetWindow } from './windows/pet'
import { createTray, notifyHiddenToTray } from './windows/tray'
import { installMcpEnvResolver, registerSettingsIpc } from './settings/settings-ipc'
import { registerChatIpc } from './chat/run'
import { registerSessionsIpc } from './sessions/registry'
import { registerWorkspaceIpc } from './workspace/workspace-ipc'
import { registerTerminalIpc, shutdownTerminal } from './workspace/terminal-ipc'
import { registerUpdaterIpc, scheduleStartupUpdateCheck } from './updater/updater'
import { registerBrowserIpc } from './browser/browser-ipc'
import { setMemoryBase } from './memory/memory-store'
import { registerMemoryIpc } from './memory/memory-ipc'
import { syncBuiltinServers } from './mcp/builtin-sync'
import {
  setDescribeImageProbe,
  setToolPathBase,
  setToolVisibility,
  setSearchHistoryBase,
  setShellAllowlist,
  setPdfPrinter
} from './agent/tools/registry'
import { setNetFetch } from './net/fetch'
import { setJsRuntime } from './agent/tools/run-js'
import { printHtmlToPdf } from './pdf/print-pdf'
import { setSkillDirs, setSkillDisabled } from './agent/skills'
import { setLedgerBase } from './agent/tools/ledger'
import { setTodoBase } from './agent/tools/todo-store'
import { setCompactBase } from './chat/compact-store'
import { setNotesBase } from './agent/tools/note-store'
import { setProgressBase } from './agent/tools/progress-store'
import { setReviewBase } from './agent/tools/review-store'
import { sweepSessionStore } from './sessions/registry'
import { mcpManager } from './mcp/manager'
import { setScreenEnabled, setScreenProbe, windowsProbe } from './agent/tools/screen'
import { setOcrProbe, windowsOcrProbe } from './agent/tools/ocr'
import { makeVisionRunner } from './llm/vision'
import { readProfileKey } from './llm/secrets'
import { setMemoryEnabled } from './memory/gate'
import { setPermissionMode } from './chat/permission'
import { registerStickerScheme, registerStickerSupport } from './stickers'
import { registerFilePickIpc } from './file-pick'
import { sessionsDir, userDataDir, configDir, checkpointDir, logsDir, appRoot } from './paths'
import { appendDebugLog } from './log'
import { readAppConfig } from './settings/app-config'

// 自定义协议必须声明在 app ready 之前（sticker:// 服务表情包图片）
registerStickerScheme()

// CDP 探针端口（自动化验证依赖它）。默认 9222；端口被"幽灵占用"（进程已死但 socket
// 还在 LISTENING）时，用 AEMEATH_CDP_PORT 换一个即可，不必等系统回收。
app.commandLine.appendSwitch('remote-debugging-port', process.env.AEMEATH_CDP_PORT ?? '9222')

// 必须在 app ready 之前申请；第二个实例拿不到锁，走 app.quit() 直接退出
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // 二次启动：找回主窗与桌宠（桌宠被"隐藏桌宠"藏起来时，这也是一条找回路径）
    showMainWindow()
    showPetWindow()
  })

  // 退出前先打标记，放行桌宠窗的 close 拦截（否则 app.quit() 会被卡住）
  app.on('before-quit', markAppQuitting)
  // MCP server 子进程随应用退出关闭
  app.on('will-quit', () => {
    void mcpManager.stopAll()
    shutdownTerminal() // 终端 v2：退出前杀掉常驻 shell，不留孤儿进程
  })

  app.whenReady().then(() => {
    // Windows 任务栏与通知需要的应用标识
    electronApp.setAppUserModelId('com.aemeath.agent')

    // 开发期：F12 开关 DevTools；生产环境屏蔽刷新类快捷键（@electron-toolkit/utils 提供）
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    registerPetIpc()
    registerMainWindowIpc()
    registerSettingsIpc()
    registerChatIpc()
    registerSessionsIpc(sessionsDir())
    setMemoryBase(join(app.getPath('userData'), 'memory'))
    registerMemoryIpc()
    registerWorkspaceIpc()
    registerTerminalIpc()
    registerBrowserIpc()
    registerStickerSupport()
    registerFilePickIpc()
    registerUpdaterIpc()
    scheduleStartupUpdateCheck() // 打包态：启动 8s 后静默检查一次（失败不打扰）
    // 文件工具相对路径的解析基准 = 应用所在目录（dev 即项目根；验收实测缺陷修复）
    setToolPathBase(app.getAppPath())
    // 出站 fetch 走 Chromium 网络栈（P6：尊重系统代理——Clash 用户 web_search 的 DDG
    // 不再直连超时白等 12s；无代理用户由引擎健康度降权兜底）。Node fetch 不读系统代理。
    setNetFetch((input, init) => net.fetch(input as string, init))
    // run_js 的 Office 运行时（esbuild 预打包的 office-runtime.cjs，走 extraResources 进包）
    setJsRuntime({
      runtimePath: join(appRoot(), 'resources', 'office', 'office-runtime.cjs'),
      execPath: process.execPath
    })
    // export_pdf 的打印器（Chromium printToPDF，隐藏窗口一次性使用）
    setPdfPrinter(printHtmlToPdf)
    // 副作用账本根
    setLedgerBase(join(userDataDir(), 'ledger'))
    // 任务清单存储根
    setTodoBase(join(userDataDir(), 'todos'))
    // 上下文摘要存储根（P8-T1；启动只 setBase 不建目录，写入时自建）
    setCompactBase(join(userDataDir(), 'compact'))
    // 学习笔记存储根
    setNotesBase(join(userDataDir(), 'notes'))
    // 复习调度存储根
    setReviewBase(join(userDataDir(), 'review'))
    // 学习进度存储根
    setProgressBase(join(userDataDir(), 'progress'))
    // 历史会话搜索基准：复用会话存储根
    setSearchHistoryBase(sessionsDir())
    // MCP env 密钥解析器：manager 连接与设置页"测试连接"共用同一套读取逻辑
    installMcpEnvResolver()
    // 内置 MCP：先把内置项按当前安装路径补齐/校正（缺则补、过期则重建），
    // 再统一连接。同步是幂等的，且不触碰用户自配的 server。
    syncBuiltinServers()
    // MCP server 按配置连接；配置变更经 SETTINGS_CHANGED 广播后重新同步
    void mcpManager.sync(readAppConfig(configDir()).mcp.servers)
    // 屏幕感知：隐私默认关——初始开关读配置，真实探针注入
    setScreenProbe(windowsProbe)
    // 识图（P8-T3）：把"图 → 文字转述"的跑腿注入工具层（选视觉档案/取密钥在这里读配置）
    setDescribeImageProbe(
      makeVisionRunner({
        readConfig: () => readAppConfig(configDir()),
        readKey: (id) => readProfileKey(configDir(), id)
      })
    )
    const bootCfg = readAppConfig(configDir())
    setScreenEnabled(bootCfg.privacy.activeWindow)
    // 本机 OCR（P8-T3 第二条腿）：注入 Windows.Media.Ocr 探针（不联网、不上传）
    setOcrProbe(windowsOcrProbe)
    setMemoryEnabled(bootCfg.privacy.memory)
    // 权限模式：启动即同步"当前档位"，运行中切档由 settings-ipc 即时更新——
    // gate 原先在 run 开始时固化模式，切「完全访问」对正在跑的这轮不生效
    setPermissionMode(bootCfg.tools.permissionMode)
    // 工具可见性：按模式 allowlist，缺省全可见；设置保存后经 settings-ipc 即时更新
    setToolVisibility(readAppConfig(configDir()).tools.visibility)
    // run_shell 用户扩展白名单：与内置默认合并，设置保存后即时更新
    setShellAllowlist(readAppConfig(configDir()).tools.shell?.allowlist ?? [])
    // 技能：双来源目录（项目内 skills/ + userData/skills/）+ 禁用名单注入
    setSkillDirs(join(app.getAppPath(), 'skills'), join(userDataDir(), 'skills'))
    setSkillDisabled(readAppConfig(configDir()).skills.disabled)
    // 会话存储一致性清扫：孤儿条目 / .bak 残留 / 孤儿旁路档
    try {
      const sweep = sweepSessionStore(sessionsDir(), {
        ledger: join(userDataDir(), 'ledger'),
        todos: join(userDataDir(), 'todos'),
        notes: join(userDataDir(), 'notes'),
        checkpoint: checkpointDir(),
        compact: join(userDataDir(), 'compact')
      })
      if (
        sweep.prunedRegistry.length > 0 ||
        sweep.removedResiduals > 0 ||
        sweep.cleanedArchives > 0
      ) {
        appendDebugLog(
          logsDir(),
          `[sweep] 会话存储清扫：孤儿条目 ${sweep.prunedRegistry.length}（${sweep.prunedRegistry.join('、')}），残留 ${sweep.removedResiduals}，孤儿旁路档 ${sweep.cleanedArchives}`
        )
      }
    } catch {
      /* 清扫失败不阻塞启动 */
    }
    const main = createMainWindow()
    createPetWindow()
    createTray()
    // 关窗 = 最小化到托盘：首次隐藏时气泡提示一次（程序仍在运行、去哪找回）
    main.on('hide', () => notifyHiddenToTray())

    app.on('activate', () => {
      // macOS：点 Dock 图标且无窗口时重建主窗（Windows 下不触发此事件）
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  // 桌宠窗常驻后，"所有窗口关闭"在正常使用中不会发生（桌宠无关闭入口，只能整体退出）。
  // 保留此兜底：万一真的一个窗口都不剩，应用退出而不是空转。
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
