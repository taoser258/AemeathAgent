// 工作区门槛：工作 / 学习模式必须先绑定工作目录，否则不能开始会话。
//
// 为什么要这道门（对齐成熟 Agent 的权限模型）：
// 成熟实现的 SessionHeader 要求一个绝对 cwd，缺失时**直接抛错、不合成默认值**——因为沙箱与
// 相对路径解析都依赖它。Aemeath 没有 OS 级沙箱，工作区就是那个等价物：它既是「标准」
// 权限模式下的免询问边界，又是文件工具相对路径的基准。
// 未绑定时相对路径会落到「应用安装目录」（通常在 Program Files，往往连写权限都没有），
// 所以宁可拦住让用户选一次，也不给一个会出事的默认值。
//
// 放在 shared：主进程（权威门禁）与渲染层（提前禁用输入 + 引导）共用同一套判定与文案，
// 避免两边各写一套、判得不一样。

import type { AppConfig, ChatMode } from './types'

/** 需要工作区的模式：工作 / 学习都带工具；对话模式无工具，天然不需要 */
export function modeNeedsWorkspace(mode: ChatMode): boolean {
  return mode !== 'chat'
}

/** 模式中文名（错误文案与界面共用，避免各处各写一套） */
export function modeLabel(mode: ChatMode): string {
  return mode === 'learn' ? '学习' : mode === 'work' ? '工作' : '对话'
}

/** 该模式绑定的工作目录；未绑定（或对话模式）返回 null */
export function boundWorkspace(workspace: AppConfig['workspace'], mode: ChatMode): string | null {
  if (!modeNeedsWorkspace(mode)) return null
  const raw = mode === 'learn' ? workspace.learn : workspace.work
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed === '' ? null : trimmed
}

/** 工作区门槛判定结果：ok=false 时 code 供渲染层区分处理（例如直接弹目录选择器） */
export type WorkspaceGate =
  { ok: true } | { ok: false; code: 'workspace-missing' | 'workspace-invalid'; error: string }

/**
 * 判定该模式能否开工。`dirExists` 注入以便单测（主进程传 fs 实现）——
 * 要检查目录是否还在：用户可能把绑定的目录删了或挪了，这时应当提示重绑，
 * 而不是让工具在一个不存在的基准上静默失败。
 */
export function checkWorkspace(
  workspace: AppConfig['workspace'],
  mode: ChatMode,
  dirExists: (dir: string) => boolean
): WorkspaceGate {
  if (!modeNeedsWorkspace(mode)) return { ok: true }
  const path = boundWorkspace(workspace, mode)
  if (path === null) {
    return {
      ok: false,
      code: 'workspace-missing',
      error: `${modeLabel(mode)}模式还没绑定工作目录。点输入框左侧的 📁 选一个目录（或到 设置 → 目录 里绑定），选好就能开始了。`
    }
  }
  if (!dirExists(path)) {
    return {
      ok: false,
      code: 'workspace-invalid',
      error: `${modeLabel(mode)}模式绑定的目录不存在了：${path}。可能被删除或移动了，请重新绑定一个目录。`
    }
  }
  return { ok: true }
}
