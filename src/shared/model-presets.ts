// 主流厂商预设：作为默认档案种子 + 旧配置迁移时的识别表。
// 纯数据、零依赖；context 为常见公开值（token），用户可随时在设置页改。
// 预设不预填模型名（presetToProfile 一律 model:''，用户自行填写），
// 旧版种子默认模型记录在 legacyModel 字段，迁移时用于识别并清空。
// 注意：豆包（火山方舟）部分账号需要用"推理接入点 ID（ep-xxx）"当模型名，UI 有提示。

import type { ModelProfile } from './types'

export interface ModelPreset {
  id: string
  name: string
  baseUrl: string
  /** 旧版种子默认模型（仅用于迁移时比对清空，新预设不再预填） */
  legacyModel: string
  context: number
  multimodal: boolean
  /** API 协议：缺省 'openai' 兼容；'anthropic' 原生 Messages；'gemini' 原生 generateContent */
  protocol?: 'openai' | 'anthropic' | 'gemini'
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: 'p-deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    legacyModel: 'deepseek-chat',
    context: 131072,
    multimodal: false
  },
  {
    id: 'p-glm',
    name: 'GLM 智谱',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    legacyModel: 'glm-4.6',
    context: 200000,
    multimodal: false
  },
  {
    id: 'p-qwen',
    name: '千问 DashScope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    legacyModel: 'qwen-plus',
    context: 131072,
    multimodal: false
  },
  {
    id: 'p-kimi',
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    legacyModel: 'moonshot-v1-8k',
    context: 8192,
    multimodal: false
  },
  {
    id: 'p-doubao',
    name: '豆包 火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    legacyModel: 'doubao-seed-1-6',
    context: 256000,
    multimodal: true
  },
  {
    id: 'p-mimo',
    name: 'MiMo 小米',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    legacyModel: '',
    context: 1048576,
    multimodal: false
  },
  {
    id: 'p-minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.cn/v1',
    legacyModel: '',
    context: 1048576,
    multimodal: true
  },
  {
    id: 'p-claude',
    name: 'Claude（Anthropic 官方）',
    baseUrl: 'https://api.anthropic.com',
    legacyModel: '',
    context: 200000,
    multimodal: true,
    protocol: 'anthropic'
  },
  {
    id: 'p-gemini',
    name: 'Gemini（Google 官方）',
    baseUrl: 'https://generativelanguage.googleapis.com',
    legacyModel: '',
    context: 1048576,
    // 默认不开多模态：预置档案模型名为空、key 也没配，开着只会让它出现在「视觉档案」
    // 候选里干扰选择（owner 拍板）。真要用 Gemini 看图，编辑档案勾上即可。
    multimodal: false,
    protocol: 'gemini'
  }
]

/** 按.baseUrl 识别厂商（旧配置迁移时给档案起名/补上下文）；未命中返回 null */
export function matchPresetByBaseUrl(baseUrl: string): ModelPreset | null {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  return MODEL_PRESETS.find((preset) => preset.baseUrl.replace(/\/+$/, '') === normalized) ?? null
}

/** 预设 → 档案（模型名留空，未配 key 的空档案） */
export function presetToProfile(preset: ModelPreset): ModelProfile {
  return {
    id: preset.id,
    name: preset.name,
    protocol: preset.protocol ?? 'openai',
    baseUrl: preset.baseUrl,
    model: '',
    context: preset.context,
    multimodal: preset.multimodal
  }
}
