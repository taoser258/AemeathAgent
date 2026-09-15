// 权限模式下拉。
// 按钮显示当前模式（图标+名称+▾），点开向上弹出三行单选；切到「完全访问」需二次确认
// （对齐 成熟实现的"确认开启完全放开"）。语义：权限只管"变更"，读取类工具永远直接执行。

import { useEffect, useRef, useState } from 'react'
import type { AppConfig } from '@shared/types'
import { useChatStore } from './store'

type PermissionMode = AppConfig['tools']['permissionMode']

const MODES: Array<{
  value: PermissionMode
  icon: string
  label: string
  desc: string
}> = [
  {
    value: 'confirm',
    icon: '🔔',
    label: '标准',
    desc: '读取直接执行；工作区内的改动也直接执行（有快照可撤销）；只有改到工作区外才问你'
  },
  {
    value: 'plan',
    icon: '📋',
    label: '计划模式',
    desc: '先给出变更计划，你确认后本轮放开执行'
  },
  {
    value: 'full',
    icon: '⚡',
    label: '完全访问',
    desc: '变更操作也不询问，直接执行（含工作区外）'
  }
]

function modeMeta(mode: PermissionMode): { icon: string; label: string } {
  const found = MODES.find((m) => m.value === mode)
  return { icon: found?.icon ?? '🔔', label: found?.label ?? '标准' }
}

/**
 * 切到「完全访问」时，把已经挂起在等的审批卡一并放行。
 *
 * 为什么需要：审批卡是**挂起等待**的——主进程那轮循环停在那里等你点。用户看到卡后
 * 切「完全访问」（已经在弹层里勾过风险确认），但这张卡不会自己消失，观感就是
 * "我明明开了完全访问，它还在问我"。这里等同替用户点一次「允许这次」：卡消失、
 * 被挂起的那轮立刻继续；主进程侧的档位切换由 settings-ipc 即时同步。
 */
function releasePendingApprovals(): void {
  const st = useChatStore.getState()
  for (const req of Object.values(st.approvalBySession)) {
    void st.respondApproval(req.approvalId, 'allow')
  }
}

function PermissionButton(): React.JSX.Element {
  const [mode, setMode] = useState<PermissionMode | null>(null)
  const [open, setOpen] = useState(false)
  const [confirmingFull, setConfirmingFull] = useState(false)
  const [riskChecked, setRiskChecked] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    void window.petAPI.getConfig().then((config) => setMode(config.tools.permissionMode))
    // 设置页若还在别处改了配置（未来入口），广播同步
    const off = window.petAPI.onSettingsChanged(() => {
      void window.petAPI.getConfig().then((config) => setMode(config.tools.permissionMode))
    })
    return off
  }, [])

  // 点击气泡外关闭（捕获阶段，避免点选项时先触发外击）
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
        setConfirmingFull(false)
        setRiskChecked(false)
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [open])

  const applyMode = async (next: PermissionMode): Promise<void> => {
    setMode(next)
    setOpen(false)
    setConfirmingFull(false)
    setRiskChecked(false)
    await window.petAPI.settingsSet({ tools: { permissionMode: next } })
    if (next === 'full') releasePendingApprovals()
  }

  const pick = (value: PermissionMode): void => {
    if (value === mode) {
      setOpen(false)
      setConfirmingFull(false)
      return
    }
    if (value === 'full') {
      setConfirmingFull(true) // 二次确认（对齐 成熟实现「确认开启完全放开」）
      return
    }
    void applyMode(value)
  }

  const meta = mode !== null ? modeMeta(mode) : { icon: '🔔', label: '…' }

  return (
    <span className="perm-switch" ref={rootRef}>
      <button
        type="button"
        className={mode === 'full' ? 'perm-switch-btn is-full' : 'perm-switch-btn'}
        title="权限模式：控制 AI 做变更前是否先征得你的同意（读取类不受限）"
        onClick={() => {
          setOpen(!open)
          setConfirmingFull(false)
          setRiskChecked(false)
        }}
      >
        <span className="perm-switch-icon">{meta.icon}</span>
        <span className="perm-switch-label">{meta.label}</span>
        <span className="perm-switch-caret">{open ? '▴' : '▾'}</span>
      </button>

      {open ? (
        <div className="perm-pop" role="menu">
          {confirmingFull ? (
            <>
              <div className="perm-pop-title">确认开启完全访问？</div>
              <p className="perm-pop-note">
                开启后 AI 做改动文件等变更操作将不再逐次询问。 仅建议在你信任当前任务时使用。
              </p>
              <label className="perm-pop-confirm">
                <input
                  type="checkbox"
                  id="perm-full-risk"
                  checked={riskChecked}
                  onChange={(e) => setRiskChecked(e.target.checked)}
                />
                我已了解风险，并愿意继续
              </label>
              <div className="perm-pop-actions">
                <button
                  type="button"
                  className="perm-pop-btn"
                  onClick={() => setConfirmingFull(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="perm-pop-btn primary"
                  disabled={!riskChecked}
                  onClick={() => void applyMode('full')}
                >
                  确认开启
                </button>
              </div>
            </>
          ) : (
            <>
              {MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  className={mode === m.value ? 'perm-pop-row active' : 'perm-pop-row'}
                  onClick={() => pick(m.value)}
                >
                  <span className="perm-pop-icon">{m.icon}</span>
                  <span className="perm-pop-text">
                    <span className="perm-pop-label">{m.label}</span>
                    <span className="perm-pop-desc">{m.desc}</span>
                  </span>
                  {mode === m.value ? <span className="perm-pop-check">✓</span> : null}
                </button>
              ))}
              <div className="perm-pop-foot">读取查看类操作在所有模式下都直接执行，无需确认。</div>
            </>
          )}
        </div>
      ) : null}
    </span>
  )
}

export default PermissionButton
