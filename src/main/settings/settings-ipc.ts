// 设置类 IPC：读（含可用人设列表与密钥状态）、写、密钥、测试连接。
// 密钥只写不读回：SETTINGS_GET 的载荷只带 keyedProfileIds（已配密钥的档案 id），
// 绝不下发明文（红线③）。

import { mkdirSync } from 'fs'
import { BrowserWindow, ipcMain, shell } from 'electron'
import {
  LEDGER_LIST,
  MCP_BUILTIN_RESTORE,
  MCP_SET_SECRET,
  MCP_TEST,
  SETTINGS_CHANGED,
  SETTINGS_GET,
  SETTINGS_HAS_API_KEY,
  SETTINGS_SET,
  SETTINGS_SET_API_KEY,
  SETTINGS_TEST_CONNECTION,
  SKILLS_OPEN_DIR
} from '@shared/ipc-channels'
import type { AppConfig, McpTestResult, SettingsReadModel } from '@shared/types'
import { applySettingsPatch, readAppConfig, writeAppConfig } from './app-config'
import { configDir, personasDir } from '../paths'
import { listChanges } from '../agent/tools/ledger'
import { mcpManager } from '../mcp/manager'
import { setScreenEnabled } from '../agent/tools/screen'
import { setMemoryEnabled } from '../memory/gate'
import { setToolVisibility, setShellAllowlist } from '../agent/tools/registry'
import { setPermissionMode } from '../chat/permission'
import { getUserSkillsDir, listSkills, setSkillDisabled } from '../agent/skills'
import { ensureLearnVault } from '../agent/workspace'
import { appendDebugLog } from '../log'
import { logsDir } from '../paths'
import { SKILLS_LIST } from '@shared/ipc-channels'
import type { SkillMeta } from '@shared/types'
import {
  configuredMcpSecretKeys,
  hasAnyApiKey,
  keyedProfileIds,
  pruneKeys,
  pruneMcpSecrets,
  readMcpSecret,
  readProfileKey,
  writeMcpSecret,
  writeProfileKey,
  mcpSecretKey
} from '../llm/secrets'
import { listPersonas, loadPersona } from '../agent/persona'
import { buildSystemPrompt } from '../agent/prompt'
import { testConnection } from '../llm/client'
import { matchPresetByBaseUrl } from '@shared/model-presets'
import { testMcpServer } from '../mcp/test-connection'
import { restoreBuiltinServer } from '../mcp/builtin-sync'
import { secretRefsIn } from '../mcp/env'
import { effectiveNamespace } from '@shared/mcp-presets'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 收集配置里所有 MCP 密钥 id（用于清理孤儿密钥）。
 * **包含 enabled=false 的 server**：用户可能只是临时关掉，密钥不该被清掉。
 */
function collectMcpSecretIds(servers: AppConfig['mcp']['servers']): string[] {
  const ids: string[] = []
  for (const s of servers) {
    const ns = effectiveNamespace(s)
    for (const name of secretRefsIn(s.env)) ids.push(mcpSecretKey(ns, name))
  }
  return ids
}

/**
 * 读取 MCP env 密钥（本模块是唯一接触 safeStorage 的地方）。
 * manager 与设置页"测试连接"共用同一份读取逻辑，避免两套规则漂移。
 */
function mcpEnvResolver(): (namespace: string, varName: string) => string | null {
  return (namespace, varName) => readMcpSecret(configDir(), namespace, varName)
}

/** 注入 MCP env 密钥解析器（应用启动时调一次）：连接与测试连接共用 */
export function installMcpEnvResolver(): void {
  mcpManager.setEnvResolver(mcpEnvResolver())
}

export function registerSettingsIpc(): void {
  ipcMain.handle(SETTINGS_GET, (): SettingsReadModel => {
    const config = readAppConfig(configDir())
    // 人设 system prompt 字符数：渲染层输入区的上下文用量估算用（每次进入/切换人设后读一次）
    let personaPromptChars = 0
    try {
      const persona = loadPersona(personasDir(), config.persona.active)
      if (persona !== null) {
        personaPromptChars = buildSystemPrompt(persona, {
          now: new Date(),
          // 与真实发送（chat/run.ts）保持一致：用户信息也计入上下文占用估算
          user: { nickname: config.user.nickname, about: config.user.about },
          bubbleLevel: config.pet.bubbleLevel
        }).length
      }
    } catch {
      personaPromptChars = 0
    }
    return {
      config,
      personas: listPersonas(personasDir()),
      keyedProfileIds: keyedProfileIds(configDir(), config),
      personaPromptChars,
      keyedMcpSecretIds: configuredMcpSecretKeys(configDir())
    }
  })

  ipcMain.handle(SETTINGS_SET, (_event, patch: unknown): AppConfig => {
    const current = readAppConfig(configDir())
    const next = applySettingsPatch(current, isRecord(patch) ? (patch as never) : {})
    writeAppConfig(configDir(), next)
    // 档案被删除时同步清掉它的密钥，避免孤儿密钥留存
    pruneKeys(
      configDir(),
      next.model.profiles.map((p) => p.id)
    )
    // MCP server 被删除/改名时同步清掉它的 env 密钥：
    // 保留名单 = 当前启用配置里出现的所有 mcp:<命名空间>:<变量名>
    pruneMcpSecrets(configDir(), collectMcpSecretIds(next.mcp.servers))
    // 配置写回广播：主窗的上下文环/模型名等订阅后即时刷新
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(SETTINGS_CHANGED)
    }
    // MCP server 启停即时同步：增删/改配置/启停不需要重启应用
    if (isRecord(patch) && (patch as Record<string, unknown>).mcp !== undefined) {
      void mcpManager.sync(next.mcp.servers)
    }
    // 屏幕感知开关即时同步：隐私开关变更立刻进/出工具注册表
    if (isRecord(patch) && (patch as Record<string, unknown>).privacy !== undefined) {
      setScreenEnabled(next.privacy.activeWindow)
      setMemoryEnabled(next.privacy.memory)
    }
    // 工具可见性即时同步：勾选变更立刻进/出工具注册表
    if (isRecord(patch) && (patch as Record<string, unknown>).tools !== undefined) {
      setToolVisibility(next.tools.visibility)
      // run_shell 白名单即时同步：扩展名单变更立刻生效
      setShellAllowlist(next.tools.shell?.allowlist ?? [])
      // 权限模式即时同步：切「完全访问」对**正在跑的这一轮**立即生效，
      // 不用等下一次发消息
      setPermissionMode(next.tools.permissionMode)
    }
    // 技能禁用名单即时同步：开关变更立刻进/出 skill_use 与附录清单
    if (isRecord(patch) && (patch as Record<string, unknown>).skills !== undefined) {
      setSkillDisabled(next.skills.disabled)
    }
    // 工作区绑定：learn 绑定空目录时初始化笔记 vault（幂等）；结果落 debug 日志
    if (isRecord(patch) && isRecord((patch as Record<string, unknown>).workspace)) {
      const w = (patch as Record<string, unknown>).workspace as Record<string, unknown>
      if (w.learn !== undefined && next.workspace.learn !== null) {
        const vault = ensureLearnVault(next.workspace.learn)
        appendDebugLog(logsDir(), `[workspace] learn 绑定：${vault.message}`)
      }
    }
    return next
  })

  // 技能清单：双来源扫描 + enabled 反演，主窗技能面板展示用
  ipcMain.handle(SKILLS_LIST, (): SkillMeta[] => listSkills())

  // 打开用户技能目录：不存在先建再开——技能面板「打开技能文件夹」按钮，
  // 用户把 <名字>/SKILL.md 放进去即可自装技能（扫描实时，无需重启）
  ipcMain.handle(SKILLS_OPEN_DIR, async (): Promise<{ ok: boolean; error?: string }> => {
    const dir = getUserSkillsDir()
    if (dir === '') return { ok: false, error: '技能目录未初始化' }
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return { ok: false, error: `无法创建目录：${dir}` }
    }
    const err = await shell.openPath(dir)
    return err === '' ? { ok: true } : { ok: false, error: err }
  })

  ipcMain.handle(
    SETTINGS_SET_API_KEY,
    (_event, payload: unknown): { ok: boolean; error?: string } => {
      // v2：载荷为 { id, key }；兼容旧签名（直接传字符串）落到 'default' 档案
      let id = 'default'
      let key: unknown = payload
      if (isRecord(payload)) {
        if (typeof payload.id === 'string' && payload.id.trim() !== '') id = payload.id.trim()
        key = payload.key
      }
      if (typeof key !== 'string') return { ok: false, error: '密钥格式无效' }
      const trimmed = key.trim()
      if (trimmed === '') return { ok: false, error: '密钥不能为空' }
      writeProfileKey(configDir(), id, trimmed)
      return { ok: true }
    }
  )

  ipcMain.handle(SETTINGS_HAS_API_KEY, (): boolean => hasAnyApiKey(configDir()))

  // MCP env 密钥写入：值经 safeStorage 加密落 secrets.json，渲染层永远读不回明文
  ipcMain.handle(MCP_SET_SECRET, (_event, payload: unknown): { ok: boolean; error?: string } => {
    const p = isRecord(payload) ? payload : {}
    const namespace = typeof p.namespace === 'string' ? p.namespace.trim() : ''
    const varName = typeof p.varName === 'string' ? p.varName.trim() : ''
    const value = typeof p.value === 'string' ? p.value.trim() : ''
    if (namespace === '' || varName === '') return { ok: false, error: '参数不完整' }
    if (value === '') return { ok: false, error: '密钥不能为空' }
    writeMcpSecret(configDir(), namespace, varName, value)
    return { ok: true }
  })

  // MCP 测试连接：按传入的**未保存**配置临时连一次，用完即关，不影响运行中的连接
  ipcMain.handle(MCP_TEST, async (_event, payload: unknown): Promise<McpTestResult> => {
    const p = isRecord(payload) ? payload : {}
    const cfg = p.config as AppConfig['mcp']['servers'][number] | undefined
    if (cfg === undefined || typeof cfg.command !== 'string' || cfg.command.trim() === '') {
      return { ok: false, error: '请先填写命令（如 npx）' }
    }
    const command = cfg.command.trim()
    const args = Array.isArray(cfg.args) ? cfg.args.filter((a) => typeof a === 'string') : []
    const preview: AppConfig['mcp']['servers'][number] = {
      id: typeof cfg.id === 'string' && cfg.id !== '' ? cfg.id : 'test',
      name: typeof cfg.name === 'string' && cfg.name !== '' ? cfg.name : '测试',
      command,
      args,
      ...(isRecord(cfg.env) ? { env: cfg.env as Record<string, string> } : {}),
      ...(typeof cfg.serverName === 'string' ? { serverName: cfg.serverName } : {}),
      ...(typeof cfg.cwd === 'string' && cfg.cwd.trim() !== '' ? { cwd: cfg.cwd } : {}),
      enabled: true
    }
    return testMcpServer(preview, mcpEnvResolver())
  })

  // 变更账本：全局只读列表（时间倒序，含 undo 标记），设置页「变更账本」分区用
  ipcMain.handle(LEDGER_LIST, () => listChanges())

  // 恢复内置服务器：从"已删除"名单移回 + 立即补齐 + 重连
  ipcMain.handle(MCP_BUILTIN_RESTORE, (_event, payload: unknown): { ok: boolean } => {
    const p = isRecord(payload) ? payload : {}
    const key = typeof p.key === 'string' ? p.key.trim() : ''
    if (key === '' || !restoreBuiltinServer(key)) return { ok: false }
    const config = readAppConfig(configDir())
    void mcpManager.sync(config.mcp.servers)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(SETTINGS_CHANGED)
    }
    return { ok: true }
  })

  ipcMain.handle(
    SETTINGS_TEST_CONNECTION,
    async (_event, options: unknown): Promise<{ ok: boolean; error?: string }> => {
      const o = isRecord(options) ? options : {}
      const baseUrl = typeof o.baseUrl === 'string' ? o.baseUrl.trim() : ''
      const model = typeof o.model === 'string' ? o.model.trim() : ''
      if (baseUrl === '' || model === '') {
        return { ok: false, error: '请先填写 Base URL 与模型名' }
      }
      // 密钥解析优先级：输入框新密钥 → 指定档案已存密钥；都不存在则报错
      const passed = typeof o.apiKey === 'string' && o.apiKey.trim() !== '' ? o.apiKey.trim() : null
      const profileId = typeof o.profileId === 'string' && o.profileId !== '' ? o.profileId : null
      const apiKey = passed ?? (profileId !== null ? readProfileKey(configDir(), profileId) : null)
      if (apiKey === null || apiKey === '') {
        return { ok: false, error: '请先填写 API Key（或先保存再测试）' }
      }
      // 档案协议：优先按 profileId 查已保存档案；找不到按 baseUrl 匹配厂商预设
      // ，缺省 openai
      const config = readAppConfig(configDir())
      const saved =
        (profileId !== null ? config.model.profiles.find((p) => p.id === profileId) : undefined) ??
        config.model.profiles.find((p) => p.baseUrl === baseUrl)
      const protocol = saved?.protocol ?? matchPresetByBaseUrl(baseUrl)?.protocol ?? 'openai'
      return testConnection({ baseUrl, apiKey, model, protocol })
    }
  )
}
