// 流式事件消费守护：
// 病根复盘——todo_updated 事件主进程一直在推、协议也声明了，但渲染层 handleEvent
// 从没写过它的分支，导致任务清单「新建要重进会话才出现、勾完成项也要重进才刷新」。
// 这类「协议声明了事件、渲染层忘了接」是静默失效（不报错，只是 UI 不更新），
// 单测很难覆盖到真实推流路径，所以用静态文本 diff 兜底：
// protocol.ts 的 StreamEventType 联合里的每个事件，store.ts 必须出现
// `ev.type === '<事件>'` 的消费分支（或在 IGNORED 里显式声明「故意不接」并写理由）。
// 与 tools-panel / tool-labels / ipc-channels 同一套「多处真相 → diff 守护」思路。

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const protocolSrc = readFileSync(join(__dirname, '..', 'src/shared/protocol.ts'), 'utf8')
const storeSrc = readFileSync(join(__dirname, '..', 'src/renderer/chat/store.ts'), 'utf8')

/** 从 `export type StreamEventType = ...` 块里抽出所有单引号事件名 */
function declaredStreamEvents(): string[] {
  const m = /export type StreamEventType\s*=\s*([\s\S]*?)\n\n/.exec(protocolSrc)
  if (m === null) throw new Error('未找到 StreamEventType 定义（协议结构变了？同步更新本测试）')
  // 块内可能夹注释行，先去掉注释再抽引号串
  const body = m[1].replace(/\/\/[^\n]*/g, '')
  return [...body.matchAll(/'([a-z_]+)'/g)].map((x) => x[1])
}

/** store.ts 里 `ev.type === 'xxx'` 消费到的事件名 */
function consumedEvents(): Set<string> {
  return new Set([...storeSrc.matchAll(/ev\.type === '([a-z_]+)'/g)].map((x) => x[1]))
}

/**
 * 明确「协议声明但渲染层不消费」的白名单（当前应为空）。
 * 将来若真加了不需要在聊天流处理的事件，加到这里并写理由——强迫作者显式决策，
 * 而不是像 todo_updated 那样无声漏接。
 */
const IGNORED: Record<string, string> = {}

describe('流式事件消费守护（协议声明 = 渲染层必须接）', () => {
  const declared = declaredStreamEvents()
  const consumed = consumedEvents()

  it('成功解析到事件清单（防正则失效导致假绿）', () => {
    expect(declared.length).toBeGreaterThanOrEqual(10)
    // 抽查几个一定存在的事件，确认解析没跑偏
    for (const t of ['token', 'done', 'tool_call_result', 'todo_updated']) {
      expect(declared).toContain(t)
    }
  })

  it('★ 每个协议事件都在 store 有消费分支（或显式列入 IGNORED）', () => {
    const missing = declared.filter((t) => !consumed.has(t) && !(t in IGNORED))
    expect(missing).toEqual([])
  })

  it('★ IGNORED 里的事件确实存在于协议（防过时白名单）', () => {
    const stale = Object.keys(IGNORED).filter((t) => !declared.includes(t))
    expect(stale).toEqual([])
  })
})
