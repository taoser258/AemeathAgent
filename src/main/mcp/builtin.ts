// 内置 MCP 服务器。
//
// 背景：普通 MCP server 要用户自己会写命令、装运行时（npx 要 Node）。这对"桌面伴侣"太苛刻。
// 内置的思路（借鉴 成熟实现的 sync-mcp-builtin）：
// - 用 **应用自己的可执行文件** 当 Node（`process.execPath` + `ELECTRON_RUN_AS_NODE=1`），
// 直接跑打包内的 @playwright/mcp/cli.js —— 用户不需要装 Node，也不需要 npx。
// - `--browser msedge` 用系统自带的 Edge，**不需要下载 Chromium**（那有上百 MB）。
// - 版本在 package.json 里**精确锁定**（不带 ^），避免上游漂移把行为改掉。
//
// 自愈式同步：以"持久化配置"为事实源，而不是运行时连接状态。
// - 配置里没有 → 补一条（默认启用，开箱可用）
// - 配置有但命令/参数过期（应用升级后安装路径变了）→ 就地校正重建
// - 内置项已下架 → 清理掉
// - 用户主动删除过 → 不再补（记在 config.mcp.removedBuiltins），否则"删了又回来"很恼人
// - **绝不触碰用户自己配的 server**

import { dirname, join, sep } from 'path'
import type { AppConfig } from '@shared/types'
import { builtinInfo } from '@shared/mcp-presets'

export type ServerConfig = AppConfig['mcp']['servers'][number]

/** 内置 server 的构造上下文（运行时才知道的值由调用方注入，本模块不 import electron） */
export interface BuiltinContext {
  /** 浏览器产出的截图/快照等文件放哪（不设会落到工作目录，污染项目） */
  outputDir: string
}

export interface BuiltinDefinition {
  /** 内置标识（写进 config.mcp.servers[].builtin） */
  key: string
  /** 设置页显示名 */
  label: string
  /** 一句话说明（说清"开了能干什么"） */
  desc: string
  /** 构造当前环境下的标准配置（路径随安装位置变化，所以每次现算，不缓存） */
  build(ctx: BuiltinContext): ServerConfig
}

/** Playwright 内置项标识 */
export const PLAYWRIGHT_BUILTIN_KEY = 'playwright'

/** 内置项的固定 id（稳定：命名空间跟着它派生，工具名才不会变） */
export const PLAYWRIGHT_BUILTIN_ID = 'builtin-playwright'

/**
 * 解析打包内 @playwright/mcp/cli.js 的绝对路径。
 *
 * 两个坑（已有人踩过，照抄结论）：
 * 1. 该包的 `exports` 只暴露 `./package.json` 与 `.`，直接 resolve 'cli.js' 会失败
 * → 先定位包根，再拼 cli.js。
 * 2. 打包后这个包被 asarUnpack 到 app.asar.unpacked；`require.resolve` 返回的是
 * asar 虚拟路径，而以 ELECTRON_RUN_AS_NODE 模式运行的 Electron **读不了 asar**
 * → 把 app.asar 段替换成 app.asar.unpacked。
 */
export function resolvePlaywrightCliPath(): string {
  const pkgJson = require.resolve('@playwright/mcp/package.json')
  const cli = join(dirname(pkgJson), 'cli.js')
  return cli.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
}

/**
 * 构造 Playwright 内置项的配置（**纯函数**，cli 路径由参数传入 → 可单测）。
 *
 * 参数选择说明：
 * - `--isolated`：浏览器档案放内存不落盘，用完即走，不污染用户真实浏览器
 * - `--headless`：无头运行。桌面应用里弹一个真窗口会抢焦点、打断用户；
 * 需要看过程时用户可自行在设置页把 `--headless` 去掉（参数可编辑）
 * - `--browser msedge`：用系统 Edge，免下载 Chromium
 * - `--output-dir`：截图/页面快照落到应用数据目录，不落到工作目录
 * - `cwd`：**子进程工作目录也钉到同一个目录**。`--output-dir` 只管自动命名的产物，
 *   而 `browser_take_screenshot` 带 `filename` 时是按**进程 CWD** 解析的——
 *   CWD 缺省继承应用目录，于是截图落进仓库根/安装目录（2026-09-17 实测：
 *   一次奶牛任务在仓库根留下 cow-shot-1.png / cow-shot-2.png / cow-zoom.png）。
 */
export function buildPlaywrightConfig(cliPath: string, ctx: BuiltinContext): ServerConfig {
  return {
    id: PLAYWRIGHT_BUILTIN_ID,
    name: 'Playwright 浏览器',
    serverName: 'browser',
    command: process.execPath,
    args: [
      cliPath,
      '--isolated',
      '--headless',
      '--browser',
      'msedge',
      '--output-dir',
      ctx.outputDir
    ],
    cwd: ctx.outputDir,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    // 浏览器操作天然比普通工具慢（导航、等待选择器），给 2 分钟；仍可按 server 覆盖
    toolCallTimeoutMs: 120_000,
    // 学习模式也用得上（查资料、看文档）——真正危险的是"改本地文件"，不是读网页
    modes: ['work', 'learn'],
    builtin: PLAYWRIGHT_BUILTIN_KEY,
    // 默认启用：依赖已打进包（asarUnpack）且用应用自带运行时启动，
    // 零外部依赖 → 新用户装完即可用浏览器，不必自己去设置页点一下。
    // 只影响"新补齐"的项：已存在的项由同步逻辑保留用户开关（见 ensureBuiltinServers ③），
    // 所以用户手动停用过的不会被这里覆盖。
    enabled: true
  }
}

/** 内置项清单（新内置项加在这里即可；label/desc 从 shared 文案表取，避免两处维护） */
export const BUILTIN_DEFINITIONS: BuiltinDefinition[] = [
  {
    key: PLAYWRIGHT_BUILTIN_KEY,
    label: builtinInfo(PLAYWRIGHT_BUILTIN_KEY)?.label ?? 'Playwright 浏览器',
    desc: builtinInfo(PLAYWRIGHT_BUILTIN_KEY)?.desc ?? '',
    build: (ctx) => buildPlaywrightConfig(resolvePlaywrightCliPath(), ctx)
  }
]

/** 两条配置在"连接相关字段"上是否等价（用于判断内置项是否过期） */
function sameConnection(a: ServerConfig, b: ServerConfig): boolean {
  return (
    a.command === b.command &&
    JSON.stringify(a.args) === JSON.stringify(b.args) &&
    JSON.stringify(a.env ?? {}) === JSON.stringify(b.env ?? {}) &&
    (a.cwd ?? '') === (b.cwd ?? '')
  )
}

/**
 * 自愈式同步。
 *
 * @param servers 当前配置里的 server 列表
 * @param removed 用户主动删除过的内置 key（不再补回）
 * @returns 新的列表 + 是否有变化（调用方据此决定要不要写盘）
 */
export function ensureBuiltinServers(
  servers: ServerConfig[],
  removed: string[],
  ctx: BuiltinContext,
  defs: BuiltinDefinition[] = BUILTIN_DEFINITIONS
): { servers: ServerConfig[]; changed: boolean } {
  const knownKeys = new Set(defs.map((d) => d.key))
  let changed = false
  let next = [...servers]

  // ① 清理：内置项已下架（key 不在清单里）→ 移除；用户自配的（无 builtin）一律不动
  const filtered = next.filter((s) => s.builtin === undefined || knownKeys.has(s.builtin))
  if (filtered.length !== next.length) {
    next = filtered
    changed = true
  }

  for (const def of defs) {
    // 用户主动删过 → 尊重用户选择，不再补回
    if (removed.includes(def.key)) continue

    const index = next.findIndex((s) => s.builtin === def.key)
    let expected: ServerConfig
    try {
      expected = def.build(ctx)
    } catch {
      // 构建失败（如依赖缺失）：保持现状，不因为内置项坏了就动用户配置
      continue
    }

    if (index === -1) {
      // ② 缺失 → 补一条（默认启用，见 buildPlaywrightConfig）
      next = [...next, expected]
      changed = true
      continue
    }

    const existing = next[index]
    if (!sameConnection(existing, expected)) {
      // ③ 过期（应用升级后安装路径变化等）→ 就地校正：
      // 保留用户的 id / 名称 / 开关 / 命名空间 / 适用模式 / 超时，只把连接参数换新
      const fixed: ServerConfig = {
        ...existing,
        command: expected.command,
        args: expected.args
      }
      // env / cwd 由内置定义**整体拥有**：定义里没有的就从配置里删掉。
      // 否则 sameConnection 永远判不等 → 每次启动都白写一次配置
      // （2026-09-17 实测：只搬 command/args/env 时，新加的 cwd 永远补不进去）。
      if (expected.env !== undefined) fixed.env = expected.env
      else delete fixed.env
      if (expected.cwd !== undefined) fixed.cwd = expected.cwd
      else delete fixed.cwd
      next[index] = fixed
      changed = true
    }
  }

  return { servers: next, changed }
}

/** 该配置是否为指定内置项 */
export function isBuiltin(server: ServerConfig, key: string): boolean {
  return server.builtin === key
}
