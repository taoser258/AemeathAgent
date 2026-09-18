// 桌宠窗渲染页：立绘 + 头顶气泡 + 手动拖拽。
// 拖拽不能走 -webkit-app-region: drag —— 那会被 Windows 当成"标题栏"，右键整窗被
// 系统菜单（还原/移动/最小化…）接管，自定义右键菜单收不到 contextmenu 事件（验收踩坑）。
// 所以：左键按下 → 记住抓取偏移 → 指针移动时经 IPC 让主进程 setBounds；右键弹自定义菜单。
// 抬起时按下与抬起的位移 < 阈值 = 点（pet:tap），移动过 = 拖（pet:dragged），
// 气泡由主进程经 pet:bubble 通道推送（P9-T5 通电）。

import { useEffect, useRef, useState } from 'react'
import art from './assets/aemeath.png'
import { PetAvatar } from './PetAvatar'

/** 气泡最长显示 60 字（窗口加宽到 400 后放得下多行短句），超出省略 */
const BUBBLE_MAX_CHARS = 60
/** 气泡停留时间后淡出（4–8s 区间取 6s） */
const BUBBLE_HIDE_MS = 6000
/** 按下抬起位移小于这个像素算"点"，否则算"拖" */
const TAP_MOVE_PX = 6

/** 按下点相对窗口左上角的偏移（屏幕坐标，DIP）+ 判定点/拖用的起点 */
interface DragState {
  offsetX: number
  offsetY: number
  startScreenX: number
  startScreenY: number
  moved: boolean
}

function PetPage(): React.JSX.Element {
  const [bubble, setBubble] = useState<string | null>(null)
  /** 形象层交互 tick：pointerup 每次 +1，PetAvatar 据此播放一次轻颤（P9-T6） */
  const [interactTick, setInteractTick] = useState(0)
  const dragState = useRef<DragState | null>(null)
  const bubbleTimer = useRef<number | null>(null)

  useEffect(() => {
    const off = window.petAPI.onPetBubble((text) => {
      const shown = text.length > BUBBLE_MAX_CHARS ? `${text.slice(0, BUBBLE_MAX_CHARS)}…` : text
      setBubble(shown)
      // 停留 6 秒淡出；新气泡来先清旧计时（不叠加）
      if (bubbleTimer.current !== null) window.clearTimeout(bubbleTimer.current)
      bubbleTimer.current = window.setTimeout(() => setBubble(null), BUBBLE_HIDE_MS)
    })
    return () => {
      off()
      if (bubbleTimer.current !== null) window.clearTimeout(bubbleTimer.current)
    }
  }, [])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return
      // 抓住指针：即使鼠标快速甩出窗口外，move / up 事件仍会继续送进来。
      // 防御：在没有活动指针（合成事件等边缘情况）时它会抛 InvalidStateError，
      // 捕获失败不该阻塞后续拖拽/点击状态的建立。
      try {
        ;(event.target as Element).setPointerCapture(event.pointerId)
      } catch {
        /* 指针捕获是增强，不是拖拽的必要条件 */
      }
      dragState.current = {
        offsetX: event.screenX - window.screenX,
        offsetY: event.screenY - window.screenY,
        startScreenX: event.screenX,
        startScreenY: event.screenY,
        moved: false
      }
    }
    const onPointerMove = (event: PointerEvent): void => {
      const drag = dragState.current
      if (!drag) return
      // 位移超过阈值：标记为拖（抬起时据此上报）
      if (
        Math.abs(event.screenX - drag.startScreenX) > TAP_MOVE_PX ||
        Math.abs(event.screenY - drag.startScreenY) > TAP_MOVE_PX
      ) {
        drag.moved = true
      }
      window.petAPI.movePetTo(event.screenX - drag.offsetX, event.screenY - drag.offsetY)
    }
    const onPointerUp = (): void => {
      const drag = dragState.current
      if (drag) {
        // 点 / 拖分两条通道；主进程的气泡门槛（冷却等）仍统一把守
        if (drag.moved) window.petAPI.petDragged()
        else window.petAPI.petTap()
        // 无论点还是拖完，让形象轻颤一下
        setInteractTick((n) => n + 1)
      }
      dragState.current = null
    }
    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault()
      window.petAPI.showPetMenu()
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('contextmenu', onContextMenu)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('contextmenu', onContextMenu)
    }
  }, [])

  return (
    <div className="pet-root">
      {bubble !== null && bubble !== '' && (
        <div
          className="pet-bubble"
          role="button"
          tabIndex={-1}
          title="点开主窗"
          onClick={() => window.petAPI.openMainWindow()}
        >
          {bubble}
        </div>
      )}
      <PetAvatar art={art} interactTick={interactTick} />
    </div>
  )
}

export default PetPage
