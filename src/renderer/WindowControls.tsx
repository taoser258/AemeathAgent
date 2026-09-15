// 窗口控制按钮（无边框窗口共用）：最小化 / 最大化还原 / 关闭（主窗关闭=隐藏）。
// ★ 图标全部 SVG 自绘（与侧栏开关 right-toggle 同款）：此前 ─ ▢ ✕ 是**文字符号**，
// 基线与字怀依赖系统字体——换台电脑（字体/DPI 不同）三个符号在按钮里各自落位不同，
// 顶栏看起来"不齐"。
// SVG 几何与字体无关，跨机器像素级一致。
// 最大化态（手动 workArea 最大化，状态源在主进程广播）：最大化单框 ↔ 还原两叠方框
// （Windows 原生语义）。

import { useEffect, useState } from 'react'

/** 统一图标画布：14×14 viewBox / 1.3 描边 / currentColor（hover 变色沿用按钮 color） */
function WinIcon({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      {children}
    </svg>
  )
}

export default function WindowControls(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    const off = window.petAPI.onWindowMaximized(setMaximized)
    // 挂载对账：广播可能早于订阅（如设置窗重开），invoke 拉一次真值
    void window.petAPI.getWindowMaximized().then(setMaximized)
    return off
  }, [])

  return (
    <div className="win-controls">
      <button
        type="button"
        className="win-btn"
        title="最小化"
        onClick={() => window.petAPI.windowControl('minimize')}
      >
        <WinIcon>
          <line x1="2.8" y1="7" x2="11.2" y2="7" stroke="currentColor" strokeWidth="1.3" />
        </WinIcon>
      </button>
      <button
        type="button"
        className="win-btn"
        title={maximized ? '还原' : '最大化'}
        onClick={() => window.petAPI.windowControl('maximize')}
      >
        {maximized ? (
          // 还原=两叠方框：前框完整，后框露左上角
          <WinIcon>
            <rect
              x="4.4"
              y="4.4"
              width="6.9"
              height="6.9"
              rx="1.6"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <path
              d="M9.6 2.8H4.5A1.7 1.7 0 0 0 2.8 4.5v5.1"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </WinIcon>
        ) : (
          <WinIcon>
            <rect
              x="2.9"
              y="2.9"
              width="8.2"
              height="8.2"
              rx="1.8"
              stroke="currentColor"
              strokeWidth="1.3"
            />
          </WinIcon>
        )}
      </button>
      <button
        type="button"
        className="win-btn close"
        title="隐藏窗口（不退出）"
        onClick={() => window.petAPI.windowControl('close')}
      >
        <WinIcon>
          <path
            d="M3.6 3.6 10.4 10.4M10.4 3.6 3.6 10.4"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </WinIcon>
      </button>
    </div>
  )
}
