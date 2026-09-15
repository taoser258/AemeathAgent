import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// 测试只覆盖纯逻辑：
// prompt 组装、session store 往返与容错、ipc 通道唯一性、配置读写往返、窗口位置解析。
// 涉及窗口 / IPC / Electron API 的代码不在单测范围。
export default defineConfig({
  resolve: {
    alias: {
      // 与 electron.vite.config.ts 保持一致：被测代码里用 @shared 引契约类型
      '@shared': resolve('src/shared')
    }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node'
  }
})
