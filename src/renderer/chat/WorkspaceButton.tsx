// 工作区绑定入口。形态对齐 PermissionButton：
// 按钮显示当前模式的绑定状态（📁 + 目录名/未绑定 + ▾），点开向上弹出操作面板：
// 选择目录（原生对话框）/ 清空绑定。改绑定即生效（拍板 §11.3）。
// chat 模式无工具、工作区不生效——整个入口不显示。

import { useEffect, useRef, useState } from 'react'
import { modeLabel } from '@shared/workspace'
import { useChatStore } from './store'

type Workspace = { work: string | null; learn: string | null }

/** 取路径末段做按钮短名（C:\a\b\proj → proj）；无分隔符兜底返回全路径 */
function shortName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

function WorkspaceButton(): React.JSX.Element | null {
  const chatMode = useChatStore((s) => s.chatMode)
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const refresh = (): void => {
      void window.petAPI.getConfig().then((config) => {
        setWorkspace(config.workspace ?? { work: null, learn: null })
      })
    }
    refresh()
    const off = window.petAPI.onSettingsChanged(refresh)
    return off
  }, [])

  // 点击气泡外关闭（捕获阶段，避免点选项时先触发外击）
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [open])

  // 对话模式不带工具，工作区无意义：入口整个不显示
  if (chatMode === 'chat') return null

  const key = chatMode === 'learn' ? 'learn' : 'work'
  const bound = workspace !== null ? workspace[key] : null

  const apply = async (value: string | null): Promise<void> => {
    setOpen(false)
    await window.petAPI.settingsSet({
      workspace: key === 'work' ? { work: value } : { learn: value }
    })
  }

  const pick = async (): Promise<void> => {
    const dir = await window.petAPI.pickDirectory()
    if (dir !== null) await apply(dir)
  }

  // 模式中文名统一走 shared（与主进程错误文案同源）；对话模式已在上面提前返回
  const modeName = modeLabel(chatMode)

  return (
    <span className="perm-switch" ref={rootRef}>
      <button
        type="button"
        className="perm-switch-btn"
        title={`工作区绑定：${modeName}模式下文件工具的相对路径在此目录内解析`}
        onClick={() => setOpen(!open)}
      >
        <span className="perm-switch-icon">📁</span>
        <span className="perm-switch-label">{bound !== null ? shortName(bound) : '未绑定'}</span>
        <span className="perm-switch-caret">{open ? '▴' : '▾'}</span>
      </button>

      {open ? (
        <div className="perm-pop" role="menu">
          <div className="perm-pop-title">
            {modeName}模式工作区{bound !== null ? '' : '（未绑定）'}
          </div>
          {bound !== null && (
            <p className="perm-pop-note" style={{ wordBreak: 'break-all' }}>
              {bound}
            </p>
          )}
          <button type="button" className="perm-pop-row" onClick={() => void pick()}>
            <span className="perm-pop-icon">📂</span>
            <span className="perm-pop-text">
              <span className="perm-pop-label">选择目录…</span>
              <span className="perm-pop-desc">绑定后「写到当前目录」就落在这里</span>
            </span>
          </button>
          <button
            type="button"
            className="perm-pop-row"
            disabled={bound === null}
            style={bound === null ? { opacity: 0.45, cursor: 'default' } : undefined}
            onClick={() => {
              if (bound !== null) void apply(null)
            }}
          >
            <span className="perm-pop-icon">🧹</span>
            <span className="perm-pop-text">
              <span className="perm-pop-label">清空绑定</span>
              <span className="perm-pop-desc">
                清空后{modeName}模式不能开始会话（要再选一个目录才能继续）
              </span>
            </span>
          </button>
          <div className="perm-pop-foot">
            {modeName}模式必须先绑定工作目录才能开始会话。绑定后它即成为「标准」权限模式下的
            免询问边界：目录内改动直接执行（写前仍自动快照、可撤销），改到目录外才弹卡。
          </div>
        </div>
      ) : null}
    </span>
  )
}

export default WorkspaceButton
