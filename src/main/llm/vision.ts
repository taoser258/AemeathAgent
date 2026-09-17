// 视觉旁路（P8-T3 第一条腿）：给"没有多模态"的模型识图能力。
//
// 思路照 GitHub 上的成熟做法（pi-image-fallback / pi-vision-bridge，调研见
// docs/交接文档/交接文档-P8.md §1.3）：**绝不切换主模型**——切来切去会把两边
// 的 prompt cache 都打烂、还会打断会话；而是对"视觉档案"做一次**独立的小调用**
// （system + 图，不挂工具），把返回的描述当**文字**注入本轮上下文，并明确标注
// "这是转述"（P7-T4 的教训：把识别内容说成亲眼所见，就会错得很自然）。
//
// 两条腿（owner 拍板"两者都要"）：
// - 本文件 = 云端视觉模型转述（擅长版面/语义，但长数字可能读错）
// - tools/ocr.ts = Windows 本地 OCR（逐字更可靠，但不懂版面）
// 图一进来**只跑本文件**（默认那条腿）；OCR 由她按需调，不自动同跑
// （双倍成本 + 双份噪声）。同图两个结果数字打架时必须点出冲突。

import { createHash } from 'crypto'
import { streamChat } from './client'
import type { ChatContentPart, ChatTurn } from './client'
import { classifyLlmError } from './errors'
import {
  VISION_AUTO,
  VISION_OFF,
  pickVisionProfile,
  visionUnavailableHint
} from '@shared/vision-pick'
import type { AppConfig, ModelProfile } from '@shared/types'

// 选档规则与中文文案在 shared/vision-pick.ts（设置页要显示"当前会用谁"，必须同一份逻辑）
export { VISION_AUTO, VISION_OFF, pickVisionProfile, visionUnavailableHint }

/** 单次识图调用超时：视觉模型比纯文本慢，但必须有上限（否则一条烂网络挂住整轮对话） */
export const VISION_TIMEOUT_MS = 60_000
/** 描述缓存条数上限：同图不重复付费；满了淘汰最早写入的一条 */
export const VISION_CACHE_MAX = 32

/**
 * 转述任务的输出契约（借 modlens 的"结构化证据"思路：散文描述对下游没用，
 * "逐字文字 + 版面 + 语义"三段才有用）。
 */
const DESCRIBE_TASK =
  '请转述这张图片的内容，供一个**看不到图**的助手使用。按三段输出，标题照抄：\n' +
  '【文字照抄】把图中所有可见文字**逐字**抄下来（含数字、符号、单位、表格的行列关系）。' +
  '不要改写、不要换算、不要补全。\n' +
  '【版面结构】说明这是什么（照片/截图/表格/图表/界面），关键元素在哪、彼此什么关系。\n' +
  '【语义摘要】用一两句话概括这张图在讲什么。\n' +
  '看不清的部分写"看不清"，**禁止猜测**；不要输出与图片无关的建议或客套话。'

const DESCRIBE_SYSTEM =
  '你是一个图像转述器。你的输出会被另一个看不到图的模型直接引用，' +
  '所以准确比流畅重要：只写图上客观存在的内容，逐字抄录优先于概括，拿不准就说看不清。'

// ── 描述缓存（按图片内容 hash，同图不重复付费）──────────────────────────
const cache = new Map<string, string>()

/**
 * 缓存键 = **图片内容 hash**。
 * 为什么不照 codex-vision-proxy 的"按会话轮次缓存"：改过的截图会命中陈旧描述，
 * 比没有缓存更糟（错误还看不出来）。
 */
export function describeCacheKey(dataUrl: string): string {
  return createHash('sha256').update(dataUrl).digest('hex').slice(0, 32)
}

/** 缓存条数（测试用） */
export function visionCacheSize(): number {
  return cache.size
}

/** 清空缓存（测试用） */
export function clearVisionCache(): void {
  cache.clear()
}

function remember(key: string, text: string): void {
  if (cache.size >= VISION_CACHE_MAX) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(key, text)
}

// ─ 识图调用 ────────────────────────────────────────────────────────────
export interface DescribeImageInput {
  profile: ModelProfile
  apiKey: string
  /** data:image/*;base64,... （与聊天附件同一形态，三协议客户端都会转成各自的图片块） */
  dataUrl: string
  /** 追加问题（如"这张图表的最大值是多少"）；缺省只做通用转述 */
  question?: string
  signal?: AbortSignal
}

export type DescribeResult =
  { ok: true; text: string; cached: boolean } | { ok: false; error: string }

/**
 * 对一张图做一次转述调用（唯一碰 LLM 的地方）。
 * 失败一律收敛为可读 error，不抛——识图是锦上添花，不该把一轮对话炸掉。
 */
export async function describeImage(input: DescribeImageInput): Promise<DescribeResult> {
  const key = describeCacheKey(input.dataUrl)
  const hit = cache.get(key)
  if (hit !== undefined) return { ok: true, text: hit, cached: true }

  const question = input.question?.trim() ?? ''
  const ask = question === '' ? DESCRIBE_TASK : `${DESCRIBE_TASK}\n\n另外请特别回答：${question}`
  const content: ChatContentPart[] = [
    { type: 'text', text: ask },
    { type: 'image_url', image_url: { url: input.dataUrl } }
  ]
  const messages: ChatTurn[] = [
    { role: 'system', content: DESCRIBE_SYSTEM },
    { role: 'user', content }
  ]
  // 超时与调用方 signal 合流：任一触发即中断这次旁路调用
  const timeout = AbortSignal.timeout(VISION_TIMEOUT_MS)
  const signal = input.signal !== undefined ? AbortSignal.any([input.signal, timeout]) : timeout

  try {
    const res = await streamChat(
      {
        baseUrl: input.profile.baseUrl,
        apiKey: input.apiKey,
        model: input.profile.model,
        temperature: 0,
        messages,
        protocol: input.profile.protocol
      },
      { signal, onDelta: () => {} }
    )
    const text = res.text.trim()
    if (text === '') {
      return {
        ok: false,
        error: '视觉档案返回了空描述——该档案可能并不支持图片输入，或端点拒绝了这次请求。'
      }
    }
    remember(key, text)
    return { ok: true, text, cached: false }
  } catch (err) {
    if (signal.aborted && input.signal?.aborted !== true) {
      return { ok: false, error: `识图超时（超过 ${VISION_TIMEOUT_MS / 1000} 秒）。` }
    }
    return { ok: false, error: classifyLlmError(err).message }
  }
}

// ─ 给工具用的接线（注入式：registry 不读配置/密钥）─────────────────────
export interface VisionRunnerDeps {
  readConfig: () => AppConfig
  readKey: (profileId: string) => string | null
}

/** 选档失败时给模型看的原因见 shared/vision-pick.ts 的 visionUnavailableHint（设置页也要用） */

/**
 * 造一个"图 → 描述"的跑腿函数，供 describe_image 工具注入使用。
 * 工具只负责读文件与出文案；选档/取密钥/调模型都留在这里。
 */
export function makeVisionRunner(
  deps: VisionRunnerDeps
): (dataUrl: string, question: string | null, signal: AbortSignal) => Promise<string> {
  return async (dataUrl, question, signal) => {
    const config = deps.readConfig()
    const pick = pickVisionProfile({
      profiles: config.model.profiles,
      activeId: config.model.activeId,
      visionProfileId: config.model.visionProfileId,
      hasKey: (id) => {
        const key = deps.readKey(id)
        return key !== null && key !== ''
      }
    })
    if (!pick.ok) throw new Error(visionUnavailableHint(pick.reason))
    const apiKey = deps.readKey(pick.profile.id)
    if (apiKey === null || apiKey === '') throw new Error(visionUnavailableHint('no-key'))
    const res = await describeImage({
      profile: pick.profile,
      apiKey,
      dataUrl,
      ...(question !== null && question !== '' ? { question } : {}),
      signal
    })
    if (!res.ok) throw new Error(res.error)
    return res.text
  }
}
