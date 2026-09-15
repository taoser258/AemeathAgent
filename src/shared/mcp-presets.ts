// MCP 命名空间规则与一键模板。
// 放在 shared：主进程校验、渲染层表单即时提示都要用同一套规则。
//
// 命名空间为什么必须由本地配置决定（而不是读远端的 serverInfo.name）：
// 远端名不可信、跨部署不唯一（同一 server 的 prod/staging 报同名）、且会随服务器升级变化。
// 工具名一旦变，历史会话里的工具调用记录与权限记忆就全部对不上——所以命名空间是"本地事实"。

import type { McpServerConfig } from './types'

/** 合法命名空间：与 成熟实现同规则（1–32 位字母数字下划线短横线），也满足各厂商 function.name 约束 */
export const MCP_NAMESPACE_RE = /^[A-Za-z0-9_-]{1,32}$/

export function isValidNamespace(value: string): boolean {
  return MCP_NAMESPACE_RE.test(value)
}

/**
 * 从展示名派生一个"建议命名空间"（**只用于新建时的表单预填**，不参与运行时取值）。
 *
 * 为什么不拿它当运行时兜底：展示名随时可改，用它派生等于"改个显示名就静默重命名所有工具"——
 * 历史会话里的工具调用记录与权限记忆会全部对不上。这正是 成熟实现文档反复强调的反模式
 * （"公开名称是会话历史和权限 API 的一部分"）。所以运行时兜底只认稳定的 id。
 */
export function suggestNamespace(name: string): string {
  return name
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '') // 中文/空格会被整体剔除
    .replace(/^[_-]+|[_-]+$/g, '') // 首尾分隔符没意义（"-gh-" → "gh"）
    .slice(0, 32)
}

/** 从稳定 id 派生命名空间（运行时兜底：老配置没有 serverName 时用） */
export function namespaceFromId(id: string): string {
  const cleaned = id
    .replace(/[^A-Za-z0-9_-]/g, '-') // 非法字符转短横线，尽量抢救出 ASCII 部分
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 32)
  return isValidNamespace(cleaned) ? cleaned : 'mcp-server'
}

/**
 * 取实际生效的命名空间。
 * 优先级：显式配置的 serverName → 从 id 派生（老配置兼容）。
 * 注意 id 一经生成不再变化，所以这个取值对同一份配置是**稳定**的。
 */
export function effectiveNamespace(server: McpServerConfig): string {
  const explicit = server.serverName?.trim() ?? ''
  return isValidNamespace(explicit) ? explicit : namespaceFromId(server.id)
}

/**
 * 内置服务器信息：展示用文案放 shared，主进程与渲染层共用一份。
 * 真正的"怎么连"由主进程按运行时路径算（见 main/mcp/builtin.ts），这里只管文案。
 */
export interface McpBuiltinInfo {
  /** 与 ServerConfig.builtin 对应 */
  key: string
  label: string
  /** 一句话说明：开了能干什么 */
  desc: string
  icon: string
}

export const MCP_BUILTINS: McpBuiltinInfo[] = [
  {
    key: 'playwright',
    label: 'Playwright 浏览器',
    desc: '让爱弥斯自己开浏览器查资料、点页面、读内容。用系统自带 Edge，不额外下载浏览器；默认无头运行，不弹窗抢焦点。',
    icon: '🌐'
  }
]

/** 按 key 取内置项信息 */
export function builtinInfo(key: string): McpBuiltinInfo | undefined {
  return MCP_BUILTINS.find((b) => b.key === key)
}

/** 一键模板：把"要会写 npx 命令"的门槛降到点一下 */
export interface McpTemplate {
  /** 模板标识（渲染层用作 React key，不入配置） */
  key: string
  /** 卡片标题 */
  label: string
  /** 一句话用途（说清"加了它能干什么"） */
  desc: string
  /** 图标（emoji，与设置页其它分区一致） */
  icon: string
  /** 预填配置（id 由渲染层生成；enabled 一律 false，让用户填完参数再开） */
  preset: Omit<McpServerConfig, 'id'>
}

// 模板清单（ 下架「本地文件浏览」与「网页抓取」：两者能力分别被内置
// 6 颗文件工具与 fetch_url 完全覆盖，且 MCP 工具不进审批/不走快照——留着等于引导用户
// 开一条无审批通道。剩下的模板都提供内置工具没有的能力，或用于验证连接。）
export const MCP_TEMPLATES: McpTemplate[] = [
  {
    key: 'memory',
    label: '知识图谱记忆',
    desc: '跨会话的知识图谱记忆（官方 memory server），可以让她记住实体与关系。',
    icon: '🧠',
    preset: {
      name: '记忆图谱',
      serverName: 'memory',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      env: {},
      toolCallTimeoutMs: 60_000,
      modes: ['work', 'learn'],
      enabled: false
    }
  },
  {
    key: 'github',
    label: 'GitHub',
    desc: '读写仓库、Issue 与 PR（官方 GitHub server）。需要一个 Personal Access Token——密钥走本机加密存储。',
    icon: '🐙',
    preset: {
      name: 'GitHub',
      serverName: 'github',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      // 值写成 ${secret:...} 引用：app.json 里只有引用，真值经 safeStorage 加密存 secrets.json
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${secret:GITHUB_PERSONAL_ACCESS_TOKEN}' },
      toolCallTimeoutMs: 60_000,
      modes: ['work', 'learn'],
      enabled: false
    }
  },
  {
    key: 'everything',
    label: '官方测试服务器',
    desc: 'MCP 官方的 everything server：工具/资源/提示词全都有，用来验证连接是否正常。',
    icon: '🧪',
    preset: {
      name: '官方测试',
      serverName: 'everything',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything'],
      env: {},
      toolCallTimeoutMs: 60_000,
      modes: ['work', 'learn'],
      enabled: false
    }
  }
]
