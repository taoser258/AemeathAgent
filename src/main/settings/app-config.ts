// app.json 读写：默认值合并、容错读取、写回。
// 设计说明：本文件不 import electron —— 目录由调用方传入（paths.ts 依赖 app.ready），
// 这样合并/读写逻辑就是纯 Node 代码，vitest 可直接单测。
// 红线③：apiKey 绝不写入 app.json，它走 llm/secrets.ts 的 safeStorage 路径。
//
// T4 扩展（只增不改）：model 下新增 profiles（模型档案列表）与 activeId；
// baseUrl/model 变为"激活档案的镜像字段"，由本文件的合并/补丁逻辑保证同步。
// 旧版 app.json（无 profiles）读取时自动迁移：镜像字段合成一条档案 + 按.baseUrl
// 识别厂商补齐名称/上下文，其余主流厂商预设作为未配置档案一并补入。

import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ApiProtocol, AppConfig, ChatMode, ModelProfile, SettingsPatch } from '@shared/types'
import { MODEL_PRESETS, matchPresetByBaseUrl, presetToProfile } from '@shared/model-presets'
import { isValidNamespace } from '@shared/mcp-presets'

export const APP_CONFIG_FILE = 'app.json'

/**
 * 默认配置：默认厂商千问；
 * 主流厂商预设全部作为档案预置，用户填各自 key 即可切换。
 */
export const DEFAULT_APP_CONFIG: AppConfig = (() => {
  const profiles = MODEL_PRESETS.map(presetToProfile)
  const active = profiles.find((p) => p.id === 'p-qwen') ?? profiles[0]
  return {
    model: {
      baseUrl: active.baseUrl,
      model: active.model,
      temperature: 0.8,
      profiles,
      activeId: active.id
    },
    persona: { active: 'aemeath' },
    pet: { x: null, y: null, clickThrough: false, scale: 0.5 },
    tools: {
      permissionMode: 'confirm',
      // 工具可见性：缺省 'all' = 与 P2 行为完全一致（全可见）
      visibility: { work: 'all', learn: 'all' },
      shell: { allowlist: [] }
    },
    mcp: { servers: [] },
    skills: { disabled: [] },
    workspace: { work: null, learn: null },
    privacy: { activeWindow: false, memory: false },
    appearance: { theme: 'light' },
    ui: { notesCard: false },
    user: { nickname: '', avatar: null, about: '' }
  }
})()

/** 档案字段防御校验：id/baseUrl 缺失即丢弃；model 允许为空（预设档案不预填模型名） */
function sanitizeProfile(raw: unknown): ModelProfile | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id.trim() === '') return null
  if (typeof r.baseUrl !== 'string' || r.baseUrl.trim() === '') return null
  if (typeof r.model !== 'string') return null
  // 起：协议白名单（缺省 openai 兼容）； 加 gemini 原生
  const protocol: ApiProtocol =
    r.protocol === 'anthropic' || r.protocol === 'gemini' ? r.protocol : 'openai'
  const context =
    typeof r.context === 'number' && Number.isFinite(r.context) && r.context >= 0
      ? Math.floor(r.context)
      : 0
  return {
    id: r.id.trim(),
    name: typeof r.name === 'string' && r.name.trim() !== '' ? r.name.trim() : r.id.trim(),
    protocol,
    baseUrl: r.baseUrl.trim(),
    model: r.model.trim(),
    context,
    multimodal: r.multimodal === true
  }
}

/**
 * 预设档案不预填模型名。
 * 旧配置里迁移/预置产生的档案若还带着旧种子默认模型（glm-4.6 等），在这里清空；
 * 用户自己填过的模型名（非种子值）原样保留。
 */
function clearSeedModels(profiles: ModelProfile[]): ModelProfile[] {
  return profiles.map((p) => {
    const preset = MODEL_PRESETS.find((item) => item.id === p.id)
    if (preset !== undefined && p.model === preset.legacyModel) return { ...p, model: '' }
    return p
  })
}

/** 旧版镜像字段 → 兜底档案（按 baseUrl 识别厂商起名；再补入其余未重复的厂商预设） */
function synthesizeProfiles(baseUrl: string, model: string): ModelProfile[] {
  const preset = matchPresetByBaseUrl(baseUrl)
  const legacy: ModelProfile = {
    // 命中预设直接继承预设 id：该档案获得"预设不可删"身份，且不会与预置档案重复
    id: preset !== null ? preset.id : 'default',
    name: preset !== null ? preset.name : '默认模型',
    protocol: 'openai',
    baseUrl,
    model,
    context: preset?.context ?? 0,
    multimodal: preset?.multimodal ?? false
  }
  const rest = MODEL_PRESETS.filter((p) => p.baseUrl !== baseUrl)
    .map(presetToProfile)
    .filter((p) => p.id !== legacy.id)
  return [legacy, ...rest]
}

/**
 * 人设名归一：demo 人设已从仓库删除、只保留 aemeath。
 * 旧 app.json 里存的 'demo' 自动迁移到 'aemeath'，避免升级后聊天报"人设缺失"。
 */
function normalizePersonaName(name: string): string {
  const trimmed = name.trim()
  return trimmed === 'demo' || trimmed === '' ? 'aemeath' : trimmed
}

/**
 * 把磁盘上读到的任意 JSON 安全合并成完整配置。
 * 逐字段判断类型而不是盲目展开：缺失/类型不对的字段一律回退默认值，
 * 保证旧版本文件或手改坏的 app.json 不会让应用起不来。
 */
export function mergeAppConfig(raw: unknown): AppConfig {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const model = source.model as Partial<AppConfig['model']> | undefined
  const persona = source.persona as Partial<AppConfig['persona']> | undefined
  const pet = source.pet as Partial<AppConfig['pet']> | undefined
  const tools = source.tools as Partial<AppConfig['tools']> | undefined
  const mcp = source.mcp as Partial<AppConfig['mcp']> | undefined
  const skillsRaw = source.skills as Partial<AppConfig['skills']> | undefined
  const workspaceRaw = source.workspace as Partial<AppConfig['workspace']> | undefined
  const privacy = source.privacy as Partial<AppConfig['privacy']> | undefined
  const appearanceRaw = source.appearance as Partial<AppConfig['appearance']> | undefined
  const uiRaw = source.ui as Partial<AppConfig['ui']> | undefined
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback

  // ── 模型档案：磁盘有就用（逐条防御校验），没有就从旧镜像字段迁移 ──
  const rawProfiles = Array.isArray(model?.profiles) ? model?.profiles : null
  let profiles: ModelProfile[] =
    rawProfiles !== null
      ? rawProfiles.map(sanitizeProfile).filter((p): p is ModelProfile => p !== null)
      : []
  if (profiles.length === 0) {
    profiles = synthesizeProfiles(
      typeof model?.baseUrl === 'string' ? model.baseUrl : DEFAULT_APP_CONFIG.model.baseUrl,
      typeof model?.model === 'string' ? model.model : DEFAULT_APP_CONFIG.model.model
    )
  }
  // id 去重（后者让位前者）
  const seen = new Set<string>()
  profiles = profiles.filter((p) => {
    if (seen.has(p.id)) return false
    seen.add(p.id)
    return true
  })

  // 预设补种与协议归位：
  // ① 补种：预设池新增（如 T6 的 p-gemini）时，老配置升级也能拿到——此前只在
  // profiles 为空时合成，磁盘上已有档案的老用户永远见不到新预设。
  // 预设档案有"不可删"身份，补种不会复活用户主动删除的东西（删不掉）。
  // ② 协议归位：预设档案的 protocol 是厂商固有属性。saveDraft 曾把它写死 'openai'
  // （已修），但受害配置已落盘——按预设校正才能自愈，用户无需手动改。
  // 两者都只动 id 命中 MODEL_PRESETS 的档案，用户自建档案绝不触碰。
  for (const preset of MODEL_PRESETS) {
    const presetProtocol: ApiProtocol = preset.protocol ?? 'openai'
    const existing = profiles.find((p) => p.id === preset.id)
    if (existing === undefined) {
      profiles.push(presetToProfile(preset))
    } else if (existing.protocol !== presetProtocol) {
      existing.protocol = presetProtocol
    }
  }

  // 旧迁移产物归位：id 为 'default' 但 baseUrl 命中厂商预设的档案，改回预设 id
  // （继承"预设不可删"身份并避免与预置档案视觉重复）；activeId 同步改写
  let rawActiveId = typeof model?.activeId === 'string' ? model.activeId : null
  profiles = profiles.map((p) => {
    if (p.id !== 'default') return p
    const preset = matchPresetByBaseUrl(p.baseUrl)
    if (preset === null) return p
    if (rawActiveId === 'default') rawActiveId = preset.id
    return { ...p, id: preset.id }
  })
  // 重映射可能产生与预置档案同 id 的重复：保留信息更全的那条（前者）
  const seenRemap = new Set<string>()
  profiles = profiles.filter((p) => {
    if (seenRemap.has(p.id)) return false
    seenRemap.add(p.id)
    return true
  })

  // 预设档案不预填模型名（清掉历史种子默认值；用户自填的不动）。
  // 必须在镜像同步之前做，否则 mirror 会带回被清掉的种子模型名
  profiles = clearSeedModels(profiles)

  const activeId =
    rawActiveId !== null && profiles.some((p) => p.id === rawActiveId)
      ? rawActiveId
      : profiles[0].id
  const activeProfile = profiles.find((p) => p.id === activeId)

  const mirror =
    activeProfile !== undefined
      ? { baseUrl: activeProfile.baseUrl, model: activeProfile.model }
      : {
          baseUrl:
            typeof model?.baseUrl === 'string' ? model.baseUrl : DEFAULT_APP_CONFIG.model.baseUrl,
          model: typeof model?.model === 'string' ? model.model : DEFAULT_APP_CONFIG.model.model
        }

  return {
    model: {
      baseUrl: mirror.baseUrl,
      model: mirror.model,
      temperature: num(model?.temperature, DEFAULT_APP_CONFIG.model.temperature),
      profiles,
      activeId
    },
    persona: {
      active:
        typeof persona?.active === 'string'
          ? normalizePersonaName(persona.active)
          : DEFAULT_APP_CONFIG.persona.active
    },
    pet: {
      // 坐标非法（含 null）一律按"没有记忆"处理，由窗口侧回退右下角
      x: typeof pet?.x === 'number' && Number.isFinite(pet.x) ? pet.x : null,
      y: typeof pet?.y === 'number' && Number.isFinite(pet.y) ? pet.y : null,
      clickThrough:
        typeof pet?.clickThrough === 'boolean'
          ? pet.clickThrough
          : DEFAULT_APP_CONFIG.pet.clickThrough,
      scale: num(pet?.scale, DEFAULT_APP_CONFIG.pet.scale)
    },
    tools: {
      // 权限模式：非法值一律回退默认 'confirm'（默认请示，安全优先）
      permissionMode: sanitizePermissionMode(tools?.permissionMode),
      // 工具可见性：脏值/缺失一律回退 'all'（全可见，不让坏配置静默阉割能力）
      visibility: sanitizeToolVisibility(tools?.visibility),
      // run_shell 用户扩展白名单：只收非空字符串、去重、限 50 条；缺省空表
      shell: {
        allowlist: sanitizeStringList(
          (tools?.shell as { allowlist?: unknown } | undefined)?.allowlist
        ).slice(0, 50)
      }
    },
    mcp: {
      servers: sanitizeMcpServers(mcp?.servers),
      // 已删除的内置项名单：只收非空字符串并去重
      ...(sanitizeStringList(mcp?.removedBuiltins).length > 0
        ? { removedBuiltins: sanitizeStringList(mcp?.removedBuiltins) }
        : {})
    },
    skills: { disabled: sanitizeStringList(skillsRaw?.disabled) },
    workspace: {
      work: sanitizeBoundDir(workspaceRaw?.work),
      learn: sanitizeBoundDir(workspaceRaw?.learn)
    },
    privacy: {
      // 隐私红线：仅显式 true 才开启，任何缺失/脏值都回退关
      activeWindow: privacy?.activeWindow === true,
      // 长期记忆：同款默认关纪律
      memory: privacy?.memory === true
    },
    appearance: {
      // 主题：白名单三值，非法/缺失回退 light（默认浅色，
      // system/dark 仍是合法显式选项）
      theme:
        appearanceRaw?.theme === 'light' ||
        appearanceRaw?.theme === 'dark' ||
        appearanceRaw?.theme === 'system'
          ? appearanceRaw.theme
          : 'light'
    },
    ui: {
      // 界面偏好：仅显式 true 才开，缺失/脏值回退关（隐私同款纪律）
      notesCard: uiRaw?.notesCard === true
    },
    user: sanitizeUser(source.user)
  }
}

/**
 * 用户个人信息防御（反馈批次④）：
 * - nickname / about 归一为 trim 后的字符串并限长（昵称 40 字、自述 2000 字，够用且防手改塞爆）
 * - avatar 只接受 `data:image/` 开头的字符串，且限长（≈ 512KB base64）——
 * 同时挡住手改 app.json 塞入的 http:// 外链与超大内容（外链会引隐私外流面）
 */
function sanitizeUser(raw: unknown): AppConfig['user'] {
  const fallback: AppConfig['user'] = { nickname: '', avatar: null, about: '' }
  if (typeof raw !== 'object' || raw === null) return fallback
  const r = raw as Record<string, unknown>
  const nickname = typeof r.nickname === 'string' ? r.nickname.trim().slice(0, 40) : ''
  const avatar =
    typeof r.avatar === 'string' && r.avatar.startsWith('data:image/') && r.avatar.length <= 512_000
      ? r.avatar
      : null
  const about = typeof r.about === 'string' ? r.about.trim().slice(0, 2000) : ''
  return { nickname, avatar, about }
}

/** 权限模式防御：仅接受三个合法值，其余回退 'confirm' */
function sanitizePermissionMode(raw: unknown): AppConfig['tools']['permissionMode'] {
  return raw === 'plan' || raw === 'full' ? raw : 'confirm'
}

/** 单模式的可见性值防御：'all' 原样；数组仅保留非空字符串并去重；空数组/脏值回退 'all'（防自锁：一个工具都不可见多半是误操作） */
function sanitizeModeVisibility(raw: unknown): 'all' | string[] {
  if (raw === 'all') return 'all'
  if (!Array.isArray(raw)) return 'all'
  const names = [
    ...new Set(
      raw.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim())
    )
  ]
  return names.length === 0 ? 'all' : names
}

/** 工具可见性防御：逐模式归一；缺失/脏对象整体回退 'all' */
function sanitizeToolVisibility(raw: unknown): AppConfig['tools']['visibility'] {
  const fallback: AppConfig['tools']['visibility'] = { work: 'all', learn: 'all' }
  if (typeof raw !== 'object' || raw === null) return fallback
  const r = raw as Record<string, unknown>
  return {
    work: sanitizeModeVisibility(r.work),
    learn: sanitizeModeVisibility(r.learn)
  }
}

/** 字符串名单防御：仅保留非空字符串，去重、去首尾空白 */
function sanitizeStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return [
    ...new Set(
      raw.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim())
    )
  ]
}

/** 绑定目录防御：非空字符串归一为 trim 值；其余（含空串/非字符串）一律 null = 未绑定 */
function sanitizeBoundDir(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * MCP server 防御：
 * id/name/command 合法才保留；args/env 只收字符串；上限 10 个；
 * serverName 非法一律**丢弃该字段**（下游按 id 派生，绝不让非法命名空间进工具名）。
 */
function sanitizeMcpServers(raw: unknown): AppConfig['mcp']['servers'] {
  if (!Array.isArray(raw)) return []
  const out: AppConfig['mcp']['servers'] = []
  const seenIds = new Set<string>()
  const seenNamespaces = new Set<string>()
  for (const item of raw.slice(0, 10)) {
    if (typeof item !== 'object' || item === null) continue
    const r = item as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id.trim().slice(0, 40) : ''
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, 40) : ''
    const command = typeof r.command === 'string' ? r.command.trim() : ''
    if (id === '' || name === '' || command === '') continue
    if (seenIds.has(id)) continue // id 去重：后者让位前者
    seenIds.add(id)
    const args = Array.isArray(r.args)
      ? r.args.filter((a): a is string => typeof a === 'string').slice(0, 20)
      : []
    // env：只收字符串键值；键名跟环境变量规范走（字母数字下划线，不以数字开头）
    const env: Record<string, string> = {}
    if (typeof r.env === 'object' && r.env !== null) {
      for (const [key, value] of Object.entries(r.env as Record<string, unknown>).slice(0, 30)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
        if (typeof value !== 'string') continue
        env[key] = value.slice(0, 2000)
      }
    }
    // 命名空间：合法才留；重复的丢掉（保留先出现的），下游按 id 派生
    const rawNs = typeof r.serverName === 'string' ? r.serverName.trim() : ''
    const serverName = isValidNamespace(rawNs) && !seenNamespaces.has(rawNs) ? rawNs : undefined
    if (serverName !== undefined) seenNamespaces.add(serverName)
    const timeout = r.toolCallTimeoutMs
    const toolCallTimeoutMs =
      typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 1000
        ? Math.min(600_000, Math.floor(timeout))
        : undefined
    const cwd = typeof r.cwd === 'string' && r.cwd.trim() !== '' ? r.cwd.trim() : undefined
    const modes = Array.isArray(r.modes)
      ? [
          ...new Set(
            r.modes.filter((m): m is ChatMode => m === 'chat' || m === 'work' || m === 'learn')
          )
        ].filter((m) => m !== 'chat') // chat 无工具，配了也不生效，直接归一掉避免困惑
      : undefined
    // 内置标识：只认非空字符串；合法值由 builtin 模块校验（未知值会被同步逻辑忽略）
    const builtin =
      typeof r.builtin === 'string' && r.builtin.trim() !== ''
        ? r.builtin.trim().slice(0, 40)
        : undefined
    out.push({
      id,
      name,
      ...(serverName !== undefined ? { serverName } : {}),
      command,
      args,
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(toolCallTimeoutMs !== undefined ? { toolCallTimeoutMs } : {}),
      ...(modes !== undefined && modes.length > 0 ? { modes } : {}),
      // reconnect 缺省 true：仅显式 false 才落盘（老配置读入后行为完全不变）
      ...(r.reconnect === false ? { reconnect: false } : {}),
      ...(builtin !== undefined ? { builtin } : {}),
      enabled: r.enabled === true
    })
  }
  return out
}

/**
 * 设置页补丁（纯函数，可单测）：局部更新 model / persona / tools，并保证镜像同步与
 * activeId 恒有效。pet 不在这里改（走 win:* 通道）。
 */
export function applySettingsPatch(current: AppConfig, patch: SettingsPatch): AppConfig {
  const next = structuredClone(current)
  const p = patch ?? {}

  if (p.persona !== undefined) {
    const active = typeof p.persona.active === 'string' ? p.persona.active.trim() : ''
    if (active !== '') next.persona.active = active
  }

  if (p.tools !== undefined && p.tools.permissionMode !== undefined) {
    next.tools.permissionMode = sanitizePermissionMode(p.tools.permissionMode)
  }

  if (p.tools?.visibility !== undefined) {
    // 工具可见性：按键局部合并——patch 只带 work 就只动 work，learn 保持现值
    const v = p.tools.visibility as Record<string, unknown>
    if (v.work !== undefined) next.tools.visibility.work = sanitizeModeVisibility(v.work)
    if (v.learn !== undefined) next.tools.visibility.learn = sanitizeModeVisibility(v.learn)
  }

  if (p.tools?.shell !== undefined) {
    // run_shell 白名单：整表替换（与 visibility 的按键合并不同——白名单是单一列表）
    const sh = p.tools.shell as { allowlist?: unknown }
    next.tools.shell = { allowlist: [] } // 兜底旧配置缺字段的情况
    if (sh.allowlist !== undefined) {
      next.tools.shell.allowlist = sanitizeStringList(sh.allowlist).slice(0, 50)
    }
  }

  if (p.privacy !== undefined) {
    // 隐私开关：布尔才接受，默认方向永远朝"关"
    if (typeof p.privacy.activeWindow === 'boolean') {
      next.privacy.activeWindow = p.privacy.activeWindow
    }
    // 长期记忆：同款纪律
    if (typeof p.privacy.memory === 'boolean') {
      next.privacy.memory = p.privacy.memory
    }
  }

  if (p.appearance !== undefined) {
    // 主题：白名单三值才接受
    if (
      p.appearance.theme === 'system' ||
      p.appearance.theme === 'light' ||
      p.appearance.theme === 'dark'
    ) {
      next.appearance.theme = p.appearance.theme
    }
  }

  if (p.ui !== undefined) {
    // 界面偏好：布尔才接受（与 privacy 同款纪律）
    if (typeof p.ui.notesCard === 'boolean') {
      next.ui.notesCard = p.ui.notesCard
    }
  }

  if (p.user !== undefined) {
    // 用户个人信息（反馈批次④）：与现值合并后再过防御校验——只传 nickname 就只动昵称，
    // 头像传 null 即清空（sanitizeUser 会把非 data:image 的值一律归为 null）
    next.user = sanitizeUser({ ...next.user, ...p.user })
  }

  if (p.mcp !== undefined && p.mcp.servers !== undefined) {
    // MCP 服务器：整表替换。 修复：此分支此前缺失——settingsSet({ mcp }) 被
    // 静默丢弃，设置页的增删/启停从未真正持久化（潜伏缺陷，T5 E2E 实测抓到）。
    next.mcp.servers = sanitizeMcpServers(p.mcp.servers)
  }

  if (p.mcp !== undefined && p.mcp.removedBuiltins !== undefined) {
    // 已删除的内置项名单：整表替换。设置页删除内置项时必须一并提交，
    // 否则下次启动自愈同步又会把它补回来。
    const list = sanitizeStringList(p.mcp.removedBuiltins)
    if (list.length > 0) next.mcp.removedBuiltins = list
    else delete next.mcp.removedBuiltins
  }

  if (p.skills?.disabled !== undefined) {
    // 技能禁用名单：整表替换（面板开关整表提交，语义与 mcp.servers 一致）
    next.skills.disabled = sanitizeStringList(p.skills.disabled)
  }

  if (p.workspace !== undefined) {
    // 工作区绑定：按键局部替换——只带 work 只动 work；绑定值须为非空字符串或 null
    const w = p.workspace as Record<string, unknown>
    if (w.work !== undefined) next.workspace.work = sanitizeBoundDir(w.work)
    if (w.learn !== undefined) next.workspace.learn = sanitizeBoundDir(w.learn)
  }

  if (p.model !== undefined) {
    const m = p.model
    if (typeof m.temperature === 'number' && Number.isFinite(m.temperature)) {
      next.model.temperature = Math.min(2, Math.max(0, m.temperature))
    }
    if (Array.isArray(m.profiles)) {
      const profiles = clearSeedModels(
        m.profiles.map(sanitizeProfile).filter((v): v is ModelProfile => v !== null)
      )
      const seen = new Set<string>()
      next.model.profiles = profiles.filter((v) => {
        if (seen.has(v.id)) return false
        seen.add(v.id)
        return true
      })
      // 空表兜底：至少保住一条，避免应用进入"无模型可用"状态
      if (next.model.profiles.length === 0) {
        next.model.profiles = synthesizeProfiles(current.model.baseUrl, current.model.model)
      }
    }
    if (typeof m.activeId === 'string' && next.model.profiles.some((v) => v.id === m.activeId)) {
      next.model.activeId = m.activeId
    } else if (!next.model.profiles.some((v) => v.id === next.model.activeId)) {
      next.model.activeId = next.model.profiles[0].id
    }
    const active = next.model.profiles.find((v) => v.id === next.model.activeId)
    if (active !== undefined) {
      next.model.baseUrl = active.baseUrl
      next.model.model = active.model
    }
  }

  return next
}

/** 读取配置；文件不存在、损坏或"合法 JSON 但非对象"时返回默认值（首次运行即此路径） */
export function readAppConfig(dir: string): AppConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, APP_CONFIG_FILE), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) {
      // 合法 JSON 但不是对象（如 '"hi"'、'[]'、'42'）：与损坏同等对待
      throw new Error('app.json 根节点不是对象')
    }
    return mergeAppConfig(parsed)
  } catch {
    return structuredClone(DEFAULT_APP_CONFIG)
  }
}

/** 写回配置；目录不存在则创建 */
export function writeAppConfig(dir: string, config: AppConfig): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, APP_CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}
