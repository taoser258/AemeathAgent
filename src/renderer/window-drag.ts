// 无边框窗顶条手动拖拽（主窗 / 设置窗共用）。
// 为什么不用 -webkit-app-region: drag：
// ① drag 区在原生命中层吞掉叠在它上面的缩放区——顶部/左上/右上角缩放失灵就是这么来的
// （缩放区 DOM z-index 再高也压不过原生 drag 区，Electron 的 app-region 不走 DOM 层叠）；
// ② drag 是系统级拖动，无边框窗没有"拖标题栏自动还原最大化"的原生行为，
// 全屏/最大化后拖顶条窗口不会回退。
// 交互语义对齐 Windows 原生标题栏：
// 单击顶条 → 无操作；位移超过阈值 → 起帧拖拽（最大化则此时才还原）；
// 双击顶条 → 最大化/还原切换（toggleWindowMaximize，组件层 onDoubleClick 接线）。
// 拖拽方案：起帧时经 win:window-drag-begin 让主进程还原最大化并回传当前窗口框（DIP），
// 之后每帧发送"光标 − 抓取点偏移"的绝对位置——绝对定位无累积反馈误差，丢帧自校正
// （同款防抽搐原理见 main-window.ts 的 WIN_WINDOW_MOVE_TO 注释）。
// 坐标口径：screenX/screenY 是 CSS 像素（DIP），与 window.getBounds() 同为 DIP，
// 跨屏/任意缩放比都一致，不用乘 devicePixelRatio（那是物理像素才要的）。

import type React from 'react'

/** 拖拽起帧阈值：位移低于它不算拖拽（原生 SM_CXDRAG 同量级），防微动误触 */
const DRAG_THRESHOLD = 4

/** 顶条 pointerdown 入口：按下只记录位置，真正拖动（超阈值）才起帧 */
export function startWindowDrag(event: React.PointerEvent<HTMLElement>): void {
  event.preventDefault()
  const downX = event.screenX
  const downY = event.screenY
  let began = false
  let cancelled = false
  const beginDrag = async (first: PointerEvent): Promise<void> => {
    // 起帧 await 期间光标还在动：缓存最新位置，拿到基准后立刻校正（否则会跳一下才追上）
    let latest: { x: number; y: number } | null = null
    const capture = (m: PointerEvent): void => {
      latest = { x: m.screenX, y: m.screenY }
    }
    window.addEventListener('pointermove', capture)
    const bounds = await window.petAPI.windowDragBegin()
    window.removeEventListener('pointermove', capture)
    if (cancelled || !bounds) return
    const grabX = downX - bounds.x
    const grabY = downY - bounds.y
    const moveTo = (screenX: number, screenY: number): void => {
      window.petAPI.windowMoveTo(
        Math.round(screenX - grabX),
        Math.round(screenY - grabY),
        bounds.width,
        bounds.height
      )
    }
    const onMove = (move: PointerEvent): void => moveTo(move.screenX, move.screenY)
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    const p = latest ?? first
    moveTo(p.screenX, p.screenY)
  }

  const onMove = (move: PointerEvent): void => {
    if (cancelled || began) return
    const dx = move.screenX - downX
    const dy = move.screenY - downY
    if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
    began = true
    window.removeEventListener('pointermove', onMove)
    void beginDrag(move)
  }
  const onUp = (): void => {
    cancelled = true
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

/** 顶条双击：最大化/还原切换（对齐原生标题栏双击行为；windowControl 的 maximize 即 toggle） */
export function toggleWindowMaximize(): void {
  window.petAPI.windowControl('maximize')
}
