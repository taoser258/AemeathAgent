// 主题应用：主窗 / 设置窗 / 桌宠窗 / 缩放面板四入口共用。
// 机制：<html data-theme="light|dark"> 切换 global.css 的两套 token 组；
// 'system' 跟随系统深浅色（matchMedia 实时响应）。
// 防闪错色：每次解析结果写 localStorage，入口同步先按缓存值上色，异步校正。

import type { AppConfig } from '@shared/types'

export type ThemeSetting = NonNullable<AppConfig['appearance']>['theme']
export type ResolvedTheme = 'light' | 'dark'

const CACHE_KEY = 'aemeath.theme-resolved'

/** 设置值 → 实际深浅（system 跟随系统） */
export function resolveTheme(setting: ThemeSetting): ResolvedTheme {
  if (setting === 'light' || setting === 'dark') return setting
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** 立即应用：写 <html data-theme> 并缓存（下次入口同步首帧用） */
export function applyTheme(setting: ThemeSetting): ResolvedTheme {
  const resolved = resolveTheme(setting)
  document.documentElement.dataset.theme = resolved
  try {
    localStorage.setItem(CACHE_KEY, resolved)
  } catch {
    /* localStorage 不可用就退化：首帧多闪一次，无碍 */
  }
  return resolved
}

/**
 * 入口挂载：① 同步按缓存上色（防闪错色）→ ② 异步按配置校正 →
 * ③ 设置变更时重读 → ④ system 模式下跟随系统实时切换。
 * 幂等，四个窗口入口各调一次即可。
 */
export function setupTheme(): void {
  try {
    const cached = localStorage.getItem(CACHE_KEY)
    if (cached === 'light' || cached === 'dark') {
      document.documentElement.dataset.theme = cached
    }
  } catch {
    /* 同上 */
  }

  const applyFromConfig = (): void => {
    void window.petAPI.getConfig().then((c) => {
      applyTheme(c.appearance?.theme ?? 'light')
    })
  }
  applyFromConfig()
  window.petAPI.onSettingsChanged(applyFromConfig)

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    void window.petAPI.getConfig().then((c) => {
      if ((c.appearance?.theme ?? 'light') === 'system') applyTheme('system')
    })
  })
}
