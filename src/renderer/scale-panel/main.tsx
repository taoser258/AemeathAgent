import { setupTheme } from '../theme'
import '../styles/global.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import ScalePanelApp from './ScalePanelApp'

// 桌宠尺寸滑动面板入口：独立小浮窗（不跟随桌宠缩放）；主题统一挂载
setupTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ScalePanelApp />
  </StrictMode>
)
