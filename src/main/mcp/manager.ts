// MCP 客户端管理。
// 设计要点：
// - 每个配置的 server 一个 Client + StdioClientTransport（SDK 唯一用途）
// - 崩溃隔离：server 进程退出只影响该 server，绝不拖垮主进程；调用返回可读错误回灌
// - 工具注册名带 mcp__<命名空间>__<tool> 前缀，与内置工具命名空间隔离
// - sync(config)：按配置差量启停（enabled 变化或"影响连接的字段"变化即重启对应 server）
// - **本文件不 import electron**：env 密钥解析要 safeStorage，改由调用方经 setEnvResolver 注入。
// 这样单测能直接跑真实 stdio 集成测试（不需要 electron 运行时）。
//
// 四项稳定性补强：
// ① 自动重连：有界指数退避 + 预算用尽即停（**仅对"曾经连上过"的 server** 生效——
// 首次就起不来通常意味着配置写错，重试无意义，这是 成熟实现的原始判断）
// ② tools/list_changed 通知 → 重新同步（确定性命名保证未变化的工具名不变）
// ③ tools/list 分页游标防循环（重复游标 = 服务器有 bug，中止并保留上一代工具）
// ④ 子进程树终结（Windows 下 npx 的孙进程 node 会残留，见 process-tree.ts）

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { AppConfig, ChatMode } from '@shared/types'
import { APP_ID } from '@shared/brand'
import { APP_VERSION } from '@shared/version'
import { effectiveNamespace } from '@shared/mcp-presets'
import { resolveEnvValues, type McpEnvResolver } from './env'
import { killProcessTree } from './process-tree'

/** 单个远端工具（listTools 结果的结构化缓存） */
interface RemoteTool {
  name: string
  description?: string
  inputSchema: unknown
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
}

/** 一个已连接 server 的运行时状态 */
interface McpConnection {
  client: Client
  transport: StdioClientTransport
  /** 直接子进程 pid（Windows 整树终结要用它） */
  pid: number | null
  /** 该 server 暴露的工具（listTools 缓存） */
  tools: RemoteTool[]
  /** 进程退出/连接断开后置 true：调用返回错误、工具从清单消失 */
  dead: boolean
  /** 是否为"曾经连上过又掉线"（决定要不要自动重连；首次就连不上不重试） */
  everConnected: boolean
  /** 已用掉的重连次数（连上后清零）；用尽即彻底放弃 */
  reconnectAttempts: number
  /** 待触发的重连定时器（closeOne / stopAll 要取消它） */
  reconnectTimer: ReturnType<typeof setTimeout> | null
  /** tools/list_changed 的防抖刷新定时器 */
  refreshTimer: ReturnType<typeof setTimeout> | null
}

/** 远端工具视图（合并进 harness 工具清单用） */
export interface McpToolView {
  /** 注册名：mcp__<命名空间>__<remoteToolName> */
  prefixedName: string
  /** 命名空间（= serverName，公开名的一部分） */
  namespace: string
  /** 配置 id（内部标识） */
  serverId: string
  /** 展示名（审批卡与工具描述里显示） */
  serverName: string
  /** 远端原名（tools/call 用它） */
  name: string
  description?: string
  inputSchema: unknown
  /** server 自报只读（annotations.readOnlyHint === true） */
  readOnly: boolean
  /**
   * server 自报破坏性（annotations.destructiveHint === true）。
   * **优先级高于 readOnly**：两者同时为真时按破坏性处理——
   * 第三方注解互相矛盾时，宁可多问一次也不能放行。
   */
  destructive: boolean
  /** 适用模式：由 server 配置决定，registry 按当前模式过滤 */
  modes: ChatMode[]
}

type ServersConfig = AppConfig['mcp']['servers']
type ServerConfig = ServersConfig[number]

/**
 * env 值里的密钥引用语法与解析规则见 `./env.ts`——那里是唯一实现，
 * 「连接」与「设置页测试连接」都走它，避免两边规则漂移。
 */

/** 工具调用默认超时（对齐 成熟实现的 60s）；可按 server 覆盖 */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000
/** 连接握手与 listTools 用较短的固定超时：启动阶段卡住要尽快失败，让用户马上看到"这个连不上" */
const HANDSHAKE_TIMEOUT_MS = 15_000
/** 重连退避序列（毫秒）：指数增长 + 上限。用尽即停止，不做无限重试。 */
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16_000] as const
/** 工具清单分页上限：正常服务器一两页就完，超过即认为服务端异常 */
const MAX_LIST_PAGES = 20
/** tools/list_changed 防抖：服务器可能在短时间内连续通知 */
const REFRESH_DEBOUNCE_MS = 300

/** env 密钥解析器：返回 null 表示未配置（由主进程注入，manager 本身不依赖 electron） */
export type McpEnvResolverFn = McpEnvResolver

// MCP clientInfo 走全局品牌单一来源（全应用版本号只写 package.json
// 一处——此前这里写死 0.1.0 已脱节三个大版本；协议字段用稳定 slug 不用展示名）

/** 影响"要不要重连"的字段：任一变化都必须重连（env/cwd 决定子进程行为，命名空间决定对外名字） */
function connectionSignature(cfg: ServerConfig): string {
  return JSON.stringify({
    command: cfg.command,
    args: cfg.args,
    env: cfg.env ?? {},
    cwd: cfg.cwd ?? '',
    ns: effectiveNamespace(cfg)
  })
}

/** 用 Promise.race 给任意异步操作加超时（SDK 自身不保证超时） */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label}超时（${ms / 1000}s）`)), ms)
      // 不要因为一个超时定时器把进程留住（应用退出时尤其重要）
      timer.unref?.()
    })
  ])
}

class McpManager {
  private connections = new Map<string, McpConnection>()
  /** id → 展示名 */
  private serverNames = new Map<string, string>()
  /** id → 命名空间（工具公开名的一段） */
  private namespaces = new Map<string, string>()
  /** 命名空间 → id（反向解析：工具名里是命名空间，调用要落回 id） */
  private namespaceToId = new Map<string, string>()
  /** id → 连接期配置快照（listTools 要读 modes，callTool 要读超时，重连要重建） */
  private configs = new Map<string, ServerConfig>()
  private signatures = new Map<string, string>()
  private envResolver: McpEnvResolverFn = () => null
  /** 应用正在退出：停止一切重连尝试 */
  private stopping = false
  /**
   * 最近一次 sync 期望启用的 server id 集合。
   *
   * 为什么需要：自动重连是**异步**的（退避等待 + 重新握手 + 发现工具）。
   * 若用户在重连窗口期内停用/删除了该 server，重连完成后若无条件写回连接，
   * 它就会被"偷偷复活"并常驻（既违背用户意图，也是资源泄漏）。
   * 写回前一律用这个集合确认"现在还想要它"。
   */
  private desired = new Set<string>()
  /** sync 串行化：并发 sync 会交错改动 connections/desired，导致状态错乱 */
  private syncChain: Promise<void> = Promise.resolve()

  /**
   * 注入 env 密钥解析器（把 ${secret:x} 换成 safeStorage 里的真值）。
   * 主进程启动时注入一次；不注入则所有引用都视为"未配置"（工具仍可用，只是 env 缺值）。
   */
  setEnvResolver(resolver: McpEnvResolverFn): void {
    this.envResolver = resolver
  }

  /**
   * 把配置里的 env 解析成真正传给子进程的变量（规则见 ./env.ts）。
   * 引用未配置时跳过该变量，由 server 自己报"缺 token"——比传空串更好定位。
   */
  private resolveEnv(cfg: ServerConfig, namespace: string): Record<string, string> {
    return resolveEnvValues(cfg, namespace, this.envResolver)
  }

  /** 按配置差量同步：新增/变更→重启；移除/禁用→停止（串行化，见 syncChain 注释） */
  async sync(servers: ServersConfig): Promise<void> {
    this.syncChain = this.syncChain.then(() => this.doSync(servers))
    return this.syncChain
  }

  private async doSync(servers: ServersConfig): Promise<void> {
    this.stopping = false
    const want = new Map(servers.filter((s) => s.enabled).map((s) => [s.id, s]))
    // 记录"当前期望"：重连/启动的异步写回都要先对照它（见 desired 注释）
    this.desired = new Set(want.keys())
    // 先重算命名空间索引（新增/改名的 server 在启动前就要能被解析）
    this.reindex(servers)

    // 停止：不在期望列表，或连接相关字段变化，或已死（留给下面的启动分支重连）
    for (const [id, conn] of this.connections) {
      const cfg = want.get(id)
      const changed =
        cfg === undefined ||
        conn.dead ||
        this.serverNames.get(id) !== cfg.name ||
        this.signatures.get(id) !== connectionSignature(cfg)
      if (changed) {
        await this.closeOne(id)
      }
    }
    // 启动：期望中有但未连接的
    for (const [id, cfg] of want) {
      if (!this.connections.has(id)) {
        await this.startOne(id, cfg)
      }
    }
    this.reindex(servers)
  }

  /**
   * 重建 命名空间 ↔ id 索引。
   * 重复命名空间的处理：**后到者让位**（保留先注册的），并打醒目日志——
   * 两个 server 抢同一个命名空间时工具名会撞车，必须让用户知道去改名。
   */
  private reindex(servers: ServersConfig): void {
    this.namespaces.clear()
    this.namespaceToId.clear()
    for (const cfg of servers.filter((s) => s.enabled)) {
      const ns = effectiveNamespace(cfg)
      const taken = this.namespaceToId.get(ns)
      if (taken !== undefined && taken !== cfg.id) {
        console.warn(`[mcp] 命名空间冲突：${ns} 已被 ${taken} 占用，${cfg.id} 的此配置不生效`)
        continue
      }
      this.namespaces.set(cfg.id, ns)
      this.namespaceToId.set(ns, cfg.id)
    }
  }

  /**
   * 建立连接并拉取工具清单（分页安全）。
   * 抽成独立方法：首次连接与自动重连走**完全同一条路径**，避免两处行为漂移。
   */
  private async connectAndDiscover(
    cfg: ServerConfig
  ): Promise<{ client: Client; transport: StdioClientTransport; tools: RemoteTool[] }> {
    const namespace = effectiveNamespace(cfg)
    const env = this.resolveEnv(cfg, namespace)
    const cwd = cfg.cwd?.trim() ?? ''
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      // 有解析结果才传 env：SDK 语义是与继承的父环境合并，传空对象会覆盖掉父环境同名变量
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(cwd !== '' ? { cwd } : {})
    })
    const client = new Client({ name: APP_ID, version: APP_VERSION })

    // 连接失败要把已 spawn 的进程收干净，否则重试会攒孤儿
    try {
      await withTimeout(client.connect(transport), HANDSHAKE_TIMEOUT_MS, '连接')
      const tools = await this.listAllTools(client)
      return { client, transport, tools }
    } catch (err) {
      const pid = transport.pid
      try {
        await client.close()
      } catch {
        /* 未连上：忽略 */
      }
      if (pid !== null) killProcessTree(pid)
      throw err
    }
  }

  /**
   * 拉取**全部**工具（处理分页）。
   *
   * 分页守卫：
   * - 游标必须前进：出现重复的非空游标即判定服务端异常，抛错中止（否则死循环拉爆内存）
   * - 页数有上限，防止服务端每次返回不同游标但永不结束
   * 抛错时调用方保留上一代工具清单，不会因为一次刷新失败就"工具全没了"。
   */
  private async listAllTools(client: Client): Promise<RemoteTool[]> {
    const acc: RemoteTool[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const res = await withTimeout(
        cursor === undefined ? client.listTools() : client.listTools({ cursor }),
        HANDSHAKE_TIMEOUT_MS,
        '获取工具清单'
      )
      acc.push(...(res.tools as RemoteTool[]))
      const next = res.nextCursor
      if (next === undefined || next === '') return acc
      if (seen.has(next)) {
        throw new Error(`工具清单分页游标重复（${next}），已中止以避免死循环`)
      }
      seen.add(next)
      cursor = next
    }
    throw new Error(`工具清单分页超过 ${MAX_LIST_PAGES} 页，已中止`)
  }

  private async startOne(id: string, cfg: ServerConfig): Promise<void> {
    const namespace = effectiveNamespace(cfg)
    try {
      const { client, transport, tools } = await this.connectAndDiscover(cfg)
      this.serverNames.set(id, cfg.name)
      this.signatures.set(id, connectionSignature(cfg))
      this.configs.set(id, cfg)
      const conn: McpConnection = {
        client,
        transport,
        pid: transport.pid,
        tools,
        dead: false,
        everConnected: true,
        reconnectAttempts: 0,
        reconnectTimer: null,
        refreshTimer: null
      }
      this.connections.set(id, conn)

      // 崩溃隔离 + 自动重连：进程退出只影响本 server
      transport.onclose = (): void => this.handleDisconnect(id)
      transport.onerror = (): void => this.handleDisconnect(id)

      // 工具清单变更通知：服务器动态增删工具时重新同步
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        this.scheduleRefresh(id)
      })
    } catch (err) {
      // 启动失败的 server 直接不可用（工具不出现）；原因落控制台便于排查。
      // 注意：**首次就连不上不安排重连**——通常是命令写错/依赖没装，重试一万次也不会变好。
      this.serverNames.set(id, cfg.name)
      this.configs.set(id, cfg)
      this.connections.set(id, {
        client: null as unknown as Client,
        transport: null as unknown as StdioClientTransport,
        pid: null,
        tools: [],
        dead: true,
        everConnected: false,
        reconnectAttempts: 0,
        reconnectTimer: null,
        refreshTimer: null
      })
      console.warn(
        `[mcp] server ${cfg.name}（命名空间 ${namespace}）启动失败：`,
        err instanceof Error ? err.message : err
      )
    }
  }

  /**
   * 断线处理。
   *
   * 两条路径：
   * - **曾经连上过**（everConnected）→ 这是"运行中掉线"，按退避序列重连
   * - 从未连上（也是 onclose 在启动失败后被触发的路径）→ 直接标记不可用，不重试
   *
   * 这样设计的原因：stdio server 起不来几乎都是配置问题，重试只会在用户眼前
   * 反复弹失败进程；而"跑着跑着挂了"才是重连真正要救的场景。
   */
  private handleDisconnect(id: string): void {
    const conn = this.connections.get(id)
    if (conn === undefined) return
    conn.dead = true
    if (this.stopping || !conn.everConnected) return
    // 已不在期望列表（用户停用/删除）→ 不安排重连
    if (!this.desired.has(id)) return
    const cfg = this.configs.get(id)
    if (cfg === undefined || cfg.reconnect === false) return
    this.scheduleReconnect(id)
  }

  private scheduleReconnect(id: string): void {
    const conn = this.connections.get(id)
    if (conn === undefined || conn.reconnectTimer !== null) return
    if (!this.desired.has(id)) return // 期间被停用：不再重试
    const attempt = conn.reconnectAttempts
    if (attempt >= RECONNECT_DELAYS_MS.length) {
      // 预算用尽：彻底放弃（工具保持不可用，用户可在设置页手动停用再启用）
      console.warn(
        `[mcp] server ${this.serverNames.get(id) ?? id} 重连 ${attempt} 次仍失败，停止重试`
      )
      return
    }
    const delay = RECONNECT_DELAYS_MS[attempt]
    conn.reconnectAttempts = attempt + 1
    const timer = setTimeout(() => {
      const current = this.connections.get(id)
      if (current !== undefined) current.reconnectTimer = null
      void this.reconnect(id)
    }, delay)
    // 定时器不应阻止应用退出
    timer.unref?.()
    conn.reconnectTimer = timer
    console.warn(
      `[mcp] server ${this.serverNames.get(id) ?? id} 掉线，${delay / 1000}s 后重连（第 ${conn.reconnectAttempts} 次）`
    )
  }

  private async reconnect(id: string): Promise<void> {
    if (this.stopping) return
    const conn = this.connections.get(id)
    const cfg = this.configs.get(id)
    if (conn === undefined || cfg === undefined) return
    // 先把旧连接收干净（含整树终结），避免重连时旧进程还占着资源
    await this.disposeConnection(id)
    try {
      const { client, transport, tools } = await this.connectAndDiscover(cfg)
      const fresh: McpConnection = {
        client,
        transport,
        pid: transport.pid,
        tools,
        dead: false,
        // everConnected 已是 true；attempts 在成功后清零，下次掉线从头退避
        everConnected: true,
        reconnectAttempts: 0,
        reconnectTimer: null,
        refreshTimer: null
      }
      // ★ 等待期间用户可能已停用/删除该 server —— 此时绝不能把连接写回，
      // 否则它会被"偷偷复活"并常驻（资源泄漏 + 违背用户意图）。
      if (this.stopping || !this.desired.has(id)) {
        const pid = fresh.pid
        try {
          await client.close()
        } catch {
          /* 忽略 */
        }
        if (pid !== null) killProcessTree(pid)
        return
      }
      this.connections.set(id, fresh)
      transport.onclose = (): void => this.handleDisconnect(id)
      transport.onerror = (): void => this.handleDisconnect(id)
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        this.scheduleRefresh(id)
      })
      console.warn(`[mcp] server ${cfg.name} 重连成功`)
    } catch (err) {
      console.warn(`[mcp] server ${cfg.name} 重连失败：`, err instanceof Error ? err.message : err)
      // 期间被停用/删除 → 不写回占位（否则留下一条不该存在的死连接）
      if (this.stopping || !this.desired.has(id)) return
      // 保留占位，继续下一次退避
      this.connections.set(id, {
        client: null as unknown as Client,
        transport: null as unknown as StdioClientTransport,
        pid: null,
        tools: [],
        dead: true,
        everConnected: true,
        reconnectAttempts: conn.reconnectAttempts,
        reconnectTimer: null,
        refreshTimer: null
      })
      this.scheduleReconnect(id)
    }
  }

  /** tools/list_changed → 防抖刷新工具清单 */
  private scheduleRefresh(id: string): void {
    const conn = this.connections.get(id)
    if (conn === undefined || conn.refreshTimer !== null) return
    const timer = setTimeout(() => {
      const current = this.connections.get(id)
      if (current !== undefined) current.refreshTimer = null
      void this.refreshTools(id)
    }, REFRESH_DEBOUNCE_MS)
    timer.unref?.()
    conn.refreshTimer = timer
  }

  /**
   * 重新拉取工具清单并替换缓存。
   * **失败时保留上一代**：一次刷新失败不该让用户眼前的工具全消失
   * （通用策略："保留可调用工具"）。
   */
  private async refreshTools(id: string): Promise<void> {
    const conn = this.connections.get(id)
    const cfg = this.configs.get(id)
    if (conn === undefined || cfg === undefined || conn.dead || !conn.client) return
    try {
      const tools = await this.listAllTools(conn.client)
      // 期间可能已被 closeOne 取代，写回前再确认一次
      const latest = this.connections.get(id)
      if (latest === conn && !latest.dead) latest.tools = tools
    } catch (err) {
      console.warn(
        `[mcp] server ${cfg.name} 刷新工具清单失败（保留原有清单）：`,
        err instanceof Error ? err.message : err
      )
    }
  }

  /** 只断开连接、不动 map（重连路径内部用） */
  private async disposeConnection(id: string): Promise<void> {
    const conn = this.connections.get(id)
    if (conn === undefined) return
    if (conn.reconnectTimer !== null) clearTimeout(conn.reconnectTimer)
    if (conn.refreshTimer !== null) clearTimeout(conn.refreshTimer)
    const pid = conn.pid
    if (conn.client) {
      try {
        await conn.client.close()
      } catch {
        // 关闭失败忽略（进程可能已死）
      }
    }
    // ★ ：SDK 只 kill 直接子进程；npx 场景下真正的 server 是孙进程，必须整树终结
    if (pid !== null) killProcessTree(pid)
  }

  private async closeOne(id: string): Promise<void> {
    await this.disposeConnection(id)
    this.connections.delete(id)
    this.signatures.delete(id)
    this.serverNames.delete(id)
    this.configs.delete(id)
  }

  /** 全部关闭（应用退出时调用）：先立停止标记，避免退出过程触发重连 */
  async stopAll(): Promise<void> {
    this.stopping = true
    for (const id of [...this.connections.keys()]) {
      await this.closeOne(id)
    }
  }

  /** 当前可用的远端工具视图（dead server 的工具不出现） */
  listTools(): McpToolView[] {
    const out: McpToolView[] = []
    for (const [id, conn] of this.connections) {
      if (conn.dead) continue
      const namespace = this.namespaces.get(id) ?? id
      const serverName = this.serverNames.get(id) ?? id
      const cfg = this.configs.get(id)
      for (const t of conn.tools) {
        out.push({
          prefixedName: `mcp__${namespace}__${t.name}`,
          namespace,
          serverId: id,
          serverName,
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          readOnly: t.annotations?.readOnlyHint === true,
          destructive: t.annotations?.destructiveHint === true,
          modes: cfg?.modes ?? ['work', 'learn']
        })
      }
    }
    return out
  }

  /** 命名空间（或 id，兼容直接按 id 调用）→ 内部 id */
  private resolveServerId(namespaceOrId: string): string | null {
    if (this.connections.has(namespaceOrId)) return namespaceOrId
    return this.namespaceToId.get(namespaceOrId) ?? null
  }

  /** 调用远端工具；任何失败都收敛为可读错误（回灌 LLM），绝不抛出拖垮主进程 */
  async callTool(
    serverId: string,
    toolName: string,
    argsJson: string
  ): Promise<{ ok: boolean; result: string }> {
    const id = this.resolveServerId(serverId)
    const conn = id === null ? undefined : this.connections.get(id)
    if (
      id === null ||
      conn === undefined ||
      conn.dead ||
      conn.client === null ||
      conn.client === undefined
    ) {
      return {
        ok: false,
        result: `MCP 服务器「${serverId}」当前不可用（可能已退出或启动失败）。请到 设置 → MCP 检查，或改用别的方式完成任务。`
      }
    }
    const timeoutMs = this.configs.get(id)?.toolCallTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    let args: Record<string, unknown> = {}
    try {
      args = argsJson.trim() === '' ? {} : (JSON.parse(argsJson) as Record<string, unknown>)
    } catch {
      return { ok: false, result: `参数不是合法 JSON：${argsJson.slice(0, 200)}` }
    }
    try {
      const result = await withTimeout(
        conn.client.callTool({ name: toolName, arguments: args }),
        timeoutMs,
        '工具调用'
      )
      const isError = (result as { isError?: boolean }).isError === true
      const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? []
      const text = content
        .map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type} 内容]`))
        .join('\n')
      if (isError) {
        // 工具级错误（如参数不对）不等于连接坏了，不能标记 dead——
        // 标记了会让健康连接被误判掉线、触发不必要的重连。
        return { ok: false, result: text === '' ? 'MCP 工具返回错误（无文本说明）' : text }
      }
      return { ok: true, result: text === '' ? '（无文本结果）' : text }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 超时/传输层异常意味着连接可能已坏：交给统一的掉线处理（可能触发重连）
      this.handleDisconnect(id)
      return { ok: false, result: `MCP 工具调用失败：${message}` }
    }
  }
}

export const mcpManager = new McpManager()
