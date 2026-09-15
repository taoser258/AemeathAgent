// harness 主循环单测：依赖注入 mock LLM 与 mock 工具，覆盖
// 多步工具往返 / 步数上限熔断 / 死循环熔断 / 用户中断 / 工具错误回灌。

import { describe, expect, it } from 'vitest'
import { runToolLoop, type ToolLoopDeps } from '../src/main/chat/loop'
import type { ChatTurn, StreamChatResult, ToolCallDraft } from '../src/main/llm/client'

function resp(over: Partial<StreamChatResult>): StreamChatResult {
  return {
    text: '',
    toolCalls: [],
    finishReason: 'stop',
    cacheKnown: false,
    ttftMs: 5,
    totalMs: 10,
    genMs: 5,
    tokPerS: 100,
    ...over
  }
}

function tc(id: string, name: string, argsJson = '{}'): ToolCallDraft {
  return { id, name, argsJson }
}

/** 按脚本逐轮流式响应的 mock LLM；executeTool 记录调用并返回固定结果 */
function makeDeps(
  script: StreamChatResult[],
  opts: {
    execResult?: { ok: boolean; result: string }
    executed?: Array<{ name: string; argsJson: string }>
  } = {}
): ToolLoopDeps & { signal: AbortSignal } {
  const controller = new AbortController()
  let round = 0
  return {
    signal: controller.signal,
    call: async (_messages: ChatTurn[]) => {
      round += 1
      return resp(script[Math.min(round - 1, script.length - 1)])
    },
    executeTool: async (name: string, argsJson: string) => {
      opts.executed?.push({ name, argsJson })
      return opts.execResult ?? { ok: true, result: '工具结果 OK' }
    },
    onToolStart: () => {},
    onToolResult: () => {},
    onStepBoundary: () => {}
  }
}

describe('runToolLoop', () => {
  it('两步工具往返：调用工具 → 结果回灌 → 最终回答', async () => {
    const executed: Array<{ name: string; argsJson: string }> = []
    const deps = makeDeps(
      [
        resp({
          text: '我来查一下时间。',
          toolCalls: [tc('c1', 'current_time')],
          finishReason: 'tool_calls'
        }),
        resp({ text: '现在是下午三点。', finishReason: 'stop' })
      ],
      { executed, execResult: { ok: true, result: '2026-09-07 15:00 星期一' } }
    )
    const messages: ChatTurn[] = [{ role: 'user', content: '现在几点了？' }]
    const boundaries: number[] = []
    deps.onStepBoundary = (turns) => boundaries.push(turns.length)

    const r = await runToolLoop(messages, deps, deps.signal)

    expect(r.stoppedReason).toBe('completed')
    expect(r.finalText).toBe('现在是下午三点。')
    expect(r.rounds).toBe(2)
    expect(r.steps).toBe(1)
    expect(executed).toEqual([{ name: 'current_time', argsJson: '{}' }])
    // 消息序列：user → assistant(tool_calls) → tool 结果
    expect(messages).toHaveLength(3)
    expect(messages[1].role).toBe('assistant')
    expect(messages[1].tool_calls?.[0]?.id).toBe('c1')
    expect(messages[2].role).toBe('tool')
    expect(messages[2].tool_call_id).toBe('c1')
    expect(messages[2].content).toContain('2026-09-07')
    // 步边界回调：assistant + tool 结果两条
    expect(boundaries).toEqual([2])
  })

  it('步数上限熔断：达到 maxSteps 停止，未执行的调用不执行', async () => {
    let seq = 0
    const executed: Array<{ name: string }> = []
    const deps = makeDeps([
      resp({ toolCalls: [tc('x', 'current_time')], finishReason: 'tool_calls' })
    ])
    // 每轮参数不同（避免触发死循环熔断），单独覆盖 call
    deps.call = async () => {
      seq += 1
      return resp({
        toolCalls: [tc(`c-${seq}`, 'current_time', `{"q":${seq}}`)],
        finishReason: 'tool_calls'
      })
    }
    deps.executeTool = async () => {
      executed.push({ name: 'current_time' })
      return { ok: true, result: 'OK' }
    }
    const r = await runToolLoop([{ role: 'user', content: 'go' }], deps, deps.signal, 3)
    expect(r.stoppedReason).toBe('max-steps')
    expect(r.rounds).toBe(3)
    // 第 3 轮达到上限：调用不再执行（只执行了前两轮的 2 次）
    expect(r.steps).toBe(2)
  })

  it('死循环熔断：同一签名连续 3 轮强制中止', async () => {
    const deps = makeDeps([
      resp({ toolCalls: [tc('same', 'current_time', '{"fixed":1}')], finishReason: 'tool_calls' })
    ])
    const r = await runToolLoop([{ role: 'user', content: 'go' }], deps, deps.signal, 10)
    expect(r.stoppedReason).toBe('loop-detected')
    expect(r.rounds).toBe(3)
  })

  it('用户中断：aborted 后停止，不再发起第二轮推理', async () => {
    const controller = new AbortController()
    const deps: ToolLoopDeps = {
      signal: controller.signal,
      call: async () =>
        resp({
          text: '先看时间……',
          toolCalls: [tc('c1', 'current_time')],
          finishReason: 'tool_calls'
        }),
      executeTool: async () => {
        // 工具执行期间用户点停止
        controller.abort()
        return { ok: true, result: 'TOO LATE' }
      },
      onToolStart: () => {},
      onToolResult: () => {},
      onStepBoundary: () => {}
    }
    const messages: ChatTurn[] = [{ role: 'user', content: 'go' }]
    const r = await runToolLoop(messages, deps, deps.signal)
    expect(r.stoppedReason).toBe('aborted')
    expect(r.steps).toBe(1)
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
  })

  it('工具错误回灌：ok:false 的结果作为观察让模型继续（自我纠错）', async () => {
    const deps = makeDeps(
      [
        resp({ toolCalls: [tc('c1', 'current_time', '{"bad":1}')], finishReason: 'tool_calls' }),
        resp({ text: '时间查询失败了，我换个说法。', finishReason: 'stop' })
      ],
      { execResult: { ok: false, result: '工具执行出错：参数不合法' } }
    )
    const messages: ChatTurn[] = [{ role: 'user', content: '现在几点？' }]
    const r = await runToolLoop(messages, deps, deps.signal)
    expect(r.stoppedReason).toBe('completed')
    expect(r.steps).toBe(1)
    expect(messages[2].role).toBe('tool')
    expect(messages[2].content).toContain('参数不合法')
  })
})

// ── ：审批钩子（beforeRound 计划模式 / beforeTool 确认模式） ──

describe('runToolLoop · 审批钩子', () => {
  it('beforeTool deny：调用不执行，回灌"用户拒绝"结果', async () => {
    const executed: string[] = []
    const deps = makeDeps([
      resp({ toolCalls: [tc('c1', 'current_time')], finishReason: 'tool_calls' }),
      resp({ text: '好的，我不用工具了。', finishReason: 'stop' })
    ])
    deps.beforeTool = async () => 'deny'
    deps.executeTool = async (name) => {
      executed.push(name)
      return { ok: true, result: 'OK' }
    }
    const messages: ChatTurn[] = [{ role: 'user', content: 'go' }]
    const r = await runToolLoop(messages, deps, deps.signal)
    expect(executed).toHaveLength(0)
    expect(r.steps).toBe(0)
    expect(r.stoppedReason).toBe('completed')
    expect(messages[2].role).toBe('tool')
    expect(messages[2].content).toContain('用户拒绝')
  })

  it('beforeRound block：整批拒绝不执行，拒绝结果回灌；达到步数上限收尾', async () => {
    let seq = 0
    const executed: string[] = []
    let asks = 0
    const deps = makeDeps([])
    deps.call = async () => {
      seq += 1
      return resp({
        toolCalls: [tc(`c-${seq}`, 'current_time', `{"q":${seq}}`)],
        finishReason: 'tool_calls'
      })
    }
    deps.executeTool = async (name) => {
      executed.push(name)
      return { ok: true, result: 'OK' }
    }
    deps.beforeRound = async () => {
      asks += 1
      return 'block'
    }
    const messages: ChatTurn[] = [{ role: 'user', content: 'go' }]
    const r = await runToolLoop(messages, deps, deps.signal, 4)
    // maxSteps=4：第 4 轮在 beforeRound 之前被步数上限掐断 → 3 次询问
    expect(asks).toBe(3)
    expect(executed).toHaveLength(0)
    expect(r.steps).toBe(0)
    expect(r.stoppedReason).toBe('max-steps')
    // 每轮 assistant + 1 条拒绝 tool 结果；第 4 轮步数上限掐断时 assistant 已入列
    // （user + 3×(assistant+tool) + 1 个悬空 assistant = 8，投影侧会补占位结果）
    expect(messages).toHaveLength(8)
    const denials = messages.filter((m) => m.role === 'tool')
    expect(denials).toHaveLength(3)
    expect(denials[0].content).toContain('用户未批准')
  })

  it('beforeTool deny 补发 denied 结果事件', async () => {
    const events: Array<{ id: string; ok: boolean; status?: string }> = []
    const deps = makeDeps([
      resp({ toolCalls: [tc('c1', 'current_time')], finishReason: 'tool_calls' }),
      resp({ text: '好的，不查了。', finishReason: 'stop' })
    ])
    deps.beforeTool = async () => 'deny'
    deps.onToolResult = (tcall, ok, _preview, _ms, status) => {
      events.push({ id: tcall.id, ok, status })
    }
    const r = await runToolLoop([{ role: 'user', content: '查时间' }], deps, deps.signal)
    expect(r.stoppedReason).toBe('completed')
    expect(events).toEqual([{ id: 'c1', ok: false, status: 'denied' }])
  })

  it('beforeRound go：批准后执行；钩子每轮都会被调（免问逻辑在 run 侧）', async () => {
    let asks = 0
    const deps = makeDeps([
      resp({ toolCalls: [tc('c1', 'current_time')], finishReason: 'tool_calls' }),
      resp({ toolCalls: [tc('c2', 'current_time', '{"z":2}')], finishReason: 'tool_calls' }),
      resp({ text: '完成。', finishReason: 'stop' })
    ])
    deps.beforeRound = async () => {
      asks += 1
      return 'go'
    }
    const r = await runToolLoop([{ role: 'user', content: 'go' }], deps, deps.signal)
    expect(asks).toBe(2)
    expect(r.steps).toBe(2)
    expect(r.stoppedReason).toBe('completed')
  })

  it('一轮多工具：全部串行执行、结果按调用顺序回灌配对', async () => {
    const executed: string[] = []
    const deps = makeDeps([
      resp({
        toolCalls: [
          tc('c1', 'read_file', '{"p":"a"}'),
          tc('c2', 'list_dir', '{"p":"."}'),
          tc('c3', 'current_time')
        ],
        finishReason: 'tool_calls'
      }),
      resp({ text: '三件都办完了。', finishReason: 'stop' })
    ])
    deps.executeTool = async (name) => {
      executed.push(name)
      return { ok: true, result: `结果-${name}` }
    }
    const messages: ChatTurn[] = [{ role: 'user', content: '三件事一起办' }]
    const r = await runToolLoop(messages, deps, deps.signal)
    expect(executed).toEqual(['read_file', 'list_dir', 'current_time'])
    expect(r.steps).toBe(3)
    const toolTurns = messages.filter((m) => m.role === 'tool')
    expect(toolTurns.map((m) => m.tool_call_id)).toEqual(['c1', 'c2', 'c3'])
    expect(toolTurns.map((m) => m.content)).toEqual([
      '结果-read_file',
      '结果-list_dir',
      '结果-current_time'
    ])
  })

  it('超长工具结果截断：>8000 字符截断并加标记，防一口吃穿上下文', async () => {
    const deps = makeDeps(
      [
        resp({ toolCalls: [tc('c1', 'read_file')], finishReason: 'tool_calls' }),
        resp({ text: '收到。', finishReason: 'stop' })
      ],
      { execResult: { ok: true, result: 'x'.repeat(9000) } }
    )
    const messages: ChatTurn[] = [{ role: 'user', content: '读大文件' }]
    let preview = ''
    deps.onToolResult = (_tc, _ok, p) => {
      preview = p
    }
    await runToolLoop(messages, deps, deps.signal)
    const fed = messages[2].content as string
    expect(fed.length).toBeLessThan(9000)
    expect(fed).toContain('…[结果过长已截断]')
    // 事件侧 preview 截到 200
    expect(preview.length).toBeLessThanOrEqual(200)
  })
})

describe('runToolLoop · 空收尾重试', () => {
  /** 自定义 deps：按脚本轮流响应，并把每轮收到的 messages 快照记下来（看催办 turn 是否注入） */
  function makeScriptDeps(
    script: StreamChatResult[],
    seen: ChatTurn[][]
  ): ToolLoopDeps & { signal: AbortSignal } {
    const controller = new AbortController()
    let round = 0
    return {
      signal: controller.signal,
      call: async (messages: ChatTurn[]) => {
        seen.push(structuredClone(messages))
        const r = script[Math.min(round, script.length - 1)]
        round += 1
        return r
      },
      executeTool: async () => ({ ok: true, result: '写入成功' }),
      onToolStart: () => {},
      onToolResult: () => {},
      onStepBoundary: () => {}
    }
  }

  it('正文空但有工具动作 → 注入催办 user turn 再要一次，拿到正文后正常完成', async () => {
    const seen: ChatTurn[][] = []
    const deps = makeScriptDeps(
      [
        // 第 1 轮：只发工具、正文空
        resp({ text: '', toolCalls: [tc('c1', 'write_file')], finishReason: 'tool_calls' }),
        // 第 2 轮：交完工具后仍空正文（触发催办）
        resp({ text: '', finishReason: 'stop' }),
        // 第 3 轮：催办后给出真正汇报
        resp({ text: '简报已经写好啦。', finishReason: 'stop' })
      ],
      seen
    )
    const messages: ChatTurn[] = [{ role: 'user', content: '写个简报' }]
    const r = await runToolLoop(messages, deps, deps.signal)

    expect(r.stoppedReason).toBe('completed')
    expect(r.finalText).toBe('简报已经写好啦。')
    // 第 3 轮调用时应能看到注入的系统催办 user turn（倒数第二条 messages 快照）
    const thirdRoundMsgs = seen[2]
    const nudge = thirdRoundMsgs.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('系统提示')
    )
    expect(nudge).toBeDefined()
  })

  it('催办后仍空 → 只重试一次，正常完成（finalText 空，不死循环）', async () => {
    const seen: ChatTurn[][] = []
    const deps = makeScriptDeps(
      [
        resp({ text: '', toolCalls: [tc('c1', 'write_file')], finishReason: 'tool_calls' }),
        resp({ text: '', finishReason: 'stop' }), // 触发催办
        resp({ text: '', finishReason: 'stop' }) // 催办后仍空 → 应就此完成，不再催
      ],
      seen
    )
    const messages: ChatTurn[] = [{ role: 'user', content: '写个简报' }]
    const r = await runToolLoop(messages, deps, deps.signal)

    expect(r.stoppedReason).toBe('completed')
    expect(r.finalText).toBe('')
    // 只应催一次：系统提示 turn 在 messages 里仅出现一次
    const nudges = r.messages.filter(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('系统提示')
    )
    expect(nudges).toHaveLength(1)
    // 第 4 轮不该再发生（只有 3 次 call）
    expect(seen).toHaveLength(3)
  })

  it('纯空回复（无工具动作）→ 不催办，直接完成（避免对闲聊误伤）', async () => {
    const seen: ChatTurn[][] = []
    const deps = makeScriptDeps([resp({ text: '', finishReason: 'stop' })], seen)
    const messages: ChatTurn[] = [{ role: 'user', content: '在吗' }]
    const r = await runToolLoop(messages, deps, deps.signal)
    expect(r.stoppedReason).toBe('completed')
    expect(r.finalText).toBe('')
    // 没有工具动作，不该注入催办，也不该有第 2 轮
    expect(seen).toHaveLength(1)
  })
})

// ── P5 补丁：轮次预算分段 + 自动续跑──
describe('runToolLoop 分段预算', () => {
  /** n 轮"要求调用工具且每轮签名不同"的脚本（签名相同会被死循环熔断先拦下，那是另一条路径） */
  const toolRounds = (n: number): StreamChatResult[] =>
    Array.from({ length: n }, (_, i) =>
      resp({
        toolCalls: [tc(`c${i}`, 'current_time', `{"round":${i}}`)],
        finishReason: 'tool_calls'
      })
    )

  it('★ 撞段预算自动续跑并跑完（不再中断等用户点继续）', async () => {
    const notices: Array<{ kind: string; text: string; attempt: number }> = []
    const deps = makeDeps([...toolRounds(3), resp({ text: '做完了。' })])
    deps.onNotice = (n) => notices.push({ kind: n.kind, text: n.text, attempt: n.attempt })

    // 单段预算 2 轮、可续 2 段：第 3 轮撞预算 → 自动续一段 → 第 4 轮给出最终回答
    const r = await runToolLoop([{ role: 'user', content: 'go' }], deps, deps.signal, {
      roundsPerSegment: 2,
      maxAutoContinues: 2
    })
    expect(r.stoppedReason).toBe('completed')
    expect(r.autoContinues).toBe(1)
    expect(r.steps).toBe(3)
    expect(r.finalText).toBe('做完了。')
    expect(notices).toHaveLength(1)
    expect(notices[0].kind).toBe('auto-continue')
    expect(notices[0].text).toContain('自动接着做')
  })

  it('续跑额度用完才停：max-steps，且每轮工具都执行了（不掐断在半路）', async () => {
    const deps = makeDeps([...toolRounds(10)])
    const r = await runToolLoop([{ role: 'user', content: 'go' }], deps, deps.signal, {
      roundsPerSegment: 2,
      maxAutoContinues: 1
    })
    expect(r.stoppedReason).toBe('max-steps')
    expect(r.autoContinues).toBe(1)
    // 硬顶 = 2 × (1+1) = 4 轮；工具全部执行 → assistant+tool 成对，序列合法
    expect(r.rounds).toBe(4)
    expect(r.steps).toBe(4)
  })

  it('续跑提示作为内部 user turn 注入（模型能看到"接着做"的要求）', async () => {
    let seenHint = false
    const deps = makeDeps([...toolRounds(2), resp({ text: '好。' })])
    const origCall = deps.call
    deps.call = async (msgs, signal) => {
      if (
        msgs.some((m) => typeof m.content === 'string' && m.content.includes('接着上一步继续推进'))
      ) {
        seenHint = true
      }
      return origCall(msgs, signal)
    }
    await runToolLoop([{ role: 'user', content: 'go' }], deps, deps.signal, {
      roundsPerSegment: 2,
      maxAutoContinues: 2
    })
    expect(seenHint).toBe(true)
  })

  it('数字口径（老行为）不受影响：仍是硬上限、不续跑', async () => {
    const deps = makeDeps([...toolRounds(10)])
    const r = await runToolLoop([{ role: 'user', content: 'go' }], deps, deps.signal, 3)
    expect(r.stoppedReason).toBe('max-steps')
    expect(r.autoContinues).toBe(0)
    expect(r.steps).toBe(2)
  })

  it('★ 输出被 max_tokens 截断不算完成：自动接着写', async () => {
    const notices: string[] = []
    const deps = makeDeps([
      resp({ text: '前半段回答（被截断', finishReason: 'length' }),
      resp({ text: '。后半段回答。', finishReason: 'stop' })
    ])
    deps.onNotice = (n) => notices.push(n.text)
    const r = await runToolLoop([{ role: 'user', content: '写个长回答' }], deps, deps.signal)
    expect(r.stoppedReason).toBe('completed')
    expect(r.rounds).toBe(2)
    expect(notices[0]).toContain('截断')
  })
})

// ── ttftMsSum 跨轮累加（done 路径曾误写 ttftMsLast，落盘"平均首 token"恒等于最后一轮）──
describe('runToolLoop · 遥测口径', () => {
  it('ttftMsSum = 各轮 ttft 之和；ttftMsLast/tpsLast = 最后一轮', async () => {
    const deps = makeDeps([
      resp({
        text: '第一步',
        toolCalls: [tc('c1', 'current_time')],
        finishReason: 'tool_calls',
        ttftMs: 120,
        tokPerS: 40
      }),
      resp({
        text: '第二步',
        toolCalls: [tc('c2', 'current_time')],
        finishReason: 'tool_calls',
        ttftMs: 80,
        tokPerS: 55
      }),
      resp({ text: '完成', finishReason: 'stop', ttftMs: 30, tokPerS: 70 })
    ])
    const r = await runToolLoop([{ role: 'user', content: '做三步' }], deps, deps.signal)
    expect(r.rounds).toBe(3)
    expect(r.ttftMsLast).toBe(30) // 最后一轮
    expect(r.ttftMsSum).toBe(230) // 120+80+30——不是 30（done bug 的根因）
    expect(r.tpsLast).toBe(70)
  })

  it('usage 逐轮累计进 inputTok/outputTok（监测栏实时化的数据源）', async () => {
    const deps = makeDeps([
      resp({
        text: 'a',
        toolCalls: [tc('c1', 'current_time')],
        finishReason: 'tool_calls',
        usage: { promptTokens: 1000, completionTokens: 50, totalTokens: 1050 }
      }),
      resp({
        text: 'b',
        finishReason: 'stop',
        usage: { promptTokens: 1200, completionTokens: 80, totalTokens: 1280 }
      })
    ])
    const r = await runToolLoop([{ role: 'user', content: 'x' }], deps, deps.signal)
    expect(r.inputTok).toBe(2200)
    expect(r.outputTok).toBe(130)
  })
})

// ── 清单催办─────────────────────────────────────────────
// 背景：提示词里写了三遍"每完成一步立刻重提交清单"，实测无效——会话档案里她整轮只交 2 次
// （攒 4 步一起交），收尾还漏掉最后一项。约束下沉到 harness：循环层在步末/收尾前各催一次。
describe('清单催办（stepReminder / finishReminder）', () => {
  it('stepReminder 非空 → 注入为内部 user turn；且**不落盘**（UI 不冒假气泡）', async () => {
    const deps = makeDeps([
      resp({ text: '先写文件。', toolCalls: [tc('c1', 'write_file')], finishReason: 'tool_calls' }),
      resp({ text: '写完了。', finishReason: 'stop' })
    ])
    const seen: ChatTurn[][] = []
    const origCall = deps.call
    deps.call = (msgs, signal) => {
      seen.push(JSON.parse(JSON.stringify(msgs)) as ChatTurn[])
      return origCall(msgs, signal)
    }
    deps.stepReminder = () => '（内部催办：清单还停在旧状态）'
    const persisted: ChatTurn[] = []
    deps.onStepBoundary = (turns) => persisted.push(...turns)

    const r = await runToolLoop([{ role: 'user', content: '做个任务' }], deps, deps.signal)

    expect(r.stoppedReason).toBe('completed')
    // 第 1 轮请求里没有催办；第 2 轮（工具执行完之后）带上了
    expect(JSON.stringify(seen[0])).not.toContain('内部催办')
    expect(JSON.stringify(seen[1])).toContain('内部催办')
    // 催办不进落盘批次 → 界面不会多出一个假的用户气泡
    expect(JSON.stringify(persisted)).not.toContain('内部催办')
  })

  it('stepReminder 返回 null → 完全不打扰（不产生额外轮次）', async () => {
    const deps = makeDeps([
      resp({
        text: '看看时间。',
        toolCalls: [tc('c1', 'current_time')],
        finishReason: 'tool_calls'
      }),
      resp({ text: '三点。', finishReason: 'stop' })
    ])
    deps.stepReminder = () => null
    const r = await runToolLoop([{ role: 'user', content: '几点' }], deps, deps.signal)
    expect(r.rounds).toBe(2) // 只有"工具轮 + 收尾轮"
  })

  it('finishReminder 非空 → 先不结束收尾，多要一轮；且**只催一次**', async () => {
    const deps = makeDeps([
      resp({ text: '都做完了！', finishReason: 'stop' }),
      resp({ text: '（同步完清单）都做完了。', finishReason: 'stop' })
    ])
    const seen: ChatTurn[][] = []
    const origCall = deps.call
    deps.call = (msgs, signal) => {
      seen.push(JSON.parse(JSON.stringify(msgs)) as ChatTurn[])
      return origCall(msgs, signal)
    }
    let asked = 0
    deps.finishReminder = () => {
      asked += 1
      return '（内部催办：有做完的项还挂着 pending）'
    }

    const r = await runToolLoop([{ role: 'user', content: '做任务' }], deps, deps.signal)

    expect(r.stoppedReason).toBe('completed')
    expect(r.rounds).toBe(2) // 原计划 1 轮收尾 → 被催成 2 轮
    expect(r.finalText).toContain('同步完清单') // 最终文本取自被催后的那一轮
    expect(asked).toBe(1) // 第二次收尾不再催（否则会来回拉扯）
    expect(JSON.stringify(seen[1])).toContain('还挂着 pending')
  })

  it('中断时不催办：abort 后直接收尾', async () => {
    const controller = new AbortController()
    const deps = makeDeps([
      resp({ text: '查一下。', toolCalls: [tc('c1', 'current_time')], finishReason: 'tool_calls' }),
      resp({ text: '结果。', finishReason: 'stop' })
    ])
    deps.signal = controller.signal
    let asked = 0
    deps.finishReminder = () => {
      asked += 1
      return '（不该出现的催办）'
    }
    deps.onToolResult = () => controller.abort() // 工具执行完就掐断
    const r = await runToolLoop([{ role: 'user', content: '做任务' }], deps, deps.signal)
    expect(r.stoppedReason).toBe('aborted')
    expect(asked).toBe(0)
  })
})
