// 应用退出标记：主窗（关闭=隐藏）与桌宠窗（close 拦截）都靠它区分
// "用户关窗口"和"应用正在退出"，避免 preventDefault 把 app.quit() 卡死。

let appQuitting = false

export function markAppQuitting(): void {
  appQuitting = true
}

export function isAppQuitting(): boolean {
  return appQuitting
}
