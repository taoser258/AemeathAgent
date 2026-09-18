import { beforeEach, describe, expect, it } from 'vitest'
import {
  appendNotice,
  appendToken,
  deriveTitle,
  finalize,
  groupPersistedIntoTurns,
  groupSessionsByDate,
  selectStreamingActive,
  useChatStore,
  type ChatMessage,
  type SessionMeta
} from '../src/renderer/chat/store'
import type { PersistedMessage } from '../src/shared/types'

// 流式中的消息造数（绕开 send 的入口直接构造，聚焦纯函数行为）
function streamingMsg(id: string): ChatMessage {
  return { id, role: 'assistant', content: '', ts: 0, streaming: true }
}

beforeEach(() => {
  // store 是模块级单例：测试间重置，避免上一个用例的会话/消息串场
  useChatStore.setState({
    sessions: [],
    activeId: null,
    messagesBySession: {},
    streaming: false
  })
})

describe('chat/store · groupSessionsByDate（侧栏日期分组）', () => {
  const NOW = new Date('2026-09-05T15:00:00').getTime()
  const day = 86_400_000
  const meta = (id: string, updatedAt: number): SessionMeta => ({
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt
  })

  it('按 今天/昨天/更早 三档分组，顺序稳定', () => {
    const groups = groupSessionsByDate(
      [meta('a', NOW), meta('b', NOW - day), meta('c', NOW - 8 * day), meta('d', NOW - day)],
      NOW
    )
    expect(groups.map((g) => g.label)).toEqual(['今天', '昨天', '更早'])
    expect(groups[1].sessions.map((s) => s.id)).toEqual(['b', 'd'])
  })

  it('空档分组不出现', () => {
    const groups = groupSessionsByDate([meta('a', NOW - 3 * day)], NOW)
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('更早')
  })

  it('置顶分组：置顶独立成组永远在最前、不进日期档、组内 updatedAt 倒序', () => {
    const metaP = (id: string, updatedAt: number): SessionMeta => ({
      ...meta(id, updatedAt),
      pinned: true
    })
    const groups = groupSessionsByDate(
      [
        meta('a', NOW), // 今天
        metaP('b', NOW - day), // 置顶，昨天
        metaP('c', NOW - 8 * day), // 置顶，更早
        meta('d', NOW - day), // 昨天
        meta('e', NOW - day) // 昨天
      ],
      NOW
    )
    expect(groups.map((g) => g.label)).toEqual(['置顶', '今天', '昨天'])
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['b', 'c']) // 组内倒序
    expect(groups[2].sessions.map((s) => s.id)).toEqual(['d', 'e']) // 非置顶进日期档
  })

  it('全部取消置顶后置顶分组消失（回归）', () => {
    const groups = groupSessionsByDate([meta('a', NOW)], NOW)
    expect(groups.map((g) => g.label)).toEqual(['今天'])
  })
})

describe('chat/store · renameSession（内联重命名）', () => {
  it('更新标题并置 titleIsCustom；空白标题被忽略', () => {
    const store = useChatStore.getState()
    store.createSession()
    const id = useChatStore.getState().activeId as string
    store.renameSession(id, '和爱弥斯的夜谈')
    const renamed = useChatStore.getState().sessions[0]
    expect(renamed.title).toBe('和爱弥斯的夜谈')
    expect(renamed.titleIsCustom).toBe(true) // 手动改名后自动派生永久失效
    store.renameSession(id, '   ')
    expect(useChatStore.getState().sessions[0].title).toBe('和爱弥斯的夜谈')
  })
})

describe('chat/store · deriveTitle（自动标题）', () => {
  it('压缩空白；超过 30 字截断加省略号', () => {
    expect(deriveTitle('  你好，\n 今天   天气怎么样？ ')).toBe('你好， 今天 天气怎么样？')
    const long = '这是一条非常长的消息'.repeat(6)
    const derived = deriveTitle(long)
    expect(derived).toHaveLength(31) // 30 字 + …
    expect(derived.endsWith('…')).toBe(true)
  })

  it('空白输入返回空串（调用方跳过派生，保留默认标题）', () => {
    expect(deriveTitle('   \n  ')).toBe('')
  })
})

describe('chat/store · 纯函数', () => {
  it('appendToken 只改目标消息的内容，其余原样', () => {
    const list = [streamingMsg('a'), streamingMsg('b')]
    const next = appendToken(list, 'b', '你好')
    expect(next[0]).toBe(list[0]) // 未命中消息保持引用（memo 优化依赖这点）
    expect(next[1].content).toBe('你好')
    expect(list[1].content).toBe('') // 原数组不被修改
  })

  it('finalize 结束指定消息；缺省时结束所有 streaming 消息', () => {
    const list = [streamingMsg('a'), streamingMsg('b')]
    expect(finalize(list, 'a').every((m) => m.streaming === (m.id === 'b'))).toBe(true)
    expect(finalize(list).every((m) => m.streaming === false)).toBe(true)
  })
})

describe('createSession 模式绑定', () => {
  it('新会话绑定当前胶囊模式；selectSession 时胶囊跟随会话', async () => {
    // 最小 window stub：selectSession 会调 petAPI 的异步恢复链
    const noopAsync = (): Promise<null> => Promise.resolve(null)
    ;(globalThis as { window?: unknown }).window = {
      petAPI: {
        todoGet: noopAsync,
        checkpointGet: noopAsync,
        notesGet: noopAsync,
        sessionMessages: noopAsync, // selectSession → loadMessages 的恢复链（缺它会留 unhandled rejection）
        sessionsSync: (): void => undefined
      }
    }
    const { useChatStore } = await import('../src/renderer/chat/store')
    const store = useChatStore.getState()
    store.setChatMode('learn')
    store.createSession()
    const created = useChatStore.getState().sessions[0]
    expect(created.mode).toBe('learn')
    // 切到别的会话：胶囊跟随其模式（无 mode 的旧会话 → work）
    useChatStore.setState((state) => ({
      sessions: [...state.sessions, { id: 's-legacy', title: '旧会话', createdAt: 1, updatedAt: 2 }]
    }))
    store.selectSession('s-legacy')
    expect(useChatStore.getState().chatMode).toBe('work')
  })
})

describe('togglePin 置顶切换', () => {
  it('翻转 pinned 并同步注册表；不动 updatedAt（不改变日期分组归属）', async () => {
    const noopAsync = (): Promise<null> => Promise.resolve(null)
    ;(globalThis as { window?: unknown }).window = {
      petAPI: {
        todoGet: noopAsync,
        checkpointGet: noopAsync,
        notesGet: noopAsync,
        sessionMessages: noopAsync,
        sessionsSync: (): void => undefined
      }
    }
    const { useChatStore } = await import('../src/renderer/chat/store')
    const store = useChatStore.getState()
    store.createSession()
    const id = useChatStore.getState().sessions[0].id
    const before = useChatStore.getState().sessions[0].updatedAt
    store.togglePin(id)
    expect(useChatStore.getState().sessions[0].pinned).toBe(true)
    expect(useChatStore.getState().sessions[0].updatedAt).toBe(before)
    store.togglePin(id)
    expect(useChatStore.getState().sessions[0].pinned).toBe(false)
    expect(useChatStore.getState().sessions[0].updatedAt).toBe(before)
  })
})

describe('bumpLearnTick 学习闭环刷新信号', () => {
  it('每次调用自增，供复习卡/进度卡共同订阅（评分后两视图一起刷新）', async () => {
    const noopAsync = (): Promise<null> => Promise.resolve(null)
    ;(globalThis as { window?: unknown }).window = {
      petAPI: {
        todoGet: noopAsync,
        checkpointGet: noopAsync,
        notesGet: noopAsync,
        sessionMessages: noopAsync,
        sessionsSync: (): void => undefined
      }
    }
    const { useChatStore } = await import('../src/renderer/chat/store')
    const before = useChatStore.getState().learnTick
    useChatStore.getState().bumpLearnTick()
    expect(useChatStore.getState().learnTick).toBe(before + 1)
    useChatStore.getState().bumpLearnTick()
    expect(useChatStore.getState().learnTick).toBe(before + 2)
  })
})

describe('deleteSession / hideSession 模式感知兜底', () => {
  it('删除当前会话后切到"当前模式"的下一个可见会话；跨模式会话不再被兜底选中', async () => {
    const noopAsync = (): Promise<null> => Promise.resolve(null)
    ;(globalThis as { window?: unknown }).window = {
      petAPI: {
        todoGet: noopAsync,
        checkpointGet: noopAsync,
        notesGet: noopAsync,
        sessionMessages: noopAsync,
        sessionsSync: (): void => undefined
      }
    }
    const { useChatStore } = await import('../src/renderer/chat/store')
    const store = useChatStore.getState()
    // 造一个 chat 会话（空的）+ 一个 work 会话（当前活动）
    useChatStore.setState({ chatMode: 'chat' })
    store.createSession() // chat，当前活动
    const chatId = useChatStore.getState().activeId as string
    useChatStore.setState({ chatMode: 'work' })
    store.createSession() // work，当前活动
    const workId = useChatStore.getState().activeId as string
    expect(useChatStore.getState().chatMode).toBe('work')
    // 删除 work 会话：剩余只有 chat 会话——不应跨模式兜底，activeId 回 null（欢迎页）
    store.deleteSession(workId)
    const after = useChatStore.getState()
    expect(after.sessions.map((s) => s.id)).toEqual([chatId])
    expect(after.activeId).toBeNull()
  })
})

describe('setChatMode 会话跟随（同款：侧栏按模式过滤）', () => {
  it('切模式：活动会话不属于新模式 → 自动切到该模式最近一条；该模式无会话 → 回欢迎页', async () => {
    const noopAsync = (): Promise<null> => Promise.resolve(null)
    ;(globalThis as { window?: unknown }).window = {
      petAPI: {
        todoGet: noopAsync,
        checkpointGet: noopAsync,
        notesGet: noopAsync,
        sessionMessages: noopAsync,
        sessionsSync: (): void => undefined
      }
    }
    const { useChatStore } = await import('../src/renderer/chat/store')
    const store = useChatStore.getState()
    // 造两条：learn（旧）→ chat（新，当前活动）
    store.setChatMode('learn')
    store.createSession() // learn
    store.setChatMode('chat')
    store.createSession() // chat，当前活动
    expect(useChatStore.getState().activeId).toBe(useChatStore.getState().sessions[0]?.id)
    // 切回 learn：活动自动切到 learn 会话
    store.setChatMode('learn')
    const after = useChatStore.getState()
    expect(after.chatMode).toBe('learn')
    expect(after.activeId).toBe(after.sessions.find((x) => x.mode === 'learn')?.id)
    // 切到 work：没有任何 work 会话 → 活动回 null（欢迎页）
    store.setChatMode('work')
    const work = useChatStore.getState()
    expect(work.chatMode).toBe('work')
    expect(work.activeId).toBeNull()
  })
})

// ── 流式态与会话绑定─────────────────────────────────────────
// 多会话并行：在途 run 按会话记录在 runningIds——A 会话跑着不影响 B 会话
// 发送；切回在途会话时该会话的输入区才显示"进行中"。历史教训：全局 streaming
// 布尔曾把切走的会话锁死（输入区禁用、无法发送）。
describe('selectStreamingActive（流式态按会话派生，多会话并行）', () => {
  it('当前会话在 runningIds → true；不在 → false（输入区可用）', () => {
    expect(selectStreamingActive({ runningIds: ['s1'], activeId: 's1' })).toBe(true)
    expect(selectStreamingActive({ runningIds: ['s1'], activeId: 's2' })).toBe(false)
    // 两个会话同时在途：各自切到对方时都仍算在流式（互不阻塞）
    expect(selectStreamingActive({ runningIds: ['s1', 's2'], activeId: 's2' })).toBe(true)
    // 无在途 run
    expect(selectStreamingActive({ runningIds: [], activeId: 's1' })).toBe(false)
    // activeId 为 null（欢迎页）不锁
    expect(selectStreamingActive({ runningIds: ['s1'], activeId: null })).toBe(false)
  })
})

describe('groupPersistedIntoTurns（历史按回合合并：同轮不被切成多个气泡）', () => {
  const pmsg = (
    m: Partial<PersistedMessage> & { role: PersistedMessage['role'] }
  ): PersistedMessage => ({ id: 'm-x', ts: 1700000000000, text: '', ...m })

  it('一轮多步（assistant+tool 交替）→ 合并成 1 条 assistant，时间线按序穿插', () => {
    const out = groupPersistedIntoTurns([
      pmsg({ id: 'u1', role: 'user', text: '读一下 package.json' }),
      pmsg({
        id: 'a1',
        role: 'assistant',
        thinking: '先看看工作区根目录',
        toolCalls: [{ id: 'c1', name: 'search_files', argsJson: '{"q":"package.json"}' }]
      }),
      pmsg({ id: 't1', role: 'tool', toolCallId: 'c1', text: '0 命中' }),
      pmsg({
        id: 'a2',
        role: 'assistant',
        thinking: '换个路径再找',
        toolCalls: [{ id: 'c2', name: 'list_dir', argsJson: '{}' }]
      }),
      pmsg({ id: 't2', role: 'tool', toolCallId: 'c2', text: 'notes/  pelican-bike.html' }),
      pmsg({
        id: 'a3',
        role: 'assistant',
        thinking: '结论清楚了',
        text: '工作区里没有 package.json。'
      })
    ])
    // 关键断言：user + assistant 两条，而不是 user + 3 条 assistant（被切分）
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(out[1].timeline?.map((sg) => sg.kind)).toEqual([
      'thinking',
      'tool',
      'thinking',
      'tool',
      'thinking',
      'text'
    ])
    expect(out[1].content).toBe('工作区里没有 package.json。')
    // 工具段带终态结果（否则卡片永远显示"正在调用"）
    const tools = (out[1].timeline ?? []).filter((sg) => sg.kind === 'tool')
    expect(tools.every((t) => t.kind === 'tool' && t.ok === true)).toBe(true)
    expect(out[1].toolRuns).toHaveLength(2)
  })

  it('中间步的过渡正文也保留（思考→正文→工具 顺序，不丢她说过的话）', () => {
    const out = groupPersistedIntoTurns([
      pmsg({
        id: 'a1',
        role: 'assistant',
        thinking: '先列目录',
        text: '我先看看工作区里有什么。',
        toolCalls: [{ id: 'c1', name: 'list_dir', argsJson: '{}' }]
      }),
      pmsg({ id: 't1', role: 'tool', toolCallId: 'c1', text: 'notes/' }),
      pmsg({ id: 'a2', role: 'assistant', text: '只有一个 notes 目录。' })
    ])
    // 顺序 = 模型实际输出：思考 → 过渡正文 → 工具 → … → 最终正文
    expect(out[0].timeline?.map((sg) => sg.kind)).toEqual(['thinking', 'text', 'tool', 'text'])
    expect(out[0].content).toContain('我先看看工作区里有什么')
    expect(out[0].content).toContain('只有一个 notes 目录')
  })

  it('多轮对话：每轮各一条 assistant 气泡（不跨轮合并）', () => {
    const out = groupPersistedIntoTurns([
      pmsg({ id: 'u1', role: 'user', text: '一' }),
      pmsg({ id: 'a1', role: 'assistant', text: '回一' }),
      pmsg({ id: 'u2', role: 'user', text: '二' }),
      pmsg({ id: 'a2', role: 'assistant', text: '回二' })
    ])
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(out[1].content).toBe('回一')
    expect(out[3].content).toBe('回二')
  })

  it('★ 系统通知（notice）独立成一条，不并进助手气泡也不吃掉回合', () => {
    const out = groupPersistedIntoTurns([
      pmsg({ id: 'u1', role: 'user', text: '做个页面' }),
      pmsg({ id: 'a1', role: 'assistant', text: '做好了' }),
      pmsg({
        id: 'n1',
        role: 'notice',
        text: '任务结束，已把 1 个中间产物移入回收站（可还原）：_preview-server.js。'
      })
    ])
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'notice'])
    expect(out[2].id).toBe('n1')
    expect(out[2].content).toContain('移入回收站')
    // 通知之后若还有一轮对话，必须新起一条气泡（不能被并进上一轮的助手气泡）
    const withNext = groupPersistedIntoTurns([
      pmsg({ id: 'a1', role: 'assistant', text: '做好了' }),
      pmsg({ id: 'n1', role: 'notice', text: '任务结束，已清理 1 个中间产物。' }),
      pmsg({ id: 'u2', role: 'user', text: '再来一个' }),
      pmsg({ id: 'a2', role: 'assistant', text: '好' })
    ])
    expect(withNext.map((m) => m.role)).toEqual(['assistant', 'notice', 'user', 'assistant'])
  })

  it('★ appendNotice：并进列表；同 id 再来一次不重复（本地显示 ↔ 盘上恢复同一条）', () => {
    const base: ChatMessage[] = [{ id: 'a1', role: 'assistant', content: '做好了', ts: 1 }]
    const once = appendNotice(base, { id: 'n1', text: '任务结束，已清理 1 个中间产物。', ts: 2 })
    expect(once.map((m) => m.role)).toEqual(['assistant', 'notice'])
    expect(once[1].content).toContain('已清理')
    // 主进程落盘后从盘上恢复时同 id 再来一次 → 原数组原样返回（引用不变 = 不触发重渲染）
    const again = appendNotice(once, { id: 'n1', text: '任务结束，已清理 1 个中间产物。', ts: 2 })
    expect(again).toBe(once)
  })

  it('未执行完的调用（无 tool 结果）→ ok=false，不误报成功', () => {
    const out = groupPersistedIntoTurns([
      pmsg({
        id: 'a1',
        role: 'assistant',
        toolCalls: [{ id: 'c9', name: 'read_file', argsJson: '{}' }]
      })
    ])
    const tool = out[0].timeline?.find((sg) => sg.kind === 'tool')
    expect(tool !== undefined && tool.kind === 'tool' ? tool.ok : null).toBe(false)
  })

  it('只取回合内最后一条 assistant 的 id 作稳定 key（重载不重挂）', () => {
    const out = groupPersistedIntoTurns([
      pmsg({
        id: 'a1',
        role: 'assistant',
        thinking: 'x',
        toolCalls: [{ id: 'c1', name: 't', argsJson: '{}' }]
      }),
      pmsg({ id: 't1', role: 'tool', toolCallId: 'c1', text: 'r' }),
      pmsg({ id: 'a2', role: 'assistant', text: 'done' })
    ])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('a2')
  })
})
