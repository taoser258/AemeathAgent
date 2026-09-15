// apiKey 存取：经 Electron safeStorage 加密后落盘。
// 红线③：apiKey 不硬编码、不进 git、不进 app.json、不进日志；UI 只显示"已配置"掩码。
// Windows 上 safeStorage 走 DPAPI；不可用时（极少数 Linux）回退明文，仅开发环境会遇到。
//
// T4 扩展（v2）：支持多模型档案 —— 密钥按档案 id 存进 secrets.json 的加密映射。
// 旧版单密钥文件 secrets.bin在读取时自动迁移为 { default: key }，
// 并在下一次写入时落到新格式；迁移完成后删除旧文件避免双源。

import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AppConfig } from '@shared/types'

const SECRETS_V2_FILE = 'secrets.json'
const SECRETS_V1_FILE = 'secrets.bin'

/**
 * MCP env 密钥的 id 前缀。
 * 与模型密钥共用同一个加密文件，靠前缀区分命名空间：'mcp:<命名空间>:<变量名>'。
 * 好处是只有一条 safeStorage 路径；代价是清理逻辑必须显式区分（见 pruneKeys 注释）。
 */
export const MCP_SECRET_NS = 'mcp'

interface SecretsFile {
  v: 1
  /** true = 每条 value 是 safeStorage.encryptString 的 base64；false = 明文 base64（仅开发回退） */
  enc: boolean
  keys: Record<string, string>
}

function v2Path(dir: string): string {
  return join(dir, SECRETS_V2_FILE)
}

function v1Path(dir: string): string {
  return join(dir, SECRETS_V1_FILE)
}

function encryptToBase64(plain: string): string {
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(plain)
    : Buffer.from(plain, 'utf8')
  return data.toString('base64')
}

function decryptFromBase64(base64: string, enc: boolean): string {
  const buffer = Buffer.from(base64, 'base64')
  if (enc && safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buffer)
  return buffer.toString('utf8')
}

/** 把整份密钥映射加密写回（唯一落盘出口，保证 enc 标志与编码方式始终一致） */
function writeKeysFile(dir: string, keys: Record<string, string>): void {
  mkdirSync(dir, { recursive: true })
  const file: SecretsFile = {
    v: 1,
    enc: safeStorage.isEncryptionAvailable(),
    keys: Object.fromEntries(
      Object.entries(keys).map(([id, value]) => [id, encryptToBase64(value)])
    )
  }
  writeFileSync(v2Path(dir), `${JSON.stringify(file, null, 2)}\n`, 'utf8')
}

/** 读取全部档案密钥（含 v1 旧文件自动迁移），绝不把明文写日志 */
export function readAllKeys(dir: string): Record<string, string> {
  // v2 映射文件
  try {
    if (existsSync(v2Path(dir))) {
      const parsed = JSON.parse(readFileSync(v2Path(dir), 'utf8')) as Partial<SecretsFile>
      if (parsed?.v === 1 && typeof parsed.keys === 'object' && parsed.keys !== null) {
        const enc = parsed.enc === true
        const out: Record<string, string> = {}
        for (const [id, base64] of Object.entries(parsed.keys)) {
          if (typeof base64 !== 'string' || base64 === '') continue
          try {
            out[id] = decryptFromBase64(base64, enc)
          } catch {
            // 单条解密失败不影响其余密钥
          }
        }
        return out
      }
    }
  } catch {
    // 损坏的 v2 文件：继续走 v1 迁移路径
  }

  // v1 旧单密钥文件 → 迁移语义：视为 'default' 档案的密钥
  try {
    if (existsSync(v1Path(dir))) {
      const buffer = readFileSync(v1Path(dir))
      const plain = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(buffer)
        : buffer.toString('utf8')
      if (plain !== '') return { default: plain }
    }
  } catch {
    // 读取失败按"无密钥"处理
  }
  return {}
}

/** 读取指定档案的密钥；未配置返回 null */
export function readProfileKey(dir: string, profileId: string): string | null {
  const key = readAllKeys(dir)[profileId]
  return key === undefined || key === '' ? null : key
}

/** 写入指定档案的密钥（加密）；空串视为清除。写入成功后完成 v1 → v2 迁移 */
export function writeProfileKey(dir: string, profileId: string, plain: string): void {
  if (profileId.trim() === '') return
  const keys = readAllKeys(dir)
  if (plain === '') delete keys[profileId]
  else keys[profileId] = plain

  writeKeysFile(dir, keys)
  // 迁移完成：旧单密钥文件退役（成功写入 v2 后才删，避免中途失败丢钥）
  if (existsSync(v1Path(dir))) rmSync(v1Path(dir), { force: true })
}

/** 清除不在保留名单里的档案密钥（档案被删除时同步清理） */
export function pruneKeys(dir: string, keepIds: string[]): void {
  const keep = new Set(keepIds)
  const keys = readAllKeys(dir)
  // ⚠️ 只清模型档案命名空间的密钥：MCP 的 env 密钥 id 带 'mcp:' 前缀，
  // 若一并清掉会把用户配好的 GitHub token 等静默删除（调用方只传档案 id，不在名单里）。
  const stale = Object.keys(keys).filter((id) => !id.startsWith(MCP_SECRET_NS) && !keep.has(id))
  if (stale.length === 0) return
  for (const id of stale) delete keys[id]
  writeKeysFile(dir, keys)
}

// ── MCP env 密钥──────────────────────────────────────────
// 与模型密钥共用一个加密文件，用 'mcp:<命名空间>:<变量名>' 作为 id 前缀隔离。

/** 组装 MCP 密钥 id：命名空间内隔离，避免两个 server 的同名变量互相覆盖 */
export function mcpSecretKey(namespace: string, varName: string): string {
  return `${MCP_SECRET_NS}:${namespace}:${varName}`
}

/** 读取某 server 的某个 env 密钥；未配置返回 null */
export function readMcpSecret(dir: string, namespace: string, varName: string): string | null {
  const value = readAllKeys(dir)[mcpSecretKey(namespace, varName)]
  return value === undefined || value === '' ? null : value
}

/** 写入某 server 的 env 密钥（加密）；空串视为清除 */
export function writeMcpSecret(
  dir: string,
  namespace: string,
  varName: string,
  plain: string
): void {
  writeProfileKey(dir, mcpSecretKey(namespace, varName), plain)
}

/** 清除不在保留名单里的 MCP 密钥（server 被删除/改名时同步清理） */
export function pruneMcpSecrets(dir: string, keepKeys: string[]): void {
  const keep = new Set(keepKeys)
  const keys = readAllKeys(dir)
  const stale = Object.keys(keys).filter(
    (id) => id.startsWith(`${MCP_SECRET_NS}:`) && !keep.has(id)
  )
  if (stale.length === 0) return
  for (const id of stale) delete keys[id]
  writeKeysFile(dir, keys)
}

/** 已配置密钥的 MCP 密钥 id 列表（不含明文，供设置页显示"已配置"状态） */
export function configuredMcpSecretKeys(dir: string): string[] {
  return Object.keys(readAllKeys(dir)).filter((id) => id.startsWith(`${MCP_SECRET_NS}:`))
}

/** 是否存在至少一把已配置的密钥 */
export function hasAnyApiKey(dir: string): boolean {
  return Object.keys(readAllKeys(dir)).length > 0
}

/** 兼容旧签名：读取"默认档案"（id=default）的密钥 */
export function readApiKey(dir: string): string | null {
  return readProfileKey(dir, 'default')
}

/** 供 settings-ipc 组装读模型：列出已配置密钥的档案 id（不含明文） */
export function keyedProfileIds(dir: string, config: AppConfig): string[] {
  const keys = readAllKeys(dir)
  return Object.keys(keys).filter((id) => config.model.profiles.some((p) => p.id === id))
}
