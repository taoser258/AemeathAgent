// 任务清单侧轨：
// 从右侧栏「任务」页签搬出来，独立钉在会话右侧——它和聊天区是 **flex 兄弟节点**（不是浮层），
// 所以聊天区会自然让位，永远不会盖住爱弥斯的回答；宽度 clamp(190px,15vw,280px) 随主窗缩放。
// 没有任务清单时整条不渲染（不占地方）；收起态是一条 42px 窄条（仍显示 完成数/总数）。
// 数据源：store.todosBySession（todo_updated 事件实时推送 + 切会话恢复），勾选走 toggleTodo（乐观更新）。

import { useState } from 'react'
import { useChatStore } from './store'

/** 收起态记忆（跨会话保留：用户收起了就一直是收起的） */
const COLLAPSE_KEY = 'aemeath.taskRail.collapsed'

function TaskRail({ last }: { last: boolean }): React.JSX.Element | null {
  const items = useChatStore((s) =>
    s.activeId === null ? undefined : s.todosBySession[s.activeId]
  )
  const toggleTodo = useChatStore((s) => s.toggleTodo)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === '1')

  if (items === undefined || items.length === 0) return null
  const done = items.filter((it) => it.status === 'done').length
  const ratio = `${done}/${items.length}`

  const setCollapse = (next: boolean): void => {
    setCollapsed(next)
    localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0')
  }

  if (collapsed) {
    return (
      <aside className={last ? 'task-rail is-collapsed is-last' : 'task-rail is-collapsed'}>
        <button
          type="button"
          className="task-rail-stub"
          title="展开任务清单"
          onClick={() => setCollapse(false)}
        >
          <span className="task-rail-chevron">‹</span>
          <span className="task-rail-stub-text">任务 {ratio}</span>
        </button>
      </aside>
    )
  }

  return (
    <aside className={last ? 'task-rail is-last' : 'task-rail'}>
      <div className="task-rail-head">
        <span className="task-rail-title">任务 {ratio}</span>
        <button
          type="button"
          className="task-rail-collapse"
          title="收起（不占地方，点窄条再展开）"
          onClick={() => setCollapse(true)}
        >
          ›
        </button>
      </div>
      <div className="task-rail-body">
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            className={it.status === 'done' ? 'ws-task done' : 'ws-task'}
            onClick={() => toggleTodo(it.id)}
            title={it.status === 'done' ? '点一下改回待办' : '点一下标记完成'}
          >
            <span className="ws-task-check">{it.status === 'done' ? '✓' : ''}</span>
            <span className="ws-task-text">{it.text}</span>
          </button>
        ))}
      </div>
    </aside>
  )
}

export default TaskRail
