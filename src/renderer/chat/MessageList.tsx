// 消息流：角色状态胶囊（在线/正在输入…）+ 消息气泡。
// 空态的星环欢迎页在 ChatPage 的欢迎态里（会话无消息时不渲染本组件）；
// 这里只处理"会话存在但没有消息"的兜底文案。
// 滚动策略：维护"贴底跟随"状态——贴近底部时新内容自动贴底；
// 用户上翻阅读即暂停跟随，右下角出现「回到底部」按钮（向下箭头），一键平滑回底。
// 旧实现的问题：每帧用"距底 <120px"判断，工具卡/长 Markdown 一帧撑开超阈值就脱钩跟丢。

import { useEffect, useRef, useState } from 'react'
import avatar from '../assets/aemeath-avatar.png'
import { useChatStore, selectStreamingActive } from './store'
import MessageBubble from './MessageBubble'

const NO_MESSAGES: never[] = []

/** 角色状态胶囊：渲染在窗口标题层（ChatPage），不再悬浮在消息区上方遮首行 */
export function StatusPill(): React.JSX.Element {
  const streaming = useChatStore(selectStreamingActive)
  return (
    <div className="status-pill">
      {/* 状态条头像与消息气泡同源（此前误用桌宠立绘 pet/assets/aemeath.png，
          960×917 的整幅立绘挤进 22px 圆形 → 糊成一团） */}
      <img className="status-pill-avatar" src={avatar} alt="" draggable={false} />
      <span className="status-pill-name">爱弥斯</span>
      <span className="status-pill-divider">·</span>
      <span className={streaming ? 'status-pill-status is-typing' : 'status-pill-status'}>
        {streaming ? '正在输入…' : '在线'}
      </span>
    </div>
  )
}

/** 距底部多少像素内视为"贴底" */
const PIN_THRESHOLD = 80

function MessageList(): React.JSX.Element {
  const messages = useChatStore((s) =>
    s.activeId === null ? NO_MESSAGES : (s.messagesBySession[s.activeId] ?? NO_MESSAGES)
  )
  // 当前会话的模式（选择器返回原始值，无新建引用问题）。
  // 对话模式隐藏思考块/工具卡——陪聊场景只看回复本身。
  const chatMode = useChatStore((s) => s.chatMode)
  const listRef = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  // 用户自己的头像（每条用户消息右侧展示，与爱弥斯的左侧头像对称； 反馈）。
  // 拉取与刷新模式照抄 SessionSidebar：getConfig + SETTINGS_CHANGED 广播。
  const [userAvatar, setUserAvatar] = useState<string | null>(null)
  useEffect(() => {
    const load = (): void => {
      void window.petAPI.getConfig().then((config) => setUserAvatar(config.user.avatar))
    }
    load()
    return window.petAPI.onSettingsChanged(load)
  }, [])

  // 用户滚动：只在贴近底部时保持跟随状态；上翻即解除（显示回底按钮）
  const handleScroll = (): void => {
    const el = listRef.current
    if (el === null) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD
    setPinned(nearBottom)
  }

  // 新消息 / 流式增量 / 贴底状态变化：贴底时强制跟到底（instant——逐 token 平滑会拖影）
  useEffect(() => {
    const el = listRef.current
    if (el === null || !pinned) return
    el.scrollTop = el.scrollHeight
  }, [messages, pinned])

  // 会话切换：无条件回底（新会话从最新处开始看）。
  // 依赖用"首条消息 id"作会话标识——数组字面量表达式会让 exhaustive-deps 无法静态检查。
  const firstMessageId = messages.length > 0 ? messages[0].id : ''
  useEffect(() => {
    const el = listRef.current
    if (el === null) return
    el.scrollTop = el.scrollHeight
    setPinned(true)
  }, [firstMessageId])

  const scrollToBottom = (): void => {
    const el = listRef.current
    if (el === null) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setPinned(true)
  }

  return (
    <div className="chat-messages-shell">
      <div className="chat-messages" ref={listRef} onScroll={handleScroll}>
        {messages.length === 0 ? (
          <div className="chat-empty">这段对话还没有内容，说点什么吧</div>
        ) : (
          messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              userAvatar={userAvatar}
              showProcess={chatMode !== 'chat'}
            />
          ))
        )}
      </div>
      {!pinned ? (
        <button
          type="button"
          className="scroll-bottom-btn"
          title="回到底部"
          onClick={scrollToBottom}
        >
          ↓
        </button>
      ) : null}
    </div>
  )
}

export default MessageList
