// 会话侧栏（成熟版式）：图标导航（新建对话）+ 对话分组列表 + 底部身份行。
// 工具/技能入口已挪到顶栏胶囊；
// 面板开着时点会话仍自动收起回聊天（activePanel/onTogglePanel 供此联动）。
// 右键会话：重命名 / 隐藏会话 / 删除会话（隐藏的在 设置 → 会话 恢复）。
// 宽度由 ChatPage 注入（拖 .sidebar-resizer 调整，localStorage 记忆）。

import { useEffect, useState } from 'react'
import type { AppConfig, UpdateStatus } from '@shared/types'
import { updateBadge } from '@shared/update-badge'
import { groupSessionsByDate, useChatStore } from './store'

export type SidePanel = 'tools' | 'skills'

/** 会话右键菜单状态：屏幕坐标 + 目标会话 */
interface SessionMenu {
  id: string
  title: string
  x: number
  y: number
}

function SessionSidebar({
  width,
  activePanel,
  onTogglePanel
}: {
  width: number
  activePanel: SidePanel | null
  onTogglePanel: (panel: SidePanel) => void
}): React.JSX.Element {
  const sessions = useChatStore((s) => s.sessions)
  const activeId = useChatStore((s) => s.activeId)
  const chatMode = useChatStore((s) => s.chatMode)
  // 在途 run 的会话 id 列表（多会话并行：A 会话跑着不影响 B 会话发送）。
  // 按列表整存订阅即可——它只在 run 起止时换引用，不随流式 token 变化。
  const runningIds = useChatStore((s) => s.runningIds)
  const createSession = useChatStore((s) => s.createSession)
  const selectSession = useChatStore((s) => s.selectSession)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const renameSession = useChatStore((s) => s.renameSession)
  const hideSession = useChatStore((s) => s.hideSession)
  const togglePin = useChatStore((s) => s.togglePin)

  // 底部身份行 = **用户自己**的头像与称呼（反馈批次④）：此前写死显示"爱弥斯 / Aemeath"。
  // 未设置时有默认口径；设置页改完经 SETTINGS_CHANGED 广播即时刷新，无需重启。
  const [user, setUser] = useState<AppConfig['user']>({ nickname: '', avatar: null, about: '' })
  useEffect(() => {
    const load = (): void => {
      void window.petAPI.getConfig().then((config) => setUser(config.user))
    }
    load()
    return window.petAPI.onSettingsChanged(load)
  }, [])
  // 默认称呼"漂泊者"与人设口径一致（soul.md 里用户即漂泊者）；用户填了自己的称呼就以其为准
  const displayName = user.nickname !== '' ? user.nickname : '漂泊者'

  // 更新角标（轻提示）：新版本由主进程启动后自动查一次并广播；这里只负责显示。
  // 挂载时先只读对账一次（不触发网络检查——否则每开一次主窗都白查一次），
  // 之后靠 UPDATE_STATUS 广播（关于页手动检查、下载进度、下载完成都会推过来）。
  const [update, setUpdate] = useState<UpdateStatus>({ state: 'idle' })
  useEffect(() => {
    void window.petAPI.updateStatusGet().then(setUpdate)
    return window.petAPI.onUpdateStatus(setUpdate)
  }, [])
  const badge = updateBadge(update)

  // 内联重命名：双击/右键菜单进入编辑态；Enter/失焦提交，Esc 取消
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // 右键菜单
  const [menu, setMenu] = useState<SessionMenu | null>(null)

  const startRename = (id: string, title: string): void => {
    setEditingId(id)
    setDraft(title)
  }

  const commitRename = (): void => {
    if (editingId !== null) renameSession(editingId, draft)
    setEditingId(null)
  }

  // 已隐藏的会话不进侧栏（在 设置 → 会话 管理）；侧栏按当前模式过滤（同款：各模式独立会话列表）
  const visible = sessions.filter((s) => s.hidden !== true && (s.mode ?? 'work') === chatMode)
  const groups = groupSessionsByDate(visible)
  const modeLabel = chatMode === 'chat' ? '对话' : chatMode === 'learn' ? '学习' : '工作'

  // 点任意处关闭右键菜单
  useEffect(() => {
    if (menu === null) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

  return (
    <aside className="chat-sidebar" style={{ width }}>
      <div className="side-nav">
        <button type="button" className="side-nav-item" onClick={createSession}>
          <span className="side-nav-icon">＋</span>
          新建对话
        </button>
        {/* 工具/技能入口已挪到顶栏胶囊 */}
      </div>
      <div className="side-section-title">{modeLabel}会话</div>
      <div className="chat-session-list">
        {visible.length === 0 && <div className="chat-session-empty">还没有对话</div>}
        {groups.map((group) => (
          <div key={group.label}>
            <div className="chat-group-title">{group.label}</div>
            {group.sessions.map((session) => (
              <div
                key={session.id}
                className={session.id === activeId ? 'chat-session active' : 'chat-session'}
                onClick={() => {
                  selectSession(session.id)
                  // 选会话自动回到聊天（同款：面板开着时点会话即收起面板）
                  if (activePanel !== null) onTogglePanel(activePanel)
                }}
                onDoubleClick={() => startRename(session.id, session.title)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setMenu({
                    id: session.id,
                    title: session.title,
                    x: event.clientX,
                    y: event.clientY
                  })
                }}
              >
                {editingId === session.id ? (
                  <input
                    className="chat-rename-input"
                    value={draft}
                    autoFocus
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitRename()
                      if (event.key === 'Escape') setEditingId(null)
                    }}
                    onBlur={commitRename}
                  />
                ) : (
                  <>
                    {/* 该会话正在生成：名字前挂一个转圈的加载环，切到别的会话也看得见它还在跑 */}
                    {runningIds.includes(session.id) && (
                      <span className="chat-session-spinner" aria-hidden="true" />
                    )}
                    <span className="chat-session-title" title="双击或右键重命名">
                      {session.pinned === true ? '📌 ' : ''}
                      {session.title}
                    </span>
                    {/* 模式区分改用侧栏按模式过滤（同款）；删除走右键菜单（悬停 × 易误删，移除） */}
                  </>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="chat-sidebar-foot" title="到 设置 → 个人 可以改这里的头像与称呼">
        {user.avatar !== null ? (
          <img className="chat-foot-avatar" src={user.avatar} alt="" draggable={false} />
        ) : (
          // 未设头像：首字圆形占位（比塞一张别人的图更诚实）
          <span className="chat-foot-avatar chat-foot-avatar-fallback" aria-hidden="true">
            {displayName.slice(0, 1)}
          </span>
        )}
        <span className="chat-user-name">{displayName}</span>
        <span className="chat-user-spacer" />
        <button
          type="button"
          className="chat-gear"
          title={badge.hint ?? '设置（独立窗口）'}
          onClick={() => window.petAPI.openSettings()}
        >
          ⚙{/* 角标只提示不代劳：点 ⚙ 进设置 → 关于 才有下载/安装按钮 */}
          {badge.show && (
            <span
              className={badge.ready ? 'chat-gear-dot is-ready' : 'chat-gear-dot'}
              aria-hidden="true"
            />
          )}
        </button>
      </div>
      {menu !== null ? (
        <>
          {/* 透明遮罩：点 elsewhere 关菜单 */}
          <div className="session-menu-backdrop" />
          <div
            className="session-menu"
            style={{ left: menu.x, top: menu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                togglePin(menu.id) // id 不在册时 togglePin 自然 no-op
                setMenu(null)
              }}
            >
              {sessions.find((s) => s.id === menu.id)?.pinned === true ? '取消置顶' : '📌 置顶'}
            </button>
            <button
              type="button"
              onClick={() => {
                startRename(menu.id, menu.title)
                setMenu(null)
              }}
            >
              重命名
            </button>
            <button
              type="button"
              onClick={() => {
                hideSession(menu.id)
                setMenu(null)
              }}
            >
              隐藏会话
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                deleteSession(menu.id)
                setMenu(null)
              }}
            >
              删除会话
            </button>
          </div>
        </>
      ) : null}
    </aside>
  )
}

export default SessionSidebar
