// 历史投影单测（chat/history.ts）：持久化消息 ↔ LLM ChatTurn 纯函数。
// 覆盖：工具往返投影 / 悬空调用补占位 / 脏数据（缺 id 的 tool 结果）丢弃 / 附件降级 / 落盘互逆。

import { describe, expect, it } from 'vitest'
import {
  attachmentNote,
  imageVerificationNote,
  llmTurnsToPersisted,
  projectPersistedHistory,
  trimHistoryForRequest,
  pruneToolResults
} from '../src/main/chat/history'
import type { ChatTurn } from '../src/main/llm/client'
import type { PersistedMessage } from '../src/shared/types'

function msg(m: Partial<PersistedMessage> & { role: PersistedMessage['role'] }): PersistedMessage {
  return { id: 'm-x', ts: 1700000000000, text: '', ...m }
}

describe('projectPersistedHistory（持久化 → LLM 投影）', () => {
  it('工具往返投影：assistant.toolCalls → tool_calls 形态，role=tool → tool_call_id 形态', () => {
    const turns = projectPersistedHistory([
      msg({ role: 'user', text: '现在几点？' }),
      msg({
        role: 'assistant',
        text: '我查一下',
        toolCalls: [{ id: 'c1', name: 'current_time', argsJson: '{}' }]
      }),
      msg({ role: 'tool', text: '15:00', toolCallId: 'c1' })
    ])
    expect(turns).toHaveLength(3)
    expect(turns[0]).toEqual({ role: 'user', content: '现在几点？' })
    expect(turns[1].role).toBe('assistant')
    expect(turns[1].tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'current_time', arguments: '{}' } }
    ])
    expect(turns[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '15:00' })
  })

  it('悬空调用修补：assistant 有调用无结果（步数上限/中断）→ 自动补占位 tool 结果', () => {
    const turns = projectPersistedHistory([
      msg({
        role: 'assistant',
        text: '',
        toolCalls: [
          { id: 'c1', name: 'read_file', argsJson: '{"path":"a"}' },
          { id: 'c2', name: 'list_dir', argsJson: '{"path":"."}' }
        ]
      }),
      // 只有 c1 有结果，c2 悬空
      msg({ role: 'tool', text: '文件内容', toolCallId: 'c1' })
    ])
    // assistant → tool(c1) → 补位 tool(c2)
    expect(turns).toHaveLength(3)
    expect(turns[2].role).toBe('tool')
    expect(turns[2].tool_call_id).toBe('c2')
    expect(turns[2].content).toContain('未执行')
  })

  it('脏数据防御：缺 toolCallId 的 tool 结果被丢弃；空 id 的调用不补占位', () => {
    const turns = projectPersistedHistory([
      msg({ role: 'tool', text: '孤儿结果' }), // 无 toolCallId → 丢
      msg({
        role: 'assistant',
        text: '',
        toolCalls: [{ id: '', name: 'read_file', argsJson: '{}' }] // 空 id → 不补
      })
    ])
    // 只有 assistant 一条（孤儿 tool 丢弃、空 id 不产生补位）
    expect(turns).toHaveLength(1)
    expect(turns[0].role).toBe('assistant')
  })

  it('附件降级：sticker/文本附件转文字说明并入 user content；图片并入图片汇总注记', () => {
    const turns = projectPersistedHistory([
      msg({
        role: 'user',
        text: '看这个',
        attachments: [
          { name: '加油.gif', kind: 'sticker' },
          { name: 'notes.txt', kind: 'text', text: '重要内容' },
          { name: 'photo.png', kind: 'image', dataUrl: 'data:image/png;base64,x' }
        ]
      })
    ])
    const content = turns[0].content as string
    expect(content).toContain('看这个')
    expect(content).toContain('[用户发送了一张爱弥斯表情包：加油.gif]')
    // 文本附件：文件名 + 「正文已内联、别再核对」提示（防 的 run_js 硬解返工）
    expect(content).toContain('[附件文件：notes.txt')
    expect(content).toContain('正文已完整内联')
    expect(content).toContain('重要内容')
    expect(content).toContain('[用户发送了图片：photo.png]')
    // 图片 dataUrl 不进文字投影（历史轮当轮 parts 已过期，降级为文字）
    expect(content).not.toContain('base64')
  })

  it('attachmentNote：图片返回 null（当轮走 parts）；未知 kind 走通用说明', () => {
    expect(attachmentNote({ name: 'p.png', kind: 'image' })).toBeNull()
    expect(attachmentNote({ name: 'f.bin', kind: 'file' })).toBe(
      '\n[用户添加了附件：f.bin（二进制/未知格式，正文未内联；需要内容请让用户说明或换文本格式）]'
    )
  })

  it('★ attachmentNote：带本地路径时写进说明（她才能接着处理这个文件，不用满磁盘找）', () => {
    const note = attachmentNote({
      name: '后三章公式总结.docx',
      kind: 'text',
      text: '正文片段',
      path: 'C:\\Users\\admin\\Desktop\\后三章公式总结.docx'
    })
    expect(note).toContain('后三章公式总结.docx')
    expect(note).toContain('本地路径：C:\\Users\\admin\\Desktop\\后三章公式总结.docx')
    expect(note).toContain('正文片段') // 正文已内联
    // 正文给了还要去"核对"原文件是 踩过的坑（run_js 硬解 + 落临时文件）
    expect(note).toContain('正文已完整内联')
    expect(note).toContain('不要再用 read_file')
  })

  it('★ attachmentNote：读不了正文的附件给出可执行下一步（PDF 明说别搜磁盘）', () => {
    const pdf = attachmentNote({ name: '论文.pdf', kind: 'file', path: '/tmp/论文.pdf' })
    expect(pdf).toContain('本地路径：/tmp/论文.pdf')
    expect(pdf).toContain('不要为此搜索磁盘')
    expect(attachmentNote({ name: '旧版.doc', kind: 'file' })).toContain('另存为 .docx')
  })
})

describe('imageVerificationNote（P7-T4 视觉核对提示）', () => {
  it('单图/多图文案单复数正确', () => {
    expect(imageVerificationNote(1)).toContain('这张图片')
    expect(imageVerificationNote(3)).toContain('这 3 张图片')
  })

  it('三条硬约束都在：标"识别" / 关键信息核对 / 看不清不许猜', () => {
    const note = imageVerificationNote(1)
    expect(note).toContain('根据图片识别')
    expect(note).toContain('复述确认')
    expect(note).toContain('禁止猜测')
  })

  it('★ 多模态直看图 ≠ 转述（owner 实测：措辞写错导致她去找文件/调 OCR）', () => {
    const note = imageVerificationNote(1)
    expect(note).toContain('你已直接看到')
    expect(note).not.toContain('转述给你')
    // 聊天图片没有磁盘路径：禁止找文件、禁止对它调两个识图工具
    expect(note).toContain('没有磁盘路径')
    expect(note).toContain('describe_image / ocr_image')
  })
})

describe('llmTurnsToPersisted（LLM turns → 持久化，与投影互逆）', () => {
  it('assistant(含 tool_calls) 与 tool 结果转持久化形态；user/system 忽略（已在盘上）', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: 'hi' }, // 落盘侧不管 user（发送前已单独落）
      {
        role: 'assistant',
        content: '查一下',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'c1', content: '内容' }
    ]
    const out = llmTurnsToPersisted(turns)
    expect(out).toHaveLength(2)
    expect(out[0].role).toBe('assistant')
    expect(out[0].text).toBe('查一下')
    expect(out[0].toolCalls).toEqual([{ id: 'c1', name: 'read_file', argsJson: '{"path":"a"}' }])
    expect(out[1]).toMatchObject({ role: 'tool', text: '内容', toolCallId: 'c1' })
    // id/ts 自动生成
    expect(out[0].id).toBeTruthy()
    expect(out[0].ts).toBeGreaterThan(0)
  })

  it('投影往返：落盘 → 投影 → 落盘 → 再投影，形态稳定（互逆性；user 由发送侧单独落盘故不在循环侧）', () => {
    const assistantBlock: PersistedMessage[] = [
      msg({ role: 'user', text: '帮忙读文件' }),
      msg({
        role: 'assistant',
        text: '好的',
        toolCalls: [{ id: 'c9', name: 'read_file', argsJson: '{"path":"x"}' }]
      }),
      msg({ role: 'tool', text: 'X 的内容', toolCallId: 'c9' })
    ]
    const once = projectPersistedHistory(assistantBlock)
    const repersisted = llmTurnsToPersisted(once)
    const twice = projectPersistedHistory(repersisted)
    // 二次投影形态稳定（user 发送侧已落盘，循环侧投影不含它；id/ts 不参与投影）
    const strip = (ms: PersistedMessage[]): Array<{ role: string; text: string }> =>
      ms.filter((m) => m.role !== 'user').map(({ role, text }) => ({ role, text }))
    const stripTurns = (ts: ChatTurn[]): Array<{ role: string; content: string }> =>
      ts
        .filter((t) => t.role !== 'user')
        .map(({ role, content }) => ({ role, content: String(content) }))
    expect(stripTurns(twice)).toEqual(stripTurns(once))
    // 再落盘的记录与原始 assistant/tool 记录语义一致
    expect(strip(repersisted)).toEqual(strip(assistantBlock))
  })
})

describe('trimHistoryForRequest', () => {
  const user = (t: string): ChatTurn => ({ role: 'user', content: t })
  const asst = (id: string): ChatTurn => ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{}' } }]
  })
  const tool = (id: string): ChatTurn => ({ role: 'tool', tool_call_id: id, content: 'ok' })

  it('切点落在 tool 中间：丢弃前导 tool，序列以合法消息开头（真实 400 场景）', () => {
    const turns: ChatTurn[] = [
      user('一'),
      asst('c1'),
      tool('c1'),
      asst('c2'),
      tool('c2'),
      tool('c2b') // 同一 assistant 的第二个结果
    ]
    // limit=3 → 原始 slice 得 [tool('c2'), tool('c2b'), ...] 之类，必含前导 tool
    const kept = trimHistoryForRequest(turns, 3)
    expect(kept[0]?.role).not.toBe('tool')
    // 尾部内容完整保留（最近的上下文不丢）
    expect(kept[kept.length - 1]).toEqual(tool('c2b'))
  })

  it('全为 tool 的窗口 → 返回空数组（宁可无历史也不发非法序列）', () => {
    expect(trimHistoryForRequest([tool('c1'), tool('c2')], 2)).toEqual([])
  })

  it('正常窗口不受影响（已合法则不裁剪）', () => {
    const turns: ChatTurn[] = [user('一'), asst('c1'), tool('c1'), user('二')]
    expect(trimHistoryForRequest(turns, 10)).toEqual(turns)
  })

  it('limit<=0 → 空数组', () => {
    expect(trimHistoryForRequest([user('一')], 0)).toEqual([])
  })
})

// ── pruneToolResults（result-pruner 同款：超长工具结果请求侧裁剪）────────

describe('pruneToolResults', () => {
  const big = 'x'.repeat(20_000)
  const marker = 'y'.repeat(1_024)

  it('超限 tool 结果 → 保头 4096 + 尾 1024 + 中间省略标注', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: '跑一下' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'run_shell', arguments: '{}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'c1', content: marker + big + marker },
      { role: 'user', content: '继续' }
    ]
    const out = pruneToolResults(turns)
    const t = out[2]
    expect(t.role).toBe('tool')
    const text = t.content as string
    expect(text.length).toBeLessThan(big.length)
    expect(text.startsWith('y'.repeat(1024) + 'x'.repeat(4096 - 1024))).toBe(true) // 头 4096 = marker 前 1024 + big 前 3072
    expect(text.endsWith(marker)).toBe(true) // 尾 1024 = 第二个 marker 全部
    expect(text).toContain('中间省略')
    // 原数组不被修改（loop 的 messages 仍要原位累积落盘）
    expect(turns[2].content).toBe(marker + big + marker)
  })

  it('未超限的 tool 结果原样返回（同一引用）', () => {
    const turns: ChatTurn[] = [{ role: 'tool', tool_call_id: 'c1', content: '短输出' }]
    const out = pruneToolResults(turns)
    expect(out[0]).toBe(turns[0])
  })

  it('非 tool 消息不裁（user/assistant 原样）', () => {
    const big = 'z'.repeat(30_000)
    const turns: ChatTurn[] = [
      { role: 'user', content: big },
      { role: 'assistant', content: big }
    ]
    const out = pruneToolResults(turns)
    expect(out[0].content).toBe(big)
    expect(out[1].content).toBe(big)
  })
})
