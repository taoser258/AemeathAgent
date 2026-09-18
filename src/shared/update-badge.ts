// 更新角标口径（纯函数 + 单测）。
//
// 形态选择（owner 三选一里取「轻提示」）：发现新版本**不弹窗、不自动下载**，
// 只在主窗侧栏的设置入口（⚙）挂一个小圆点，hover 才看到版本号与去处；
// 下载/安装仍由 设置 → 关于 页的用户主动点击驱动——改用户机器的动作一律过用户的手。
//
// 单独抽出来的理由（AGENTS.md 行为类约定）：判定逻辑一律独立纯函数模块 + 单测，
// 不许留在组件闭包里——闭包里的口径没法被测，也最容易在后续改动中悄悄失准。
import type { UpdateStatus } from './types'

export interface UpdateBadge {
  /** 是否挂角标（只在「有新版本 / 已下好待安装」时为 true） */
  show: boolean
  /** 悬停提示文案；不挂角标时为 null */
  hint: string | null
  /** 已下载待安装：角标停掉脉动，语义从「有新版」变成「重启即可装」 */
  ready: boolean
}

const HIDDEN: UpdateBadge = { show: false, hint: null, ready: false }

export function updateBadge(status: UpdateStatus): UpdateBadge {
  // 没有版本号 = 没有可提示的目标（idle/checking/not-available/error/downloading 都没有）
  if (status.version === undefined) return HIDDEN
  if (status.state === 'available') {
    return { show: true, hint: `发现新版本 v${status.version}｜设置 → 关于 可下载`, ready: false }
  }
  if (status.state === 'downloaded') {
    return {
      show: true,
      hint: `新版本 v${status.version} 已下载｜重启即可安装（设置 → 关于）`,
      ready: true
    }
  }
  // downloading 也不提示：进度本来就在关于页看着，侧栏再闪一下只是噪音
  return HIDDEN
}
