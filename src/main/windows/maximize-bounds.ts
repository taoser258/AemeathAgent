// 最大化目标框计算（纯函数，无 electron 依赖，可直接单测）。
//
// 背景（owner 实测问题）：任务栏设为「自动隐藏」时，Windows 给出的 workArea
// 与显示器矩形**完全一致**（任务栏不占位）。此时把窗口铺到 workArea，窗口就与
// 显示器矩形完全重合——Windows shell 会把这种窗口判定为「全屏应用」，从而
// **主动抑制自动隐藏任务栏的弹出**（等同看视频/打游戏时不弹任务栏的机制），
// 鼠标贴到屏幕最底部也唤不出任务栏。
//
// 解法：自动隐藏场景下，最大化框**底部再留 1 个逻辑像素**，打破"完全覆盖显示器"
// 这一判定，任务栏便恢复正常的贴底弹出行为。
// - 这 1px 恰好落在主窗底部 28px 圆角那圈空白里，视觉上不可见；
// - 窗口尺寸/位置不随时间变化（owner 明确要求"窗口保持不动"，不做贴底让位）。

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 打破全屏判定的底部留缝（逻辑像素） */
export const MAXIMIZE_BOTTOM_GAP = 1

/**
 * 算出最大化的目标框。
 * @param display Electron screen.Display 形状（只取 bounds 与 workArea）
 * - 任务栏常显：workArea 已扣掉任务栏 → 原样使用（不留缝，避免多一条缝）；
 * - 任务栏自动隐藏：workArea == 显示器全幅 → 底部留 MAXIMIZE_BOTTOM_GAP。
 */
export function maximizedBounds(display: { bounds: Rect; workArea: Rect }): Rect {
  const { bounds, workArea } = display
  const autoHidden = bounds.height - workArea.height <= MAXIMIZE_BOTTOM_GAP
  const gap = autoHidden ? MAXIMIZE_BOTTOM_GAP : 0
  return {
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: Math.max(1, workArea.height - gap)
  }
}
