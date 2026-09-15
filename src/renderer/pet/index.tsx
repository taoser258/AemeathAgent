// 桌宠窗渲染页：立绘 + 头顶气泡 + 手动拖拽。
// 拖拽不能走 -webkit-app-region: drag —— 那会被 Windows 当成"标题栏"，右键整窗被
// 系统菜单（还原/移动/最小化…）接管，自定义右键菜单收不到 contextmenu 事件（验收踩坑）。
// 所以：左键按下 → 记住抓取偏移 → 指针移动时经 IPC 让主进程 setPosition；右键弹自定义菜单。
// 气泡内容由主进程经 pet:bubble 通道推送。

import { useEffect, useRef, useState } from 'react'
import art from './assets/aemeath.png'

/** 气泡最长显示 40 字，超出省略 */
const BUBBLE_MAX_CHARS = 40

/** 按下点相对窗口左上角的偏移（屏幕坐标，DIP） */
interface DragState {
  offsetX: number
  offsetY: number
}

function PetPage(): React.JSX.Element {
  const [bubble, setBubble] = useState<string | null>(null)
  const dragState = useRef<DragState | null>(null)

  useEffect(() => {
    const off = window.petAPI.onPetBubble((text) => {
      setBubble(text.length > BUBBLE_MAX_CHARS ? `${text.slice(0, BUBBLE_MAX_CHARS)}…` : text)
    })
    return off
  }, [])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return
      // 抓住指针：即使鼠标快速甩出窗口外，move / up 事件仍会继续送进来
      ;(event.target as Element).setPointerCapture(event.pointerId)
      dragState.current = {
        offsetX: event.screenX - window.screenX,
        offsetY: event.screenY - window.screenY
      }
    }
    const onPointerMove = (event: PointerEvent): void => {
      const drag = dragState.current
      if (!drag) return
      window.petAPI.movePetTo(event.screenX - drag.offsetX, event.screenY - drag.offsetY)
    }
    const onPointerUp = (): void => {
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
      {bubble !== null && bubble !== '' && <div className="pet-bubble">{bubble}</div>}
      <img className="pet-art" src={art} alt="爱弥斯" draggable={false} />
    </div>
  )
}

export default PetPage
