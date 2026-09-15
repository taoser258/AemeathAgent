// 子 Agent v1 单测。设计：。
// spawn.ts 零 electron 依赖 → 纯 DI 直接单测；registry 整体 mock（给 permission 的
// 分级判定供假值，同时隔离 MCP manager 与技能存储）。

import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/agent/tools/registry', () => ({
  getLlmTools: () => [],
  isMutatingTool: (name: string): boolean => name === 'write_file',
  isApprovalExempt: (): boolean => false,
  approvalTargetPath: (_name: string, argsJson: string): string | null => {
    try {
      const a = JSON.parse(argsJson) as { path?: unknown }
      return typeof a.path === 'string' ? a.path : null
    } catch {
      return null
    }
  }
}))

import type { StreamChatResult, ToolCallDraft } from '../src/main/llm/client'
import {
  SUB_AGENT_MAX_STEPS,
  buildSubAgentMessages,
  effectiveSubMode,
  filterSubTools,
  formatSubAgentResult,
  handleSpawnTool,
  isSubAllowedTool,
  runSubAgent,
  type SubAgentDeps
} from '../src/main/agent/spawn'
import type { PermissionMode } from '../src/main/chat/permission'
import type { ApprovalDecision } from '../src/shared/protocol'

const baseRes = (over: Partial<StreamChatResult> = {}): StreamChatResult => ({
  text: '',
  toolCalls: [],
  finishReason: 'stop',
  cacheKnown: false,
  ttftMs: 1,
  totalMs: 5,
  tokPerS: 0,
  ...over
})

const tc = (name: string, argsJson: string, id = 'c1'): ToolCallDraft => ({ id, name, argsJson })

interface Harness {
  deps: SubAgentDeps
  calls: StreamChatResult[]
  execSpy: Array<{ name: string; argsJson: string }>
  approvals: Array<{ kind: string; reason?: string }>
  events: Array<{ type: string; data: unknown }>
  controller: AbortController
}

function makeDeps(over: Partial<SubAgentDeps> = {}): Harness {
  const controller = new AbortController()
  const calls: StreamChatResult[] = []
  const execSpy: Array<{ name: string; argsJson: string }> = []
  const approvals: Array<{ kind: string; reason?: string }> = []
  const events: Array<{ type: string; data: unknown }> = []
  const deps: SubAgentDeps = {
    call: async () => {
      const r = calls.shift()
      return r === undefined ? baseRes({ text: '（没有更多轮次）' }) : r
    },
    executeTool: async (name, argsJson) => {
      execSpy.push({ name, argsJson })
      return { ok: true, result: 'ok' }
    },
    requestApproval: async (kind, _calls, reason): Promise<ApprovalDecision> => {
      approvals.push({ kind, reason })
      return 'allow'
    },
    parentMode: 'confirm',
    workspace: null,
    sessionId: 's-parent',
    parentSignal: controller.signal,
    emit: (type, data) => events.push({ type, data }),
    ...over
  }
  return { deps, calls, execSpy, approvals, events, controller }
}

describe('分身工具白名单（设计 §5，宿主侧硬编码）', () => {
  it('清单过滤：只放行白名单内置工具与 MCP；禁嵌套/undo/skill/屏幕感知', () => {
    const out = filterSubTools(
      [
        { function: { name: 'read_file' } },
        { function: { name: 'write_file' } },
        { function: { name: 'note_read' } },
        { function: { name: 'spawn_agent' } },
        { function: { name: 'undo_last_change' } },
        { function: { name: 'skill_use' } },
        { function: { name: 'active_window' } },
        { function: { name: 'mcp__browser__browser_navigate' } }
      ].map((t) => t as unknown as { function: { name: string } })
    ).map((t) => t.function.name)
    expect(out).toEqual(['read_file', 'write_file', 'note_read', 'mcp__browser__browser_navigate'])
  })

  it('isSubAllowedTool 执行期守卫：未知工具与撤销一律拒绝；MCP 前缀放行', () => {
    expect(isSubAllowedTool('spawn_agent')).toBe(false)
    expect(isSubAllowedTool('undo_last_change')).toBe(false)
    expect(isSubAllowedTool('some_random_tool')).toBe(false)
    expect(isSubAllowedTool('mcp__anything__x')).toBe(true)
    expect(isSubAllowedTool('list_dir')).toBe(true)
  })
})

describe('分身消息与模式映射', () => {
  it('系统提示含身份/边界/报告要求与工作区基准；user 组装三要素', () => {
    const msgs = buildSubAgentMessages('整理目录', {
      context: '目录是 C:/data',
      reportFocus: '改动清单',
      workspace: 'E:/ws'
    })
    expect(msgs).toHaveLength(2)
    expect(msgs[0]?.role).toBe('system')
    expect(msgs[0]?.content).toContain('任务分身')
    expect(msgs[0]?.content).toContain('不能再派分身')
    expect(msgs[0]?.content).toContain('没有撤销工具')
    expect(msgs[0]?.content).toContain('E:/ws')
    expect(msgs[1]?.content).toContain('任务目标：整理目录')
    expect(msgs[1]?.content).toContain('背景与约束：目录是 C:/data')
    expect(msgs[1]?.content).toContain('报告侧重：改动清单')
  })

  it('context/reportFocus 缺省不产出 undefined；未绑工作区有回退说明', () => {
    const msgs = buildSubAgentMessages('目标')
    expect(msgs[1]?.content).not.toContain('undefined')
    expect(msgs[0]?.content).toContain('没有绑定工作区')
  })

  it('plan → confirm 映射；confirm/full 原样', () => {
    expect(effectiveSubMode('plan')).toBe('confirm')
    expect(effectiveSubMode('confirm')).toBe('confirm')
    expect(effectiveSubMode('full')).toBe('full')
    expect(SUB_AGENT_MAX_STEPS).toBeGreaterThan(8) // 分身比主循环（8）宽
  })
})

describe('runSubAgent 运行行为', () => {
  it('完成路径：报告=最终文本；事件 started/progress/finished 齐全；执行走注入的 executeTool', async () => {
    const h = makeDeps()
    h.calls.push(
      baseRes({ toolCalls: [tc('read_file', '{"path":"C:/a.txt"}')] }),
      baseRes({ text: '目录里共 3 个文件。' })
    )
    const o = await runSubAgent('统计文件数', {}, h.deps)
    expect(o.status).toBe('completed')
    expect(o.report).toBe('目录里共 3 个文件。')
    expect(o.rounds).toBe(2)
    expect(o.steps).toBe(1)
    expect(h.events[0]?.type).toBe('agent_started')
    expect(h.events[h.events.length - 1]?.type).toBe('agent_finished')
    expect(h.events.some((e) => e.type === 'agent_progress')).toBe(true)
    // executeTool 由 run.ts 绑定主会话上下文——这里验证分身确实经由注入入口执行
    expect(h.execSpy).toEqual([{ name: 'read_file', argsJson: '{"path":"C:/a.txt"}' }])
  })

  it('handleSpawnTool：回灌文本含状态/报告/统计；ok 仅 completed 为真', async () => {
    const h = makeDeps()
    h.calls.push(baseRes({ text: '搞定' }))
    const r = await handleSpawnTool(JSON.stringify({ objective: '做事' }), h.deps)
    expect(r.ok).toBe(true)
    expect(r.result).toContain('[分身完成] 状态: completed')
    expect(r.result).toContain('报告: 搞定')
    expect(r.result).toMatch(/统计: 1 轮 \/ 0 步/)
    // ：执行日志载荷（run.ts 据此落 userData/logs/agents/）
    expect(r.log?.objective).toBe('做事')
    expect(r.log?.outcome.status).toBe('completed')
  })

  it('参数防御：缺 objective / 非 JSON → 可读错误，不启动分身', async () => {
    const h = makeDeps()
    const r1 = await handleSpawnTool('not-json', h.deps)
    expect(r1.ok).toBe(false)
    expect(r1.result).toContain('JSON')
    const r2 = await handleSpawnTool(JSON.stringify({ context: 'x' }), h.deps)
    expect(r2.ok).toBe(false)
    expect(r2.result).toContain('objective')
    expect(h.events).toHaveLength(0)
  })

  it('执行期守卫：分身越权点名撤销工具 → 被拦截，不落到 executeTool', async () => {
    const h = makeDeps()
    h.calls.push(
      baseRes({ toolCalls: [tc('undo_last_change', '{}')] }),
      baseRes({ text: '撤销工具不可用，我直接汇报。' })
    )
    const o = await runSubAgent('试图撤销', {}, h.deps)
    expect(h.execSpy).toHaveLength(0) // 关键断言：真执行入口未被触碰
    expect(o.status).toBe('completed')
    // steps=1：守卫拒绝也计一次"调用尝试"（与主循环对被拒工具的口径一致），
    // 拒绝原因已作为工具结果回灌，模型会自纠
    expect(o.steps).toBe(1)
  })

  it('plan 主会话 → 分身内部变更逐项弹 tool 卡（非 plan 卡），reason 标注「来自子任务」', async () => {
    const h = makeDeps({ parentMode: 'plan' as PermissionMode })
    h.calls.push(
      baseRes({ toolCalls: [tc('write_file', '{"path":"C:/out/a.txt","content":"x"}')] }),
      baseRes({ text: '写好了。' })
    )
    const o = await runSubAgent('写一个文件', {}, h.deps)
    expect(o.status).toBe('completed')
    expect(h.approvals).toHaveLength(1)
    expect(h.approvals[0]?.kind).toBe('tool')
    expect(h.approvals[0]?.reason).toContain('来自子任务')
    expect(h.approvals[0]?.reason).toContain('写一个文件')
  })

  it('工作区内的分身写入直放（与主会话同语义），不弹卡', async () => {
    const h = makeDeps({ workspace: 'C:/out' })
    h.calls.push(
      baseRes({ toolCalls: [tc('write_file', '{"path":"C:/out/a.txt","content":"x"}')] }),
      baseRes({ text: 'ok' })
    )
    const o = await runSubAgent('区内写入', {}, h.deps)
    expect(h.approvals).toHaveLength(0)
    expect(o.status).toBe('completed')
  })

  it('主会话停止 → 分身级联中止（status=aborted，报告用回退文案）', async () => {
    const h = makeDeps()
    h.deps.call = async () => {
      h.controller.abort()
      return baseRes({ toolCalls: [tc('read_file', '{"path":"C:/a.txt"}')] })
    }
    const o = await runSubAgent('长任务', {}, h.deps)
    expect(o.status).toBe('aborted')
    expect(o.report).toBe('分身已被用户中止。')
  })

  it('同签名熔断 → budget-exhausted（max-steps/loop-detected 同语义）', async () => {
    const h = makeDeps()
    for (let i = 0; i < 5; i++) {
      h.calls.push(baseRes({ toolCalls: [tc('read_file', '{"path":"C:/same.txt"}', `c${i}`)] }))
    }
    const o = await runSubAgent('死循环任务', {}, h.deps)
    expect(o.status).toBe('budget-exhausted')
    expect(o.report).toContain('步数上限')
  })

  it('LLM 调用抛错 → status=failed，报告含错误信息', async () => {
    const h = makeDeps()
    h.deps.call = async () => {
      throw new Error('网络炸了')
    }
    const o = await runSubAgent('任务', {}, h.deps)
    expect(o.status).toBe('failed')
    expect(o.report).toContain('分身执行失败')
    expect(o.report).toContain('网络炸了')
  })

  it('completed 但无文字 → 报告用回退文案（不回灌空串）', async () => {
    const h = makeDeps()
    h.calls.push(baseRes({ text: '' }))
    const o = await runSubAgent('任务', {}, h.deps)
    expect(o.status).toBe('completed')
    expect(o.report).toContain('没有留下文字报告')
  })

  it('并发守卫：分身运行中再派 → 立即 failed，不影响第一个', async () => {
    const h = makeDeps()
    let release!: (r: StreamChatResult) => void
    const blocker = new Promise<StreamChatResult>((resolve) => {
      release = resolve
    })
    h.deps.call = async () => blocker
    const first = runSubAgent('任务一', {}, h.deps)
    await new Promise((r) => setTimeout(r, 0)) // 让第一个分身先起步
    const second = await runSubAgent('任务二', {}, h.deps)
    expect(second.status).toBe('failed')
    expect(second.report).toContain('已有分身运行中')
    expect(h.events.filter((e) => e.type === 'agent_started')).toHaveLength(1)
    release(baseRes({ text: '一完成' }))
    const o1 = await first
    expect(o1.status).toBe('completed')
    expect(o1.report).toBe('一完成')
  })
})

describe('formatSubAgentResult', () => {
  it('四态标签齐全', () => {
    const mk = (status: Parameters<typeof formatSubAgentResult>[0]['status']): string =>
      formatSubAgentResult({
        agentId: 'a',
        status,
        report: 'r',
        rounds: 1,
        steps: 2,
        ms: 3000,
        inputTok: 0,
        outputTok: 0
      })
    expect(mk('completed')).toContain('[分身完成]')
    expect(mk('failed')).toContain('[分身失败]')
    expect(mk('aborted')).toContain('[分身已中止]')
    expect(mk('budget-exhausted')).toContain('[分身步数用尽]')
    expect(mk('completed')).toContain('3.0s')
  })
})
