// MCP env 解析：把配置里的 `${secret:名称}` 引用换成真值。
// 单独成文件的原因：**manager（连接时用）与 test-connection（设置页"测试连接"用）
// 必须走同一套解析规则**——两处各写一份，迟早会出现"测试通过但实际连接缺 token"的鬼故事。

import type { AppConfig } from '@shared/types'

export type McpServerConfig = AppConfig['mcp']['servers'][number]

/** env 密钥解析器：返回 null 表示未配置（由主进程注入 safeStorage 读取，本模块不依赖 electron） */
export type McpEnvResolver = (namespace: string, varName: string) => string | null

/**
 * 密钥引用语法：`${secret:变量名}`。
 * **整串匹配才算引用**——`prefix-${secret:X}` 这类拼接无法可靠还原，
 * 宁可按明文处理（UI 会提示），也不静默拼出一个错误的值送进子进程。
 */
const SECRET_REF_RE = /^\$\{secret:([^}]+)\}$/

/** 列出配置里引用到的密钥名（设置页据此渲染"待填密钥"输入框） */
export function secretRefsIn(env: Record<string, string> | undefined): string[] {
  const out: string[] = []
  for (const value of Object.values(env ?? {})) {
    const ref = SECRET_REF_RE.exec(value.trim())
    if (ref !== null) out.push(ref[1].trim())
  }
  return out
}

/** 某个变量名是否被当作密钥引用（渲染层判断该行要不要走加密输入） */
export function isSecretRef(value: string): boolean {
  return SECRET_REF_RE.test(value.trim())
}

/**
 * 解析成真正传给子进程的环境变量表。
 * 引用未配置时**跳过该变量**（而不是传空串）：让 server 自己报"缺少 TOKEN"，
 * 比我们塞个空串更容易定位——空串常被 server 当成"值填错了"。
 */
export function resolveEnvValues(
  cfg: McpServerConfig,
  namespace: string,
  resolver: McpEnvResolver
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(cfg.env ?? {})) {
    const ref = SECRET_REF_RE.exec(value.trim())
    if (ref === null) {
      out[key] = value
      continue
    }
    const resolved = resolver(namespace, ref[1].trim())
    if (resolved !== null && resolved !== '') out[key] = resolved
  }
  return out
}

/** 配置里引用了密钥、但实际未配置（测试连接时用来给出"还差哪把钥匙"的明确提示） */
export function missingSecretRefs(
  cfg: McpServerConfig,
  namespace: string,
  resolver: McpEnvResolver
): string[] {
  return secretRefsIn(cfg.env).filter((name) => {
    const value = resolver(namespace, name)
    return value === null || value === ''
  })
}
