// 独立设置窗页面：左侧导航（分区）+ 右侧卡片内容 + 自绘窗口控制。
// 设置页：桌宠 / 聊天 / 模型 / 关于 分区。
// 拖动：整个窗口按住非交互区域即可拖动（与桌宠窗同款手动拖动方案，
// 走 win:window-move；不依赖 -webkit-app-region——透明窗上它会吞指针事件）。

import type { ThemeSetting } from '../theme'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppConfig,
  ModelProfile,
  ReasoningAdapterId,
  ReasoningEffort,
  SessionMeta,
  TokenUsageResult,
  UpdateStatus
} from '@shared/types'
import { MODEL_PRESETS } from '@shared/model-presets'
import { pickVisionProfile, visionUnavailableHint } from '@shared/vision-pick'
import { REASONING_LABELS, REASONING_LEVELS } from '@shared/reasoning'
import {
  ADAPTER_LABELS,
  adapterFoldedLevels,
  adapterLevelsHint,
  resolveReasoningAdapter
} from '@shared/reasoning-adapters'
import { APP_FOOTER_LABEL, APP_STAGE_LABEL } from '@shared/version'
import { APP_NAME } from '@shared/brand'
import WindowControls from '../WindowControls'
import { startWindowDrag, toggleWindowMaximize } from '../window-drag'
import McpSection from './McpSection'
import avatar from '../assets/aemeath-avatar.png'
import logoDeepseek from '../assets/vendor/p-deepseek.png'
import logoGlm from '../assets/vendor/p-glm.png'
import logoQwen from '../assets/vendor/p-qwen.png'
import logoKimi from '../assets/vendor/p-kimi.png'
import logoDoubao from '../assets/vendor/p-doubao.png'
import logoMimo from '../assets/vendor/p-mimo.png'
import logoMinimax from '../assets/vendor/p-minimax.png'
import logoClaude from '../assets/vendor/p-claude.png'
import logoGemini from '../assets/vendor/p-gemini.png'

/** 预设档案的官方 logo（多取自 LobeHub Icons；MiMo 由官方 wordmark 反相去背处理，来源见 assets/vendor/）；自定义档案走字母头像 */
const VENDOR_LOGOS: Record<string, string> = {
  'p-deepseek': logoDeepseek,
  'p-glm': logoGlm,
  'p-qwen': logoQwen,
  'p-kimi': logoKimi,
  'p-doubao': logoDoubao,
  'p-mimo': logoMimo,
  'p-minimax': logoMinimax,
  'p-claude': logoClaude,
  'p-gemini': logoGemini
}

/** 厂商预设档案不可删除；仅自定义档案可删 */
function isPresetId(id: string): boolean {
  return MODEL_PRESETS.some((p) => p.id === id)
}

type SectionId =
  | 'pet'
  | 'appearance'
  | 'user'
  | 'memory'
  | 'sessions'
  | 'mcp'
  | 'workspace'
  | 'model'
  | 'usage'
  | 'about'

interface NavItem {
  id: SectionId
  icon: string
  label: string
}

// 账本分区已移除。撤销机制本身不受影响——
// ledger 仍是撤销上一步的数据底座（主进程 IPC 与快照链原样保留）。
const NAV: Array<NavItem> = [
  { id: 'pet', icon: '🐾', label: '桌宠' },
  { id: 'appearance', icon: '🎨', label: '外观' },
  { id: 'user', icon: '👤', label: '个人' },
  { id: 'memory', icon: '🧠', label: '记忆' },
  { id: 'sessions', icon: '🗂️', label: '会话' },
  { id: 'mcp', icon: '🔌', label: 'MCP' },
  { id: 'workspace', icon: '📁', label: '目录' },
  { id: 'model', icon: '🤖', label: '模型' },
  { id: 'usage', icon: '📊', label: '用量' },
  { id: 'about', icon: 'ℹ️', label: '关于' }
]

const SOON_NAV: Array<{ icon: string; label: string; note: string }> = []

/** 外观分区：主题三选一，改动即写配置并全窗生效（各窗自行监听 SETTINGS_CHANGED） */
function AppearanceSection(): React.JSX.Element {
  const [theme, setTheme] = useState<ThemeSetting | null>(null)

  useEffect(() => {
    void window.petAPI.getConfig().then((c) => setTheme(c.appearance?.theme ?? 'light'))
  }, [])

  const pick = (next: ThemeSetting): void => {
    setTheme(next) // 乐观更新
    void window.petAPI.settingsSet({ appearance: { theme: next } }).catch(() => {
      void window.petAPI.getConfig().then((c) => setTheme(c.appearance?.theme ?? 'light'))
    })
  }

  const options: Array<{ value: ThemeSetting; icon: string; label: string; desc: string }> = [
    { value: 'system', icon: '🌗', label: '跟随系统', desc: 'Windows 深浅色切换时爱弥斯跟着换' },
    { value: 'light', icon: '🌞', label: '浅色', desc: '樱粉暖白纸感（默认观感）' },
    { value: 'dark', icon: '🌙', label: '深色', desc: '深紫夜色，樱粉提亮保证对比' }
  ]

  return (
    <div className="settings-card">
      <div className="settings-card-head">
        <span className="settings-card-icon">🎨</span>
        <div>
          <div className="settings-card-title">主题</div>
          <div className="settings-card-desc">
            主窗、设置与桌宠同步换肤；「跟随系统」会实时响应 Windows 的深浅色切换。
          </div>
        </div>
      </div>
      <div className="appearance-options">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={theme === o.value ? 'appearance-option active' : 'appearance-option'}
            onClick={() => pick(o.value)}
          >
            <span className="appearance-option-icon">{o.icon}</span>
            <span className="appearance-option-label">{o.label}</span>
            <span className="appearance-option-desc">{o.desc}</span>
            {theme === o.value && <span className="appearance-option-check">✓</span>}
          </button>
        ))}
      </div>
      <p className="settings-hint">改动即时生效（无需重启）。</p>
    </div>
  )
}

/** 记忆分区：总开关（privacy.memory，默认关）+ 条目管理（编辑/删除/清空）。
 * 条目编辑/删除/清空走专用 IPC（主进程先快照再改，误操作可从 backups 找回）。 */
const KIND_LABEL: Record<string, string> = { preference: '偏好', fact: '事实', commitment: '承诺' }
/** 单条记忆正文上限（与 shared/memory MEMORY_CONTENT_MAX 同口径） */
const MEMORY_EDIT_MAX = 120

interface MemoryItem {
  id: string
  kind: 'preference' | 'fact' | 'commitment'
  content: string
  hits: number
  updatedAt: number
}

function MemorySection(): React.JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [items, setItems] = useState<MemoryItem[] | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  // 编辑态：editingId=正在改的条目；draft=草稿；savingId=保存中（失败也要复位，Day10 教训）
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [editError, setEditError] = useState('')

  const refresh = (): void => {
    void window.petAPI.memoryList().then(setItems)
  }

  useEffect(() => {
    void window.petAPI.getConfig().then((config) => {
      setEnabled(config.privacy?.memory === true)
    })
    refresh()
  }, [])

  const handleToggle = async (): Promise<void> => {
    const next = !(enabled === true)
    setEnabled(next) // 乐观更新
    try {
      await window.petAPI.settingsSet({ privacy: { memory: next } })
    } catch {
      setEnabled(!next) // 失败回滚
    }
  }

  const handleDelete = async (id: string): Promise<void> => {
    const res = await window.petAPI.memoryDelete(id)
    if (res.ok) setItems((cur) => (cur ?? []).filter((it) => it.id !== id))
  }

  const handleClear = async (): Promise<void> => {
    await window.petAPI.memoryClear()
    setItems([])
    setConfirmClear(false)
  }

  const startEdit = (it: MemoryItem): void => {
    setEditingId(it.id)
    setDraft(it.content)
    setEditError('')
  }

  const cancelEdit = (): void => {
    setEditingId(null)
    setDraft('')
    setEditError('')
  }

  const saveEdit = async (id: string): Promise<void> => {
    const text = draft.trim()
    if (text === '') {
      setEditError('内容不能为空')
      return
    }
    setSavingId(id)
    setEditError('')
    try {
      const res = await window.petAPI.memoryUpdate(id, text)
      if (!res.ok) {
        setEditError(res.error ?? '保存失败')
        return
      }
      // 主进程刷了 updatedAt 且列表按它倒序——重新拉取，顺序天然正确
      refresh()
      cancelEdit()
    } catch {
      setEditError('保存失败，请重试')
    } finally {
      // 成功失败都要复位 busy，一次 IPC 失败不能把按钮打死（Day10 教训）
      setSavingId(null)
    }
  }

  return (
    <div className="settings-card">
      <div className="settings-card-head">
        <span className="settings-card-icon">🧠</span>
        <div>
          <div className="settings-card-title">长期记忆</div>
          <div className="settings-card-desc">
            打开后，爱弥斯会在对话中自动记住关于你的重要信息（偏好 / 事实 / 约定），
            跨会话生效。全部存储在本机，随时可删。
          </div>
        </div>
      </div>
      <div className="settings-row">
        <span className="settings-row-label">
          启用长期记忆
          <span className="settings-row-sub">
            默认关闭。开启后她会悄悄记下值得记住的事；关闭只是暂停，已有记忆保留。
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled === true}
          className={enabled ? 'switch on' : 'switch'}
          onClick={() => void handleToggle()}
          disabled={enabled === null}
        >
          <span className="switch-knob" />
        </button>
      </div>

      {items !== null && items.length > 0 && (
        <>
          <div className="settings-row">
            <span className="settings-row-label">
              已记住 {items.length} 条
              <span className="settings-row-sub">
                按最近更新排序；可编辑改正文，点 × 删除单条。
              </span>
            </span>
            {confirmClear ? (
              <span style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="settings-button"
                  onClick={() => void handleClear()}
                >
                  确认清空
                </button>
                <button
                  type="button"
                  className="settings-button"
                  onClick={() => setConfirmClear(false)}
                >
                  取消
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="settings-button"
                onClick={() => setConfirmClear(true)}
              >
                清空全部
              </button>
            )}
          </div>
          {items.map((it) =>
            editingId === it.id ? (
              <div key={it.id} className="settings-field memory-edit">
                <span className="settings-field-label">
                  <span
                    style={{
                      display: 'inline-block',
                      marginRight: 8,
                      padding: '1px 8px',
                      borderRadius: 999,
                      fontSize: 11,
                      background: 'rgba(240,103,158,0.12)',
                      color: 'var(--accent)'
                    }}
                  >
                    {KIND_LABEL[it.kind] ?? it.kind}
                  </span>
                  编辑这条记忆
                </span>
                <textarea
                  className="settings-textarea"
                  style={{ minHeight: 84 }}
                  value={draft}
                  maxLength={MEMORY_EDIT_MAX}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // Esc 取消；Ctrl/Cmd+Enter 保存
                    if (e.key === 'Escape') cancelEdit()
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void saveEdit(it.id)
                  }}
                />
                <span className="settings-row-sub">
                  {draft.trim().length}/{MEMORY_EDIT_MAX} · Ctrl+Enter 保存，Esc 取消
                </span>
                {editError !== '' && <p className="settings-banner fail">{editError}</p>}
                <span className="settings-actions" style={{ margin: '4px 0 0' }}>
                  <button
                    type="button"
                    className="settings-button primary"
                    disabled={savingId === it.id || draft.trim() === ''}
                    onClick={() => void saveEdit(it.id)}
                  >
                    {savingId === it.id ? '保存中…' : '保存'}
                  </button>
                  <button
                    type="button"
                    className="settings-button"
                    disabled={savingId === it.id}
                    onClick={cancelEdit}
                  >
                    取消
                  </button>
                </span>
              </div>
            ) : (
              <div key={it.id} className="settings-row">
                <span className="settings-row-label">
                  <span
                    style={{
                      display: 'inline-block',
                      marginRight: 8,
                      padding: '1px 8px',
                      borderRadius: 999,
                      fontSize: 11,
                      background: 'rgba(240,103,158,0.12)',
                      color: 'var(--accent)'
                    }}
                  >
                    {KIND_LABEL[it.kind] ?? it.kind}
                  </span>
                  {it.content}
                  <span className="settings-row-sub">
                    {new Date(it.updatedAt).toLocaleString()} · 被引用 {it.hits} 次
                  </span>
                </span>
                <span style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button
                    type="button"
                    className="settings-button"
                    title="编辑这条记忆"
                    disabled={editingId !== null}
                    onClick={() => startEdit(it)}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="settings-button"
                    title="删除这条记忆"
                    disabled={editingId !== null}
                    onClick={() => void handleDelete(it.id)}
                  >
                    ×
                  </button>
                </span>
              </div>
            )
          )}
        </>
      )}
      {items !== null && items.length === 0 && (
        <p className="settings-hint">
          还没有任何记忆。开启后聊几句，值得记住的事会自动出现在这里。
        </p>
      )}
    </div>
  )
}

/** 气泡档位的三个选项（设置页） */
const BUBBLE_LEVEL_OPTIONS: Array<{ value: 'off' | 'greet' | 'all'; label: string; hint: string }> =
  [
    { value: 'off', label: '全关', hint: '头顶不冒泡' },
    { value: 'greet', label: '只打招呼', hint: '启动 / 被点 / 被拖时应一声' },
    { value: 'all', label: '主动提醒', hint: '再加空闲问候与任务完成/失败' }
  ]

/** 空闲分钟下拉选项（0 = 关） */
const IDLE_MIN_OPTIONS = [0, 5, 10, 15, 30, 60, 120, 240]

function PetSection(): React.JSX.Element {
  const [clickThrough, setClickThrough] = useState<boolean | null>(null)
  const [screenAware, setScreenAware] = useState<boolean | null>(null)
  // 气泡设置（P9-T5）；null = 还没从配置读到
  const [bubbleLevel, setBubbleLevel] = useState<'off' | 'greet' | 'all' | null>(null)
  const [dndStart, setDndStart] = useState('23:00')
  const [dndEnd, setDndEnd] = useState('08:00')
  const [idleMin, setIdleMin] = useState(30)

  useEffect(() => {
    window.petAPI.getConfig().then((config) => {
      setClickThrough(config.pet.clickThrough)
      setScreenAware(config.privacy?.activeWindow === true)
      setBubbleLevel(config.pet.bubbleLevel)
      setDndStart(config.pet.bubbleDndStart)
      setDndEnd(config.pet.bubbleDndEnd)
      setIdleMin(config.pet.bubbleIdleMin)
    })
  }, [])

  const handleToggle = async (): Promise<void> => {
    const next = await window.petAPI.toggleClickThrough()
    setClickThrough(next)
  }

  const handleScreenAware = async (): Promise<void> => {
    const next = !(screenAware === true)
    setScreenAware(next) // 乐观更新
    try {
      await window.petAPI.settingsSet({ privacy: { activeWindow: next } })
    } catch {
      setScreenAware(!next) // 失败回滚
    }
  }

  /** 气泡设置统一保存口：合并当前值提交；失败由调用处处理提示 */
  const saveBubble = async (patch: {
    bubbleLevel?: 'off' | 'greet' | 'all'
    bubbleDndStart?: string
    bubbleDndEnd?: string
    bubbleIdleMin?: number
  }): Promise<void> => {
    await window.petAPI.settingsSet({ pet: patch })
  }

  const handleLevel = (level: 'off' | 'greet' | 'all'): void => {
    setBubbleLevel(level) // 乐观更新
    void saveBubble({ bubbleLevel: level }).catch(() =>
      setBubbleLevel((cur) => (cur === level ? null : cur))
    )
  }

  const handleDnd = (which: 'start' | 'end', value: string): void => {
    if (which === 'start') setDndStart(value)
    else setDndEnd(value)
    // time 输入失焦/变更即保存；非法 HH:MM 主进程会防御性回退
    void saveBubble(which === 'start' ? { bubbleDndStart: value } : { bubbleDndEnd: value })
  }

  const handleIdle = (value: number): void => {
    setIdleMin(value)
    void saveBubble({ bubbleIdleMin: value })
  }

  return (
    <div className="settings-card">
      <div className="settings-card-head">
        <span className="settings-card-icon">🐾</span>
        <div>
          <div className="settings-card-title">桌宠</div>
          <div className="settings-card-desc">桌宠窗口的交互方式与找回入口。</div>
        </div>
      </div>
      <div className="settings-row">
        <span className="settings-row-label">
          点击穿透
          <span className="settings-row-sub">开启后鼠标会“穿过”桌宠，关闭入口只在设置页。</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={clickThrough === true}
          className={clickThrough ? 'switch on' : 'switch'}
          onClick={() => void handleToggle()}
          disabled={clickThrough === null}
        >
          <span className="switch-knob" />
        </button>
      </div>
      <div className="settings-row">
        <span className="settings-row-label">显示桌宠</span>
        <button type="button" className="settings-button" onClick={() => window.petAPI.showPet()}>
          找回桌宠
        </button>
      </div>
      <div className="settings-card-head">
        <span className="settings-card-icon">💬</span>
        <div>
          <div className="settings-card-title">头顶气泡</div>
          <div className="settings-card-desc">
            她什么时候会冒出来说句话。主动说话有冷却（4 分钟）和每小时上限（3 条）。
          </div>
        </div>
      </div>
      <div className="settings-row settings-row-block">
        <span className="settings-row-label">冒泡档位</span>
        <div className="bubble-level-pick" role="radiogroup">
          {BUBBLE_LEVEL_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={bubbleLevel === opt.value}
              title={opt.hint}
              className={`bubble-level-opt${bubbleLevel === opt.value ? ' on' : ''}`}
              onClick={() => handleLevel(opt.value)}
              disabled={bubbleLevel === null}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-row settings-row-block">
        <span className="settings-row-label">
          免打扰时段
          <span className="settings-row-sub">
            这期间不冒泡（复习到期提醒除外）；两端填相同等于不启用。
          </span>
        </span>
        <div className="dnd-range">
          <input
            type="time"
            className="settings-input-inline dnd-time"
            aria-label="免打扰开始"
            value={dndStart}
            onChange={(e) => handleDnd('start', e.target.value)}
          />
          <span className="dnd-dash">—</span>
          <input
            type="time"
            className="settings-input-inline dnd-time"
            aria-label="免打扰结束"
            value={dndEnd}
            onChange={(e) => handleDnd('end', e.target.value)}
          />
        </div>
      </div>
      <div className="settings-row">
        <span className="settings-row-label">
          空闲冒泡
          <span className="settings-row-sub">多久没动静就冒一句（仅「主动提醒」档生效）。</span>
        </span>
        <select
          className="settings-select dnd-select"
          value={idleMin}
          onChange={(e) => handleIdle(Number(e.target.value))}
        >
          {IDLE_MIN_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {m === 0 ? '关闭' : `${m} 分钟`}
            </option>
          ))}
        </select>
      </div>

      <p className="settings-hint">
        桌宠右键菜单里还有：打开主窗 / 隐藏桌宠 / 尺寸调节 / 回到右下角 / 退出。
      </p>

      <div className="settings-card-head">
        <span className="settings-card-icon">🔒</span>
        <div>
          <div className="settings-card-title">隐私</div>
          <div className="settings-card-desc">
            全部默认关闭；开启后爱弥斯才获得相应感知能力，随时可以再关。
          </div>
        </div>
      </div>
      <div className="settings-row">
        <span className="settings-row-label">
          屏幕感知
          <span className="settings-row-sub">
            允许「前台窗口」工具读取你当前聚焦的应用名与窗口标题，让聊天更懂语境。关闭时她完全看不到这个能力。
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={screenAware === true}
          className={screenAware ? 'switch on' : 'switch'}
          onClick={() => void handleScreenAware()}
          disabled={screenAware === null}
        >
          <span className="switch-knob" />
        </button>
      </div>
    </div>
  )
}

/** 生成档案 id（渲染层生成，主进程会做防御校验与去重） */
function newProfileId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** 上下文窗口快捷预设（P8-T4 图一）：常用量级一键填入，省得手打 6 位数字 */
const CONTEXT_PRESETS = [32 * 1024, 64 * 1024, 128 * 1024, 256 * 1024]
/** 输出上限快捷预设：与输入分开（输出给多了只是浪费额度，给少了会被截断） */
const OUTPUT_PRESETS = [8 * 1024, 16 * 1024, 32 * 1024, 64 * 1024]

/**
 * 把图片 dataURL 等比压到 ≤max 边的 PNG dataURL。
 * 在渲染层用 canvas 做（主进程零图像依赖）：一来不必引入图片库，二来压缩后就地存进
 * app.json 的 dataURL，换机器/挪文件都不会丢图，也免去自建协议 + CSP 放行。
 */
function shrinkImageToDataUrl(dataUrl: string, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = (): void => {
      const scale = Math.min(1, max / Math.max(img.width, img.height))
      const w = Math.max(1, Math.round(img.width * scale))
      const h = Math.max(1, Math.round(img.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (ctx === null) {
        reject(new Error('无法创建 canvas 上下文'))
        return
      }
      ctx.drawImage(img, 0, 0, w, h)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = (): void => reject(new Error('图片解码失败'))
    img.src = dataUrl
  })
}

/**
 * 个人信息：此前侧栏左下角写死显示"爱弥斯 / Aemeath"，
 * 其实那一格表达的是"用户自己"。这里让用户填：称呼 / 头像 / 关于我。
 * 昵称与自述会经 buildRuntimeAppendix 注入 system prompt —— 爱弥斯直接就知道用户是谁。
 */
function UserSection(): React.JSX.Element {
  const [nickname, setNickname] = useState('')
  const [about, setAbout] = useState('')
  const [avatarData, setAvatarData] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    void window.petAPI.getConfig().then((config) => {
      setNickname(config.user.nickname)
      setAbout(config.user.about)
      setAvatarData(config.user.avatar)
      setLoaded(true)
    })
  }, [])

  const save = useCallback(async (patch: Partial<AppConfig['user']>): Promise<void> => {
    try {
      await window.petAPI.settingsSet({ user: patch })
      setNotice('')
    } catch {
      setNotice('保存失败，请重试')
    }
  }, [])

  const pickAvatar = async (): Promise<void> => {
    const res = await window.petAPI.pickFiles()
    if (res.attachments.length === 0) return // 用户取消
    const image = res.attachments.find((a) => a.kind === 'image' && a.dataUrl !== undefined)
    if (image?.dataUrl === undefined) {
      setNotice('请选择一张图片（png / jpg / webp / gif，6MB 以内）')
      return
    }
    try {
      const small = await shrinkImageToDataUrl(image.dataUrl, 256)
      setAvatarData(small)
      await save({ avatar: small })
    } catch {
      setNotice('图片处理失败，换一张试试')
    }
  }

  const clearAvatar = (): void => {
    setAvatarData(null)
    void save({ avatar: null })
  }

  const nameForFallback = nickname.trim() !== '' ? nickname.trim() : '漂'

  return (
    <div className="settings-card">
      <div className="settings-card-head">
        <span className="settings-card-icon">👤</span>
        <div>
          <div className="settings-card-title">个人信息</div>
          <div className="settings-card-desc">
            告诉爱弥斯「你是谁」。称呼与自述会直接进入她的系统提示词——聊天时她就知道该怎么叫你、
            你关心什么；头像与称呼也会显示在侧栏左下角。
          </div>
        </div>
      </div>

      <div className="settings-row">
        <span className="settings-row-label">
          🖼 头像
          <span className="settings-row-sub">
            显示在侧栏左下角。选图后自动压到 256px 存进本机配置，原图不会被移动。
          </span>
        </span>
        <span className="settings-actions">
          {avatarData !== null ? (
            <img className="settings-user-avatar" src={avatarData} alt="头像预览" />
          ) : (
            <span className="settings-user-avatar settings-user-avatar-fallback" aria-hidden="true">
              {nameForFallback.slice(0, 1)}
            </span>
          )}
          <button type="button" className="settings-button" onClick={() => void pickAvatar()}>
            选择图片
          </button>
          <button
            type="button"
            className="settings-button"
            disabled={avatarData === null}
            onClick={clearAvatar}
          >
            清除
          </button>
        </span>
      </div>

      <div className="settings-row">
        <span className="settings-row-label">
          🏷 称呼
          <span className="settings-row-sub">
            爱弥斯怎么叫你。留空 = 按人设默认口径（漂泊者）。
          </span>
        </span>
        <span className="settings-actions">
          <input
            className="settings-input settings-input-inline"
            maxLength={40}
            value={nickname}
            disabled={!loaded}
            onChange={(e) => setNickname(e.target.value)}
            onBlur={() => void save({ nickname: nickname.trim() })}
          />
        </span>
      </div>

      <div className="settings-field">
        <span className="settings-field-label">📝 关于我</span>
        <span className="settings-field-sub">
          身份、专业、正在忙的事、喜好与雷点、希望她怎么跟你说话……写多少都行（上限 2000
          字）。留空则完全不注入，她不会知道任何你的背景。
        </span>
        {/* 不给示例占位：写示例容易顺手把真实身份信息写进去，而这一栏存的是"用户自己的资料" */}
        <textarea
          className="settings-input settings-textarea"
          rows={7}
          maxLength={2000}
          value={about}
          disabled={!loaded}
          onChange={(e) => setAbout(e.target.value)}
          onBlur={() => void save({ about: about.trim() })}
        />
      </div>

      {notice !== '' && <p className="settings-hint">{notice}</p>}
      <p className="settings-hint">
        🔒 这些内容只存在本机的 userData/config/app.json，不进 git、不随安装包分发。改动即时生效，
        下一句对话她就会用上。
      </p>
    </div>
  )
}

function WorkspaceSection(): React.JSX.Element {
  const [workspace, setWorkspace] = useState<{
    work: string | null
    learn: string | null
  } | null>(null)
  const [notesCard, setNotesCard] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    window.petAPI.getConfig().then((config) => {
      setWorkspace(config.workspace ?? { work: null, learn: null })
      setNotesCard(config.ui?.notesCard === true)
    })
  }, [])

  const toggleNotesCard = async (): Promise<void> => {
    const next = !notesCard
    setNotesCard(next) // 乐观更新
    try {
      await window.petAPI.settingsSet({ ui: { notesCard: next } })
    } catch {
      setNotesCard(notesCard) // 失败回滚
      setNotice('保存失败，请重试')
    }
  }

  const apply = async (key: 'work' | 'learn', value: string | null): Promise<void> => {
    if (workspace === null) return
    const next = key === 'work' ? { ...workspace, work: value } : { ...workspace, learn: value }
    setWorkspace(next) // 乐观更新
    try {
      await window.petAPI.settingsSet({
        workspace: key === 'work' ? { work: value } : { learn: value }
      })
      setNotice('')
    } catch {
      setWorkspace(workspace) // 失败回滚
      setNotice('保存失败，请重试')
    }
  }

  const pick = async (key: 'work' | 'learn'): Promise<void> => {
    const dir = await window.petAPI.pickDirectory()
    if (dir !== null) void apply(key, dir)
  }

  const rows: Array<{
    key: 'work' | 'learn'
    icon: string
    label: string
    desc: string
    path: string | null
  }> = [
    {
      key: 'work',
      icon: '🧰',
      label: '工作模式目录',
      desc: '工作模式的读写文件都相对这个目录解析；目录内的变更直接执行（写前自动快照、可一键撤销），改到目录外才弹确认。',
      path: workspace?.work ?? null
    },
    {
      key: 'learn',
      icon: '📚',
      label: '学习模式目录',
      desc: '绑定空目录会自动初始化笔记 vault（notes/index.md），学习笔记有家可归。',
      path: workspace?.learn ?? null
    }
  ]

  return (
    <div className="settings-card">
      <div className="settings-card-head">
        <span className="settings-card-icon">📁</span>
        <div>
          <div className="settings-card-title">工作区绑定</div>
          <div className="settings-card-desc">
            给工作 / 学习模式各指定一个工作目录。<b>两种模式必须先绑定才能开始会话</b>
            ；绑定后爱弥斯说「写到当前目录」就落在这里，改绑定立即生效。
          </div>
        </div>
      </div>
      {rows.map((row) => (
        <div key={row.key} className="settings-row">
          <span className="settings-row-label">
            {row.icon} {row.label}
            <span className="settings-row-sub">
              {row.desc}
              <br />
              当前：{row.path ?? '未绑定 —— 该模式还不能开始会话'}
            </span>
          </span>
          <span className="settings-actions">
            <button type="button" className="settings-button" onClick={() => void pick(row.key)}>
              选择目录
            </button>
            <button
              type="button"
              className="settings-button"
              disabled={row.path === null}
              onClick={() => void apply(row.key, null)}
            >
              清空
            </button>
          </span>
        </div>
      ))}
      <div className="settings-row">
        <span className="settings-row-label">
          📒 学习笔记卡
          <span className="settings-row-sub">
            学习模式消息区顶部的常驻小卡：显示本会话笔记/闪卡计数，带「导出
            Markdown」按钮。关闭后卡片隐藏（笔记功能本身不受影响，仍可让爱弥斯导出）。
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={notesCard}
          className={notesCard ? 'switch on' : 'switch'}
          onClick={() => void toggleNotesCard()}
        >
          <span className="switch-knob" />
        </button>
      </div>
      {notice !== '' && <p className="settings-hint">{notice}</p>}
      <p className="settings-hint">
        💬 对话模式无工具，不需要绑定、也不受这条限制。绑定后即成为「标准」权限模式下的免询问边界：
        该目录内的改动直接执行（变更前仍自动快照、可一键撤销），改到目录外才弹卡。
      </p>
    </div>
  )
}

function SessionsSection(): React.JSX.Element {
  const [list, setList] = useState<SessionMeta[]>([])
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')

  const flash = (message: string): void => {
    setNotice(message)
    setTimeout(() => setNotice(''), 2000)
  }

  const refresh = useCallback((): void => {
    void window.petAPI.sessionsList().then(setList)
  }, [])

  useEffect(() => {
    refresh()
    const off = window.petAPI.onSessionsChanged(refresh)
    return off
  }, [refresh])

  const hidden = list.filter((s) => s.hidden === true)

  const restore = (id: string): void => {
    window.petAPI.sessionSetHidden(id, false)
    flash('已恢复到侧栏 ✓')
  }

  const removeHard = (id: string): void => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id)
      setTimeout(() => setConfirmDeleteId((cur) => (cur === id ? null : cur)), 3000)
      return
    }
    setConfirmDeleteId(null)
    window.petAPI.sessionDeleteHard(id)
    flash('已永久删除')
  }

  return (
    <div className="settings-card">
      <div className="settings-card-head">
        <span className="settings-card-icon">🗂️</span>
        <div>
          <div className="settings-card-title">会话管理</div>
          <div className="settings-card-desc">
            共 {list.length} 个会话（{list.length - hidden.length} 个可见 / {hidden.length}{' '}
            个已隐藏）。
          </div>
        </div>
      </div>

      {hidden.length === 0 ? (
        <p className="settings-hint">
          没有已隐藏的会话。在主窗侧栏右键某个会话即可选择 重命名 / 隐藏会话 / 删除会话。
        </p>
      ) : (
        <div className="profile-list">
          {hidden.map((session) => (
            <div key={session.id} className="profile-row">
              <div className="profile-info">
                <div className="profile-name">
                  {session.pinned === true ? '📌 ' : ''}
                  {session.title}
                </div>
                <div className="profile-meta">
                  {new Date(session.updatedAt).toLocaleString('zh-CN', {
                    month: 'numeric',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                  {' 更新'}
                </div>
              </div>
              <div className="profile-actions">
                <button
                  type="button"
                  className="settings-button"
                  onClick={() => restore(session.id)}
                >
                  恢复
                </button>
                <button
                  type="button"
                  className={
                    confirmDeleteId === session.id ? 'settings-button danger' : 'settings-button'
                  }
                  onClick={() => removeHard(session.id)}
                >
                  {confirmDeleteId === session.id ? '确认删除?' : '永久删除'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {notice !== '' ? <p className="settings-banner ok">{notice}</p> : null}
    </div>
  )
}

/** 上下文展示：1024 以上按 K 显示 */
function formatContext(context: number): string {
  if (!(context > 0)) return '上下文未设置'
  return context >= 1024 ? `上下文 ${Math.round(context / 1024)}K` : `上下文 ${context}`
}

function ModelSection(): React.JSX.Element {
  const [loaded, setLoaded] = useState(false)
  const [profiles, setProfiles] = useState<ModelProfile[]>([])
  const [activeId, setActiveId] = useState('')
  const [temperature, setTemperature] = useState(0.8)
  /** 视觉档案（P8-T3）：'' = 自动 / 'off' = 不做转述 / 档案 id */
  const [visionProfileId, setVisionProfileId] = useState('')
  /** 上下文自动压缩（P8-T1，全局开关；缺省开） */
  const [autoCompact, setAutoCompact] = useState(true)
  const [personas, setPersonas] = useState<string[]>([])
  const [activePersona, setActivePersona] = useState('aemeath')
  const [keyedIds, setKeyedIds] = useState<string[]>([])
  // 编辑器：draft 非空表示正在编辑（新增或修改）；keyInput 是该档案的密钥输入
  const [draft, setDraft] = useState<ModelProfile | null>(null)
  const [isNewDraft, setIsNewDraft] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [notice, setNotice] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  /** 编辑器定位：打开时滚到可视区（列表长，编辑器在下方，不滚过去像"没反应"） */
  const editorRef = useRef<HTMLDivElement | null>(null)

  const refreshKeyed = (): void => {
    void window.petAPI.settingsGet().then((res) => setKeyedIds(res.keyedProfileIds))
  }

  useEffect(() => {
    void window.petAPI.settingsGet().then((res) => {
      setProfiles(res.config.model.profiles)
      setActiveId(res.config.model.activeId)
      setTemperature(res.config.model.temperature)
      setVisionProfileId(res.config.model.visionProfileId)
      setAutoCompact(res.config.chat.autoCompact)
      setPersonas(res.personas)
      setActivePersona(res.config.persona.active)
      setKeyedIds(res.keyedProfileIds)
      setLoaded(true)
    })
  }, [])

  /**
   * 滚动到编辑器——**只在打开/切换档案的瞬间**（owner 实测 bug：依赖写 [draft]，
   * 而每次击键 setDraft({...}) 都是新对象引用 → 每敲一个字都 smooth scroll 一次，
   * 页面持续往上滚；编辑器里所有输入框（昵称/URL/模型名/数字框）全部中招）。
   * 用 ref 记住上次滚到的档案 id：内容变化（id 不变）不滚，关闭后重开才再滚。
   */
  const editorScrolledId = useRef<string | null>(null)
  useEffect(() => {
    if (draft !== null && editorScrolledId.current !== draft.id) {
      // 等 DOM 渲染完再滚，编辑器顶部对齐可视区顶部
      window.requestAnimationFrame(() => {
        editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }
    editorScrolledId.current = draft === null ? null : draft.id
  }, [draft])

  const flashNotice = (message: string): void => {
    setNotice(message)
    setTimeout(() => setNotice(''), 2000)
  }

  /** 结构性变更统一走这里：写 profiles/activeId/温度，读回后同步本地状态 */
  const persist = async (
    nextProfiles: ModelProfile[],
    nextActiveId: string,
    nextTemperature = temperature
  ): Promise<void> => {
    const res = await window.petAPI.settingsSet({
      model: { profiles: nextProfiles, activeId: nextActiveId, temperature: nextTemperature },
      persona: { active: activePersona }
    })
    setProfiles(res.model.profiles)
    setActiveId(res.model.activeId)
    setTemperature(res.model.temperature)
    refreshKeyed()
  }

  const handleUse = (id: string): void => {
    if (id === activeId) return
    void persist(profiles, id)
  }

  const handlePersonaChange = (name: string): void => {
    setActivePersona(name)
    void window.petAPI.settingsSet({ persona: { active: name } })
  }

  const handleTemperatureCommit = (value: number): void => {
    void persist(profiles, activeId, value)
  }

  /** 视觉档案（P8-T3）：独立于档案表的全局设置，写完读回同步（约定：写配置一律读回） */
  const handleVisionProfileChange = (id: string): void => {
    setVisionProfileId(id) // 乐观更新：下拉不等待网络
    void window.petAPI
      .settingsSet({ model: { visionProfileId: id } })
      .then((res) => setVisionProfileId(res.model.visionProfileId))
      .catch(() => flashNotice('视觉档案保存失败'))
  }

  /** 自动压缩开关（P8-T1）：乐观更新 + 读回同步；失败回滚并提示 */
  const toggleAutoCompact = async (): Promise<void> => {
    const next = !autoCompact
    setAutoCompact(next)
    try {
      const res = await window.petAPI.settingsSet({ chat: { autoCompact: next } })
      setAutoCompact(res.chat.autoCompact)
    } catch {
      setAutoCompact(!next)
      flashNotice('自动压缩开关保存失败')
    }
  }

  const startAdd = (): void => {
    const id = newProfileId()
    setDraft({
      id,
      name: '自定义模型',
      protocol: 'openai',
      baseUrl: '',
      model: '',
      context: 0,
      multimodal: false
    })
    setIsNewDraft(true)
    setKeyInput('')
    setTestResult(null)
  }

  const startEdit = (profile: ModelProfile): void => {
    setDraft({ ...profile })
    setIsNewDraft(false)
    setKeyInput('')
    setTestResult(null)
  }

  /** 编辑器里的档位视图（P8-T4）：只列该档案勾选的档位，按强度顺序 */
  const levels = REASONING_LEVELS.filter((l) => (draft?.reasoningLevels ?? []).includes(l))
  const levelCount = levels.length
  /**
   * 当前生效的思考参数风格（P9-T1）：手动覆盖优先，否则按 Base URL 自动识别。
   * 仅 openai 兼容协议有意义；anthropic/gemini 走各自原生预算映射。
   */
  const draftAdapter: ReasoningAdapterId | null =
    draft !== null && draft.protocol === 'openai'
      ? resolveReasoningAdapter({
          baseUrl: draft.baseUrl,
          ...(draft.reasoningAdapter !== undefined ? { override: draft.reasoningAdapter } : {})
        })
      : null
  /** 该风格（+型号）下会被折算的档：chip 变灰提示，勾选数据不动 */
  const foldedLevels =
    draftAdapter !== null
      ? new Set(adapterFoldedLevels(draftAdapter, draft?.model ?? ''))
      : new Set()
  /** 勾选的档里是否含会被折算的 —— 提示行用 */
  const hasFolded = levels.some((l) => foldedLevels.has(l))

  const closeEditor = (): void => {
    setDraft(null)
    setIsNewDraft(false)
    setKeyInput('')
    setTestResult(null)
  }

  const toggleLevel = (level: ReasoningEffort): void => {
    if (draft === null) return
    const cur = draft.reasoningLevels ?? []
    const next = cur.includes(level) ? cur.filter((l) => l !== level) : [...cur, level]
    // 保持强度顺序（滑条与下拉都按这个顺序）
    const ordered = REASONING_LEVELS.filter((l) => next.includes(l))
    // 默认档位必须还在支持列表里，否则回退首项（不留"选了但发不出去"的悬空状态）
    const effort = draft.reasoningEffort
    const fixedEffort =
      effort !== undefined && effort !== 'default' && !ordered.includes(effort)
        ? ordered[0]
        : draft.reasoningEffort
    setDraft({
      ...draft,
      ...(ordered.length > 0 ? { reasoningLevels: ordered } : { reasoningLevels: undefined }),
      ...(fixedEffort !== undefined ? { reasoningEffort: fixedEffort } : {})
    })
  }

  const saveDraft = async (): Promise<void> => {
    if (draft === null) return
    const name = draft.name.trim()
    const baseUrl = draft.baseUrl.trim()
    const model = draft.model.trim()
    if (name === '' || baseUrl === '') {
      setTestResult({ ok: false, message: '昵称和 Base URL 不能为空' })
      return
    }
    const cleaned: ModelProfile = {
      ...draft,
      name,
      baseUrl,
      model,
      // 协议以编辑器下拉为准（ 修复：此处曾写死 'openai'——预设档案点一次
      // 「编辑→保存」协议就被冲掉，之后聊天全打错端点； 起潜伏）
      context: Number.isFinite(draft.context) && draft.context > 0 ? Math.floor(draft.context) : 0,
      // P8-T4：输出上限非正数 = 未设置；档位按强度顺序归一，空表 = 不支持思考
      maxOutput:
        typeof draft.maxOutput === 'number' &&
        Number.isFinite(draft.maxOutput) &&
        draft.maxOutput > 0
          ? Math.floor(draft.maxOutput)
          : undefined,
      reasoningLevels: REASONING_LEVELS.filter((l) => (draft.reasoningLevels ?? []).includes(l)),
      reasoningEffort:
        draft.reasoningEffort !== undefined && draft.reasoningEffort !== 'default'
          ? draft.reasoningEffort
          : 'default',
      // P9-T1：思考参数风格；'auto'/非 openai 协议都不持久化（=按 Base URL 自动识别）
      reasoningAdapter:
        draft.protocol === 'openai' && draft.reasoningAdapter !== undefined
          ? draft.reasoningAdapter
          : undefined
    }
    if (cleaned.reasoningLevels?.length === 0) delete cleaned.reasoningLevels
    if (cleaned.maxOutput === undefined) delete cleaned.maxOutput
    if (cleaned.reasoningAdapter === undefined) delete cleaned.reasoningAdapter
    // 保存前再兜一次：默认档位若已不在支持列表里 → 回退首项（UI 里已处理，防手改配置绕过）
    const lv = cleaned.reasoningLevels
    if (
      cleaned.reasoningEffort !== undefined &&
      cleaned.reasoningEffort !== 'default' &&
      (lv === undefined || !lv.includes(cleaned.reasoningEffort))
    ) {
      cleaned.reasoningEffort = lv !== undefined && lv.length > 0 ? lv[0] : 'default'
    }
    const exists = profiles.some((p) => p.id === cleaned.id)
    const nextProfiles = exists
      ? profiles.map((p) => (p.id === cleaned.id ? cleaned : p))
      : [...profiles, cleaned]
    await persist(nextProfiles, exists ? activeId : activeId === '' ? cleaned.id : activeId)
    if (keyInput.trim() !== '') {
      const res = await window.petAPI.setApiKey(cleaned.id, keyInput.trim())
      if (!res.ok) {
        setTestResult({ ok: false, message: res.error ?? '密钥保存失败' })
        return
      }
    }
    refreshKeyed()
    flashNotice(isNewDraft ? '模型已添加 ✓' : '档案已保存 ✓')
    closeEditor()
  }

  const testDraft = async (): Promise<void> => {
    if (draft === null) return
    if (draft.baseUrl.trim() === '' || draft.model.trim() === '') {
      setTestResult({ ok: false, message: '请先填写 Base URL 与模型名' })
      return
    }
    setTesting(true)
    setTestResult(null)
    const res = await window.petAPI.testConnection({
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      apiKey: keyInput.trim() === '' ? undefined : keyInput.trim(),
      profileId: draft.id
    })
    setTesting(false)
    setTestResult(
      res.ok
        ? { ok: true, message: '连接成功，模型可用' }
        : { ok: false, message: res.error ?? '未知错误' }
    )
  }

  const deleteProfile = (id: string): void => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id)
      setTimeout(() => setConfirmDeleteId((cur) => (cur === id ? null : cur)), 3000)
      return
    }
    setConfirmDeleteId(null)
    if (draft?.id === id) closeEditor()
    const nextProfiles = profiles.filter((p) => p.id !== id)
    const nextActive = activeId === id ? (nextProfiles[0]?.id ?? '') : activeId
    void persist(nextProfiles, nextActive)
    flashNotice('已删除')
  }

  const hasKey = (id: string): boolean => keyedIds.includes(id)

  /**
   * 「现在到底谁在替她看图」（P8-T3 反馈）：用**与主进程同一份**选档逻辑算出来，
   * 而不是渲染层自己猜——否则会出现"设置里显示用 A、实际用了 B"这种最难查的偏差。
   */
  const visionPick = pickVisionProfile({ profiles, activeId, visionProfileId, hasKey })
  const activeName = profiles.find((p) => p.id === activeId)?.name ?? '当前档案'
  const visionNow = ((): string => {
    if (!visionPick.ok) {
      // 「不做转述」是用户主动选的、不是错误，用大白话说明；其余三种是真问题，给可操作原因
      if (visionPick.reason === 'off') {
        return '现在不做转述：图片发过去她只会如实说「我看不到图」。'
      }
      return visionUnavailableHint(visionPick.reason)
    }
    return visionPick.profile.id === activeId
      ? `现在用「${visionPick.profile.name}」自己看图——它已开多模态，图片直接发给她，不经过转述。`
      : `现在用「${visionPick.profile.name}」替她看图——图片先发给它转述成文字，再交给「${activeName}」。`
  })()

  /**
   * 上下文/多模态徽章可见性：
   * 未接入 API Key 的预设档案保持极简——只有手动改过上下文才展示；
   * 配了密钥（真实在用）或自定义档案则照常展示。
   */
  const showCapabilityBadges = (profile: ModelProfile): boolean => {
    if (hasKey(profile.id)) return true
    if (!isPresetId(profile.id)) return true
    if (profile.context <= 0) return false
    const preset = MODEL_PRESETS.find((p) => p.id === profile.id)
    return profile.context !== (preset?.context ?? 0) // 与预设默认不同 = 手动填过
  }

  return (
    <div className="settings-card">
      <div className="settings-card-head">
        <span className="settings-card-icon">🤖</span>
        <div>
          <div className="settings-card-title">模型接入</div>
          <div className="settings-card-desc">
            支持多档案并存：DeepSeek / GLM / 千问 / Kimi / 豆包 / MiMo / MiniMax 预置，可添加任意
            OpenAI 兼容自定义模型。
          </div>
        </div>
      </div>

      {/* 档案列表：点卡片任意空白处即切换提供方（按钮会阻断冒泡） */}
      <div className="profile-list">
        {/* 预设档案在前（按官方顺序）、自定义在后——避免后加的预设沉底 */}
        {[...profiles]
          .sort((a, b) => {
            const pa = isPresetId(a.id) ? 0 : 1
            const pb = isPresetId(b.id) ? 0 : 1
            if (pa !== pb) return pa - pb
            if (pa === 0) {
              return (
                MODEL_PRESETS.findIndex((x) => x.id === a.id) -
                MODEL_PRESETS.findIndex((x) => x.id === b.id)
              )
            }
            return 0
          })
          .map((profile) => {
            const preset = isPresetId(profile.id)
            return (
              <div
                key={profile.id}
                className={profile.id === activeId ? 'profile-row active' : 'profile-row'}
                role="button"
                tabIndex={0}
                aria-label={`使用 ${profile.name}`}
                onClick={() => handleUse(profile.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') handleUse(profile.id)
                }}
              >
                {VENDOR_LOGOS[profile.id] !== undefined ? (
                  <img
                    className="profile-logo"
                    src={VENDOR_LOGOS[profile.id]}
                    alt=""
                    draggable={false}
                  />
                ) : (
                  <div className="profile-logo fallback">{profile.name.slice(0, 1)}</div>
                )}
                <div className="profile-info">
                  <div className="profile-name">
                    {profile.name}
                    {preset ? <span className="badge">预设</span> : null}
                    {profile.id === activeId ? (
                      <span className="settings-badge">使用中</span>
                    ) : null}
                  </div>
                  <div className="profile-meta">
                    {/* 预设档案不预填模型名：模型为空时这一行只显示 Base URL */}
                    {profile.model === '' ? '' : `${profile.model} · `}
                    {profile.baseUrl.replace(/^https?:\/\//, '')}
                  </div>
                  <div className="profile-badges">
                    {showCapabilityBadges(profile) ? (
                      <>
                        <span className="badge">{formatContext(profile.context)}</span>
                        {profile.multimodal ? <span className="badge">多模态</span> : null}
                      </>
                    ) : null}
                    <span className={hasKey(profile.id) ? 'badge ok' : 'badge warn'}>
                      {hasKey(profile.id) ? '密钥已配置' : '未配密钥'}
                    </span>
                  </div>
                </div>
                <div className="profile-actions">
                  <button
                    type="button"
                    className="settings-button"
                    onClick={(e) => {
                      e.stopPropagation()
                      startEdit(profile)
                    }}
                    disabled={!loaded}
                  >
                    编辑
                  </button>
                  {preset ? null : (
                    <button
                      type="button"
                      className={
                        confirmDeleteId === profile.id
                          ? 'settings-button danger'
                          : 'settings-button'
                      }
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteProfile(profile.id)
                      }}
                      disabled={!loaded}
                    >
                      {confirmDeleteId === profile.id ? '确认删除?' : '删除'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        <button
          type="button"
          className="settings-button add-profile"
          onClick={startAdd}
          disabled={!loaded}
        >
          ＋ 添加自定义模型
        </button>
      </div>

      {/* 上下文压缩（P8-T1）：全局行为开关 */}
      <div className="settings-card">
        <div className="settings-card-head">
          <span className="settings-card-icon">🗜️</span>
          <div>
            <div className="settings-card-title">上下文压缩</div>
            <div className="settings-card-desc">
              会话接近模型窗口时，把更早的对话摘要成一段转述，长任务不再丢前文、也更省钱。
            </div>
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-row-label">
            自动压缩（默认开）
            <span className="settings-row-sub">
              只压缩「发给模型的视图」——会话原文一条不删，回看与搜索仍是原文；压缩时会在气泡下说明一次。
              判断依据是上次请求的真实用量，所以档案的「上下文窗口」填 0（未设置）时不生效。
              也可以在输入框右侧的上下文用量浮层里手动压一次。
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={autoCompact}
            className={autoCompact ? 'switch on' : 'switch'}
            onClick={() => void toggleAutoCompact()}
          >
            <span className="switch-knob" />
          </button>
        </div>
      </div>

      {/* 视觉档案（P8-T3）：当前模型不开多模态时，谁替它"看图" */}
      <div className="settings-card">
        <div className="settings-card-head">
          <span className="settings-card-icon">👁️</span>
          <div>
            <div className="settings-card-title">识图（视觉档案）</div>
            <div className="settings-card-desc">
              当前模型看不到图片时，让一个支持图片的档案替它「转述」成文字。
            </div>
          </div>
        </div>
        <div className="settings-field">
          <label className="settings-field-label" htmlFor="vision-profile">
            谁替她看图
          </label>
          <select
            id="vision-profile"
            className="settings-input"
            value={visionProfileId}
            onChange={(e) => handleVisionProfileChange(e.target.value)}
            disabled={!loaded}
          >
            <option value="">自动（推荐）：她自己能看图就直接看，看不到才自动挑一个</option>
            <option value="off">不做转述：看不到就如实告诉你</option>
            {profiles
              .filter((p) => p.multimodal)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {`固定用它看图：${p.name}${hasKey(p.id) ? '' : '（没配密钥，选它也没用）'}`}
                </option>
              ))}
          </select>
          {/* 实时结论（与主进程同一份选档逻辑算出来）：省得用户在 4 个选项里猜 */}
          <span className="settings-field-sub">{visionNow}</span>
        </div>
        <div className="settings-field">
          <span className="settings-field-sub">
            三个选项的区别：<b>自动</b> = 让她自己看（能看就自己看，看不到就替你挑一个能看的）；
            <b>不做转述</b> = 不许别人替她看，她只能告诉你「看不到」；
            <b>固定用它看图</b> = 不许自动挑，永远由你指定的这个档案转述。
            <br />
            转述只在当前档案没开多模态时才发生（她自己能看到图时，图片直接发给她）。
            被转述的图只会发给你自己配置的那个档案；转述结果当文字交给她，回复里会标明
            「根据图片识别」，关键数字仍建议你核对原图。
            <br />
            下拉里只列出<b>已开启多模态</b>的档案；
            想让某个档案也能当眼睛，到上面的档案列表点「编辑」、勾上「开启多模态」并配好密钥即可。
          </span>
        </div>
      </div>

      {/* 编辑器 */}
      {draft !== null ? (
        <div className="profile-editor" ref={editorRef}>
          <div className="profile-editor-title">
            {isNewDraft ? '添加自定义模型' : `编辑：${draft.name}`}
          </div>

          <div className="settings-field">
            <label className="settings-field-label" htmlFor="pf-name">
              昵称
            </label>
            <input
              id="pf-name"
              className="settings-input"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              spellCheck={false}
            />
          </div>

          <div className="settings-field">
            <label className="settings-field-label" htmlFor="pf-protocol">
              API 协议
            </label>
            <select
              id="pf-protocol"
              className="settings-select"
              value={draft.protocol}
              onChange={(e) =>
                setDraft({ ...draft, protocol: e.target.value as typeof draft.protocol })
              }
            >
              <option value="openai">OpenAI 兼容（覆盖主流国产厂商）</option>
              <option value="anthropic">Anthropic 原生（Claude 官方 / 兼容端点）</option>
              <option value="gemini">Gemini 原生（Google 官方）</option>
            </select>
            <span className="settings-field-sub">
              Anthropic 协议档案的模型名填 claude 系列型号（如 claude-sonnet-4-5）。
            </span>
          </div>

          {/* 思考参数风格（P9-T1，仅 OpenAI 兼容）：默认按 Base URL 自动识别厂商，可手动覆盖 */}
          {draft.protocol === 'openai' ? (
            <div className="settings-field">
              <label className="settings-field-label" htmlFor="pf-adapter">
                思考参数风格
              </label>
              <select
                id="pf-adapter"
                className="settings-select"
                value={draft.reasoningAdapter ?? 'auto'}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    reasoningAdapter:
                      e.target.value === 'auto' ? undefined : (e.target.value as ReasoningAdapterId)
                  })
                }
              >
                <option value="auto">
                  自动（按接入地址识别为{draftAdapter !== null ? ADAPTER_LABELS[draftAdapter] : ''}
                  ）
                </option>
                {(Object.keys(ADAPTER_LABELS) as ReasoningAdapterId[]).map((id) => (
                  <option key={id} value={id}>
                    {ADAPTER_LABELS[id]}
                  </option>
                ))}
              </select>
              <span className="settings-field-sub">
                {draft.reasoningAdapter === undefined && draftAdapter !== null
                  ? `已按 Base URL 识别为「${ADAPTER_LABELS[draftAdapter]}」；中转网关识别不准时可在此手动指定。`
                  : '手动指定后按该厂商规则发送思考参数；选「自动」恢复按接入地址识别。'}
              </span>
            </div>
          ) : null}

          <div className="settings-field">
            <label className="settings-field-label" htmlFor="pf-effort">
              默认思考强度
            </label>
            <select
              id="pf-effort"
              className="settings-select"
              value={draft.reasoningEffort ?? 'default'}
              disabled={levelCount === 0}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  reasoningEffort: e.target.value as ModelProfile['reasoningEffort']
                })
              }
            >
              <option value="default">自动（使用请求层默认值）</option>
              {levels.map((l) => (
                <option key={l} value={l}>
                  {REASONING_LABELS[l]}
                </option>
              ))}
            </select>
            {levelCount === 0 ? (
              <span className="settings-field-sub">
                先勾选下面的「支持的思考强度」——没勾就是该模型不吃思考参数，这里无从选。
              </span>
            ) : null}
          </div>

          {/* 支持档位多选（P8-T4）：勾了哪些，聊天区右键模型时就能在哪些档位之间拖 */}
          <div className="settings-field">
            <label className="settings-field-label">支持的思考强度</label>
            <div className="level-grid">
              {REASONING_LEVELS.map((l) => {
                const on = levels.includes(l)
                // P9-T1：该厂商/型号会折算的档灰显（仍可勾，发送时按厂商规则折算，不拦对话）
                const folded = draft.protocol === 'openai' && foldedLevels.has(l)
                return (
                  <button
                    key={l}
                    type="button"
                    aria-pressed={on}
                    className={on ? 'level-chip on' : 'level-chip'}
                    style={{ opacity: folded ? 0.62 : 1 }}
                    title={
                      folded && draftAdapter !== null
                        ? adapterLevelsHint(draftAdapter, draft.model)
                        : undefined
                    }
                    onClick={() => toggleLevel(l)}
                  >
                    {on ? '✓ ' : ''}
                    {REASONING_LABELS[l]}
                  </button>
                )
              })}
            </div>
            <span className="settings-field-sub">
              {draft.protocol === 'openai' && draftAdapter !== null
                ? adapterLevelsHint(draftAdapter, draft.model)
                : 'Anthropic / Gemini 原生协议按思考预算 token 发送，五档均可使用。'}
              {hasFolded ? ' 勾选变灰的档位不会丢失，发送时自动折算，不会把对话拦下来。' : ''}
            </span>
          </div>

          <div className="settings-field">
            <label className="settings-field-label" htmlFor="pf-url">
              Base URL
            </label>
            <input
              id="pf-url"
              className="settings-input"
              value={draft.baseUrl}
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
              spellCheck={false}
            />
          </div>

          <div className="settings-field">
            <label className="settings-field-label" htmlFor="pf-model">
              模型名称
            </label>
            <input
              id="pf-model"
              className="settings-input"
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              spellCheck={false}
            />
            <span className="settings-field-sub">留空则该档案暂不可发起聊天。</span>
            {draft.baseUrl.includes('volces.com') ? (
              <span className="settings-field-sub">
                火山方舟部分账号需填推理接入点 ID（ep-开头）作为模型名。
              </span>
            ) : null}
          </div>

          <div className="settings-field">
            <label className="settings-field-label" htmlFor="pf-context">
              输入（上下文窗口，tokens）
            </label>
            <input
              id="pf-context"
              className="settings-input"
              type="number"
              min={0}
              step={1024}
              value={draft.context}
              onChange={(e) => setDraft({ ...draft, context: Number(e.target.value) })}
              spellCheck={false}
            />
            <div className="preset-row">
              {CONTEXT_PRESETS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className="preset-chip"
                  onClick={() => setDraft({ ...draft, context: n })}
                >
                  {n / 1024}K
                </button>
              ))}
              <button
                type="button"
                className="preset-chip"
                onClick={() => setDraft({ ...draft, context: 0 })}
              >
                清空
              </button>
            </div>
            <span className="settings-field-sub">
              模型的输入上限：用于裁剪聊天历史、也决定「上下文压缩」何时触发。不确定就填
              0（不裁剪）。注意光人设与工具说明就有约 15K 的固定占用（对话模式无工具约 5K）——
              这部分压缩也省不掉，窗口填得比它小会每次请求都超限；多数模型建议 32K 以上。
            </span>
            {draft.context > 0 && draft.context < 8192 ? (
              <span className="settings-field-sub settings-field-warn">
                ⚠ 当前值小于固定占用（约 15K，对话模式约 5K）：工作/学习模式下大概率每次请求都超限，
                用量环会一直红色。
              </span>
            ) : null}
          </div>

          <div className="settings-field">
            <label className="settings-field-label" htmlFor="pf-maxout">
              输出（单次回复上限，tokens）
            </label>
            <input
              id="pf-maxout"
              className="settings-input"
              type="number"
              min={0}
              step={1024}
              value={draft.maxOutput ?? 0}
              onChange={(e) => {
                const v = Number(e.target.value)
                // 0 = 清空（不发该参数）：与"输入"同一套交互口径，免得出现两处空值语义
                setDraft({ ...draft, maxOutput: v > 0 ? v : undefined })
              }}
              spellCheck={false}
            />
            <div className="preset-row">
              {OUTPUT_PRESETS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className="preset-chip"
                  onClick={() => setDraft({ ...draft, maxOutput: n })}
                >
                  {n / 1024}K
                </button>
              ))}
              <button
                type="button"
                className="preset-chip"
                onClick={() => setDraft({ ...draft, maxOutput: undefined })}
              >
                清空
              </button>
            </div>
            <span className="settings-field-sub">
              留空（0）= 不发送该参数，交给模型默认值（推荐）。 填了才会发出去：Claude 走
              max_tokens（开思考时它必须大于思考预算）、Gemini 走 maxOutputTokens、其余兼容端点走
              max_tokens。
            </span>
          </div>

          <div className="settings-row">
            <span className="settings-row-label">
              开启多模态
              <span className="settings-row-sub">
                标记该模型支持图像输入（能直接看图）。没开的模型可以靠上面的「视觉档案」代看。
              </span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={draft.multimodal}
              className={draft.multimodal ? 'switch on' : 'switch'}
              onClick={() => setDraft({ ...draft, multimodal: !draft.multimodal })}
            >
              <span className="switch-knob" />
            </button>
          </div>

          <div className="settings-field">
            <label className="settings-field-label" htmlFor="pf-key">
              API Key
              {hasKey(draft.id) ? <span className="settings-badge">已配置</span> : null}
            </label>
            <input
              id="pf-key"
              className="settings-input"
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={hasKey(draft.id) ? '已加密保存（留空表示不修改）' : 'sk-…'}
              spellCheck={false}
              autoComplete="off"
            />
            <span className="settings-field-sub">
              每个档案独立保存，系统级加密，不上传不写配置文件。
            </span>
          </div>

          <div className="settings-actions">
            <button
              type="button"
              className="settings-button primary"
              onClick={() => void saveDraft()}
            >
              保存档案
            </button>
            <button
              type="button"
              className="settings-button"
              onClick={() => void testDraft()}
              disabled={testing}
            >
              {testing ? '测试中…' : '测试连接'}
            </button>
            <button type="button" className="settings-button" onClick={closeEditor}>
              取消
            </button>
          </div>

          {testResult !== null ? (
            <p className={testResult.ok ? 'settings-banner ok' : 'settings-banner fail'}>
              {testResult.ok ? '✓ ' : '✕ '}
              {testResult.message}
            </p>
          ) : null}
        </div>
      ) : null}

      {notice !== '' ? <p className="settings-banner ok">{notice}</p> : null}

      {/* 全局：人设与温度 */}
      <div className="settings-field" style={{ marginTop: 18 }}>
        <label className="settings-field-label" htmlFor="f-persona">
          人设
        </label>
        <select
          id="f-persona"
          className="settings-select"
          value={activePersona}
          onChange={(e) => handlePersonaChange(e.target.value)}
          disabled={!loaded}
        >
          {personas.map((name) => (
            <option key={name} value={name}>
              {/* 显示首字母大写，value 仍存目录名——避免动 personas 目录与配置迁移 */}
              {name.charAt(0).toUpperCase() + name.slice(1)}
              {name === 'aemeath' ? '（爱弥斯）' : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-field">
        <label className="settings-field-label" htmlFor="f-temp">
          温度（temperature）：<span className="settings-mono">{temperature.toFixed(1)}</span>
        </label>
        <input
          id="f-temp"
          type="range"
          min={0}
          max={2}
          step={0.1}
          value={temperature}
          onChange={(e) => setTemperature(Number(e.target.value))}
          onPointerUp={() => handleTemperatureCommit(temperature)}
          onKeyUp={() => handleTemperatureCommit(temperature)}
          onBlur={() => handleTemperatureCommit(temperature)}
          disabled={!loaded}
        />
        <span className="settings-field-sub">
          控制回复的随机性：越低越稳定克制（适合问技术问题），越高越发散有创意（适合角色扮演闲聊）。日常陪伴推荐
          0.7–1.0。
        </span>
      </div>

      <p className="settings-hint">
        聊天使用「使用中」的档案；「使用」按钮即时生效，无需保存。豆包（火山方舟）部分账号需填推理接入点
        ID（ep- 开头）作为模型名。
      </p>
    </div>
  )
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

/** 用量统计范围（DeepSeek usage 同款四档；today 按小时分桶，其余按天） */
type UsageRange = 'today' | '7d' | '30d' | 'all'

const USAGE_RANGES: Array<{ id: UsageRange; label: string }> = [
  { id: 'today', label: '今天' },
  { id: '7d', label: '近 7 天' },
  { id: '30d', label: '近 30 天' },
  { id: 'all', label: '全部' }
]

/** 范围起点时间戳（毫秒）；all 返回 0（全含） */
function usageRangeStart(id: UsageRange): number {
  if (id === 'all') return 0
  const now = new Date()
  if (id === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return now.getTime() - (id === '7d' ? 7 : 30) * 86_400_000
}

function fmtMsShort(ms: number): string {
  return ms >= 60000 ? `${Math.round(ms / 60000)} 分` : `${Math.round(ms / 1000)} 秒`
}

/** 「用量」分区：累计聚合 + 时间范围图表 + 按模型分组 + 按会话明细。
    数字 = 每轮请求后供应商回报的真实 usage（含思考 tokens），非估算；
    时间范围/模型维度依赖 v7 起记录的流水（usage/log.jsonl），此前只有累计值。 */
function UsageSection(): React.JSX.Element {
  const [data, setData] = useState<TokenUsageResult | null>(null)
  const [range, setRange] = useState<UsageRange>('7d')

  useEffect(() => {
    void window.petAPI.tokenUsage().then(setData)
  }, [])

  const start = usageRangeStart(range)
  const points = useMemo(
    () => (data === null ? [] : data.points.filter((p) => p.t >= start)),
    [data, start]
  )

  // 范围内汇总（all 直接用会话档累计——比流水更完整，流水之前没有）
  const sum = useMemo(() => {
    if (range === 'all') {
      return data === null
        ? { inputTok: 0, outputTok: 0, cachedTok: 0, llmMs: 0, rounds: 0 }
        : { ...data.totals }
    }
    return points.reduce(
      (acc, p) => ({
        inputTok: acc.inputTok + p.inputTok,
        outputTok: acc.outputTok + p.outputTok,
        cachedTok: acc.cachedTok + p.cachedTok,
        llmMs: acc.llmMs + p.llmMs,
        rounds: acc.rounds + p.rounds
      }),
      { inputTok: 0, outputTok: 0, cachedTok: 0, llmMs: 0, rounds: 0 }
    )
  }, [data, points, range])

  // 分桶：today 按小时、其余按天；空桶也占位（连续轴，DeepSeek 同款观感）
  const buckets = useMemo(() => {
    type Bucket = { label: string; inputTok: number; outputTok: number }
    const list: Bucket[] = []
    const idx = new Map<string, number>()
    const keyOf = (d: Date): string =>
      range === 'today' ? `h${d.getHours()}` : `d${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    const labelOf = (d: Date): string =>
      range === 'today'
        ? `${String(d.getHours()).padStart(2, '0')}:00`
        : `${d.getMonth() + 1}/${d.getDate()}`
    const push = (d: Date): void => {
      list.push({ label: labelOf(d), inputTok: 0, outputTok: 0 })
      idx.set(keyOf(d), list.length - 1)
    }
    if (range === 'today') {
      const now = new Date()
      for (let h = 0; h <= now.getHours(); h += 1)
        push(new Date(now.getFullYear(), now.getMonth(), now.getDate(), h))
    } else {
      const days = range === '7d' ? 7 : range === '30d' ? 30 : 0
      const today = new Date()
      if (days > 0) {
        for (let k = days - 1; k >= 0; k -= 1) {
          push(new Date(today.getFullYear(), today.getMonth(), today.getDate() - k))
        }
      }
    }
    if (range === 'all') {
      // 全部：从最早一条所在天到今天，连续建桶（上限 120 桶防极端长尾）
      const first = points[0]?.t
      if (first !== undefined) {
        const a = new Date(first)
        const b = new Date()
        const dayMs = 86_400_000
        const span = Math.min(
          120,
          Math.floor(
            (b.getTime() - new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()) / dayMs
          ) + 1
        )
        list.length = 0
        idx.clear()
        for (let k = span - 1; k >= 0; k -= 1) {
          push(new Date(b.getFullYear(), b.getMonth(), b.getDate() - k))
        }
      }
    }
    for (const p of points) {
      const at = idx.get(keyOf(new Date(p.t)))
      if (at === undefined) continue
      list[at].inputTok += p.inputTok
      list[at].outputTok += p.outputTok
    }
    return list
  }, [points, range])

  // 按模型分组（表格行；占比 = 该模型 tokens / 范围内总量）
  const byModel = useMemo(() => {
    const map = new Map<
      string,
      { model: string; rounds: number; inputTok: number; outputTok: number }
    >()
    for (const p of points) {
      const cur = map.get(p.model) ?? { model: p.model, rounds: 0, inputTok: 0, outputTok: 0 }
      cur.rounds += p.rounds
      cur.inputTok += p.inputTok
      cur.outputTok += p.outputTok
      map.set(p.model, cur)
    }
    const rows = [...map.values()]
    const totalAll = Math.max(
      1,
      rows.reduce((a, r) => a + r.inputTok + r.outputTok, 0)
    )
    return rows
      .map((r) => ({ ...r, share: (r.inputTok + r.outputTok) / totalAll }))
      .sort((a, b) => b.inputTok + b.outputTok - (a.inputTok + a.outputTok))
  }, [points])

  const maxBucket = Math.max(1, ...buckets.map((b) => b.inputTok + b.outputTok))
  const showChart = range !== 'all' || buckets.length > 0

  return (
    <div className="settings-card">
      <div className="settings-card-head">
        <span className="settings-card-icon">📊</span>
        <div>
          <div className="settings-card-title">Token 用量</div>
          <div className="settings-card-desc">
            数字来自每轮请求后供应商回报的真实 usage（含思考 tokens），不是估算。
          </div>
        </div>
      </div>

      {data === null ? (
        <p className="settings-hint">读取中…</p>
      ) : (
        <>
          {/* 时间范围（DeepSeek usage 同款；换范围联动下方汇总与图表） */}
          <div className="usage-range" role="tablist">
            {USAGE_RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                className={range === r.id ? 'usage-range-chip active' : 'usage-range-chip'}
                onClick={() => setRange(r.id)}
              >
                {r.label}
              </button>
            ))}
          </div>

          <div className="usage-summary">
            <div className="usage-stat">
              <div className="usage-num">{fmtTok(sum.inputTok)}</div>
              <div className="usage-cap">输入 tokens</div>
            </div>
            <div className="usage-stat">
              <div className="usage-num">{fmtTok(sum.outputTok)}</div>
              <div className="usage-cap">输出 tokens</div>
            </div>
            <div className="usage-stat">
              <div className="usage-num">
                {sum.cachedTok > 0
                  ? `${Math.round((sum.cachedTok / Math.max(1, sum.inputTok)) * 100)}%`
                  : '—'}
              </div>
              <div className="usage-cap">缓存命中</div>
            </div>
            <div className="usage-stat">
              <div className="usage-num">{sum.rounds}</div>
              <div className="usage-cap">对话轮数</div>
            </div>
            <div className="usage-stat">
              <div className="usage-num">{fmtMsShort(sum.llmMs)}</div>
              <div className="usage-cap">LLM 总耗时</div>
            </div>
          </div>

          {/* 用量柱状图：today 按小时、其余按天；浅柱=输入、深柱=输出（堆叠） */}
          {showChart && (
            <>
              <div className="usage-list-title">
                用量趋势（{range === 'today' ? '按小时' : '按天'} · 浅色 输入 / 深色 输出）
              </div>
              <div className="usage-chart" role="img">
                {buckets.map((b) => {
                  const total = b.inputTok + b.outputTok
                  const h = total === 0 ? 0 : Math.max(3, (total / maxBucket) * 100)
                  // 段高 = **占柱子的百分比**（两段相加恒为 100）。
                  // 此前写成"占柱子的 h%"——两段加起来只有 h%，柱子底部空出 (100-h)%，
                  // 于是整块粉条在半空浮着，看着就像"有一块和底色一样"。
                  let outRatio = total === 0 ? 0 : (b.outputTok / total) * 100
                  let inRatio = total === 0 ? 0 : (b.inputTok / total) * 100
                  // 缓存命中高时输出常只占 1~2%，细到看不见 → 给"有值的那段"一个可见下限，
                  // 差额从另一段扣（不增总量，柱子高度仍是真实占比）
                  const MIN_SEG = 3
                  if (outRatio > 0 && outRatio < MIN_SEG) {
                    outRatio = MIN_SEG
                    inRatio = 100 - MIN_SEG
                  } else if (inRatio > 0 && inRatio < MIN_SEG) {
                    inRatio = MIN_SEG
                    outRatio = 100 - MIN_SEG
                  }
                  return (
                    <div
                      key={b.label}
                      className="usage-chart-col"
                      title={`${b.label} · 输入 ${b.inputTok} · 输出 ${b.outputTok}`}
                    >
                      <div className="usage-chart-bar" style={{ height: `${h}%` }}>
                        {inRatio > 0 && (
                          <div className="usage-chart-in" style={{ height: `${inRatio}%` }} />
                        )}
                        {outRatio > 0 && (
                          <div className="usage-chart-out" style={{ height: `${outRatio}%` }} />
                        )}
                      </div>
                      <span className="usage-chart-label">{b.label}</span>
                    </div>
                  )
                })}
              </div>
              {points.length === 0 && (
                <p className="settings-hint">
                  该时段还没有明细记录——流水自本版本起统计，聊几句回来看就有。
                </p>
              )}
            </>
          )}

          {/* 按模型分组（表格）：范围内 tokens 与占比 */}
          {byModel.length > 0 && (
            <>
              <div className="usage-list-title">按模型</div>
              <div className="usage-models">
                <div className="usage-models-head">
                  <span>模型</span>
                  <span>轮数</span>
                  <span>输入</span>
                  <span>输出</span>
                  <span>占比</span>
                </div>
                {byModel.map((m) => (
                  <div key={m.model} className="usage-models-row">
                    <span className="usage-models-name" title={m.model}>
                      {m.model}
                    </span>
                    <span>{m.rounds}</span>
                    <span>{fmtTok(m.inputTok)}</span>
                    <span>{fmtTok(m.outputTok)}</span>
                    <span className="usage-models-share">
                      <div className="usage-bar-track">
                        <div
                          className="usage-bar-fill"
                          style={{ width: `${Math.max(3, m.share * 100)}%` }}
                        />
                      </div>
                      {Math.round(m.share * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          {(() => {
            const withOut = data.rows.filter((r) => r.outputTok > 0)
            const max = Math.max(1, ...withOut.map((r) => r.outputTok))
            if (withOut.length < 2) return null
            return (
              <>
                <div className="usage-list-title">输出分布（按会话）</div>
                <div className="usage-bars">
                  {withOut.slice(0, 12).map((r) => (
                    <div key={r.sessionId} className="usage-bar-row">
                      <span className="usage-bar-name" title={r.title}>
                        {r.title}
                      </span>
                      <div className="usage-bar-track">
                        <div
                          className="usage-bar-fill"
                          style={{ width: `${Math.max(4, (r.outputTok / max) * 100)}%` }}
                        />
                      </div>
                      <span className="usage-bar-val">{fmtTok(r.outputTok)}</span>
                    </div>
                  ))}
                </div>
              </>
            )
          })()}

          <div className="usage-list-title">按会话（最近在前，最多 100 条）</div>
          <div className="profile-list">
            {data.rows.length === 0 ? (
              <p className="settings-hint">还没有用量数据——去聊一句回来就有。</p>
            ) : (
              data.rows.map((r) => (
                <div key={r.sessionId} className="profile-row">
                  <div className="profile-info">
                    <div className="profile-name">{r.title}</div>
                    <div className="profile-meta">
                      {r.mode === 'chat' ? '💬 对话' : r.mode === 'learn' ? '📚 学习' : '🧰 工作'} ·{' '}
                      {r.rounds} 轮 · LLM {fmtMsShort(r.llmMs)} ·{' '}
                      {new Date(r.updatedAt).toLocaleString('zh-CN', {
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </div>
                  </div>
                  <div className="usage-tokens">
                    ↑ {fmtTok(r.inputTok)} · ↓ {fmtTok(r.outputTok)}
                  </div>
                </div>
              ))
            )}
          </div>
          <p className="settings-hint">
            ↑ 输入（含系统提示与人设，多轮对话会重复计入）· ↓ 输出（含思考
            tokens）。累计与按会话覆盖全部历史；时间范围与按模型自本版本起记录。
          </p>
        </>
      )}
    </div>
  )
}

/** 关于页的自动更新区块：状态机驱动，检查/下载/重启安装三步各给反馈。
 * 失败静默（后端保证），这里只呈现用户主动触发后的结果。 */
function UpdateRow(): React.JSX.Element {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  const [busy, setBusy] = useState(false)

  useEffect(() => window.petAPI.onUpdateStatus(setStatus), [])

  const check = (): void => {
    setBusy(true)
    void window.petAPI.updateCheck().finally(() => setBusy(false))
  }
  const download = (): void => {
    setBusy(true)
    void window.petAPI.updateDownload().finally(() => setBusy(false))
  }

  const s = status.state
  let hint = ''
  if (s === 'checking') hint = '正在检查更新…'
  else if (s === 'not-available') hint = '已是最新版本'
  else if (s === 'available') hint = `发现新版本 v${status.version ?? '?'}，点右侧下载`
  else if (s === 'downloading') hint = `下载中 ${status.percent ?? 0}%`
  else if (s === 'downloaded') hint = `v${status.version ?? '?'} 已下载，重启后生效`
  else if (s === 'error') hint = `检查失败：${status.error ?? '未知错误'}`
  else if (status.dev === true) hint = '开发模式（未打包安装版）下不可用'
  else hint = '检查 GitHub Releases 的新版本（仅安装版可用）'

  return (
    <>
      <div className="settings-row">
        <span className="settings-row-label">
          自动更新
          <span className="settings-row-sub">{hint}</span>
        </span>
        <span className="settings-update-actions">
          {s === 'available' && (
            <button
              type="button"
              className="settings-btn primary"
              disabled={busy}
              onClick={download}
            >
              下载
            </button>
          )}
          {s === 'downloaded' && (
            <button
              type="button"
              className="settings-btn primary"
              onClick={() => void window.petAPI.updateQuitInstall()}
            >
              重启安装
            </button>
          )}
          {(s === 'idle' || s === 'not-available' || s === 'error') && (
            <button type="button" className="settings-btn" disabled={busy} onClick={check}>
              {busy ? '检查中…' : '检查更新'}
            </button>
          )}
          {s === 'error' && (
            <button
              type="button"
              className="settings-btn"
              onClick={() => void window.petAPI.updateOpenReleases()}
            >
              打开下载页
            </button>
          )}
        </span>
      </div>
      {s === 'downloading' && (
        <div className="settings-update-bar">
          <div className="settings-update-bar-fill" style={{ width: `${status.percent ?? 0}%` }} />
        </div>
      )}
    </>
  )
}

function AboutSection(): React.JSX.Element {
  return (
    <div className="settings-card">
      <div className="settings-card-head">
        <span className="settings-card-icon">ℹ️</span>
        <div>
          <div className="settings-card-title">关于 {APP_NAME}</div>
          <div className="settings-card-desc">以《鸣潮》爱弥斯为主题的桌面 AI 伴侣 Agent。</div>
        </div>
      </div>
      <div className="settings-row">
        <span className="settings-row-label">版本</span>
        <span className="settings-row-label">{APP_STAGE_LABEL}</span>
      </div>
      <div className="settings-row">
        <span className="settings-row-label">源码</span>
        <span className="settings-row-label">github.com/taoser258/AemeathAgent</span>
      </div>
      <UpdateRow />
    </div>
  )
}

function SettingsApp(): React.JSX.Element {
  const [section, setSection] = useState<SectionId>('pet')

  return (
    <div className="settings-shell" style={{ position: 'relative' }}>
      {/* 右上角窗口控制（按钮自身不触发拖拽） */}
      <div style={{ position: 'absolute', top: 8, right: 12, zIndex: 10 }}>
        <WindowControls />
      </div>
      {/* 顶部拖拽条：手动拖拽（与主窗同款）——app-region:drag 在无边框窗上
          不会"拖出即还原最大化"（实测反馈），且原生 drag 区吞命中，改由
          startWindowDrag 接管（见 src/renderer/window-drag.ts）。
          单击无操作、拖动超阈值才还原、双击切换最大化（防误触） */}
      <div
        className="settings-drag-strip"
        onPointerDown={startWindowDrag}
        onDoubleClick={toggleWindowMaximize}
      />
      <nav className="settings-nav">
        <div className="settings-nav-head">
          <img className="settings-nav-logo" src={avatar} alt="Aemeath" draggable={false} />
          <span className="settings-nav-name">设置</span>
        </div>
        <div className="settings-nav-list">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={section === item.id ? 'settings-nav-item active' : 'settings-nav-item'}
              onClick={() => setSection(item.id)}
            >
              <span>{item.icon}</span>
              {item.label}
            </button>
          ))}
          {SOON_NAV.map((item) => (
            <button
              key={item.label}
              type="button"
              className="settings-nav-item soon"
              title={item.note}
            >
              <span>{item.icon}</span>
              {item.label}
              <span className="soon-badge">SOON</span>
            </button>
          ))}
        </div>
        <div className="settings-nav-foot">{APP_FOOTER_LABEL}</div>
      </nav>
      <div className="settings-body" style={{ paddingTop: 30 }}>
        <h1 className="settings-page-title">
          {NAV.find((n) => n.id === section)?.label ?? '设置'}
        </h1>
        <p className="settings-page-sub">改动即时生效，无需重启。</p>
        {section === 'pet' && <PetSection />}
        {section === 'appearance' && <AppearanceSection />}
        {section === 'user' && <UserSection />}
        {section === 'memory' && <MemorySection />}
        {section === 'sessions' && <SessionsSection />}
        {section === 'mcp' && <McpSection />}
        {section === 'workspace' && <WorkspaceSection />}
        {section === 'model' && <ModelSection />}
        {section === 'usage' && <UsageSection />}
        {section === 'about' && <AboutSection />}
      </div>
    </div>
  )
}

export default SettingsApp
