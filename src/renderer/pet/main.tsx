import { setupTheme } from '../theme'
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
