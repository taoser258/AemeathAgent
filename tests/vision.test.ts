// 视觉旁路单测（P8-T3 第一条腿）：
// 「非多模态模型也能"看见"图片」这条承诺的守护——选档规则、缓存按内容 hash、
// 失败收敛、以及 describe_image 工具端到端（注入假探针，与 active_window 同款）。
// 真实 LLM 调用不在单测范围（vi.mock 掉 streamChat）。

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelProfile } from '../src/shared/types'
import { visionFailureNote, visionTranscriptionNote } from '../src/main/chat/history'

const streamChatMock = vi.fn()
vi.mock('../src/main/llm/client', () => ({
  streamChat: (...args: unknown[]) => streamChatMock(...args)
}))

const {
  VISION_AUTO,
  VISION_OFF,
  VISION_CACHE_MAX,
  clearVisionCache,
  describeCacheKey,
  describeImage,
  makeVisionRunner,
  pickVisionProfile,
  visionCacheSize,
  visionUnavailableHint
} = await import('../src/main/llm/vision')
const { executeToolCall, setDescribeImageProbe, setToolPathBase } =
  await import('../src/main/agent/tools/registry')

function prof(id: string, opts: { multimodal?: boolean } = {}): ModelProfile {
  return {
    id,
    name: `档案-${id}`,
    protocol: 'openai',
    baseUrl: 'https://api.example/v1',
    model: `${id}-model`,
    context: 32000,
    multimodal: opts.multimodal === true
  }
}

const IMG_A = 'data:image/png;base64,AAAA'
const IMG_B = 'data:image/png;base64,BBBB'

describe('视觉旁路 · 选档（pickVisionProfile）', () => {
  const profiles = [
    prof('main'),
    prof('vision', { multimodal: true }),
    prof('vision2', { multimodal: true })
  ]
  const hasKey = (id: string): boolean => id !== 'vision2' // vision2 没配密钥

  it('设置选了「不做转述」→ 直接拒绝（不偷偷花钱）', () => {
    const r = pickVisionProfile({ profiles, activeId: 'main', visionProfileId: VISION_OFF, hasKey })
    expect(r).toEqual({ ok: false, reason: 'off' })
  })

  it('指定了具体档案 → 只用它（缺密钥/已被删如实报错，不换人）', () => {
    const ok = pickVisionProfile({
      profiles,
      activeId: 'main',
      visionProfileId: 'vision',
      hasKey
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.profile.id).toBe('vision')
    expect(
      pickVisionProfile({ profiles, activeId: 'main', visionProfileId: 'vision2', hasKey })
    ).toEqual({ ok: false, reason: 'no-key' })
    expect(
      pickVisionProfile({ profiles, activeId: 'main', visionProfileId: 'deleted', hasKey })
    ).toEqual({ ok: false, reason: 'missing-profile' })
  })

  it('自动：优先用激活档案自己（它多模态且有密钥）', () => {
    const r = pickVisionProfile({
      profiles,
      activeId: 'vision',
      visionProfileId: VISION_AUTO,
      hasKey
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.profile.id).toBe('vision')
  })

  it('自动：激活档案不能看图 → 挑第一个"开多模态且有密钥"的', () => {
    const r = pickVisionProfile({
      profiles,
      activeId: 'main',
      visionProfileId: VISION_AUTO,
      hasKey
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.profile.id).toBe('vision') // vision2 没密钥 → 跳过
  })

  it('自动：一个可用的都没有 → unavailable（调用方回退成"看不到图"提示）', () => {
    const r = pickVisionProfile({
      profiles: [prof('main'), prof('vision', { multimodal: true })],
      activeId: 'main',
      visionProfileId: VISION_AUTO,
      hasKey: () => false
    })
    expect(r).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('每种失败都有可执行的下一步文案', () => {
    expect(visionUnavailableHint('off')).toContain('设置')
    expect(visionUnavailableHint('missing-profile')).toContain('重新选')
    expect(visionUnavailableHint('no-key')).toContain('API Key')
    expect(visionUnavailableHint('unavailable')).toContain('多模态')
  })
})

describe('视觉旁路 · 缓存与调用', () => {
  beforeEach(() => {
    clearVisionCache()
    streamChatMock.mockReset()
  })

  it('缓存键 = 图片内容 hash：同图同键、异图异键', () => {
    expect(describeCacheKey(IMG_A)).toBe(describeCacheKey(IMG_A))
    expect(describeCacheKey(IMG_A)).not.toBe(describeCacheKey(IMG_B))
  })

  it('同图只调用一次（第二次命中缓存）', async () => {
    streamChatMock.mockResolvedValue({ text: '【文字照抄】收入 1234' })
    const p = prof('vision', { multimodal: true })
    const first = await describeImage({ profile: p, apiKey: 'k', dataUrl: IMG_A })
    const second = await describeImage({ profile: p, apiKey: 'k', dataUrl: IMG_A })
    expect(first).toEqual({ ok: true, text: '【文字照抄】收入 1234', cached: false })
    expect(second).toEqual({ ok: true, text: '【文字照抄】收入 1234', cached: true })
    expect(streamChatMock).toHaveBeenCalledTimes(1)
  })

  it('请求形状：不带 tools、温度 0、图片作为 image_url part 传入', async () => {
    streamChatMock.mockResolvedValue({ text: '描述' })
    await describeImage({
      profile: prof('vision', { multimodal: true }),
      apiKey: 'k',
      dataUrl: IMG_A,
      question: '第三行是多少'
    })
    const req = streamChatMock.mock.calls[0][0] as {
      temperature: number
      tools?: unknown
      messages: Array<{ role: string; content: unknown }>
    }
    expect(req.tools).toBeUndefined()
    expect(req.temperature).toBe(0)
    const user = req.messages[1]
    const parts = user.content as Array<{ type: string }>
    expect(parts.map((x) => x.type)).toEqual(['text', 'image_url'])
  })

  it('问句会拼进提示（通用转述 + 追问）', async () => {
    streamChatMock.mockResolvedValue({ text: '描述' })
    await describeImage({
      profile: prof('vision', { multimodal: true }),
      apiKey: 'k',
      dataUrl: IMG_B,
      question: '表格里最大的数是多少'
    })
    const req = streamChatMock.mock.calls[0][0] as {
      messages: Array<{ content: Array<{ type: string; text?: string }> }>
    }
    const text = req.messages[1].content[0].text ?? ''
    expect(text).toContain('文字照抄')
    expect(text).toContain('表格里最大的数是多少')
  })

  it('空描述 → 可读失败（不当作"看过了"）', async () => {
    streamChatMock.mockResolvedValue({ text: '   ' })
    const r = await describeImage({ profile: prof('v'), apiKey: 'k', dataUrl: IMG_A })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('空描述')
  })

  it('调用抛错 → 收敛为可读错误（不抛、不阻断对话）', async () => {
    streamChatMock.mockRejectedValue(Object.assign(new Error('fetch failed'), { status: 500 }))
    const r = await describeImage({ profile: prof('v'), apiKey: 'k', dataUrl: IMG_A })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('500')
  })

  it('缓存有上限：写满后淘汰最早一条（不会无限涨）', async () => {
    streamChatMock.mockResolvedValue({ text: 'x' })
    const p = prof('vision')
    for (let i = 0; i < VISION_CACHE_MAX + 3; i += 1) {
      await describeImage({ profile: p, apiKey: 'k', dataUrl: `data:image/png;base64,${i}` })
    }
    expect(visionCacheSize()).toBeLessThanOrEqual(VISION_CACHE_MAX)
    expect(visionCacheSize()).toBe(VISION_CACHE_MAX)
    // 最新那张还在（命中），最早那张已被淘汰（重新调用）
    streamChatMock.mockClear()
    await describeImage({
      profile: p,
      apiKey: 'k',
      dataUrl: `data:image/png;base64,${VISION_CACHE_MAX + 2}`
    })
    expect(streamChatMock).not.toHaveBeenCalled()
  })
})

describe('视觉旁路 · 注入注脚（history）', () => {
  it('转述注脚标明来源与三条引用纪律', () => {
    const note = visionTranscriptionNote('截图.png', '千问视觉', '【文字照抄】收入 1234')
    expect(note).toContain('转述')
    expect(note).toContain('千问视觉')
    expect(note).toContain('据识图转述')
    expect(note).toContain('核对')
    expect(note).toContain('ocr_image')
    expect(note).toContain('截图.png')
  })

  it('★ 转述注脚必须警告：聊天图片无路径，对它调 ocr_image 必然 ENOENT（owner 实测全盘搜索事故）', () => {
    const note = visionTranscriptionNote('粘贴图片-080902.png', '千问视觉', '内容')
    expect(note).toContain('没有磁盘路径')
    expect(note).toContain('ENOENT')
  })

  it('失败注脚要求"如实说看不到"，不许编', () => {
    const note = visionFailureNote('a.png', '网络错误')
    expect(note).toContain('a.png')
    expect(note).toContain('网络错误')
    expect(note).toContain('不要凭空描述')
  })
})

describe('describe_image 工具（端到端，注入假探针）', () => {
  let tmp = ''

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aemeath-vision-'))
    setToolPathBase(tmp)
    writeFileSync(join(tmp, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(join(tmp, 'note.txt'), 'hi')
  })

  afterEach(() => {
    setDescribeImageProbe(null)
    rmSync(tmp, { recursive: true, force: true })
  })

  it('正常路径：把 dataUrl 与问句交给探针，返回转述文本', async () => {
    const calls: Array<{ url: string; question: string | null }> = []
    setDescribeImageProbe(async (dataUrl, question) => {
      calls.push({ url: dataUrl, question })
      return '【文字照抄】hello'
    })
    const r = await executeToolCall(
      'describe_image',
      JSON.stringify({ path: join(tmp, 'shot.png'), question: '图里写了什么' }),
      new AbortController().signal,
      's1'
    )
    expect(r.ok).toBe(true)
    expect(r.result).toContain('hello')
    expect(calls[0].url.startsWith('data:image/png;base64,')).toBe(true)
    expect(calls[0].question).toBe('图里写了什么')
  })

  it('非图片扩展名 → 明确报错并指路（PDF 走 read_file）', async () => {
    setDescribeImageProbe(async () => '不该被调用')
    const r = await executeToolCall(
      'describe_image',
      JSON.stringify({ path: join(tmp, 'note.txt') }),
      new AbortController().signal
    )
    expect(r.ok).toBe(false)
    expect(r.result).toContain('read_file')
  })

  it('探针抛错（未配视觉档案）→ 收敛为可读失败，不抛异常', async () => {
    setDescribeImageProbe(async () => {
      throw new Error('没有可用的视觉档案——请到 设置 → 模型 开启「多模态」')
    })
    const r = await executeToolCall(
      'describe_image',
      JSON.stringify({ path: join(tmp, 'shot.png') }),
      new AbortController().signal
    )
    expect(r.ok).toBe(false)
    expect(r.result).toContain('视觉档案')
  })

  it('探针未注入（应用还没就绪）→ 明说未就绪', async () => {
    const r = await executeToolCall(
      'describe_image',
      JSON.stringify({ path: join(tmp, 'shot.png') }),
      new AbortController().signal
    )
    expect(r.ok).toBe(false)
    expect(r.result).toContain('尚未就绪')
  })
})

describe('makeVisionRunner（工具侧接线）', () => {
  beforeEach(() => {
    clearVisionCache()
    streamChatMock.mockReset()
  })

  const config = (
    visionProfileId: string
  ): { model: { profiles: ModelProfile[]; activeId: string; visionProfileId: string } } => ({
    model: {
      profiles: [prof('main'), prof('vision', { multimodal: true })],
      activeId: 'main',
      visionProfileId
    }
  })

  it('自动选档 → 转述成功返回文本', async () => {
    streamChatMock.mockResolvedValue({ text: '【语义摘要】一张报表截图' })
    const run = makeVisionRunner({
      readConfig: () => config('') as never,
      readKey: (id) => (id === 'vision' ? 'k' : null)
    })
    const text = await run(IMG_A, null, new AbortController().signal)
    expect(text).toContain('报表截图')
  })

  it('选不出档案 → 抛出可读原因（工具层会转成 failed 回灌给模型）', async () => {
    const run = makeVisionRunner({
      readConfig: () => config('') as never,
      readKey: () => null
    })
    await expect(run(IMG_A, null, new AbortController().signal)).rejects.toThrow('视觉档案')
  })
})
