// ：MCP env 解析与命名空间规则的纯函数单测。
// 这两块是"配出去的 server 到底能不能用"的关键路径，且都属于易出静默错误的地方
// （密钥少传一个 = server 启动后才报错；命名空间不稳定 = 历史工具调用记录失效）。

import { describe, expect, it } from 'vitest'
import {
  isSecretRef,
  missingSecretRefs,
  resolveEnvValues,
  secretRefsIn,
  type McpEnvResolver
} from '../src/main/mcp/env'
import {
  effectiveNamespace,
  isValidNamespace,
  namespaceFromId,
  suggestNamespace
} from '../src/shared/mcp-presets'
import type { AppConfig } from '../src/shared/types'

type ServerConfig = AppConfig['mcp']['servers'][number]

function server(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: 'srv-1',
    name: '测试 server',
    command: 'node',
    args: [],
    enabled: true,
    ...over
  }
}

/** 造一个解析器：给定映射就返回真值，否则 null（模拟"未配置"） */
function resolver(map: Record<string, string> = {}): McpEnvResolver {
  return (namespace, varName) => map[`${namespace}:${varName}`] ?? null
}

describe('MCP env 解析', () => {
  it('明文值原样透传，不碰解析器', () => {
    const out = resolveEnvValues(server({ env: { NODE_ENV: 'production' } }), 'srv-1', () => {
      throw new Error('明文不应调用解析器')
    })
    expect(out).toEqual({ NODE_ENV: 'production' })
  })

  it('${secret:X} 引用解析为真值（按命名空间隔离）', () => {
    const cfg = server({ env: { TOKEN: '${secret:MY_TOKEN}' } })
    const out = resolveEnvValues(cfg, 'github', resolver({ 'github:MY_TOKEN': 'ghp_abc' }))
    expect(out).toEqual({ TOKEN: 'ghp_abc' })
  })

  it('同名密钥在不同命名空间互不干扰', () => {
    const cfg = server({ env: { TOKEN: '${secret:TOKEN}' } })
    const map = { 'a:TOKEN': '值A', 'b:TOKEN': '值B' }
    expect(resolveEnvValues(cfg, 'a', resolver(map)).TOKEN).toBe('值A')
    expect(resolveEnvValues(cfg, 'b', resolver(map)).TOKEN).toBe('值B')
  })

  it('未配置的引用**跳过该变量**（不传空串：让 server 自己报缺 token，更好定位）', () => {
    const cfg = server({ env: { TOKEN: '${secret:MISSING}', PLAIN: 'ok' } })
    const out = resolveEnvValues(cfg, 'srv-1', resolver())
    expect(out).toEqual({ PLAIN: 'ok' })
    expect('TOKEN' in out).toBe(false)
  })

  it('解析器返回空串也视为未配置（空串会被 server 当成"填错了"）', () => {
    const cfg = server({ env: { TOKEN: '${secret:T}' } })
    expect(resolveEnvValues(cfg, 'ns', () => '')).toEqual({})
  })

  it('引用必须**整串**匹配：拼接形式按明文处理（无法可靠还原，不静默拼错值）', () => {
    const cfg = server({ env: { URL: 'https://x/?t=${secret:T}' } })
    expect(isSecretRef('https://x/?t=${secret:T}')).toBe(false)
    expect(resolveEnvValues(cfg, 'ns', () => 'secret-value')).toEqual({
      URL: 'https://x/?t=${secret:T}'
    })
  })

  it('secretRefsIn 列出引用的密钥名；missingSecretRefs 报出未配置的', () => {
    const cfg = server({
      env: { A: '${secret:TOKEN_A}', B: '${secret:TOKEN_B}', C: '明文' }
    })
    expect(secretRefsIn(cfg.env)).toEqual(['TOKEN_A', 'TOKEN_B'])
    const missing = missingSecretRefs(cfg, 'ns', resolver({ 'ns:TOKEN_A': '有' }))
    expect(missing).toEqual(['TOKEN_B'])
  })

  it('env 缺省时一切都为空（不报错）', () => {
    expect(resolveEnvValues(server(), 'ns', resolver())).toEqual({})
    expect(secretRefsIn(undefined)).toEqual([])
    expect(missingSecretRefs(server(), 'ns', resolver())).toEqual([])
  })
})

describe('MCP 命名空间规则', () => {
  it('合法性：1–32 位字母数字下划线短横线（与 成熟实现及各家 function.name 约定一致）', () => {
    expect(isValidNamespace('github')).toBe(true)
    expect(isValidNamespace('my_server-1')).toBe(true)
    expect(isValidNamespace('a'.repeat(32))).toBe(true)
    expect(isValidNamespace('')).toBe(false)
    expect(isValidNamespace('a'.repeat(33))).toBe(false)
    expect(isValidNamespace('有中文')).toBe(false)
    expect(isValidNamespace('has space')).toBe(false)
    expect(isValidNamespace('has.dot')).toBe(false)
  })

  it('effectiveNamespace 优先用显式 serverName', () => {
    expect(effectiveNamespace(server({ serverName: 'gh', id: 'mcp-ab12cd' }))).toBe('gh')
  })

  it('★ 无 serverName 时从 **id** 派生（不是展示名）：改名展示名不会重命名工具', () => {
    const a = server({ id: 'echo-test', name: '旧名字' })
    const b = server({ id: 'echo-test', name: '新名字（随时可改）' })
    expect(effectiveNamespace(a)).toBe('echo-test')
    expect(effectiveNamespace(b)).toBe('echo-test') // ← 关键：展示名变化不影响工具名
  })

  it('非法 serverName 一律回退到 id 派生（脏配置不污染工具名）', () => {
    expect(effectiveNamespace(server({ serverName: '有中文', id: 'srv-1' }))).toBe('srv-1')
    expect(effectiveNamespace(server({ serverName: 'a'.repeat(40), id: 'srv-1' }))).toBe('srv-1')
  })

  it('namespaceFromId 兜底：非法字符转短横线并抢救出 ASCII 部分；实在救不了才用 mcp-server', () => {
    expect(namespaceFromId('有中文的id')).toBe('id') // 中文被替换后剥掉，剩下可用的 ASCII
    expect(namespaceFromId('ok-id')).toBe('ok-id')
    expect(namespaceFromId('纯中文的id名')).toBe('id') // 结尾仍有 ASCII
    expect(namespaceFromId('')).toBe('mcp-server') // 空
    expect(namespaceFromId('全是中文')).toBe('mcp-server') // 一个 ASCII 都不剩
  })

  it('suggestNamespace 只用于表单预填：留下 ASCII 部分，中文名返回空串（交给 id 兜底）', () => {
    expect(suggestNamespace('GitHub')).toBe('GitHub')
    expect(suggestNamespace('文件系统')).toBe('')
    expect(suggestNamespace('  spaced  ')).toBe('spaced')
  })
})
