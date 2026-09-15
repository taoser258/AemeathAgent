// 学习进度卡：学习模式下的"这门课学到哪了"。
//
// 三块信息：
// ① 学习计划——目标 + 剩余天数（用户有节奏感；没设时提示可以说"我要X之前学完Y"）；
// ② 知识点掌握度——横条 0-100，实测（复习评分回流）优先、否则自评（带角标区分来源）；
// ③ 闪卡复习概况——今日待复习 / 已练 / 已掌握。
//
// 与笔记卡、复习卡同位（消息区顶部），数据来自 progress:get。刷新时机：切会话 /
// 流式结束（模型刚写完进度）/ 复习评分后（复习卡那边评分完会推 SETTINGS 不动，
// 这里靠流式结束与切会话重取；用户操作后想立刻看到可切走再切回，够用）。

import { useCallback, useEffect, useState } from 'react'
import { useChatStore, selectStreamingActive } from './store'

interface TopicRow {
  topic: string
  score: number
  measured: boolean
  cards: number
}

interface ProgressView {
  goal: string
  deadline: number
  daysLeft: number | null
  topics: TopicRow[]
  review: { due: number; total: number; started: number; mature: number; mastery: number }
  noteCount: number
}

function ProgressCard(): React.JSX.Element | null {
  const activeId = useChatStore((s) => s.activeId)
  const chatMode = useChatStore((s) => s.chatMode)
  const streaming = useChatStore(selectStreamingActive)
  // 复习评分后与复习卡一起刷新
  const learnTick = useChatStore((s) => s.learnTick)
  const [view, setView] = useState<ProgressView | null>(null)
  const [open, setOpen] = useState(false)

  const refresh = useCallback((sessionId: string) => {
    void window.petAPI
      .progressGet(sessionId)
      .then((res) => {
        if (res === null) return
        setView({
          goal: res.plan.goal,
          deadline: res.plan.deadline,
          daysLeft: res.daysLeft,
          topics: res.topics,
          review: res.review,
          noteCount: res.noteCount
        })
      })
      .catch(() => {
        /* 读失败保持上次状态；不抛未处理 rejection */
      })
  }, [])

  useEffect(() => {
    if (activeId === null || chatMode !== 'learn') return
    refresh(activeId)
  }, [activeId, chatMode, refresh, learnTick])

  useEffect(() => {
    if (!streaming && activeId !== null && chatMode === 'learn') {
      refresh(activeId)
    }
  }, [streaming, activeId, chatMode, refresh])

  if (chatMode !== 'learn' || activeId === null || view === null) return null
  // 完全空白时不占位（没目标、没知识点、没卡）
  if (view.goal === '' && view.topics.length === 0 && view.review.total === 0) return null

  const overall =
    view.topics.length === 0
      ? null
      : Math.round(view.topics.reduce((s, t) => s + t.score, 0) / view.topics.length)

  return (
    <div className="notes-card progress-card" role="status" aria-label="学习进度">
      <div className="todo-card-head">
        <span className="todo-card-icon">🎯</span>
        <span className="todo-card-title">学习进度</span>
        <span className="todo-card-count">
          {view.goal !== '' ? view.goal : '未设学习目标'}
          {view.daysLeft !== null && ` · 还剩 ${view.daysLeft} 天`}
        </span>
        <button type="button" className="notes-export-btn" onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '查看详情'}
        </button>
      </div>

      {open && (
        <div className="progress-body">
          {overall !== null && (
            <div className="progress-overall">
              <span className="progress-overall-label">总体掌握度</span>
              <div className="progress-bar">
                <div className="progress-bar-fill" style={{ width: `${overall}%` }} />
              </div>
              <span className="progress-overall-score">{overall}%</span>
            </div>
          )}

          {view.topics.length > 0 && (
            <div className="progress-topics">
              {view.topics.map((t) => (
                <div className="progress-topic" key={t.topic}>
                  <span className="progress-topic-name">
                    {t.topic}
                    {t.cards > 0 && <span className="progress-topic-cards">{t.cards} 卡</span>}
                  </span>
                  <div className="progress-bar">
                    <div className="progress-bar-fill" style={{ width: `${t.score}%` }} />
                  </div>
                  <span className="progress-topic-score">
                    {t.score}%
                    <span className={t.measured ? 'progress-src measured' : 'progress-src'}>
                      {t.measured ? '实测' : '自评'}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="progress-review-line">
            闪卡 {view.review.total} 张 · 今日待复习 {view.review.due} 张 · 已练{' '}
            {view.review.started} 张 · 已掌握 {view.review.mature} 张 · 笔记 {view.noteCount} 条
          </div>

          {view.topics.length === 0 && (
            <div className="progress-hint">
              还没有知识点记录。跟爱弥斯说「我打算 X 之前学完 Y」可以设目标；
              讲解完一个章节她会自动记掌握度。
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default ProgressCard
