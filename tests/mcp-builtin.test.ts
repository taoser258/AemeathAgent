// / 纯逻辑单测：
// - process-tree: 进程树终结的安全边界（不误杀、非 win32 不动作）
// - builtin: 内置服务器自愈同步（补缺 / 校正过期 / 下架清理 / 尊重用户删除 / 不碰用户配置）

import { describe, expect, it } from 'vitest'
import { killProcessTree } from '../src/main/mcp/process-tree'
import {
  BUILTIN_DEFINITIONS,
  PLAYWRIGHT_BUILTIN_ID,
  PLAYWRIGHT_BUILTIN_KEY,
  buildPlaywrightConfig,
  ensureBuiltinServers,
  resolvePlaywrightCliPath,
  type BuiltinContext,
  type BuiltinDefinition
} from '../src/main/mcp/builtin'
import type { AppConfig } from '../src/shared/types'

type ServerConfig = AppConfig['mcp']['servers'][number]

const CTX: BuiltinContext = { outputDir: 'C:/data/mcp-output/playwright' }
/** 当前环境下解析出的真实 cli 路径（同步逻辑用的就是它，所以测试必须拿它对比） */
const REAL_CLI = resolvePlaywrightCliPath()
/** 一个"故意过期"的路径，模拟应用升级后安装位置变化 */
const STALE_CLI = 'C:/旧安装位置/node_modules/@playwright/mcp/cli.js'

function server(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: 'user-1',
    name: '用户自己配的',
    command: 'npx',
    args: ['-y', 'some-server'],
    enabled: true,
    ...over
  }
}

function builtinServer(over: Partial<ServerConfig> = {}): ServerConfig {
  return { ...buildPlaywrightConfig(REAL_CLI, CTX), enabled: true, ...over }
}

/** 一个可控的假内置定义，便于测各种分支 */
function fakeDef(build: BuiltinDefinition['build']): BuiltinDefinition {
  return { key: 'fake', label: '假内置', desc: '测试用', build }
}

describe('mcp/process-tree · 进程树终结的安全边界', () => {
  it('非法 pid 一律不动手（0 / 负数 / 非整数都不该去 kill）', () => {
    expect(killProcessTree(0)).toBe(false)
    expect(killProcessTree(-1)).toBe(false)
    expect(killProcessTree(1.5)).toBe(false)
    expect(killProcessTree(Number.NaN)).toBe(false)
  })

  it('不存在的 pid：返回 false 而不抛异常（清理路径不能因为进程已死就崩）', () => {
    // 用一个几乎不可能存在的 pid；taskkill 会失败，函数必须吞掉
    expect(() => killProcessTree(999_999)).not.toThrow()
  })
})

describe('mcp/builtin · Playwright 配置构造', () => {
  it('用 process.execPath 当 Node（用户不需要装 Node/npx）+ ELECTRON_RUN_AS_NODE', () => {
    const cfg = buildPlaywrightConfig(REAL_CLI, CTX)
    expect(cfg.command).toBe(process.execPath)
    expect(cfg.env?.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('默认无头 + 系统 Edge（免下载 Chromium）+ 隔离档案 + 产物落到应用数据目录', () => {
    const cfg = buildPlaywrightConfig(REAL_CLI, CTX)
    expect(cfg.args).toContain('--headless')
    expect(cfg.args).toContain('msedge')
    expect(cfg.args).toContain('--isolated')
    expect(cfg.args[cfg.args.indexOf('--output-dir') + 1]).toBe(CTX.outputDir)
    // cli.js 必须是绝对路径的第一项（先于所有选项）
    expect(cfg.args[0]).toBe(REAL_CLI)
  })

  it('★ cwd 也钉到产物目录：显式 filename 的截图按进程 CWD 解析，不能落进仓库/安装目录', () => {
    expect(buildPlaywrightConfig(REAL_CLI, CTX).cwd).toBe(CTX.outputDir)
  })

  it('默认启用（依赖随包分发 → 开箱可用）+ 命名空间固定为 browser + 超时放宽到 2 分钟', () => {
    const cfg = buildPlaywrightConfig(REAL_CLI, CTX)
    expect(cfg.enabled).toBe(true)
    expect(cfg.serverName).toBe('browser')
    expect(cfg.toolCallTimeoutMs).toBe(120_000)
    expect(cfg.builtin).toBe(PLAYWRIGHT_BUILTIN_KEY)
  })
})

describe('mcp/builtin · 自愈式同步', () => {
  it('配置里没有 → 补一条（默认启用，开箱可用）', () => {
    const r = ensureBuiltinServers([server()], [], CTX)
    expect(r.changed).toBe(true)
    expect(r.servers).toHaveLength(2)
    const added = r.servers.find((s) => s.builtin === PLAYWRIGHT_BUILTIN_KEY)
    expect(added?.enabled).toBe(true)
    expect(added?.id).toBe(PLAYWRIGHT_BUILTIN_ID)
  })

  it('已存在且参数一致 → 不改动（幂等：重复启动不会反复写盘）', () => {
    const r = ensureBuiltinServers([builtinServer()], [], CTX)
    expect(r.changed).toBe(false)
    expect(r.servers).toHaveLength(1)
  })

  it('★ 老配置缺 cwd（此前截图会落进应用目录）→ 自愈同步补上，不需用户手动改', () => {
    const { cwd: _dropped, ...noCwd } = builtinServer()
    const r = ensureBuiltinServers([noCwd as ReturnType<typeof builtinServer>], [], CTX)
    expect(r.changed).toBe(true)
    expect(r.servers[0].cwd).toBe(CTX.outputDir)
    // 校正后必须收敛：再同步一次不该再判"过期"（否则每次启动都白写一次配置）
    expect(ensureBuiltinServers(r.servers, [], CTX).changed).toBe(false)
  })

  it('★ 参数过期（应用升级后安装路径变化）→ 就地校正，但保留用户的开关与偏好', () => {
    const stale = builtinServer({
      command: 'C:/旧路径/electron.exe',
      args: [STALE_CLI],
      enabled: true, // 用户开着的
      modes: ['work'], // 用户改过的
      name: '我的浏览器'
    })
    const r = ensureBuiltinServers([stale], [], CTX)
    expect(r.changed).toBe(true)
    const fixed = r.servers[0]
    expect(fixed.id).toBe(stale.id) // id 不变（工具命名空间跟着它，不能漂）
    expect(fixed.command).toBe(process.execPath)
    expect(fixed.args[0]).toBe(REAL_CLI) // 校正回当前环境的真实路径
    expect(fixed.enabled).toBe(true) // 用户开着 → 校正后仍然开着
    expect(fixed.modes).toEqual(['work']) // 用户的偏好不被覆盖
    expect(fixed.name).toBe('我的浏览器')
  })

  it('★ 用户手动停用过的 → 校正后仍保持停用（默认启用不得覆盖用户选择）', () => {
    // 默认值由 false 改 true 时补的守护：改动只应影响"新补齐"的项，
    // 已经存在的项必须尊重用户开关（否则用户会觉得"我关了它又自己开了"）。
    const off = builtinServer({
      command: 'C:/旧路径/electron.exe',
      args: [STALE_CLI],
      enabled: false // 用户主动关掉的
    })
    const r = ensureBuiltinServers([off], [], CTX)
    expect(r.changed).toBe(true) // 路径过期 → 连接参数被校正
    expect(r.servers[0].enabled).toBe(false) // 但开关保持用户的选择，不被默认值翻回来
  })

  it('用户主动删过（removedBuiltins）→ 不再补回（否则"删了又回来"很恼人）', () => {
    const r = ensureBuiltinServers([server()], [PLAYWRIGHT_BUILTIN_KEY], CTX)
    expect(r.changed).toBe(false)
    expect(r.servers).toHaveLength(1)
  })

  it('内置项已下架（key 不在清单里）→ 清理掉', () => {
    const legacy = builtinServer({ builtin: 'legacy-removed' })
    const r = ensureBuiltinServers([server(), legacy], [], CTX)
    expect(r.changed).toBe(true)
    expect(r.servers.some((s) => s.builtin === 'legacy-removed')).toBe(false)
  })

  it('★ 绝不触碰用户自配的 server（无论补/改/删哪条路径）', () => {
    const mine = server({ id: 'mine', name: '我的 MCP', command: 'node', args: ['x.mjs'] })
    const withStale = ensureBuiltinServers(
      [mine, builtinServer({ command: 'C:/旧/electron.exe' })],
      [],
      CTX
    )
    expect(withStale.servers.find((s) => s.id === 'mine')).toEqual(mine)
    const withAdd = ensureBuiltinServers([mine], [], CTX)
    expect(withAdd.servers.find((s) => s.id === 'mine')).toEqual(mine)
  })

  it('构建失败（如依赖缺失）→ 保持现状，不因为内置项坏了就动用户配置', () => {
    const defs = [
      fakeDef(() => {
        throw new Error('依赖缺失')
      })
    ]
    const mine = server()
    const r = ensureBuiltinServers([mine], [], CTX, defs)
    expect(r.changed).toBe(false)
    expect(r.servers).toEqual([mine])
  })

  it('内置项的 build 抛错时，已有条目保持原样（不会被清掉）', () => {
    const defs = [
      fakeDef(() => {
        throw new Error('x')
      })
    ]
    const existing = server({ id: 'b', builtin: 'fake' })
    const r = ensureBuiltinServers([existing], [], CTX, defs)
    expect(r.servers).toEqual([existing])
  })

  it('默认清单里确实注册了 Playwright（防手滑删掉注册项）', () => {
    expect(BUILTIN_DEFINITIONS.some((d) => d.key === PLAYWRIGHT_BUILTIN_KEY)).toBe(true)
  })
})
