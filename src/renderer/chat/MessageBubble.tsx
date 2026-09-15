// 单条消息气泡：用户消息右对齐（可含表情包/图片/文件附件）；助手消息带头像 + Markdown 渲染，
// 流式中的空内容显示打字动画、有内容后尾随闪烁光标。

import { memo, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { keyArgOf, summarizeToolCall, toolLabel, toolNameWithLabel } from '@shared/tool-labels'
import avatar from '../assets/aemeath-avatar.png'
import { useChatStore, type ChatMessage, type TimelineSegment, type ToolRunView } from './store'
import {
  spawnBadge,
  spawnHistStatusFromResult,
  spawnObjectiveFromArgs,
  spawnProgressText,
  spawnStatsText
} from './spawnCard'
import Markdown from './Markdown'

/** sticker:// 图片地址（文件名经 URL 编码；协议在主进程注册，见 main/stickers.ts） */
function stickerSrc(name: string): string {
  return `sticker://local/${encodeURIComponent(name)}`
}

/** 子任务分身卡：spawn_agent 专用——头部（objective + 状态徽标）、
 * 运行中进度（轮/步/最近工具，来自 agent_progress 事件折叠）、终态可折叠报告。
 * 无分身视图（历史恢复/事件缺失）时退化为「objective + 原始结果」的简化卡，
 * 信息量与通用工具卡持平。 */
function SpawnCard({ run }: { run: ToolRunView }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const sub = run.sub
  // 历史恢复路径：sub 缺失且重建的 toolRuns 没有 ok——从持久化结果文本反推状态，
  // 否则徽标会永远「运行中」且隐藏报告展开按钮
  const histStatus = sub === undefined ? spawnHistStatusFromResult(run.resultPreview) : null
  const badge =
    sub !== undefined
      ? spawnBadge(sub, run.ok, run.status)
      : histStatus !== null
        ? spawnBadge(undefined, histStatus === 'completed', histStatus)
        : spawnBadge(undefined, run.ok, run.status)
  const objective =
    sub?.objective ?? spawnObjectiveFromArgs(run.argsPreview) ?? '（任务目标未记录）'
  const running = badge.tone === 'run'
  const stats = sub !== undefined && sub.status !== 'running' ? spawnStatsText(sub) : null
  const report = sub?.report ?? (sub === undefined ? run.resultPreview : undefined)
  return (
    <div className="spawn-card" data-status={sub?.status ?? (running ? 'running' : 'done')}>
      <div className="spawn-card-head">
        <span className="spawn-card-icon" aria-hidden="true">
          🤖
        </span>
        <span className="spawn-card-title" title={objective}>
          {objective}
        </span>
        <span className={`spawn-badge tone-${badge.tone}`}>{badge.label}</span>
      </div>
      {running && sub !== undefined && (
        <div className="spawn-card-progress">{spawnProgressText(sub)}</div>
      )}
      {!running && stats !== null && <div className="spawn-card-stats">{stats}</div>}
      {!running && report !== undefined && (
        <>
          <button type="button" className="spawn-card-toggle" onClick={() => setOpen(!open)}>
            {open ? '收起分身报告' : '查看分身报告'}
            <span className={`msg-tool-chevron${open ? ' open' : ''}`} aria-hidden="true">
              ›
            </span>
          </button>
          {open && <div className="spawn-card-report">{report}</div>}
        </>
      )}
    </div>
  )
}

/** 工具调用行：默认只显示"调用 XX 工具"，点击展开参数与结果详情。
 * 读写类工具：标题旁附文件行按钮，点击直接在右侧栏预览——
 * 她读过/改过哪个文件，过程中就能点开看，不用等回复结束。 */
/** 轻量时钟钩子：active=true 时每秒触发一次重渲染（用于实时耗时显示）。
 * 注意不要在 effect 里同步 setState（本项目 lint 硬规则：cascading renders）。 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/**
 * 流式气泡底部的「正在做什么」一行淡色说明（她写代码时只看见图标
 * 一闪一闪，像卡住了；要像 成熟实现那样用淡色字说清当前在干嘛）。
 *
 * 优先级：引擎状态提示（自动续跑/连接重试）> 正在执行的那个工具（带实时秒数）> 正在写回答/思考。
 * 工具是串行执行的，所以"最后一个还没有结果的工具段"就是当前正在跑的那个。
 */
function ActivityLine({ message }: { message: ChatMessage }): React.JSX.Element | null {
  const notice = useChatStore((s) =>
    s.activeId === null ? undefined : s.noticeBySession[s.activeId]
  )
  const timeline: TimelineSegment[] = message.timeline ?? []
  const found = [...timeline].reverse().find((s) => s.kind === 'tool' && s.ok === undefined)
  const running = found !== undefined && found.kind === 'tool' ? found : null
  const tick = useNow(running !== null && running.startedAt !== undefined)

  if (notice !== undefined) {
    return <div className="msg-activity">🔄 {notice.text}</div>
  }
  if (running !== null) {
    const label = toolLabel(running.name)
    // 活动行只带关键参数（"正在跑命令… node -e ..."）——完整动宾短语留给工具卡展开区
    const keyArg = keyArgOf(running.name, running.argsPreview)
    const secs =
      running.startedAt === undefined
        ? null
        : Math.max(0, Math.round((tick - running.startedAt) / 1000))
    // 长步骤额外给一句"还在做"，避免用户以为死了（20 秒以上才提示，短工具不刷屏）
    const slowHint = secs !== null && secs >= 20 ? '（这步比较耗时，她还在做）' : ''
    return (
      <div className="msg-activity">
        {running.name === 'spawn_agent'
          ? '分身正在干活…'
          : `正在${label === '' ? '执行工具' : label}…`}
        {keyArg !== '' ? ` ${keyArg}` : ''}
        {secs !== null ? ` · 已 ${secs} 秒` : ''}
        {slowHint}
      </div>
    )
  }
  return (
    <div className="msg-activity">
      {timeline.some((s) => s.kind === 'text') ? '正在接着往下写…' : '正在思考…'}
    </div>
  )
}

function ToolCard({ run }: { run: ToolRunView }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const running = run.ok === undefined
  const openRightFile = useChatStore((s) => s.openRightFile)
  // 参数翻成人话（展开时才需要，但算一次成本极低，且渲染分支要用它判断有无内容）
  const summary = summarizeToolCall(run.name, run.argsPreview)
  // 运行中每秒刷新一次 → 显示"已 N 秒"
  const nowTick = useNow(running && run.startedAt !== undefined)
  return (
    <div className="msg-tool-card">
      <button
        type="button"
        className="msg-tool-toggle"
        onClick={() => setOpen(!open)}
        title={open ? '收起详情' : '展开详情'}
      >
        <span
          className="msg-tool-status"
          data-ok={running ? 'run' : String(run.ok ?? false)}
          data-status={run.status ?? (run.ok ? 'ok' : 'failed')}
        >
          {running
            ? '◌'
            : run.status === 'denied'
              ? '🚫'
              : run.status === 'timeout'
                ? '⏱'
                : run.ok
                  ? '✓'
                  : '✗'}
        </span>
        <span className="msg-tool-name">
          {running ? '正在调用' : '调用了'} {toolNameWithLabel(run.name)}
          {running && run.startedAt !== undefined
            ? ` · 已 ${Math.max(0, Math.round((nowTick - run.startedAt) / 1000))} 秒`
            : run.durationMs !== undefined
              ? ` · ${(run.durationMs / 1000).toFixed(1)}s`
              : ''}
        </span>
        <span className={`msg-tool-chevron${open ? ' open' : ''}`} aria-hidden="true">
          ›
        </span>
      </button>
      {run.file !== undefined && (
        <button
          type="button"
          className="msg-tool-file"
          title={`${run.file.action}：${run.file.rel}（点击在右侧栏预览）`}
          onClick={() => openRightFile(run.file!.rel, run.file!.name)}
        >
          <span className="msg-tool-file-icon">📄</span>
          <span className="msg-tool-file-name">{run.file.name}</span>
          <span className="msg-tool-file-action">{run.file.action}</span>
          {/* diff 徽标（同款口径）：写类工具执行中显示"生成中"，
              完成后显示增删行数（+绿 / -红，与 diff 惯例一致） */}
          {(run.name === 'write_file' || run.name === 'edit_file') &&
            (running ? (
              <span className="msg-tool-diff is-running">生成中</span>
            ) : run.diff !== undefined ? (
              <span className="msg-tool-diff">
                <em className="is-added">+{run.diff.added}</em>
                <em className="is-removed">-{run.diff.removed}</em>
              </span>
            ) : null)}
          <span className="msg-tool-file-open">↗</span>
        </button>
      )}
      {open && (
        <div className="msg-tool-detail">
          {/* 人话描述在前、原始参数在后 */}
          {summary !== '' && <div className="msg-tool-summary">{summary}</div>}
          {run.argsPreview !== '' && <div className="msg-tool-args">{run.argsPreview}</div>}
          {run.resultPreview !== undefined && (
            <div className="msg-tool-result">{run.resultPreview}</div>
          )}
        </div>
      )}
    </div>
  )
}

function MessageBubble({
  message,
  userAvatar = null,
  showProcess = true
}: {
  message: ChatMessage
  /** 用户自己的头像（设置→个人上传；null = 未设置，不渲染占位） */
  userAvatar?: string | null
  /** 是否展示过程（思考块/工具卡）。对话模式传 false——：陪聊不看工程过程 */
  showProcess?: boolean
}): React.JSX.Element {
  // 文件卡片点击 → 开右侧栏预览（store 是唯一入口，文件树/卡片/开关共用）
  const openRightFile = useChatStore((s) => s.openRightFile)
  if (message.role === 'user') {
    const atts = message.attachments ?? []
    const stickers = atts.filter((a) => a.kind === 'sticker')
    const images = atts.filter((a) => a.kind === 'image' && a.dataUrl !== undefined)
    const chips = atts.filter((a) => a.kind !== 'sticker' && a.kind !== 'image')
    // 只有图片/表情包没有文字时去掉气泡底色（贴纸直接贴在聊天区更好看）
    const bare = message.content.trim() === '' && chips.length === 0

    // 图片穿插在文字之间：
    // 正文按空行分段，图片轮流插到段与段之间（图片多于段落时尾部顺延）。
    // 输入侧没有"图在光标处"的位置信息，段间交替是最接近阅读直觉的排布。
    const paragraphs = message.content.split(/\n{2,}/).filter((p) => p.trim() !== '')
    const interleaved: ReactNode[] = []
    paragraphs.forEach((para, i) => {
      interleaved.push(
        <div key={`p-${i}`} className="msg-text">
          {para}
        </div>
      )
      const img = images[i]
      if (img !== undefined) {
        interleaved.push(<MsgImage key={`im-${img.name}-${i}`} img={img} />)
      }
    })
    // 多出来的图片（段落数不够配）全部排到末尾
    images.slice(paragraphs.length).forEach((img, k) => {
      interleaved.push(<MsgImage key={`im-extra-${img.name}-${k}`} img={img} />)
    })

    return (
      <div className="msg-row user">
        <div className={bare ? 'msg-bubble user bare' : 'msg-bubble user'}>
          {stickers.map((a) => (
            <img
              key={`st-${a.name}`}
              className="msg-sticker"
              src={stickerSrc(a.name)}
              alt={a.name}
              draggable={false}
            />
          ))}
          {interleaved}
          {chips.length > 0 && (
            <div className="msg-files">
              {chips.map((a) => (
                <span key={a.name} className="msg-file-chip" title={a.name}>
                  📎 {a.name}
                </span>
              ))}
            </div>
          )}
        </div>
        {/* 用户头像在气泡右侧（与爱弥斯的左侧头像对称； 反馈批次） */}
        {userAvatar !== null && (
          <img className="msg-avatar user-avatar" src={userAvatar} alt="" draggable={false} />
        )}
      </div>
    )
  }

  return (
    <div className="msg-row assistant">
      <img className="msg-avatar" src={avatar} alt="爱弥斯" draggable={false} />
      <div className="msg-bubble assistant">
        {message.timeline !== undefined && message.timeline.length > 0 ? (
          /* 过程时间线：思考/工具/正文按发生顺序
             穿插展示——此前所有思考挤在顶部、工具全堆下面，时序被压平。 */
          <>
            {message.timeline.map((seg, i) => {
              if (seg.kind === 'thinking') {
                if (!showProcess) return null
                return (
                  <ThinkingBlock
                    key={`th-${i}`}
                    text={seg.text}
                    streaming={message.streaming === true && i === message.timeline!.length - 1}
                  />
                )
              }
              if (seg.kind === 'tool') {
                if (!showProcess) return null
                // 与 toolRuns 合并取最新（分身进度等实时数据在 toolRuns 上），timeline 只管顺序
                const live = message.toolRuns?.find((r) => r.toolCallId === seg.toolCallId)
                const run: ToolRunView = live !== undefined ? { ...seg, ...live } : seg
                return run.name === 'spawn_agent' ? (
                  <SpawnCard key={seg.toolCallId} run={run} />
                ) : (
                  <ToolCard key={seg.toolCallId} run={run} />
                )
              }
              return (
                <Markdown
                  key={`tx-${i}`}
                  content={seg.text}
                  streaming={message.streaming === true}
                />
              )
            })}
            {message.files !== undefined && message.files.length > 0 && (
              <FileCards files={message.files} onOpen={openRightFile} />
            )}
            {message.streaming === true &&
              (message.timeline.some((s) => s.kind === 'text') ? (
                <span className="stream-cursor" aria-hidden="true" />
              ) : (
                <span className="typing-dots" aria-label="正在输入">
                  <i />
                  <i />
                  <i />
                </span>
              ))}
            {message.streaming === true && <ActivityLine message={message} />}
          </>
        ) : (
          /* 旧布局回退（更早的历史消息没有 timeline）：思考块在顶 + 工具卡在下 */
          <>
            {showProcess && (
              <ThinkingBlock text={message.thinking} streaming={message.streaming === true} />
            )}
            {showProcess &&
              (message.toolRuns ?? []).map((r) =>
                r.name === 'spawn_agent' ? (
                  <SpawnCard key={r.toolCallId} run={r} />
                ) : (
                  <ToolCard key={r.toolCallId} run={r} />
                )
              )}
            {message.content === '' && message.streaming === true ? (
              <span className="typing-dots" aria-label="正在输入">
                <i />
                <i />
                <i />
              </span>
            ) : (
              <>
                <Markdown content={message.content} streaming={message.streaming === true} />
                {message.streaming === true && (
                  <span className="stream-cursor" aria-hidden="true" />
                )}
              </>
            )}
            {message.files !== undefined && message.files.length > 0 && (
              <FileCards files={message.files} onOpen={openRightFile} />
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** 产出文件卡片（同款口径）：回复末尾列出本轮写出的文件，点击 → 右侧栏预览。
 * 后缀决定角标文字（TS/JS/MD/JSON…），与成熟实现观感一致。 */
function fileBadgeText(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toUpperCase()
  if (ext === '') return 'FILE'
  if (ext === 'JPEG') return 'JPG'
  return ext.slice(0, 4)
}

function FileCards({
  files,
  onOpen
}: {
  files: Array<{ rel: string; name: string; action: string }>
  onOpen: (rel: string, name: string) => void
}): React.JSX.Element {
  const badgeOf = (n: string): string => fileBadgeText(n)
  return (
    <div className="msg-file-cards">
      {files.map((f) => (
        <button
          key={f.rel}
          type="button"
          className="msg-file-card"
          title={`${f.action}：${f.rel}（点击在右侧栏预览）`}
          onClick={() => onOpen(f.rel, f.name)}
        >
          <span className="msg-file-badge">{badgeOf(f.name)}</span>
          <span className="msg-file-info">
            <span className="msg-file-title">{f.name}</span>
            <span className="msg-file-sub">
              {f.action} ·{' '}
              {f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '工作区根'}
            </span>
          </span>
          <span className="msg-file-open">↗</span>
        </button>
      ))}
    </div>
  )
}

/** 思考段：**默认收起为一行紧凑摘要**（参考成熟 Agent 的穿插式节奏），
 * 点击展开全文——此前是默认展开的大块，多条思考堆在一起把界面淹没。
 * 内部滚动：展开态流式时贴底跟随（像终端 tail），用户上滑解除、滑回底部恢复。
 * 窗口化渲染（卡死防护 ）：DOM 只保留尾部 3000 字——实测 4.1 万字思考逐字
 * 进 DOM 把主线程打满（点哪都没反应）。字数徽标仍显示全量。 */
const THINK_WINDOW = 3000
/** 收起态摘要长度（单行省略，足够让人知道她在想什么主题） */
const THINK_SUMMARY = 88

function ThinkingBlock({ text, streaming }: { text?: string; streaming: boolean }): ReactNode {
  const [manual, setManual] = useState<boolean | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  const body = text ?? ''
  const total = body.length
  const omitted = total > THINK_WINDOW ? total - THINK_WINDOW : 0
  const shown = omitted > 0 ? body.slice(-THINK_WINDOW) : body
  // 流式期间贴底跟随（依赖 body：每个增量到来都触发）
  useEffect(() => {
    const el = bodyRef.current
    if (el === null) return
    if (streaming && stickRef.current) el.scrollTop = el.scrollHeight
  }, [body, streaming])
  // 新一轮流式开始：重置为跟随（上一轮用户上滑过也不影响新一轮）
  useEffect(() => {
    if (streaming) stickRef.current = true
  }, [streaming])
  if (body === '') return null
  // 默认收起（紧凑一行）；用户点开过就以用户操作为准
  const open = manual ?? false
  // 收起态摘要：压平换行，取开头一段（推理通常先点题）
  const summary = body.replace(/\s+/g, ' ').trim().slice(0, THINK_SUMMARY)
  const handleScroll = (): void => {
    const el = bodyRef.current
    if (el === null) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }
  return (
    <div className={streaming ? 'thinking-block is-live' : 'thinking-block'}>
      <button
        type="button"
        className="thinking-toggle"
        onClick={() => setManual(!open)}
        aria-expanded={open}
        title={open ? '收起思考' : '展开思考全文'}
      >
        <span className={streaming ? 'thinking-pulse' : undefined}>💭 思考</span>
        {!open && <span className="thinking-summary">{summary}</span>}
        <span className="thinking-meta">
          {total >= 1000 ? `${(total / 1000).toFixed(1)}K` : total} 字 · {open ? '收起' : '展开'}
        </span>
      </button>
      {open && (
        <div className="thinking-body" ref={bodyRef} onScroll={handleScroll}>
          {omitted > 0 && <div className="thinking-omit">（前 {omitted} 字已省略）</div>}
          {shown}
        </div>
      )}
    </div>
  )
}

// 聊天图片：双击全屏放大（Lightbox 走 portal 挂 body，
// 不受气泡 overflow/transform 裁剪），单击遮罩或 ESC 关闭。
type MsgImageAttachment = { name: string; dataUrl?: string }

function MsgImage({ img }: { img: MsgImageAttachment }): React.JSX.Element {
  const [zoom, setZoom] = useState(false)
  useEffect(() => {
    if (!zoom) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setZoom(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoom])
  return (
    <>
      <img
        className="msg-image"
        src={img.dataUrl}
        alt={img.name}
        draggable={false}
        title="双击放大"
        onDoubleClick={() => setZoom(true)}
      />
      {zoom &&
        createPortal(
          <div
            className="img-lightbox"
            onClick={() => setZoom(false)}
            role="dialog"
            aria-label={`放大查看 ${img.name}`}
          >
            <img className="img-lightbox-img" src={img.dataUrl} alt={img.name} draggable={false} />
            <span className="img-lightbox-hint">{img.name} · 单击或 Esc 关闭</span>
          </div>,
          document.body
        )}
    </>
  )
}

// memo：旧消息的 props 引用不变，流式 token 只重渲染正在输出的那一条
export default memo(MessageBubble)
