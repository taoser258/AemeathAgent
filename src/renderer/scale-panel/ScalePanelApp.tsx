// 桌宠尺寸滑动面板：由桌宠右键菜单"调整大小"唤起的独立小浮窗。
// 全透明背景：只有标题（滑杆上方居中）、滑杆、百分比（滑杆下方居中）可见。
// 滑动实时调整桌宠尺寸（0.5–1.5）；✕ 关闭面板（桌宠保持当前大小）。

import { useEffect, useState } from 'react'

function ScalePanelApp(): React.JSX.Element {
  const [scalePercent, setScalePercent] = useState<number | null>(null)

  useEffect(() => {
    window.petAPI.getConfig().then((config) => setScalePercent(Math.round(config.pet.scale * 100)))
  }, [])

  return (
    <div className="scale-panel">
      <button
        type="button"
        className="scale-panel-close"
        title="关闭"
        onClick={() => window.petAPI.windowControl('close')}
      >
        ✕
      </button>
      <div className="scale-panel-title">调整大小</div>
      <input
        type="range"
        min={50}
        max={150}
        value={scalePercent ?? 50}
        className="scale-panel-slider"
        onChange={(event) => {
          const percent = Number(event.target.value)
          setScalePercent(percent)
          window.petAPI.applyPetScale(percent / 100)
        }}
      />
      <div className="scale-panel-value">{scalePercent ?? 50}%</div>
    </div>
  )
}

export default ScalePanelApp
