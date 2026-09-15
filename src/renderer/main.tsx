import { setupTheme } from './theme'
// 全局样式不再在此直连：由 chat.css 顶部 @import 内联（顺序铁律见该文件头注释）
import './styles/genui.css'
import './chat/chat.css'

// 字体：霞鹜文楷屏幕版（界面正文，OFL 许可，本地打包离线可用）+ Maple Mono（代码，OFL）
import 'lxgw-wenkai-screen-webfont/style.css'
import '@fontsource/maple-mono/400.css'
import '@fontsource/maple-mono/500.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

// 主题：createRoot 前同步上色（按 localStorage 缓存），防深色首帧闪白
setupTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
