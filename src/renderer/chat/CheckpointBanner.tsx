// 续跑横幅：会话存在未完成任务存档时，在消息区与输入框之间提示。
// 「继续任务」以提示语走完整发送管线（主进程从会话历史重建进度续跑）；「放弃」销档。

import { useChatStore, selectStreamingActive } from './store'

function CheckpointBanner(): React.JSX.Element | null {
  const activeId = useChatStore((s) => s.activeId)
  const marker = useChatStore((s) =>
    s.activeId === null ? undefined : s.checkpointBySession[s.activeId]
  )
  const resumeTask = useChatStore((s) => s.resumeTask)
  const streaming = useChatStore(selectStreamingActive)

  if (activeId === null || marker === undefined || streaming) return null

  const time = new Date(marker.updatedAt)
  const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`

  return (
    <div className="checkpoint-banner" role="status">
      <span className="checkpoint-icon">💾</span>
      <div className="checkpoint-text">
        <span className="checkpoint-title">有未完成的任务</span>
        <span className="checkpoint-sub">
          已执行 {marker.steps} 步 · {hhmm} 记录 —— 可以从断点接着跑
        </span>
      </div>
      <div className="checkpoint-actions">
        <button type="button" className="checkpoint-btn primary" onClick={() => resumeTask()}>
          ▶ 继续任务
        </button>
        <button
          type="button"
          className="checkpoint-btn"
          onClick={() => {
            void window.petAPI.checkpointDiscard(activeId)
            useChatStore.setState((state) => {
              const next = { ...state.checkpointBySession }
              delete next[activeId]
              return { checkpointBySession: next }
            })
          }}
        >
          放弃
        </button>
      </div>
    </div>
  )
}

export default CheckpointBanner
