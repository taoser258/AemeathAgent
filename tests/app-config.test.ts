import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APP_CONFIG,
  applySettingsPatch,
  mergeAppConfig,
  readAppConfig,
  writeAppConfig
} from '../src/main/settings/app-config'

// 每个用例独立临时目录，避免互相污染
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'aemeath-config-'))
}

describe('settings/app-config', () => {
  it('部分写入的字段补全默认值（旧版本文件兼容）', () => {
    const merged = mergeAppConfig({ model: { baseUrl: 'https://example.com/v1' } })
    expect(merged.model.baseUrl).toBe('https://example.com/v1')
    expect(merged.model.model).toBe(DEFAULT_APP_CONFIG.model.model)
    expect(merged.model.temperature).toBe(DEFAULT_APP_CONFIG.model.temperature)
    expect(merged.pet).toEqual(DEFAULT_APP_CONFIG.pet)
  })

  it('类型不对的字段一律回退默认（坐标非法按"没有记忆"处理）', () => {
    const merged = mergeAppConfig({ pet: { x: 'abc', y: NaN, clickThrough: 'yes' } })
    expect(merged.pet.x).toBeNull()
    expect(merged.pet.y).toBeNull()
    expect(merged.pet.clickThrough).toBe(false)
  })

  it('损坏的 app.json → 整体回退默认配置（首次运行/手改坏不崩溃）', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'app.json'), '{oops', 'utf8')
    expect(readAppConfig(dir)).toEqual(DEFAULT_APP_CONFIG)

    // 合法 JSON 但不是对象，同样回退
    writeFileSync(join(dir, 'app.json'), '"hi"', 'utf8')
    expect(readAppConfig(dir)).toEqual(DEFAULT_APP_CONFIG)
    rmSync(dir, { recursive: true, force: true })
  })

  it('文件不存在 → 默认配置', () => {
    const dir = tempDir()
    expect(readAppConfig(dir)).toEqual(DEFAULT_APP_CONFIG)
    rmSync(dir, { recursive: true, force: true })
  })

  it('读写往返：写出的字段原样读回（含 pet 坐标与穿透状态）', () => {
    const dir = tempDir()
    const config = mergeAppConfig({ pet: { x: 123, y: 456, clickThrough: true } })
    writeAppConfig(dir, config)
    expect(readAppConfig(dir)).toEqual(config)
    expect(JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8')).pet.clickThrough).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('宽窗迁移（P9-T5）：旧 x 左移半窗差一次，layoutV2 置真', () => {
    // scale 0.5：半窗差 (400-260)/2*0.5 = 35
    const merged = mergeAppConfig({ pet: { x: 1000, y: 500, scale: 0.5 } })
    expect(merged.pet.x).toBe(965)
    expect(merged.pet.layoutV2).toBe(true)
    // scale 1：半窗差 70
    const big = mergeAppConfig({ pet: { x: 1000, scale: 1 } })
    expect(big.pet.x).toBe(930)
    // x 为 null：保持 null（首次运行走右下回退）
    expect(mergeAppConfig({ pet: { scale: 0.5 } }).pet.x).toBeNull()
  })

  it('宽窗迁移只做一次：layoutV2=true 后 x 不再移动', () => {
    const merged = mergeAppConfig({
      pet: { x: 1000, y: 500, scale: 0.5, layoutV2: true }
    })
    expect(merged.pet.x).toBe(1000)
  })

  it('气泡设置补丁：档位/时段/空闲分钟经防御后持久化', () => {
    const base = mergeAppConfig({})
    // 档位合法值落盘；脏值不动
    let next = applySettingsPatch(base, { pet: { bubbleLevel: 'off' } })
    expect(next.pet.bubbleLevel).toBe('off')
    next = applySettingsPatch(base, { pet: { bubbleLevel: 'weird' as never } })
    expect(next.pet.bubbleLevel).toBe(base.pet.bubbleLevel)
    // 时段：合法落盘，非法回退当前值
    next = applySettingsPatch(base, { pet: { bubbleDndStart: '22:00' } })
    expect(next.pet.bubbleDndStart).toBe('22:00')
    next = applySettingsPatch(base, { pet: { bubbleDndEnd: '99:99' } })
    expect(next.pet.bubbleDndEnd).toBe(base.pet.bubbleDndEnd)
    // 空闲：0 与 5–240 落盘；脏值不动
    next = applySettingsPatch(base, { pet: { bubbleIdleMin: 0 } })
    expect(next.pet.bubbleIdleMin).toBe(0)
    next = applySettingsPatch(base, { pet: { bubbleIdleMin: 60 } })
    expect(next.pet.bubbleIdleMin).toBe(60)
    next = applySettingsPatch(base, { pet: { bubbleIdleMin: 999 } })
    expect(next.pet.bubbleIdleMin).toBe(base.pet.bubbleIdleMin)
    // 补丁不可夹带位置/穿透字段（类型外字段无效）
    next = applySettingsPatch(base, { pet: { clickThrough: true } } as never)
    expect(next.pet.clickThrough).toBe(base.pet.clickThrough)
  })

  it('工具可见性：缺省全 all；数组去重保留；脏值/空数组回退 all（防自锁）', () => {
    const merged = mergeAppConfig({
      tools: { visibility: { work: ['current_time', 'read_file', 'read_file'], learn: 'all' } }
    })
    expect(merged.tools.visibility.work).toEqual(['current_time', 'read_file'])
    expect(merged.tools.visibility.learn).toBe('all')
    const dirty = mergeAppConfig({ tools: { visibility: { work: [], learn: 42 } } })
    expect(dirty.tools.visibility).toEqual({ work: 'all', learn: 'all' })
    const broken = mergeAppConfig({ tools: { visibility: 'nope' } })
    expect(broken.tools.visibility).toEqual({ work: 'all', learn: 'all' })
    expect(mergeAppConfig({}).tools.visibility).toEqual({ work: 'all', learn: 'all' })
    // 读写往返：物化后的 allowlist 落盘不丢
    const dir = tempDir()
    writeAppConfig(dir, merged)
    expect(readAppConfig(dir).tools.visibility).toEqual(merged.tools.visibility)
    rmSync(dir, { recursive: true, force: true })
  })

  it('工具可见性 patch：按键局部合并——只带 work 不动 learn，与 permissionMode 互不干扰', () => {
    const base = mergeAppConfig({
      tools: { visibility: { work: ['current_time'], learn: ['note_read'] } }
    })
    const next = applySettingsPatch(base, { tools: { visibility: { work: 'all' } } })
    expect(next.tools.visibility.work).toBe('all')
    expect(next.tools.visibility.learn).toEqual(['note_read'])
    const next2 = applySettingsPatch(base, { tools: { permissionMode: 'plan' } })
    expect(next2.tools.permissionMode).toBe('plan')
    expect(next2.tools.visibility).toEqual({ work: ['current_time'], learn: ['note_read'] })
  })

  it('聊天行为（P8-T1）：自动压缩缺省开；只有显式 false 才关；patch 只改这一项', () => {
    expect(mergeAppConfig({}).chat.autoCompact).toBe(true)
    expect(
      mergeAppConfig({ chat: { autoCompact: 'x' as unknown as boolean } }).chat.autoCompact
    ).toBe(true)
    expect(mergeAppConfig({ chat: { autoCompact: false } }).chat.autoCompact).toBe(false)
    const next = applySettingsPatch(mergeAppConfig({}), { chat: { autoCompact: false } })
    expect(next.chat.autoCompact).toBe(false)
    expect(applySettingsPatch(next, { chat: { autoCompact: true } }).chat.autoCompact).toBe(true)
    // 不传 chat 的 patch 不动它
    expect(applySettingsPatch(next, { ui: { notesCard: true } }).chat.autoCompact).toBe(false)
  })

  it('视觉档案（P8-T3）：缺省自动；脏值回退自动；patch 只改这一项、不动档案表', () => {
    expect(mergeAppConfig({}).model.visionProfileId).toBe('')
    expect(mergeAppConfig({ model: { visionProfileId: ' p-claude ' } }).model.visionProfileId).toBe(
      'p-claude'
    )
    expect(
      mergeAppConfig({ model: { visionProfileId: 42 as unknown as string } }).model.visionProfileId
    ).toBe('')
    const base = mergeAppConfig({})
    const next = applySettingsPatch(base, { model: { visionProfileId: 'off' } })
    expect(next.model.visionProfileId).toBe('off')
    expect(next.model.profiles).toEqual(base.model.profiles) // 档案表未被顺手改写
    expect(next.model.activeId).toBe(base.model.activeId)
  })

  it('档案新字段（P8-T4）：输出上限与思考档位被保留；脏值丢弃；缺省即"没有"', () => {
    const merged = mergeAppConfig({
      model: {
        profiles: [
          {
            id: 'p1',
            name: '甲',
            protocol: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
            model: 'claude',
            context: 200000,
            maxOutput: 32000,
            multimodal: false,
            reasoningEffort: 'xhigh',
            reasoningLevels: ['low', 'xhigh', '不是档位']
          }
        ],
        activeId: 'p1'
      }
    })
    const p = merged.model.profiles.find((x) => x.id === 'p1')
    expect(p?.maxOutput).toBe(32000)
    expect(p?.reasoningEffort).toBe('xhigh')
    expect(p?.reasoningLevels).toEqual(['low', 'xhigh'])
    // 旧配置（没有这些字段）读出来不炸，且不会凭空造出字段
    const legacy = mergeAppConfig({ model: { baseUrl: 'https://x/v1', model: 'm' } })
    expect(legacy.model.profiles[0].reasoningLevels).toBeUndefined()
    expect(legacy.model.profiles[0].maxOutput).toBeUndefined()
    // 脏值：非正数上限丢弃、非法档位丢弃
    const dirty = mergeAppConfig({
      model: {
        profiles: [
          {
            id: 'p2',
            baseUrl: 'https://x/v1',
            model: 'm',
            context: 0,
            maxOutput: -1,
            reasoningEffort: '超级高',
            reasoningLevels: 'low'
          }
        ],
        activeId: 'p2'
      }
    })
    const q = dirty.model.profiles.find((x) => x.id === 'p2')
    expect(q?.maxOutput).toBeUndefined()
    expect(q?.reasoningEffort).toBeUndefined()
    expect(q?.reasoningLevels).toBeUndefined()
  })

  it('P9-T1 思考参数风格：合法值保留，脏值丢弃（=自动识别），旧配置不凭空造字段', () => {
    const merged = mergeAppConfig({
      model: {
        profiles: [
          {
            id: 'p1',
            baseUrl: 'https://api.deepseek.com/v1',
            model: 'm',
            reasoningAdapter: 'deepseek'
          },
          { id: 'p2', baseUrl: 'https://x/v1', model: 'm', reasoningAdapter: 'bytedance' },
          { id: 'p3', baseUrl: 'https://x/v1', model: 'm', reasoningAdapter: 42 }
        ],
        activeId: 'p1'
      }
    })
    expect(merged.model.profiles.find((x) => x.id === 'p1')?.reasoningAdapter).toBe('deepseek')
    expect(merged.model.profiles.find((x) => x.id === 'p2')?.reasoningAdapter).toBeUndefined()
    expect(merged.model.profiles.find((x) => x.id === 'p3')?.reasoningAdapter).toBeUndefined()
    // 旧配置无该字段
    const legacy = mergeAppConfig({ model: { baseUrl: 'https://x/v1', model: 'm' } })
    expect(legacy.model.profiles[0].reasoningAdapter).toBeUndefined()
  })

  it('技能禁用名单：去重去空白；脏值回退空（全启用）；patch 整表替换', () => {
    const merged = mergeAppConfig({ skills: { disabled: [' a ', 'a', 'b', 42] } })
    expect(merged.skills.disabled).toEqual(['a', 'b'])
    expect(mergeAppConfig({}).skills.disabled).toEqual([])
    expect(mergeAppConfig({ skills: { disabled: 'nope' } }).skills.disabled).toEqual([])
    const next = applySettingsPatch(merged, { skills: { disabled: ['c'] } })
    expect(next.skills.disabled).toEqual(['c'])
    // 旧配置文件无 skills 字段 → 默认空名单（全启用兼容）
    expect(mergeAppConfig({ pet: { x: 1 } }).skills).toEqual({ disabled: [] })
  })

  it('工作区绑定：非空字符串归一；空串/脏值回退 null；patch 按键局部替换', () => {
    const merged = mergeAppConfig({
      workspace: { work: ' E:\\proj ', learn: ' D:\\notes ' }
    })
    expect(merged.workspace.work).toBe('E:\\proj')
    expect(merged.workspace.learn).toBe('D:\\notes')
    expect(mergeAppConfig({}).workspace).toEqual({ work: null, learn: null })
    expect(
      mergeAppConfig({ workspace: { work: 'x', learn: 42 as unknown as string } }).workspace
    ).toEqual({
      work: 'x',
      learn: null
    })
    // 只带 work 不动 learn；清空 = 传 null
    const next = applySettingsPatch(merged, { workspace: { work: null } })
    expect(next.workspace.work).toBeNull()
    expect(next.workspace.learn).toBe('D:\\notes')
    const next2 = applySettingsPatch(merged, { workspace: { learn: 'E:\\vault' } })
    expect(next2.workspace.learn).toBe('E:\\vault')
    expect(next2.workspace.work).toBe('E:\\proj')
  })

  it('MCP 服务器 patch', () => {
    const base = mergeAppConfig({})
    expect(base.mcp.servers).toEqual([])
    const servers = [
      {
        id: 'fs',
        name: '文件',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:\\dir'],
        enabled: true
      },
      { id: '', name: '缺 id 应丢弃', command: 'x', args: [], enabled: true }
    ]
    const next = applySettingsPatch(base, { mcp: { servers } })
    expect(next.mcp.servers).toHaveLength(1)
    expect(next.mcp.servers[0]).toMatchObject({ id: 'fs', enabled: true })
    // 整表替换语义：空表 = 全部移除
    const next2 = applySettingsPatch(next, { mcp: { servers: [] } })
    expect(next2.mcp.servers).toEqual([])
  })
})

describe('settings/app-config · T4 模型档案（只增不改）', () => {
  it('默认配置预置主流厂商档案，激活千问且镜像同步', () => {
    const c = DEFAULT_APP_CONFIG
    expect(c.model.profiles.map((p) => p.id)).toEqual([
      'p-deepseek',
      'p-glm',
      'p-qwen',
      'p-kimi',
      'p-doubao',
      'p-mimo',
      'p-minimax',
      'p-claude',
      'p-gemini'
    ])
    expect(c.model.activeId).toBe('p-qwen')
    // 预设档案不预填模型名
    expect(c.model.profiles.every((p) => p.model === '')).toBe(true)
    const active = c.model.profiles.find((p) => p.id === 'p-qwen')
    expect(c.model.baseUrl).toBe(active?.baseUrl)
    expect(c.model.model).toBe(active?.model)
  })

  it('预设档案里的历史种子默认模型（glm-4.6 等）在合并时自动清空', () => {
    const merged = mergeAppConfig({
      model: {
        profiles: [
          {
            id: 'p-glm',
            name: 'GLM 智谱',
            protocol: 'openai',
            baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
            model: 'glm-4.6',
            context: 0,
            multimodal: false
          },
          {
            id: 'p-qwen',
            name: '千问 DashScope',
            protocol: 'openai',
            baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            model: 'qwen-max',
            context: 131072,
            multimodal: false
          }
        ]
      }
    })
    const glm = merged.model.profiles.find((p) => p.id === 'p-glm')
    const qwen = merged.model.profiles.find((p) => p.id === 'p-qwen')
    expect(glm?.model).toBe('') // 种子默认值 → 清空
    expect(qwen?.model).toBe('qwen-max') // 用户自填的非种子值 → 保留
  })

  it('旧版 app.json（无 profiles）自动迁移：镜像合成档案继承预设 id + 补入其余预设', () => {
    const merged = mergeAppConfig({
      model: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max' }
    })
    const legacy = merged.model.profiles.find((p) => p.id === 'p-qwen')
    expect(legacy?.name).toBe('千问 DashScope') // baseUrl 命中预设 → 厂商名
    expect(legacy?.model).toBe('qwen-max') // 保留用户自己的模型名
    expect(legacy?.context).toBe(131072) // 预设的上下文
    expect(merged.model.profiles.length).toBeGreaterThanOrEqual(5)
    expect(merged.model.activeId).toBe('p-qwen')
    expect(merged.model.baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
  })

  it('已迁移配置里的 default 档案自动归位预设 id（获得不可删身份，activeId 跟随）', () => {
    const merged = mergeAppConfig({
      model: {
        activeId: 'default',
        profiles: [
          {
            id: 'default',
            name: 'GLM 智谱',
            protocol: 'openai',
            baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
            model: 'glm-4.6',
            context: 0,
            multimodal: false
          },
          {
            id: 'p-deepseek',
            name: 'DeepSeek',
            protocol: 'openai',
            baseUrl: 'https://api.deepseek.com/v1',
            model: 'deepseek-chat',
            context: 131072,
            multimodal: false
          }
        ]
      }
    })
    const glm = merged.model.profiles.find((p) => p.baseUrl.includes('bigmodel'))
    expect(glm?.id).toBe('p-glm')
    expect(merged.model.profiles.some((p) => p.id === 'default')).toBe(false)
    expect(merged.model.activeId).toBe('p-glm')
    // 去重后不产生两条 p-glm
    expect(merged.model.profiles.filter((p) => p.id === 'p-glm')).toHaveLength(1)
  })

  it('profiles 在磁盘上原样保留（往返幂等）', () => {
    const once = mergeAppConfig(DEFAULT_APP_CONFIG)
    const twice = mergeAppConfig(once)
    expect(twice).toEqual(once)
  })

  it('applySettingsPatch：切换 activeId 后镜像同步到该档案', () => {
    const next = applySettingsPatch(DEFAULT_APP_CONFIG, {
      model: { activeId: 'p-deepseek' }
    })
    expect(next.model.activeId).toBe('p-deepseek')
    expect(next.model.baseUrl).toBe('https://api.deepseek.com/v1')
    // 预设不预填模型名：镜像跟随档案的空模型名
    expect(next.model.model).toBe('')
  })

  it('applySettingsPatch：非法档案被丢弃；全部删光时兜底合成，activeId 恒有效', () => {
    const broken = applySettingsPatch(DEFAULT_APP_CONFIG, {
      model: { profiles: [{ id: '', baseUrl: '', model: '' }] }
    })
    expect(broken.model.profiles.length).toBeGreaterThanOrEqual(1)
    expect(broken.model.profiles.some((p) => p.id === broken.model.activeId)).toBe(true)

    const emptied = applySettingsPatch(DEFAULT_APP_CONFIG, {
      model: {
        profiles: [
          {
            id: 'x',
            name: 'x',
            protocol: 'openai',
            baseUrl: 'https://x/v1',
            model: 'm',
            context: 0,
            multimodal: false
          }
        ]
      }
      // 随后清空：patch 数组为空 → 兜底
    })
    void emptied
    const cleared = applySettingsPatch(DEFAULT_APP_CONFIG, { model: { profiles: [] } })
    expect(cleared.model.profiles.length).toBeGreaterThanOrEqual(1)
    expect(cleared.model.profiles.some((p) => p.id === cleared.model.activeId)).toBe(true)
  })

  it('applySettingsPatch：温度越界被钳制在 0–2', () => {
    const next = applySettingsPatch(DEFAULT_APP_CONFIG, { model: { temperature: 9 } })
    expect(next.model.temperature).toBe(2)
  })

  it('人设名归一：demo（已删除）与空值自动迁移到 aemeath', () => {
    expect(mergeAppConfig({ persona: { active: 'demo' } }).persona.active).toBe('aemeath')
    expect(mergeAppConfig({ persona: { active: '  ' } }).persona.active).toBe('aemeath')
    expect(mergeAppConfig({ persona: { active: 'aemeath' } }).persona.active).toBe('aemeath')
  })
})

// ── ：权限模式字段（只增不改） ──

describe('settings/app-config · T3 权限模式', () => {
  it('mergeAppConfig：缺省/非法 permissionMode 回退 confirm，合法值保留', () => {
    const d = mergeAppConfig({})
    expect(d.tools.permissionMode).toBe('confirm')
    const p = mergeAppConfig({ tools: { permissionMode: 'plan' } })
    expect(p.tools.permissionMode).toBe('plan')
    const bad = mergeAppConfig({ tools: { permissionMode: 'yolo' } })
    expect(bad.tools.permissionMode).toBe('confirm')
  })

  it('applySettingsPatch：可切换三种模式；tools 补丁不影响 model/persona', () => {
    const base = structuredClone(DEFAULT_APP_CONFIG)
    const next = applySettingsPatch(base, { tools: { permissionMode: 'full' } })
    expect(next.tools.permissionMode).toBe('full')
    expect(next.persona.active).toBe(base.persona.active)
    const back = applySettingsPatch(next, { tools: { permissionMode: 'confirm' } })
    expect(back.tools.permissionMode).toBe('confirm')
    // 旧版 allowedRoots 字段读入时被忽略，不报错
    const legacy = mergeAppConfig({ tools: { permissionMode: 'full', allowedRoots: ['C:/lab'] } })
    expect(legacy.tools.permissionMode).toBe('full')
    expect('allowedRoots' in legacy.tools).toBe(false)
  })
})

describe('settings/app-config · 用户个人信息（反馈批次④）', () => {
  it('缺省 = 空资料：昵称/自述空串、头像 null（不会凭空注入用户信息）', () => {
    expect(mergeAppConfig({}).user).toEqual({ nickname: '', avatar: null, about: '' })
    expect(DEFAULT_APP_CONFIG.user).toEqual({ nickname: '', avatar: null, about: '' })
  })

  it('昵称/自述 trim 并限长；合法头像 dataURL 原样保留', () => {
    const merged = mergeAppConfig({
      user: {
        nickname: `  ${'长'.repeat(60)}  `,
        about: '  一段测试自述  ',
        avatar: 'data:image/png;base64,AAAA'
      }
    })
    expect(merged.user.nickname).toHaveLength(40)
    expect(merged.user.nickname).toBe('长'.repeat(40))
    expect(merged.user.about).toBe('一段测试自述')
    expect(merged.user.avatar).toBe('data:image/png;base64,AAAA')
  })

  it('头像防御：外链 / 超长 / 非字符串一律归 null（防手改 app.json 引外链或塞爆）', () => {
    expect(
      mergeAppConfig({ user: { avatar: 'https://evil.example/a.png' } }).user.avatar
    ).toBeNull()
    expect(mergeAppConfig({ user: { avatar: 'file:///C:/a.png' } }).user.avatar).toBeNull()
    expect(mergeAppConfig({ user: { avatar: 123 } }).user.avatar).toBeNull()
    const huge = `data:image/png;base64,${'A'.repeat(600_000)}`
    expect(mergeAppConfig({ user: { avatar: huge } }).user.avatar).toBeNull()
  })

  it('自述限长 2000 字（防手改 app.json 塞爆配置）', () => {
    expect(mergeAppConfig({ user: { about: 'x'.repeat(3000) } }).user.about).toHaveLength(2000)
  })

  it('patch 按键局部替换：只改昵称不动头像/自述；头像传 null 即清空', () => {
    const base = mergeAppConfig({
      user: { nickname: '旧名', about: '旧自述', avatar: 'data:image/png;base64,AAAA' }
    })
    const renamed = applySettingsPatch(base, { user: { nickname: '新名' } })
    expect(renamed.user).toEqual({
      nickname: '新名',
      about: '旧自述',
      avatar: 'data:image/png;base64,AAAA'
    })
    const cleared = applySettingsPatch(base, { user: { avatar: null } })
    expect(cleared.user.avatar).toBeNull()
    expect(cleared.user.nickname).toBe('旧名')
    expect(cleared.user.about).toBe('旧自述')
  })
})

describe('settings/app-config · MCP 配置防御', () => {
  const baseServer = {
    id: 'm1',
    name: '文件系统',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    enabled: true
  }

  it('env 只收合法键名的字符串值（键名必须能当环境变量名）', () => {
    const merged = mergeAppConfig({
      mcp: {
        servers: [
          {
            ...baseServer,
            env: {
              OK_KEY: 'plain',
              TOKEN: '${secret:TOKEN}',
              'bad-key': 'x', // 含短横线：不是合法环境变量名
              '1LEADING': 'x', // 数字开头
              NUM: 123 // 非字符串
            }
          }
        ]
      }
    })
    expect(merged.mcp.servers[0].env).toEqual({ OK_KEY: 'plain', TOKEN: '${secret:TOKEN}' })
  })

  it('serverName 非法或重复一律丢弃（下游回退 id 派生，绝不让脏值进工具名）', () => {
    const merged = mergeAppConfig({
      mcp: {
        servers: [
          { ...baseServer, id: 'a', serverName: 'good-name' },
          { ...baseServer, id: 'b', serverName: '有中文' }, // 非法
          { ...baseServer, id: 'c', serverName: 'good-name' } // 与 a 重复
        ]
      }
    })
    expect(merged.mcp.servers[0].serverName).toBe('good-name')
    expect(merged.mcp.servers[1].serverName).toBeUndefined()
    expect(merged.mcp.servers[2].serverName).toBeUndefined()
  })

  it('id 重复只保留先出现的那条（后者让位，避免两个 server 抢同一命名空间）', () => {
    const merged = mergeAppConfig({
      mcp: {
        servers: [
          { ...baseServer, id: 'dup', name: '先' },
          { ...baseServer, id: 'dup', name: '后' }
        ]
      }
    })
    expect(merged.mcp.servers).toHaveLength(1)
    expect(merged.mcp.servers[0].name).toBe('先')
  })

  it('toolCallTimeoutMs 越界被钳制（下限 1s、上限 600s）；非法值丢弃', () => {
    const merged = mergeAppConfig({
      mcp: {
        servers: [
          { ...baseServer, id: 'a', toolCallTimeoutMs: 10 },
          { ...baseServer, id: 'b', toolCallTimeoutMs: 9_999_999 },
          { ...baseServer, id: 'c', toolCallTimeoutMs: 'soon' },
          { ...baseServer, id: 'd', toolCallTimeoutMs: 120_000 }
        ]
      }
    })
    expect(merged.mcp.servers.find((s) => s.id === 'a')?.toolCallTimeoutMs).toBeUndefined()
    expect(merged.mcp.servers.find((s) => s.id === 'b')?.toolCallTimeoutMs).toBe(600_000)
    expect(merged.mcp.servers.find((s) => s.id === 'c')?.toolCallTimeoutMs).toBeUndefined()
    expect(merged.mcp.servers.find((s) => s.id === 'd')?.toolCallTimeoutMs).toBe(120_000)
  })

  it('modes 归一：去重、剔除非法值、剔除 chat（chat 无工具，配了也不生效）', () => {
    const merged = mergeAppConfig({
      mcp: {
        servers: [
          { ...baseServer, id: 'a', modes: ['work', 'work', 'chat', 'bogus'] },
          { ...baseServer, id: 'b', modes: ['chat'] }, // 全被剔除 → 字段丢弃
          { ...baseServer, id: 'c', modes: ['learn'] }
        ]
      }
    })
    expect(merged.mcp.servers.find((s) => s.id === 'a')?.modes).toEqual(['work'])
    expect(merged.mcp.servers.find((s) => s.id === 'b')?.modes).toBeUndefined()
    expect(merged.mcp.servers.find((s) => s.id === 'c')?.modes).toEqual(['learn'])
  })

  it('cwd 空串/非字符串一律丢弃（不留空 cwd 给子进程）', () => {
    const merged = mergeAppConfig({
      mcp: {
        servers: [
          { ...baseServer, id: 'a', cwd: '   ' },
          { ...baseServer, id: 'b', cwd: 42 },
          { ...baseServer, id: 'c', cwd: ' D:/work ' }
        ]
      }
    })
    expect(merged.mcp.servers.find((s) => s.id === 'a')?.cwd).toBeUndefined()
    expect(merged.mcp.servers.find((s) => s.id === 'b')?.cwd).toBeUndefined()
    expect(merged.mcp.servers.find((s) => s.id === 'c')?.cwd).toBe('D:/work')
  })

  it('老配置（只有 P2 四字段）读入后行为不变：新字段全部缺省', () => {
    const merged = mergeAppConfig({ mcp: { servers: [baseServer] } })
    const s = merged.mcp.servers[0]
    expect(s.serverName).toBeUndefined()
    expect(s.env).toBeUndefined()
    expect(s.cwd).toBeUndefined()
    expect(s.toolCallTimeoutMs).toBeUndefined()
    expect(s.modes).toBeUndefined()
    expect(s.enabled).toBe(true)
  })
})

describe('预设补种与协议归位', () => {
  it('★ 老配置（磁盘已有档案、无 p-gemini）升级后自动补出新预设', () => {
    // 模拟 T6 之前落盘的配置：有 6 条旧预设 + 1 条用户自建，没有 p-gemini
    const oldOnDisk = {
      model: {
        profiles: [
          {
            id: 'p-deepseek',
            name: 'DeepSeek',
            protocol: 'openai',
            baseUrl: 'https://api.deepseek.com/v1',
            model: 'deepseek-chat',
            context: 131072,
            multimodal: false
          },
          {
            id: 'p-claude',
            name: 'Claude',
            protocol: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
            model: 'claude-sonnet-4',
            context: 200000,
            multimodal: true
          },
          {
            id: 'p-mine',
            name: '我的自定义',
            protocol: 'openai',
            baseUrl: 'https://my.gateway.example/v1',
            model: 'm1',
            context: 8000,
            multimodal: false
          }
        ],
        activeId: 'p-mine',
        baseUrl: 'https://my.gateway.example/v1',
        model: 'm1'
      }
    }
    const merged = mergeAppConfig(oldOnDisk)
    const ids = merged.model.profiles.map((p) => p.id)
    expect(ids).toContain('p-gemini') // 新预设补种到位
    expect(ids).toContain('p-mine') // 用户自建档案原样保留
    // 补种不抢激活：用户当前用谁还是谁
    expect(merged.model.activeId).toBe('p-mine')
  })

  it('★ 被 saveDraft 冲掉协议的预设档案自动归位（p-claude:openai → anthropic）', () => {
    const damaged = {
      model: {
        profiles: [
          {
            id: 'p-claude',
            name: 'Claude',
            protocol: 'openai',
            baseUrl: 'https://api.anthropic.com',
            model: '',
            context: 200000,
            multimodal: true
          }
        ],
        activeId: 'p-claude',
        baseUrl: 'https://api.anthropic.com',
        model: ''
      }
    }
    const merged = mergeAppConfig(damaged)
    const claude = merged.model.profiles.find((p) => p.id === 'p-claude')
    expect(claude?.protocol).toBe('anthropic')
  })

  it('协议归位只动预设档案，用户自建档案协议原样', () => {
    const cfg = {
      model: {
        profiles: [
          {
            id: 'p-gemini',
            name: 'Gemini',
            protocol: 'openai',
            baseUrl: 'https://my-proxy.example',
            model: 'g',
            context: 100000,
            multimodal: true
          },
          {
            id: 'mine',
            name: '自建',
            protocol: 'openai',
            baseUrl: 'https://x.example/v1',
            model: 'x',
            context: 0,
            multimodal: false
          }
        ],
        activeId: 'mine',
        baseUrl: 'https://x.example/v1',
        model: 'x'
      }
    }
    const merged = mergeAppConfig(cfg)
    expect(merged.model.profiles.find((p) => p.id === 'p-gemini')?.protocol).toBe('gemini')
    expect(merged.model.profiles.find((p) => p.id === 'mine')?.protocol).toBe('openai')
  })
})

describe('appearance.theme', () => {
  it('默认浅色；非法值一律回退 light，system 仍是合法显式值', () => {
    expect(DEFAULT_APP_CONFIG.appearance.theme).toBe('light')
    expect(mergeAppConfig({ appearance: { theme: 'sepia' as never } }).appearance.theme).toBe(
      'light'
    )
    expect(mergeAppConfig({ appearance: {} }).appearance.theme).toBe('light')
    expect(mergeAppConfig({}).appearance.theme).toBe('light')
    expect(mergeAppConfig({ appearance: { theme: 'system' } }).appearance.theme).toBe('system')
  })

  it('合法三值经 patch 写入；dark/light 保留', () => {
    expect(
      applySettingsPatch(DEFAULT_APP_CONFIG, { appearance: { theme: 'dark' } }).appearance.theme
    ).toBe('dark')
    expect(
      applySettingsPatch(DEFAULT_APP_CONFIG, { appearance: { theme: 'light' } }).appearance.theme
    ).toBe('light')
    expect(
      applySettingsPatch(DEFAULT_APP_CONFIG, { appearance: { theme: 'system' } }).appearance.theme
    ).toBe('system')
    // 非法 patch 被拒（保留原值）
    expect(
      applySettingsPatch(
        { ...DEFAULT_APP_CONFIG, appearance: { theme: 'dark' } },
        { appearance: { theme: 'blue' as never } }
      ).appearance.theme
    ).toBe('dark')
  })

  it('appearance 补丁不影响其他分区（必查两处回归）', () => {
    const next = applySettingsPatch(DEFAULT_APP_CONFIG, {
      appearance: { theme: 'dark' },
      workspace: { work: 'E://proj' }
    })
    expect(next.appearance.theme).toBe('dark')
    expect(next.workspace.work).toBe('E://proj')
    expect(next.tools.permissionMode).toBe('confirm')
  })
})

describe('ui.notesCard（学习笔记卡开关）', () => {
  it('默认关；脏值回退关（隐私同款纪律）', () => {
    expect(DEFAULT_APP_CONFIG.ui.notesCard).toBe(false)
    expect(mergeAppConfig({ ui: { notesCard: 'yes' as never } }).ui.notesCard).toBe(false)
    expect(mergeAppConfig({ ui: {} }).ui.notesCard).toBe(false)
    expect(mergeAppConfig({}).ui.notesCard).toBe(false)
  })

  it('显式 true 才开；patch 可开关往返', () => {
    expect(mergeAppConfig({ ui: { notesCard: true } }).ui.notesCard).toBe(true)
    const on = applySettingsPatch(DEFAULT_APP_CONFIG, { ui: { notesCard: true } })
    expect(on.ui.notesCard).toBe(true)
    expect(applySettingsPatch(on, { ui: { notesCard: false } }).ui.notesCard).toBe(false)
    // 非法 patch（非布尔）被拒，保留原值
    expect(applySettingsPatch(on, { ui: { notesCard: 'on' as never } }).ui.notesCard).toBe(true)
  })
})
