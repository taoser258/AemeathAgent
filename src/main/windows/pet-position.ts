// 桌宠位置解析（纯函数，不依赖 electron，可单测）。
// 高 DPI 坑位：恢复窗口位置前校验"显示器还在"，
// 记忆位置完全脱离所有显示器（拔掉外接屏等）时回退主屏右下角。

export interface DisplayArea {
  /** 显示器工作区（去掉任务栏），全局屏幕坐标 */
  x: number
  y: number
  width: number
  height: number
}

export interface WindowSize {
  width: number
  height: number
}

/**
 * 桌宠窗尺寸（P9-T5 起加宽）：
 * 立绘 260 宽（源图 960x917，PET_ART_WIDTH）居中放在 400 宽的透明窗里，
 * 两侧各 70 DIP 透明区，气泡由此可以溢出立绘宽度而不顶到窗口边。
 * 高度仍是 260 立绘 + 头顶约 56px 气泡空间。
 */
export const PET_WINDOW_WIDTH = 400
export const PET_WINDOW_HEIGHT = 316
/** 立绘在窗内的逻辑宽度（渲染层按它钉死，不随窗宽走） */
export const PET_ART_WIDTH = 260

/** 滑动调节的倍率范围（右键菜单 → 调整大小） */
export const PET_SCALE_MIN = 0.5
export const PET_SCALE_MAX = 1.5
export const PET_SCALE_DEFAULT = 0.5

/** 由缩放倍率得到窗口实际尺寸；倍率钳制在 0.5–1.5（滑动范围），非法值回退默认 0.75 */
export function petWindowSize(scale: number): WindowSize {
  const safe = Number.isFinite(scale)
    ? Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, scale))
    : PET_SCALE_DEFAULT
  return {
    width: Math.round(PET_WINDOW_WIDTH * safe),
    height: Math.round(PET_WINDOW_HEIGHT * safe)
  }
}

/** 右下角回退时离屏幕边缘的留白 */
const FALLBACK_MARGIN = 24

export function resolvePetPosition(
  saved: { x: number | null; y: number | null },
  size: WindowSize,
  displays: DisplayArea[]
): { x: number; y: number } {
  const primary = displays[0]
  if (!primary) {
    // screen.getAllDisplays() 理论上不会为空；防御式兜底
    return { x: 0, y: 0 }
  }
  const fallback = {
    x: primary.x + primary.width - size.width - FALLBACK_MARGIN,
    y: primary.y + primary.height - size.height - FALLBACK_MARGIN
  }

  const { x, y } = saved
  if (x === null || y === null) return fallback

  // 窗口矩形与任一显示器相交即认为"显示器还在"：
  // 允许窗口部分拖出屏幕边缘（保留用户拖放意图），只有完全落在所有屏幕之外才回退
  const intersectsAny = displays.some(
    (d) => x < d.x + d.width && x + size.width > d.x && y < d.y + d.height && y + size.height > d.y
  )
  return intersectsAny ? { x, y } : fallback
}
