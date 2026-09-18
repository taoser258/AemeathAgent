// 形象层（P9-T6）：PetAvatar = 桌宠的"形象"，与气泡、拖拽解耦。
// 这是可插拔抽象的第一版——当前只有 PNG 实现（呼吸 + 交互轻颤）；
// 将来 Live2D / VRM 只是把本组件内部换成对应实现，**PetPage 与 IPC 都不用动**。
//
// 刻意不做的事：单张 PNG 没有可切换的口型/表情素材，所以不提供 setMouth 这类
// 没有实现支撑的空壳接口（YAGNI）；呼吸与轻颤是当前 PNG 确实能做到的"活着"感。

import { useEffect, useRef } from 'react'

export interface PetAvatarProps {
  /** 立绘图片（PNG） */
  art: string
  /**
   * 交互 tick：每次变为新值（点 / 拖拽结束）播放一次轻颤。
   * 挂载首帧不颤（那是开机，不是被碰）。
   */
  interactTick: number
}

/** 轻颤关键帧：被点到时身体轻轻一缩再回弹（幅度刻意小，别像被打） */
const BUMP_KEYFRAMES = [
  { transform: 'scale(1) rotate(0deg)' },
  { transform: 'scale(0.95) rotate(-1.6deg)', offset: 0.3 },
  { transform: 'scale(1.04) rotate(1.2deg)', offset: 0.65 },
  { transform: 'scale(1) rotate(0deg)' }
]
const BUMP_MS = 420

export function PetAvatar({ art, interactTick }: PetAvatarProps): React.JSX.Element {
  const imgRef = useRef<HTMLImageElement>(null)
  const mountedAt = useRef(0)

  useEffect(() => {
    mountedAt.current += 1
    // 第一次 effect = 挂载，不播放
    if (mountedAt.current === 1) return
    // WAAPI 命令式触发一次性轻颤：不改 React 状态、不与 class 切换打架；
    // 轻颤期间临时盖过 CSS 呼吸动画，结束后呼吸自然恢复。
    imgRef.current?.animate(BUMP_KEYFRAMES, { duration: BUMP_MS, easing: 'ease-out' })
  }, [interactTick])

  return <img ref={imgRef} className="pet-avatar-art" src={art} alt="爱弥斯" draggable={false} />
}
