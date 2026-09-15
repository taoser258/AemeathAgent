// MCP 服务器分区。
//
// 解决的核心问题：原来只有"名称 + 一整行命令"两个输入框——用户得自己会写
// `npx -y @modelcontextprotocol/server-filesystem D:/dir`，还得知道要填哪个环境变量，
// 配错了也只有一句 console 警告。现在提供：
// 一键模板 / 命名空间可视化 / 环境变量（含加密密钥）/ 工作目录 / 超时 / 适用模式 / 测试连接
//
// 密钥处理：值写 `${secret:变量名}` 进 app.json，真值走 mcpSetSecret 加密落盘，
// 渲染层永远读不回明文——只在 settingsGet().keyedMcpSecretIds 里看到"已配置"。

import { useCallback, useEffect, useState } from 'react'
import type { ChatMode, McpServerConfig, McpTestResult } from '@shared/types'
import {
  MCP_BUILTINS,
  MCP_TEMPLATES,
  builtinInfo,
  effectiveNamespace,
  isValidNamespace,
  suggestNamespace
} from '@shared/mcp-presets'

/** 环境变量行（编辑态；保存时再折叠回 Record） */
interface EnvRow {
  key: string
  value: string
  /** true = 该行的值当密钥处理（加密存 safeStorage，配置里只留 ${secret:key}） */
  secret: boolean
}

/** 编辑态草稿：列表行 + 环境变量行数组（env 是对象，编辑需要有序行） */
interface Draft {
  id: string
  name: string
  serverName: string
  command: string
  argsText: string
  cwd: string
  timeoutSec: string
  modes: ChatMode[]
  reconnect: boolean
  envRows: EnvRow[]
  /** 新建时若由模板生成，标记来源仅供展示 */
  fromTemplate?: string
  /** 内置标识：编辑内置项时必须原样带回，否则它会"脱壳"成用户自配项 */
  builtin?: string
}

/** 命令摘要：可执行名 + 首个位置参数 + 参数计数（完整内容点「编辑」查看；整串路径又长又难读） */
function commandSummary(server: McpServerConfig): string {
  const exe = server.command.split(/[\\/]/).pop() ?? server.command
  const positional = server.args.filter((a) => !a.startsWith('-'))
  const first = positional[0]?.split(/[\\/]/).pop() ?? ''
  const count = server.args.length
  return `${exe}${first !== '' ? ` ${first}` : ''}${count > 1 ? ` 等 ${count} 项参数` : ''}${
    server.cwd !== undefined ? ` · 工作目录 ${server.cwd}` : ''
  }`
}

function newMcpId(): string {
  return 'mcp-' + Math.random().toString(36).slice(2, 8)
}

/** 配置 → 草稿（env 展开成有序行；密钥引用识别为 secret 行） */
function toDraft(server: McpServerConfig, fromTemplate?: string): Draft {
  const envRows: EnvRow[] = Object.entries(server.env ?? {}).map(([key, value]) => {
    const ref = /^\$\{secret:([^}]+)\}$/.exec(value.trim())
    return ref !== null
      ? { key, value: '', secret: true } // 密钥真值读不回来，留空 = 不改动
      : { key, value, secret: false }
  })
  return {
    id: server.id,
    name: server.name,
    serverName: server.serverName ?? effectiveNamespace(server),
    command: server.command,
    argsText: server.args.join(' '),
    cwd: server.cwd ?? '',
    // 配置里存毫秒，UI 用秒（人看得懂的单位）
    timeoutSec:
      server.toolCallTimeoutMs !== undefined
        ? String(Math.round(server.toolCallTimeoutMs / 1000))
        : '',
    modes: server.modes ?? ['work', 'learn'],
    // 缺省 true（与主进程语义一致）：只有显式 false 才是"关了"
    reconnect: server.reconnect !== false,
    envRows,
    ...(server.builtin !== undefined ? { builtin: server.builtin } : {}),
    fromTemplate
  }
}

function emptyDraft(): Draft {
  const id = newMcpId()
  return {
    id,
    name: '',
    // 新建时给个可用的默认命名空间（用户可用模板或改名，但**生成后就不再随名字变**）
    serverName: suggestNamespace('') || id,
    command: '',
    argsText: '',
    cwd: '',
    timeoutSec: '',
    modes: ['work', 'learn'],
    reconnect: true,
    envRows: []
  }
}

/** 指定路径是否已配置密钥（keyedMcpSecretIds 形如 mcp:<命名空间>:<变量名>） */
function keyedSecretSet(ids: string[], namespace: string): Set<string> {
  const prefix = `mcp:${namespace}:`
  return new Set(ids.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length)))
}

function McpSection(): React.JSX.Element {
  const [servers, setServers] = useState<McpServerConfig[]>([])
  const [keyedIds, setKeyedIds] = useState<string[]>([])
  const [removedBuiltins, setRemovedBuiltins] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [testResult, setTestResult] = useState<McpTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)

  const flash = (message: string): void => {
    setNotice(message)
    setTimeout(() => setNotice(''), 3000)
  }

  const reload = useCallback((): void => {
    void window.petAPI.settingsGet().then((res) => {
      setServers(res.config.mcp?.servers ?? [])
      setKeyedIds(res.keyedMcpSecretIds)
      setRemovedBuiltins(res.config.mcp?.removedBuiltins ?? [])
    })
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const save = (next: McpServerConfig[], message = '已保存，服务器连接已即时同步 ✓'): void => {
    setServers(next)
    void window.petAPI
      .settingsSet({ mcp: { servers: next } })
      .then(() => {
        flash(message)
        reload() // 重新拉一次：密钥"已配置"状态需要主进程判定
      })
      .catch(() => flash('保存失败，请重试'))
  }

  const toggle = (id: string): void => {
    save(servers.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)))
  }

  /**
   * 删除服务器。
   * 若删的是内置项，必须同时把它的 key 记进 removedBuiltins——
   * 否则下次启动的自愈同步又会把它补回来（用户会觉得"删不掉"）。
   */
  const remove = (id: string): void => {
    const target = servers.find((s) => s.id === id)
    const nextServers = servers.filter((s) => s.id !== id)
    setServers(nextServers)
    const patch: { mcp: { servers: McpServerConfig[]; removedBuiltins?: string[] } } = {
      mcp: { servers: nextServers }
    }
    if (target?.builtin !== undefined) {
      const nextRemoved = [...new Set([...removedBuiltins, target.builtin])]
      patch.mcp.removedBuiltins = nextRemoved
      setRemovedBuiltins(nextRemoved)
    }
    void window.petAPI
      .settingsSet(patch)
      .then(() => {
        flash(
          target?.builtin !== undefined
            ? '已删除内置服务器（可在下方「恢复内置」找回；密钥已一并清理）'
            : '已删除（该服务器的密钥也已一并清理）'
        )
        reload()
      })
      .catch(() => flash('保存失败，请重试'))
  }

  /** 恢复被删除的内置项：主进程把它从名单移回并补齐 */
  const restoreBuiltin = (key: string): void => {
    void window.petAPI.mcpRestoreBuiltin(key).then((res) => {
      if (res.ok) {
        flash('已恢复内置服务器（默认停用，需要时点「启用」）')
        reload()
      } else {
        flash('恢复失败，请重试')
      }
    })
  }

  /** 草稿 → 配置（含密钥落盘） */
  const commit = async (): Promise<void> => {
    if (draft === null) return
    const name = draft.name.trim()
    const command = draft.command.trim()
    if (name === '' || command === '') {
      flash('名称与命令必填')
      return
    }
    const ns = draft.serverName.trim()
    if (!isValidNamespace(ns)) {
      flash('命名空间只能用字母、数字、下划线和短横线（1–32 位）')
      return
    }
    // 命名空间不能与其它服务器重复（重复会导致工具名撞车）
    const clash = servers.find((s) => s.id !== draft.id && effectiveNamespace(s) === ns)
    if (clash !== undefined) {
      flash(`命名空间 ${ns} 已被「${clash.name}」占用，请换一个`)
      return
    }

    // ── 环境变量：密钥行先落盘（safeStorage），配置里只留引用 ──
    const env: Record<string, string> = {}
    for (const row of draft.envRows) {
      const key = row.key.trim()
      if (key === '') continue
      if (row.secret) {
        const value = row.value.trim()
        if (value !== '') {
          const res = await window.petAPI.mcpSetSecret({ namespace: ns, varName: key, value })
          if (!res.ok) {
            flash(`密钥「${key}」保存失败：${res.error ?? '未知原因'}`)
            return
          }
        }
        // 值为空 = 保留已存的密钥（真值读不回来，所以空不覆盖）
        env[key] = `\${secret:${key}}`
      } else {
        env[key] = row.value
      }
    }

    const timeoutNum = Number(draft.timeoutSec)
    const existing = servers.find((s) => s.id === draft.id)
    const next: McpServerConfig = {
      id: draft.id,
      name,
      serverName: ns,
      command,
      args: draft.argsText.split(' ').filter((a) => a.trim() !== ''),
      enabled: existing?.enabled ?? true,
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(draft.cwd.trim() !== '' ? { cwd: draft.cwd.trim() } : {}),
      ...(Number.isFinite(timeoutNum) && timeoutNum >= 1
        ? { toolCallTimeoutMs: Math.min(600, Math.floor(timeoutNum)) * 1000 }
        : {}),
      ...(draft.modes.length > 0 ? { modes: draft.modes } : {}),
      // reconnect 缺省 true：只有关掉才落盘（保持配置干净、老配置语义不变）
      ...(draft.reconnect ? {} : { reconnect: false }),
      // ★ 内置标识必须原样带回：丢了它就"脱壳"成用户自配项，
      // 下次启动自愈同步会再补一条标准内置，结果出现两个 Playwright。
      ...(draft.builtin !== undefined ? { builtin: draft.builtin } : {})
    }
    save(
      existing !== undefined
        ? servers.map((s) => (s.id === draft.id ? next : s))
        : [...servers, next]
    )
    setDraft(null)
    setTestResult(null)
  }

  const addFromTemplate = (index: number): void => {
    const tpl = MCP_TEMPLATES[index]
    const id = newMcpId()
    setDraft(
      toDraft(
        {
          id,
          ...tpl.preset,
          // 模板里的 serverName 可能与本机既有重名：撞了就退到 id 派生
          serverName: servers.some((s) => effectiveNamespace(s) === tpl.preset.serverName)
            ? id
            : tpl.preset.serverName,
          enabled: false
        },
        tpl.label
      )
    )
    setShowTemplates(false)
    setTestResult(null)
  }

  const test = async (): Promise<void> => {
    if (draft === null) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.petAPI.mcpTest({
        id: draft.id,
        name: draft.name.trim() || '测试',
        serverName: draft.serverName.trim(),
        command: draft.command.trim(),
        args: draft.argsText.split(' ').filter((a) => a.trim() !== ''),
        ...(draft.cwd.trim() !== '' ? { cwd: draft.cwd.trim() } : {}),
        enabled: true
      })
      setTestResult(result)
    } catch {
      setTestResult({ ok: false, error: '测试失败：与主进程通信异常' })
    } finally {
      setTesting(false)
    }
  }

  const nsPreview =
    draft === null ? '' : isValidNamespace(draft.serverName.trim()) ? draft.serverName.trim() : '?'
  const keyedHere = draft === null ? new Set<string>() : keyedSecretSet(keyedIds, nsPreview)

  return (
    <div className="settings-card">
      <div className="settings-card-head">
        <span className="settings-card-icon">🔌</span>
        <div>
          <div className="settings-card-title">MCP 服务器</div>
          <div className="settings-card-desc">
            接入外部工具（MCP 协议，stdio）。工具以{' '}
            <code className="settings-mono">mcp__命名空间__工具名</code>{' '}
            注册；只读工具直接执行，其余执行前要你批准。命令需本机可运行。
          </div>
        </div>
      </div>

      {notice !== '' && <p className="settings-hint">{notice}</p>}

      {/* ── 服务器列表 ── */}
      {servers.length === 0 ? (
        <p className="settings-hint">还没有配置 MCP 服务器。从下面挑一个模板，或手动添加。</p>
      ) : (
        <div className="profile-list">
          {servers.map((server) => {
            const ns = effectiveNamespace(server)
            const secretCount = Object.values(server.env ?? {}).filter((v) =>
              v.startsWith('${secret:')
            ).length
            const configured = keyedSecretSet(keyedIds, ns).size
            return (
              <div key={server.id} className="profile-row">
                <div className="profile-info">
                  <div className="profile-name">
                    {server.enabled ? '🟢' : '⚪'} {server.name}
                    {server.builtin !== undefined && (
                      <span
                        className="settings-badge"
                        title="应用内置，命令与参数会随安装路径自动校正"
                      >
                        {builtinInfo(server.builtin)?.icon ?? '📦'} 内置
                      </span>
                    )}
                    <span className="settings-badge settings-mono">{ns}</span>
                    {!server.enabled && <span className="settings-badge">已停用</span>}
                  </div>
                  <div className="profile-meta">{commandSummary(server)}</div>
                  <div className="profile-meta">
                    适用：
                    {(server.modes ?? ['work', 'learn'])
                      .map((m) => (m === 'work' ? '🧰 工作' : '📚 学习'))
                      .join(' / ')}
                    {secretCount > 0 ? ` · 密钥 ${configured}/${secretCount} 已配置` : ''}
                    {server.reconnect === false ? ' · 已关闭自动重连' : ''}
                  </div>
                </div>
                <div className="profile-actions">
                  <button
                    type="button"
                    className="settings-btn"
                    onClick={() => {
                      setDraft(toDraft(server))
                      setTestResult(null)
                    }}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="settings-btn"
                    onClick={() => {
                      setDraft(toDraft(server))
                      setTestResult(null)
                      setTimeout(() => void test(), 0)
                    }}
                  >
                    测试
                  </button>
                  <button type="button" className="settings-btn" onClick={() => toggle(server.id)}>
                    {server.enabled ? '停用' : '启用'}
                  </button>
                  <button
                    type="button"
                    className="settings-btn danger"
                    onClick={() => remove(server.id)}
                  >
                    删除
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── 已删除的内置项：提供找回入口（内置项本会自动补齐，所以"删掉"必须能撤回） ── */}
      {draft === null && removedBuiltins.length > 0 && (
        <div className="mcp-removed">
          <span className="mcp-field-hint">已删除的内置服务器（不再自动补回，可随时找回）：</span>
          <div className="mcp-templates">
            {removedBuiltins.map((key) => {
              const info = MCP_BUILTINS.find((b) => b.key === key)
              return (
                <button
                  key={key}
                  type="button"
                  className="settings-btn"
                  onClick={() => restoreBuiltin(key)}
                >
                  ↺ 恢复 {info?.icon ?? '📦'} {info?.label ?? key}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* ── 模板区 ── */}
      {draft === null && (
        <div className="mcp-templates">
          <button
            type="button"
            className="settings-btn"
            onClick={() => setShowTemplates((v) => !v)}
          >
            {showTemplates ? '收起模板' : '＋ 从模板添加'}
          </button>
          <button type="button" className="settings-btn" onClick={() => setDraft(emptyDraft())}>
            ＋ 手动添加
          </button>
        </div>
      )}
      {showTemplates && draft === null && (
        <div className="profile-list">
          {MCP_TEMPLATES.map((tpl, index) => (
            <div key={tpl.key} className="profile-row">
              <div className="profile-info">
                <div className="profile-name">
                  {tpl.icon} {tpl.label}
                </div>
                <div className="profile-meta">{tpl.desc}</div>
              </div>
              <div className="profile-actions">
                <button
                  type="button"
                  className="settings-btn primary"
                  onClick={() => addFromTemplate(index)}
                >
                  使用
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── 编辑态 ── */}
      {draft !== null && (
        <div className="mcp-draft">
          <div className="profile-editor-title">
            {draft.fromTemplate !== undefined
              ? `配置模板：${draft.fromTemplate}（填好参数后点保存）`
              : servers.some((s) => s.id === draft.id)
                ? servers.find((s) => s.id === draft.id)?.builtin !== undefined
                  ? '编辑内置服务器（命令与参数会随安装环境自动校正，改这两项不生效；开关、适用模式、超时有效）'
                  : '编辑服务器'
                : '添加服务器'}
          </div>

          <label className="mcp-field">
            <span>名称</span>
            <input
              className="settings-input"
              placeholder="展示名，随便起"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>

          <label className="mcp-field">
            <span>命名空间</span>
            <input
              className="settings-input"
              value={draft.serverName}
              onChange={(e) => setDraft({ ...draft, serverName: e.target.value })}
            />
            <span className="mcp-field-hint">
              工具注册为 <code className="settings-mono">mcp__{nsPreview}__工具名</code>。
              改了它，历史对话里的工具调用记录就对不上了，所以尽量一次定好。
            </span>
          </label>

          <label className="mcp-field">
            <span>命令</span>
            <input
              className="settings-input"
              placeholder="npx / node / uvx / 绝对路径"
              value={draft.command}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            />
          </label>

          <label className="mcp-field">
            <span>参数</span>
            <input
              className="settings-input"
              placeholder="空格分隔，如：-y @modelcontextprotocol/server-filesystem D:/dir"
              value={draft.argsText}
              onChange={(e) => setDraft({ ...draft, argsText: e.target.value })}
            />
          </label>

          <div className="mcp-row-2">
            <label className="mcp-field">
              <span>工作目录（可选）</span>
              <input
                className="settings-input"
                placeholder="留空 = 继承应用目录"
                value={draft.cwd}
                onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
              />
            </label>
            <label className="mcp-field">
              <span>超时（秒，可选）</span>
              <input
                className="settings-input"
                placeholder="默认 60"
                value={draft.timeoutSec}
                onChange={(e) => setDraft({ ...draft, timeoutSec: e.target.value })}
              />
            </label>
          </div>

          <div className="mcp-field">
            <span>适用模式</span>
            <div className="mcp-modes">
              {(['work', 'learn'] as ChatMode[]).map((mode) => {
                const checked = draft.modes.includes(mode)
                return (
                  <label key={mode} className="mcp-check">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setDraft({
                          ...draft,
                          // 至少留一个：两个都不勾等于这个 server 白配（chat 本来就无工具）
                          modes: checked
                            ? draft.modes.filter((m) => m !== mode)
                            : [...draft.modes, mode]
                        })
                      }
                    />
                    {mode === 'work' ? '🧰 工作模式' : '📚 学习模式'}
                  </label>
                )
              })}
            </div>
            <span className="mcp-field-hint">对话模式（💬）本来就没有工具，无需配置。</span>
          </div>

          <div className="mcp-field">
            <span>掉线自动重连</span>
            <div className="mcp-modes">
              <label className="mcp-check">
                <input
                  type="checkbox"
                  checked={draft.reconnect}
                  onChange={(e) => setDraft({ ...draft, reconnect: e.target.checked })}
                />
                服务器意外退出时自动重连（退避重试，最多 5 次）
              </label>
            </div>
            <span className="mcp-field-hint">
              只在「连上过又掉线」时生效；首次就连不上通常是命令写错，不会无意义重试。
              关掉后服务器挂了需要手动停用再启用。
            </span>
          </div>

          {/* ── 环境变量 ── */}
          <div className="mcp-field">
            <span>环境变量</span>
            {draft.envRows.length === 0 && (
              <span className="mcp-field-hint">
                该服务器不需要环境变量。若它要 token / 密码，请添加一行并勾选「密钥」——
                值会加密存在本机，不会写进配置文件。
              </span>
            )}
            {draft.envRows.map((row, index) => {
              const isKeyed = row.secret && keyedHere.has(row.key.trim())
              return (
                <div key={index} className="mcp-env-row">
                  <input
                    className="settings-input mcp-env-key"
                    placeholder="变量名"
                    value={row.key}
                    onChange={(e) => {
                      const next = [...draft.envRows]
                      next[index] = { ...row, key: e.target.value }
                      setDraft({ ...draft, envRows: next })
                    }}
                  />
                  <input
                    className="settings-input"
                    type={row.secret ? 'password' : 'text'}
                    placeholder={row.secret && isKeyed ? '已配置（留空 = 不改动）' : '值'}
                    value={row.value}
                    onChange={(e) => {
                      const next = [...draft.envRows]
                      next[index] = { ...row, value: e.target.value }
                      setDraft({ ...draft, envRows: next })
                    }}
                  />
                  <label className="mcp-check" title="勾选后该值加密存储，配置里只留引用">
                    <input
                      type="checkbox"
                      checked={row.secret}
                      onChange={(e) => {
                        const next = [...draft.envRows]
                        next[index] = { ...row, secret: e.target.checked }
                        setDraft({ ...draft, envRows: next })
                      }}
                    />
                    🔒 密钥
                  </label>
                  {row.secret && isKeyed && <span className="settings-badge">已配置</span>}
                  <button
                    type="button"
                    className="settings-btn danger"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        envRows: draft.envRows.filter((_, i) => i !== index)
                      })
                    }
                  >
                    删除
                  </button>
                </div>
              )
            })}
            <div className="mcp-templates">
              <button
                type="button"
                className="settings-btn"
                onClick={() =>
                  setDraft({
                    ...draft,
                    envRows: [...draft.envRows, { key: '', value: '', secret: false }]
                  })
                }
              >
                ＋ 变量
              </button>
              <button
                type="button"
                className="settings-btn"
                onClick={() =>
                  setDraft({
                    ...draft,
                    envRows: [...draft.envRows, { key: '', value: '', secret: true }]
                  })
                }
              >
                ＋ 密钥
              </button>
            </div>
          </div>

          {/* ── 测试结果 ── */}
          {testResult !== null && (
            <div className={testResult.ok ? 'mcp-result ok' : 'mcp-result bad'}>
              {testResult.ok ? '✓ 连接成功' : '✗ 连接失败'}
              {testResult.ok && testResult.toolCount !== undefined && (
                <>
                  ：发现 {testResult.toolCount} 个工具
                  {testResult.toolNames !== undefined && testResult.toolNames.length > 0 && (
                    <div className="mcp-result-tools">
                      {testResult.toolNames.join('、')}
                      {testResult.toolCount > testResult.toolNames.length ? ' …' : ''}
                    </div>
                  )}
                </>
              )}
              {testResult.error !== undefined && <div>{testResult.error}</div>}
            </div>
          )}

          <div className="profile-actions">
            <button type="button" className="settings-btn primary" onClick={() => void commit()}>
              保存并连接
            </button>
            <button
              type="button"
              className="settings-btn"
              disabled={testing || draft.command.trim() === ''}
              onClick={() => void test()}
            >
              {testing ? '测试中…' : '测试连接'}
            </button>
            <button
              type="button"
              className="settings-btn"
              onClick={() => {
                setDraft(null)
                setTestResult(null)
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default McpSection
