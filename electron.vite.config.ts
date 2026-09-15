import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    resolve: {
      alias: {
        // 主进程与渲染进程共享的契约代码（类型与常量）
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {},
  renderer: {
    build: {
      rollupOptions: {
        // 多入口：主窗（聊天）+ 桌宠窗（透明页）+ 设置窗（独立窗口）
        input: {
          index: resolve('src/renderer/index.html'),
          pet: resolve('src/renderer/pet.html'),
          'scale-panel': resolve('src/renderer/scale-panel.html'),
          settings: resolve('src/renderer/settings.html')
        }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()]
  }
})
