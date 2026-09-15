import { setupTheme } from '../theme'
// 字体与主窗同源。
// 此前只在主窗入口 import 了文楷/Maple 的字体 CSS，设置窗没引——
// 'LXGW WenKai Screen' 在设置窗根本不存在，静默回退成雅黑，观感割裂。
import 'lxgw-wenkai-screen-webfont/style.css'
import '@fontsource/maple-mono/400.css'
import '@fontsource/maple-mono/500.css'
// 全局样式改由 settings.css 顶部 @import 内联（顺序铁律见 chat.css 头注释）
import './settings.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import SettingsApp from './SettingsApp'

// 设置窗入口：独立窗口（三入口之一），卡片式页面；主题跟随全局外观设置
setupTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>
)
