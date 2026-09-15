// 复习卡：学习模式下钉在消息区顶部，
// 显示"今日待复习 N 张"，点开逐张自测——先想答案，再点"看答案"，然后三档评分。
//
// 为什么这样设计：闪卡此前只能自己翻（等于没有复习机制）。这里把"想到没想起来"
// 变成一次点击：again（再来）→ 10 分钟后再出现；good（记得）→ 按 1/3/7/16/35 天推后；
// easy（太简单）→ 跳两档。评分落盘进 review-store，掌握度回流到进度卡。
//
// 刷新时机：切会话 / 流式结束（模型刚写完新卡）/ 评分后本地更新汇总。

import { useCallback, useEffect, useState } from 'react'
import Markdown from './Markdown'
import { useChatStore, selectStreamingActive } from './store'

interface DueCard {
  id: string
  title: string
  content: string
  topic: string | null
  isNew: boolean
  level: number
  lapses: number
}

interface Summary {
  due: number
  total: number
  started: number
  mature: number
  mastery: number
}

const EMPTY_SUMMARY: Summary = { due: 0, total: 0, started: 0, mature: 0, mastery: 0 }

function ReviewCard(): React.JSX.Element | null {
  const activeId = useChatStore((s) => s.activeId)
  const chatMode = useChatStore((s) => s.chatMode)
  const streaming = useChatStore(selectStreamingActive)
  const bumpLearnTick = useChatStore((s) => s.bumpLearnTick)
  const [cards, setCards] = useState<DueCard[]>([])
  const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY)
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState(false) // 当前卡是否已翻面
  const [busy, setBusy] = useState(false)

  const refresh = useCallback((sessionId: string) => {
    void window.petAPI
      .reviewDue(sessionId)
      .then((res) => {
        if (res === null) return
        setCards(res.cards)
        setSummary(res.summary)
        setShown(false)
      })
      .catch(() => {
        /* 读失败保持上次状态；不抛未处理 rejection */
      })
  }, [])

  useEffect(() => {
    if (activeId === null || chatMode !== 'learn') return
    refresh(activeId)
  }, [activeId, chatMode, refresh])

  useEffect(() => {
    if (!streaming && activeId !== null && chatMode === 'learn') {
      refresh(activeId)
    }
  }, [streaming, activeId, chatMode, refresh])

  if (chatMode !== 'learn' || activeId === null) return null

  const current = cards[0]

  const grade = (g: 'again' | 'good' | 'easy'): void => {
    if (current === undefined || busy) return
    setBusy(true)
    // ★ then 与 catch 都必须复位 busy：ipcRenderer.invoke 的 Promise 在 handler 抛错时
    // reject，只在 then 里复位会让三个评分按钮永久禁用。
    const settle = (): void => setBusy(false)
    void window.petAPI
      .reviewGrade(activeId, current.id, g)
      .then((res) => {
        settle()
        if (!res.ok) {
          // 卡片可能已被清理：刷新一次让列表对齐
          refresh(activeId)
          return
        }
        if (res.summary !== undefined) setSummary(res.summary)
        // 本地先移出当前卡（不等重取，手感更顺）；again 的卡稍后由刷新拉回
        setCards((prev) => prev.slice(1))
        setShown(false)
        // 进度卡读的是另一路 IPC（progressGet 含 review 汇总），评分后不会自发刷新——
        // bump learnTick 让它和复习卡一起对齐
        bumpLearnTick()
      })
      .catch(() => {
        settle()
        refresh(activeId)
      })
  }

  const levelText = (c: DueCard): string => {
    if (c.isNew) return '新卡'
    if (c.lapses > 0 && c.level === 0) return '错题重练'
    return `第 ${c.level + 1} 档`
  }

  return (
    <div className="notes-card review-card" role="status" aria-label="复习队列">
      <div className="todo-card-head">
        <span className="todo-card-icon">🔁</span>
        <span className="todo-card-title">今日复习</span>
        <span className="todo-card-count">
          {summary.due > 0 ? `待复习 ${summary.due} 张` : '暂无到期'}
          {summary.total > 0 && ` · 共 ${summary.total} 张`}
          {summary.started > 0 && ` · 掌握度 ${summary.mastery}%`}
        </span>
        {summary.due > 0 && (
          <button
            type="button"
            className="notes-export-btn"
            onClick={() => {
              setOpen((v) => !v)
              setShown(false)
            }}
          >
            {open ? '收起' : '开始复习'}
          </button>
        )}
      </div>

      {open && current !== undefined && (
        <div className="review-body">
          <div className="review-meta">
            <span className="review-badge">{levelText(current)}</span>
            {current.topic !== null && <span className="review-topic">{current.topic}</span>}
            <span className="review-progress">还剩 {cards.length} 张</span>
          </div>
          {/* 题干与答案走同一套 Markdown+KaTeX 渲染（此前直出纯文本，
              闪卡里的 $...$ 公式全是乱码）；容器带 chat-md 以命中公式/表格样式 */}
          <div className="review-question chat-md">
            <Markdown content={current.title} />
          </div>
          {shown ? (
            <div className="review-answer chat-md">
              <Markdown content={current.content} />
            </div>
          ) : (
            <button type="button" className="review-reveal" onClick={() => setShown(true)}>
              想好了，看答案
            </button>
          )}
          {shown && (
            <div className="review-grades">
              <button
                type="button"
                className="review-grade again"
                disabled={busy}
                onClick={() => grade('again')}
                title="没想起来（10 分钟后再练）"
              >
                没想起来
              </button>
              <button
                type="button"
                className="review-grade good"
                disabled={busy}
                onClick={() => grade('good')}
                title="想起来了（按 1/3/7/16/35 天推后）"
              >
                想起来了
              </button>
              <button
                type="button"
                className="review-grade easy"
                disabled={busy}
                onClick={() => grade('easy')}
                title="太简单了（跳两档）"
              >
                太简单
              </button>
            </div>
          )}
        </div>
      )}

      {open && current === undefined && (
        <div className="review-empty">今天的卡都练完了，明天再来 🎉</div>
      )}
    </div>
  )
}

export default ReviewCard
