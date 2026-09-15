// userData 路径常量。
// 所有落盘位置集中在这里定义，业务代码禁止散落拼路径。
// 导出成函数而非常量：app.getPath() 必须在应用 ready 之后调用，函数可避免模块加载期取值。

import { join } from 'path'
import { app } from 'electron'

/** Electron userData 根目录（Windows 下通常在 %APPDATA%/aemeath-agent） */
export function userDataDir(): string {
  return app.getPath('userData')
}

/** 配置目录：app.json（应用配置）与 secrets.bin（safeStorage 加密的 apiKey） */
export function configDir(): string {
  return join(userDataDir(), 'config')
}

/** 会话目录：每个会话一个子目录 <id>/{meta.json, messages.jsonl} */
export function sessionsDir(): string {
  return join(userDataDir(), 'sessions')
}

/** 日志目录：主进程关键失败的落盘取证（logs/aemeath.log，见 main/log.ts） */
export function logsDir(): string {
  return join(userDataDir(), 'logs')
}

/**
 * 随包只读资源根目录（人设 / 图标 / 表情包的基准）。
 *
 * 为什么要分叉：dev 下 app.getAppPath() 就是项目根；但打包后 getAppPath() 指向
 * `<安装目录>/resources/app.asar`，而 personas/ 与 resources/ 是 **asar 外**的实体目录
 * （electron-builder extraResources 原样铺到 `<安装目录>/resources/` 下）。
 * 因此打包态必须用 process.resourcesPath。两态下 personas/、resources/ 的相对层级完全一致，
 * 所以下游函数写法不变、只换基准。
 *
 * 教训：P3 打包首版 `build.files` 只含 out/**+package.json，personas/ 与 resources/
 * 双双漏包 → 安装版无人设（发消息直接报错）、无窗口图标、表情包面板空。实机验收才暴露。
 */
export function appRoot(): string {
  return app.isPackaged ? process.resourcesPath : app.getAppPath()
}

/** 人设目录：personas/<name>/{soul.md, style.md}（随仓库分发；打包经 extraResources 随包） */
export function personasDir(): string {
  return join(appRoot(), 'personas')
}

/** 表情包目录：resources/stickers/*.gif（随项目分发，不进 git；经 sticker:// 协议服务） */
export function stickersDir(): string {
  return join(appRoot(), 'resources', 'stickers')
}

/** 应用图标（窗口 / 任务栏）：resources/icon.png */
export function appIconPath(): string {
  return join(appRoot(), 'resources', 'icon.png')
}

/**
 * checkpoint 目录：可恢复执行的状态快照将存放在这里。
 * 这里只保留常量、不创建不写入；接入 harness 时由相应模块负责初始化。
 */
export function checkpointDir(): string {
  return join(userDataDir(), 'checkpoint')
}
