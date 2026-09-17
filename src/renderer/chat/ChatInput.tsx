// 输入区：Enter=发送、Shift+Enter=换行；
// 底部状态条 = 上下文用量环（成熟风格）+ 模型一键切换；
// 左侧按钮：＋ 上传本地文件（主进程原生对话框+读取）、☺ 表情包面板（sticker:// 协议）。

import { useEffect, useMemo, useState } from 'react'
import type { ChatAttachmentPayload, ModelProfile, ReasoningEffort } from '@shared/types'
import {
  REASONING_LEVELS,
  planReasoning,
  reasoningDetail,
  reasoningSummary
} from '@shared/reasoning'
import { resolveReasoningAdapter } from '@shared/reasoning-adapters'
import { boundWorkspace, modeLabel, modeNeedsWorkspace } from '@shared/workspace'
import { useChatStore, selectStreamingActive, type ChatMessage } from './store'
import PermissionButton from './PermissionButton'
import WorkspaceButton from './WorkspaceButton'
import ReasoningSlider from './ReasoningSlider'

const NO_MESSAGES: ChatMessage[] = []

/** 本地待发送附件（渲染层私有；发送时去掉 id 即为主进程契约） */
type LocalAtt = ChatAttachmentPayload & { id: string }

const MAX_ATTACHMENTS = 8
/** 与主进程 file-pick.ts 同口径：图片超过 6MB 不发 dataUrl */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024

function newAttId(): string {
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** 剪贴板 File → 附件契约（dataUrl 走 FileReader；渲染层只处理粘贴这一入口，
 * 文件选择仍走主进程原生对话框，见 main/file-pick.ts） */
function readImageAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

/** token 数格式化：1000→1.0K，1e6→1.0M（对齐 成熟实现的显示习惯） */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

/** 时长格式化：59.3秒 / 2分38秒 */
function fmtDur(ms: number): string {
  if (ms <= 0) return '0秒'
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}秒`
  const m = Math.floor(s / 60)
  return `${m}分${Math.round(s - m * 60)}秒`
}

/** 上下文用量环：14px 小环 + 成熟风格文字（环只是指示，数字才是主角） */
function UsageRing({
  ratio,
  busy,
  over
}: {
  ratio: number
  busy: boolean
  /** 真实占用已超过档案窗口（压缩也救不了，多为窗口填太小/固定占用过高）→ 警示红 */
  over: boolean
}): React.JSX.Element {
  const size = 14
  const r = 5
  const c = 2 * Math.PI * r
  const clamped = Math.min(1, Math.max(0, ratio))
  return (
    <svg
      className={`usage-ring${busy ? ' busy' : ''}${over ? ' over' : ''}`}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2.5"
      />
      <circle
        className="usage-ring-val"
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--pink-400)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - clamped)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 240ms ease, stroke 160ms ease' }}
      />
    </svg>
  )
}

function ChatInput(): React.JSX.Element {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<LocalAtt[]>([])
  const [notice, setNotice] = useState('')
  const streaming = useChatStore(selectStreamingActive)
  const send = useChatStore((s) => s.send)
  const stop = useChatStore((s) => s.stop)
  const nudge = useChatStore((s) => s.nudge)
  const chatMode = useChatStore((s) => s.chatMode)
  /** 当前会话 id（手动压缩要按会话走；与模型档案 id 区分开，别混用） */
  const sessionId = useChatStore((s) => s.activeId)
  // 当前会话消息（上下文用量估算用）
  const activeMessages = useChatStore((s) =>
    s.activeId === null ? NO_MESSAGES : (s.messagesBySession[s.activeId] ?? NO_MESSAGES)
  )

  // 模型档案（状态条切换器）
  const [activeModel, setActiveModel] = useState('')
  const [profiles, setProfiles] = useState<ModelProfile[]>([])
  const [activeId, setActiveId] = useState('')
  const [switcherOpen, setSwitcherOpen] = useState(false)
  // 上下文估算：人设 system prompt 字符数（主进程算好）+ 档案上下文窗口
  const [personaChars, setPersonaChars] = useState(0)
  const [contextCap, setContextCap] = useState(0)

  // 表情包面板
  const [stickerOpen, setStickerOpen] = useState(false)
  const [stickers, setStickers] = useState<string[]>([])

  // 工作区绑定（门槛判定用）；null = 还没读到配置，此时不显示引导卡（避免闪一下）
  const [workspace, setWorkspace] = useState<{
    work: string | null
    learn: string | null
  } | null>(null)

  const refreshModels = (): void => {
    void window.petAPI.settingsGet().then((res) => {
      setProfiles(res.config.model.profiles)
      setActiveId(res.config.model.activeId)
      setActiveModel(res.config.model.model)
      setPersonaChars(res.personaPromptChars)
      const active = res.config.model.profiles.find((p) => p.id === res.config.model.activeId)
      setContextCap(active?.context ?? 0)
      const bound = res.config.workspace ?? { work: null, learn: null }
      setWorkspace(bound)
    })
  }

  // 该模式是否因缺工作区而开不了工（对话模式无工具，永远不需要）
  const needWorkspace =
    workspace !== null &&
    modeNeedsWorkspace(chatMode) &&
    boundWorkspace(workspace, chatMode) === null

  const pickWorkspace = async (): Promise<void> => {
    const dir = await window.petAPI.pickDirectory()
    if (dir === null) return
    await window.petAPI.settingsSet({
      workspace: chatMode === 'learn' ? { learn: dir } : { work: dir }
    })
  }

  // 不自动弹目录选择框（ 改口：保持安静，引导卡 + 按钮就够了，
  // 用户自己决定什么时候选）。绑定动作只有引导卡和 📁 胶囊两个入口。

  useEffect(() => {
    refreshModels()
    void window.petAPI
      .stickersList()
      .then(setStickers)
      .catch(() => setStickers([]))
    // 设置页保存后即时刷新（模型名/上下文窗口/人设基线）
    return window.petAPI.onSettingsChanged(() => refreshModels())
  }, [])

  const switchModel = async (id: string): Promise<void> => {
    const res = await window.petAPI.settingsSet({ model: { activeId: id } })
    setActiveId(res.model.activeId)
    setActiveModel(res.model.model)
    const active = res.model.profiles.find((p) => p.id === res.model.activeId)
    setContextCap(active?.context ?? 0)
    setSwitcherOpen(false)
  }

  // ── 上下文用量：优先真实 API usage（prompt+completion），无则字符估算（1 token ≈ 1.6 字符，与主进程裁剪公式一致）──
  const realUsage = useChatStore((s) =>
    s.activeId === null ? undefined : s.usageBySession[s.activeId]
  )
  const stats = useChatStore((s) =>
    s.activeId === null ? undefined : s.statsBySession[s.activeId]
  )
  const personaTokens = Math.round(personaChars / 1.6)
  const convTokensEst = Math.round(activeMessages.reduce((n, m) => n + m.content.length, 0) / 1.6)
  const usage = useMemo(() => {
    if (realUsage !== undefined) {
      const used = realUsage.promptTokens + realUsage.completionTokens
      return {
        used,
        ratio: contextCap > 0 ? Math.min(1, used / contextCap) : 0,
        real: true,
        conv: Math.max(0, used - personaTokens)
      }
    }
    const used = personaTokens + convTokensEst
    return {
      used,
      ratio: contextCap > 0 ? Math.min(1, used / contextCap) : 0,
      real: false,
      conv: convTokensEst
    }
  }, [realUsage, personaTokens, convTokensEst, contextCap])
  /** 真实占用已超过档案窗口（压缩也救不了的场景，环/浮层给警示态） */
  const overCap = contextCap > 0 && usage.used > contextCap
  const [usageOpen, setUsageOpen] = useState(false)
  /** 手动压缩（P8-T1）进行中（一次摘要调用，按秒计） */
  const [compacting, setCompacting] = useState(false)
  /** 右键模型弹出的「思考强度」菜单（P8-T4）：null = 未开 */
  const [reasoningMenu, setReasoningMenu] = useState<string | null>(null)

  const menuProfile =
    reasoningMenu === null ? undefined : profiles.find((p) => p.id === reasoningMenu)
  /** 菜单里的可选档位 = 「自动（不注入）」+ 该档案勾选的档位；
   *  空 = 没开思考（菜单给指路而不是空滑条）。
   *  '自动'必须作为最左一档存在——否则默认档（default）会被 indexOf 回退成「低」，
   *  用户会以为"正在注入低强度"，而实际是"不注入"（实测踩到过）。 */
  const menuLevels: ReasoningEffort[] =
    menuProfile === undefined || (menuProfile.reasoningLevels ?? []).length === 0
      ? []
      : [
          'default',
          ...(menuProfile.reasoningLevels ?? []).filter((l) => REASONING_LEVELS.includes(l))
        ]

  /** 当前右键菜单档案的思考参数风格（P9-T1：手动覆盖优先，否则按 Base URL 识别） */
  const menuAdapter =
    menuProfile !== undefined && menuProfile.protocol === 'openai'
      ? resolveReasoningAdapter({
          baseUrl: menuProfile.baseUrl,
          ...(menuProfile.reasoningAdapter !== undefined
            ? { override: menuProfile.reasoningAdapter }
            : {})
        })
      : undefined

  /** 档位 → 预算说明（与设置页/协议实现同源；只给 tokens 部分，档位名由滑条自己写） */
  const menuHintOf = (level: ReasoningEffort): string => {
    const plan = planReasoning({
      protocol: menuProfile?.protocol ?? 'openai',
      effort: level,
      ...(menuAdapter !== undefined
        ? { adapter: menuAdapter, model: menuProfile?.model ?? '' }
        : {}),
      ...(menuProfile?.maxOutput !== undefined ? { maxOutput: menuProfile.maxOutput } : {})
    })
    return reasoningDetail(plan)
  }

  /** 写回档位：只影响**后续请求**（正在跑的那轮不回溯），乐观更新 + 读回同步 */
  const applyReasoning = async (level: ReasoningEffort): Promise<void> => {
    if (menuProfile === undefined) return
    const before = menuProfile.reasoningEffort
    setProfiles((cur) =>
      cur.map((p) => (p.id === menuProfile.id ? { ...p, reasoningEffort: level } : p))
    )
    try {
      const res = await window.petAPI.settingsSet({
        model: {
          profiles: profiles.map((p) =>
            p.id === menuProfile.id ? { ...p, reasoningEffort: level } : p
          ),
          activeId
        }
      })
      setProfiles(res.model.profiles)
      const plan = planReasoning({
        protocol: menuProfile.protocol,
        effort: level,
        ...(menuAdapter !== undefined ? { adapter: menuAdapter, model: menuProfile.model } : {}),
        ...(menuProfile.maxOutput !== undefined ? { maxOutput: menuProfile.maxOutput } : {})
      })
      // 折算说明优先级：厂商适配器 note（如"已按 max 发送"）> 通用协议钳制旧文案
      const tail = plan.adapterNote
        ? plan.adapterNote
        : plan.clamped
          ? '该协议上限，已自动降级'
          : ''
      flashNotice(
        `「${menuProfile.name}」思考强度 → ${reasoningSummary(plan)}${tail !== '' ? `（${tail}）` : ''}；下次发言生效`
      )
    } catch {
      setProfiles((cur) =>
        cur.map((p) => (p.id === menuProfile.id ? { ...p, reasoningEffort: before } : p))
      )
      flashNotice('思考强度保存失败')
    }
  }

  // 点别处/切模型就收起菜单（右键菜单不该常驻）
  useEffect(() => {
    if (reasoningMenu === null) return
    const close = (): void => setReasoningMenu(null)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [reasoningMenu])

  // ── 附件（主进程原生对话框选择并读取，见 main/file-pick.ts）──────────
  const flashNotice = (message: string): void => {
    setNotice(message)
    window.setTimeout(() => setNotice((cur) => (cur === message ? '' : cur)), 4000)
  }

  /** 手动压缩当前会话（P8-T1）：主进程读会话档案生成摘要并落盘，下次发言起生效 */
  const doCompact = async (): Promise<void> => {
    if (sessionId === null) return
    setCompacting(true)
    try {
      const res = await window.petAPI.chatCompact(sessionId)
      flashNotice(res.message)
    } catch {
      // 交互约定：点按钮 → 置 busy → 异步 then 复位，必须带 catch 复位
      //（否则一次 IPC 失败就把按钮永久置灰）
      flashNotice('压缩上下文失败（主进程未响应）')
    } finally {
      setCompacting(false)
    }
  }

  const pickFiles = async (): Promise<void> => {
    const res = await window.petAPI.pickFiles()
    const room = MAX_ATTACHMENTS - attachments.length
    const accepted = res.attachments.slice(0, Math.max(0, room))
    if (res.attachments.length > room) {
      res.warnings.push(`附件总数最多 ${MAX_ATTACHMENTS} 个，多余的未添加`)
    }
    // 视觉前置提示：当前档案没开多模态却选了图片 → 当场提醒。
    // P8-T3 起不再是"一定看不到"：配了视觉档案（设置 → 模型）会由它转述成文字，
    // 但转述会比直接看图更容易认错字——所以照实说清两种情况，别让用户以为稳了。
    const hasImage = accepted.some((a) => a.kind === 'image')
    const active = profiles.find((p) => p.id === activeId)
    if (hasImage && active !== undefined && active.multimodal !== true) {
      res.warnings.push(
        `当前模型「${active.name}」未开启多模态：若已在 设置 → 模型 配好「视觉档案」，图片会先由它转述成文字（据识图转述，长数字可能认错）；没配的话她会看不到这张图。`
      )
    }
    if (accepted.length > 0) {
      setAttachments((cur) => [...cur, ...accepted.map((a) => ({ ...a, id: newAttId() }))])
    }
    if (res.warnings.length > 0) flashNotice(res.warnings.join('；'))
  }

  // ── 直接粘贴图片（截图后 Ctrl+V 进输入框）──────────────────────────
  // 只拦图片：纯文字粘贴走 textarea 默认行为；非图片文件忽略。
  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    if (streaming || needWorkspace) return
    const files = [...event.clipboardData.files].filter((f) => f.type.startsWith('image/'))
    if (files.length === 0) return
    event.preventDefault() // 有图片才接管，避免把图片文件名粘进文字里
    void (async () => {
      const accepted: LocalAtt[] = []
      const warns: string[] = []
      for (const file of files) {
        if (accepted.length >= MAX_ATTACHMENTS - attachments.length) {
          warns.push(`附件总数最多 ${MAX_ATTACHMENTS} 个，多余的未添加`)
          break
        }
        const ext = (file.name.match(/\.\w+$/)?.[0] ?? '.png').toLowerCase()
        const name =
          file.name !== '' && !/^image\./i.test(file.name)
            ? file.name
            : `粘贴图片-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}${ext}`
        if (file.size > MAX_IMAGE_BYTES) {
          warns.push(`图片 ${name} 超过 6MB，未添加`)
          continue
        }
        const dataUrl = await readImageAsDataUrl(file)
        if (dataUrl === null) {
          warns.push(`图片 ${name} 读取失败`)
          continue
        }
        accepted.push({ id: newAttId(), name, kind: 'image', size: file.size, dataUrl })
      }
      const active = profiles.find((p) => p.id === activeId)
      if (accepted.length > 0 && active !== undefined && active.multimodal !== true) {
        warns.push(
          `当前模型「${active.name}」未开启多模态：若已配好「视觉档案」会由它转述成文字，否则她看不到这张图（见 设置 → 模型）。`
        )
      }
      if (accepted.length > 0) setAttachments((cur) => [...cur, ...accepted])
      if (warns.length > 0) flashNotice(warns.join('；'))
    })()
  }

  const doSend = (): void => {
    // **工作中插话（steering）**：任务进行中发送 = 把消息注入她正在跑的任务
    //（本地立刻显示用户气泡 + 新的流式气泡；主进程下一轮把消息喂给她）
    if (streaming) {
      const t = text.trim()
      if (t === '' || activeId === null) return
      setText('')
      void nudge(t).then((ok) => {
        if (!ok) {
          // 竞态兜底：任务恰好在插话瞬间结束 → 回填输入框让用户正常发送
          setText(t)
          flashNotice('任务已结束，按发送直接发新消息')
        }
      })
      return
    }
    // 工作区门槛（工作 / 学习模式）：输入框此时是禁用的，这里是键位/程序化调用的兜底
    if (needWorkspace) {
      flashNotice(`先绑定${modeLabel(chatMode)}模式的工作目录，才能开始`)
      return
    }
    if (text.trim() === '' && attachments.length === 0) return
    send(
      text,
      attachments.map(({ name, kind, size, dataUrl, text: fileText, path }) => ({
        name,
        kind,
        size,
        dataUrl,
        text: fileText,
        path
      }))
    )
    setText('')
    setAttachments([])
  }

  const sendSticker = (name: string): void => {
    if (streaming || needWorkspace) return
    send('', [{ name, kind: 'sticker' }])
    setStickerOpen(false)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter 直接发送；Shift+Enter 换行；Ctrl/Cmd+Enter 同样发送（兼容老习惯）
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      doSend()
    }
  }

  return (
    <div className="chat-input-area">
      {notice !== '' && <div className="input-notice">{notice}</div>}
      {needWorkspace && (
        <div className="workspace-gate">
          <span className="workspace-gate-icon">📁</span>
          <div className="workspace-gate-text">
            <b>{modeLabel(chatMode)}模式还不能开始</b>
            <span>
              先选一个工作目录：她读写文件都相对它解析，目录内的改动直接执行（写前自动快照、可一键撤销）。
              或者切到「对话」模式先聊聊。
            </span>
          </div>
          <button type="button" className="workspace-gate-btn" onClick={() => void pickWorkspace()}>
            选择目录
          </button>
        </div>
      )}
      <div className="chat-input-box">
        {/* 附件展示在对话框**内部**；
            图片给缩略图 + 悬停放大预览（同款口径），随时可点 × 移除 */}
        {attachments.length > 0 && (
          <div className="attach-chips">
            {attachments.map((att) => {
              const isImage = att.kind === 'image' && att.dataUrl !== undefined
              return (
                <span
                  key={att.id}
                  className={isImage ? 'attach-chip is-image' : 'attach-chip'}
                  title={att.name}
                >
                  {isImage ? (
                    <span className="attach-thumb-wrap">
                      <img className="attach-thumb" src={att.dataUrl} alt={att.name} />
                      {/* 悬停放大预览：纯 CSS hover 显示，不占布局 */}
                      <span className="attach-preview">
                        <img src={att.dataUrl} alt={att.name} />
                      </span>
                    </span>
                  ) : (
                    <span className="attach-icon">{att.kind === 'sticker' ? '🎀' : '📄'}</span>
                  )}
                  <span className="attach-name">{att.name}</span>
                  <button
                    type="button"
                    className="attach-remove"
                    aria-label={`移除附件 ${att.name}`}
                    onClick={() => setAttachments((cur) => cur.filter((a) => a.id !== att.id))}
                  >
                    ×
                  </button>
                </span>
              )
            })}
          </div>
        )}
        <textarea
          className="chat-input"
          placeholder={
            needWorkspace
              ? '先在上面选一个工作目录…'
              : streaming
                ? '任务进行中——说点什么，她会看到并接着做…'
                : '和爱弥斯说点什么吧…'
          }
          value={text}
          rows={2}
          disabled={needWorkspace}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="chat-input-actions" style={{ position: 'relative' }}>
          <span className="chat-input-actions-left">
            <button
              type="button"
              className="composer-icon-btn"
              title="上传本地文件（文本直接阅读；图片需模型开启多模态）"
              disabled={needWorkspace}
              onClick={() => void pickFiles()}
            >
              ＋
            </button>
            <button
              type="button"
              className="composer-icon-btn"
              title="表情包"
              disabled={needWorkspace}
              onClick={() => setStickerOpen(!stickerOpen)}
            >
              ☺
            </button>
            <PermissionButton />
            <WorkspaceButton />
          </span>
          {stickerOpen ? (
            <div className="sticker-panel">
              <div className="sticker-panel-title">爱弥斯表情包（点击直接发送）</div>
              <div className="sticker-grid">
                {stickers.length === 0 && <div className="sticker-empty">没有找到表情包</div>}
                {stickers.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className="sticker-item"
                    title={name.replace(/\.gif$/i, '')}
                    onClick={() => sendSticker(name)}
                  >
                    <img
                      src={`sticker://local/${encodeURIComponent(name)}`}
                      alt={name}
                      loading="lazy"
                      draggable={false}
                    />
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <span className="chat-input-actions-right">
            <span
              className="usage-holder"
              title="上下文用量（悬停查看明细）"
              onMouseEnter={() => setUsageOpen(true)}
              onMouseLeave={() => setUsageOpen(false)}
            >
              <UsageRing ratio={usage.ratio} busy={streaming} over={overCap} />
              {usageOpen ? (
                <div className="usage-pop" role="tooltip">
                  <div className="usage-pop-title">上下文用量明细</div>
                  <div className="usage-pop-row">
                    <span>模型上限</span>
                    <b>{contextCap > 0 ? `${fmtTokens(contextCap)} tokens` : '未设置'}</b>
                  </div>
                  <div className="usage-pop-row">
                    <span>人设基线</span>
                    <b>{fmtTokens(personaTokens)} tokens（估算）</b>
                  </div>
                  {usage.real ? (
                    <div className="usage-pop-row">
                      <span>上次请求（真实）</span>
                      <b>{fmtTokens(usage.used)} tokens · 含人设/历史/回复</b>
                    </div>
                  ) : (
                    <div className="usage-pop-row">
                      <span>对话消息</span>
                      <b>{fmtTokens(usage.conv)} tokens（估算）</b>
                    </div>
                  )}
                  <div className={`usage-pop-row total${overCap ? ' over' : ''}`}>
                    <span>已使用</span>
                    <b>
                      {contextCap > 0
                        ? // 超限时显示真实百分比（clamp 成 100% 会把 17.9K/10K 这种情况藏掉）
                          `${((usage.used / contextCap) * 100).toFixed(usage.used > contextCap ? 0 : 1)}% · ${fmtTokens(usage.used)} / ${fmtTokens(contextCap)}`
                        : `${fmtTokens(usage.used)} tokens`}
                    </b>
                  </div>
                  {overCap ? (
                    <div className="usage-pop-note over-hint">
                      已经超过窗口：人设与工具说明是固定占用（压缩只动历史消息）。请把档案的上下文窗口调大，或到
                      设置 → 工具 关掉用不到的工具。
                    </div>
                  ) : null}
                  <div className="usage-pop-note">
                    {usage.real
                      ? '数据来源：上次请求的真实用量（每次对话后自动更新）'
                      : '数据来源：字符估算（首次对话后自动转为真实用量）'}
                  </div>
                  {/* 手动压缩（P8-T1）：把更早的对话折叠成摘要，下次发言起生效 */}
                  <button
                    type="button"
                    className="approval-btn usage-pop-action"
                    disabled={streaming || compacting || sessionId === null}
                    onClick={() => void doCompact()}
                  >
                    {compacting ? '压缩中…' : '压缩更早的对话'}
                  </button>
                  <div className="usage-pop-note">
                    原始记录不会被删（回看/搜索仍是原文）；只是把更早的部分摘要成一段转述，省出窗口空间。
                  </div>
                </div>
              ) : null}
            </span>
            <span className="model-holder">
              <button
                type="button"
                className="meta-model-btn"
                title="点击切换模型（已配置档案）"
                onClick={() => setSwitcherOpen(!switcherOpen)}
              >
                {activeModel === '' ? '模型未选择' : `模型 ${activeModel}`} ▾
              </button>
              {switcherOpen ? (
                <div className="model-switcher">
                  {profiles.map((profile) => (
                    <button
                      key={profile.id}
                      type="button"
                      className={profile.id === activeId ? 'active' : ''}
                      disabled={profile.model === ''}
                      title={
                        profile.model === ''
                          ? '该档案还没填模型名（点编辑填写后可切换）'
                          : `${profile.baseUrl}（右键调整思考强度）`
                      }
                      onClick={() => void switchModel(profile.id)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        // 右键 = 调思考强度（P8-T4 图二）：没开思考的档案也弹，
                        // 但菜单里说明清楚去哪儿开——比"右键没反应"强得多
                        setReasoningMenu(profile.id)
                      }}
                    >
                      <span className="sw-name">
                        {profile.id === activeId ? '✓ ' : ''}
                        {profile.name}
                      </span>
                      <span className="sw-model">
                        {profile.model === '' ? '未填模型' : profile.model}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
              {reasoningMenu !== null ? (
                <div
                  className="reasoning-pop"
                  role="dialog"
                  aria-label="调整思考强度"
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <div className="reasoning-pop-head">思考强度</div>
                  {menuLevels.length === 0 ? (
                    <div className="reasoning-pop-empty">
                      该档案还没开启思考模式——到 设置 → 模型 → 编辑，勾选「支持的思考强度」后再来。
                    </div>
                  ) : (
                    <>
                      <ReasoningSlider
                        levels={menuLevels}
                        value={menuProfile?.reasoningEffort}
                        onChange={(level) => void applyReasoning(level)}
                        hintOf={menuHintOf}
                        model={menuProfile?.model ?? ''}
                      />
                      <div className="reasoning-pop-note">
                        改动「下次发言」生效（正在跑的这轮不回溯）；默认档位在 设置 → 模型 里改。
                      </div>
                    </>
                  )}
                </div>
              ) : null}
            </span>
            {streaming ? (
              <>
                {text.trim() !== '' && (
                  <button
                    type="button"
                    className="chat-send is-nudge"
                    title="插入到正在进行的任务（Enter）"
                    onClick={doSend}
                  >
                    ⇗
                  </button>
                )}
                <button type="button" className="chat-stop" title="停止" onClick={() => stop()}>
                  ■
                </button>
              </>
            ) : (
              <button
                type="button"
                className="chat-send"
                title="发送（Enter；Shift+Enter 换行）"
                onClick={doSend}
                disabled={needWorkspace || (text.trim() === '' && attachments.length === 0)}
              >
                ↑
              </button>
            )}
          </span>
        </div>
      </div>
      {stats !== undefined && (stats.rounds > 0 || stats.samples > 0 || streaming) ? (
        <div className="chat-stats-bar">
          <span>
            {stats.rounds} 轮{stats.steps > 0 ? ` · ${stats.steps} 步` : ''}
          </span>
          <i />
          <span>
            LLM {fmtDur(stats.llmMs)}
            {stats.toolMs > 0 ? ` · 工具 ${fmtDur(stats.toolMs)}` : ''}
          </span>
          <i />
          <span>
            首 token {stats.ttftMsLast > 0 ? `${(stats.ttftMsLast / 1000).toFixed(1)}s` : '—'} ·{' '}
            {stats.tpsLast > 0 ? `${Math.round(stats.tpsLast)} tok/s` : '—'}
          </span>
          <i />
          <span>
            缓存命中{' '}
            {stats.cacheKnown
              ? `${Math.round((stats.cachedTok / Math.max(1, stats.inputTok)) * 100)}%`
              : '—'}
          </span>
          <i />
          <span>
            输入 {fmtTokens(stats.inputTok)} tok · 输出 {fmtTokens(stats.outputTok)} tok
          </span>
        </div>
      ) : null}
    </div>
  )
}

export default ChatInput
