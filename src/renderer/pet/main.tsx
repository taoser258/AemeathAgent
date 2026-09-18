import { setupTheme } from '../theme'
// 字体与主窗/设置窗同源：气泡文字用霞鹜文楷（不引则静默回退雅黑，观感割裂——同设置窗旧问题）
import 'lxgw-wenkai-screen-webfont/style.css'
import './pet.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import PetPage from './index'

// 桌宠窗入口：与主窗完全独立的页面，透明背景与布局互不影响；主题统一挂载
setupTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PetPage />
  </StrictMode>
)
