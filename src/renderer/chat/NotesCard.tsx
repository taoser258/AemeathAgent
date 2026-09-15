// 学习笔记卡：学习模式下显示在消息区顶部（与 TodoCard 同位）。
// 展示当前会话的笔记/闪卡计数；导出按钮走另存对话框生成 Markdown。
// 刷新时机：切换会话 / 流式结束（模型 note_write 落盘后）。

import { useCallback, useEffect, useState } from 'react'
import { useChatStore, selectStreamingActive } from './store'

interface NoteItem {
  ts: number
  kind: 'note' | 'card'
  title: string
  content: string
}

function NotesCard(): React.JSX.Element | null {
  const activeId = useChatStore((s) => s.activeId)
  const chatMode = useChatStore((s) => s.chatMode)
  const streaming = useChatStore(selectStreamingActive)
  const [items, setItems] = useState<NoteItem[]>([])
  const [tip, setTip] = useState('')

  const refresh = useCallback((sessionId: string) => {
    void window.petAPI.notesGet(sessionId).then((state) => {
      setItems(state?.items ?? [])
    })
  }, [])

  useEffect(() => {
    if (activeId === null || chatMode !== 'learn') return
    refresh(activeId)
  }, [activeId, chatMode, refresh])

  // 流式结束后重取（模型刚写完笔记）
  useEffect(() => {
    if (!streaming && activeId !== null && chatMode === 'learn') {
      refresh(activeId)
    }
  }, [streaming, activeId, chatMode, refresh])

  if (chatMode !== 'learn' || activeId === null) return null

  const notes = items.filter((i) => i.kind === 'note').length
  const cards = items.filter((i) => i.kind === 'card').length

  const handleExport = (): void => {
    void window.petAPI.notesExport(activeId).then((res) => {
      if (res.ok && res.path !== undefined) {
        setTip(`已导出：${res.path}`)
      } else if (res.canceled === true) {
        setTip('')
      } else {
        setTip(res.error ?? '导出失败')
      }
      setTimeout(() => setTip(''), 3500)
    })
  }

  return (
    <div className="notes-card" role="status" aria-label="学习笔记">
      <div className="todo-card-head">
        <span className="todo-card-icon">📒</span>
        <span className="todo-card-title">学习笔记</span>
        <span className="todo-card-count">
          {notes} 笔记 · {cards} 闪卡
        </span>
        <button
          type="button"
          className="notes-export-btn"
          onClick={() => void handleExport()}
          disabled={items.length === 0}
          title="导出为 Markdown 文件（可直接复习用）"
        >
          导出 Markdown
        </button>
      </div>
      {tip !== '' && <div className="notes-tip">{tip}</div>}
    </div>
  )
}

export default NotesCard
