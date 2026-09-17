// 视觉档案的选择规则（P8-T3）：**主进程与设置页共用同一份**。
// 放 shared 的原因：设置页要如实告诉用户"当前会用哪个档案当眼睛"，
// 若渲染层自己再写一套判断，迟早与真正执行的逻辑分叉（用户看到 A、实际用 B）。

import type { ModelProfile } from './types'

/** 设置里"自动挑一个可用视觉档案"的取值 */
export const VISION_AUTO = ''
/** 设置里"不做转述"的取值（关掉这条腿） */
export const VISION_OFF = 'off'

export type VisionPick =
  | { ok: true; profile: ModelProfile }
  | { ok: false; reason: 'off' | 'missing-profile' | 'no-key' | 'unavailable' }

/**
 * 挑一个档案来做识图：
 * ① 设置指定了具体档案 → 只用它（指名了就不偷偷换人，缺 key/档案被删如实报错）；
 * ② 自动：优先**激活档案自己**（它本来就多模态，省一次配置、还保温它的缓存）；
 * ③ 再退到"第一个开着多模态且配了 key"的档案（按档案表顺序）；
 * ④ 都没有 → unavailable（调用方回退成原有的"未开启多模态"提示）。
 */
export function pickVisionProfile(input: {
  profiles: readonly ModelProfile[]
  activeId: string
  visionProfileId: string
  hasKey: (id: string) => boolean
}): VisionPick {
  if (input.visionProfileId === VISION_OFF) return { ok: false, reason: 'off' }
  if (input.visionProfileId !== VISION_AUTO) {
    const named = input.profiles.find((p) => p.id === input.visionProfileId)
    if (named === undefined) return { ok: false, reason: 'missing-profile' }
    if (!input.hasKey(named.id)) return { ok: false, reason: 'no-key' }
    return { ok: true, profile: named }
  }
  const active = input.profiles.find((p) => p.id === input.activeId)
  if (active !== undefined && active.multimodal && input.hasKey(active.id)) {
    return { ok: true, profile: active }
  }
  const anyVision = input.profiles.find((p) => p.multimodal && input.hasKey(p.id))
  if (anyVision === undefined) return { ok: false, reason: 'unavailable' }
  return { ok: true, profile: anyVision }
}

/** 选档失败时给用户/模型看的原因（要说清下一步，而不是丢个 reason 码） */
export function visionUnavailableHint(
  reason: 'off' | 'missing-profile' | 'no-key' | 'unavailable'
): string {
  if (reason === 'off') return '识图已关闭（设置 → 模型 的「视觉档案」选了「不做转述」）。'
  if (reason === 'missing-profile') return '设置的视觉档案已被删除——请到 设置 → 模型 重新选一个。'
  if (reason === 'no-key') return '指定的视觉档案还没配 API Key——请到 设置 → 模型 填入密钥。'
  return '没有可用的视觉档案——请到 设置 → 模型 给某个支持图片的档案打开「多模态」并配好密钥，或在「视觉档案」里指定一个。'
}
