// 学习笔记存储单测：追加 / 防御校验 / 会话隔离 / 损坏容错。

import { existsSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendNotes,
  getNotesBase,
  readNotes,
  removeNotes,
  setNotesBase
} from '../src/main/agent/tools/note-store'

let root = ''

beforeEach(() => {
  root = join(
    tmpdir(),
    'aemeath-notes-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
  )
  setNotesBase(join(root, 'notes'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('note-store', () => {
  it('追加与读回：id 自增时间戳、kind 归一、文件落盘', () => {
    const state = appendNotes('s1', [
      { kind: 'note', title: '闭包是什么', content: '函数与其词法环境的组合' },
      { kind: 'card', title: '闭包的用途？', content: '数据私有化 / 柯里化 / 回调状态保持' }
    ])
    expect(state.items).toHaveLength(2)
    const back = readNotes('s1')
    expect(back?.items[1].kind).toBe('card')
    expect(back?.items[1].title).toBe('闭包的用途？')
    expect(existsSync(join(getNotesBase(), 's1.json'))).toBe(true)
  })

  it('多次追加累加（追加式语义）；updatedAt 刷新', async () => {
    appendNotes('s1', [{ kind: 'note', title: 'a', content: 'x' }])
    const s1 = readNotes('s1')
    await new Promise((r) => setTimeout(r, 5))
    appendNotes('s1', [{ kind: 'card', title: 'b', content: 'y' }])
    const s2 = readNotes('s1')
    expect(s2?.items).toHaveLength(2)
    expect(s2?.updatedAt ?? 0).toBeGreaterThanOrEqual(s1?.updatedAt ?? 0)
  })

  it('防御：空/非数组/超批/非法 kind/缺 title 或 content', () => {
    expect(() => appendNotes('s1', [])).toThrow(/非空数组/)
    expect(() => appendNotes('s1', 'nope')).toThrow(/数组/)
    expect(() => appendNotes('s1', [{ kind: 'idea', title: 't', content: 'c' }])).toThrow(
      /没有合法条目/
    )
    expect(() => appendNotes('s1', [{ kind: 'note', title: '  ', content: 'c' }])).toThrow(
      /没有合法条目/
    )
    const big = Array.from({ length: 11 }, (_, i) => ({
      kind: 'note',
      title: 't' + i,
      content: 'c'
    }))
    expect(() => appendNotes('s1', big)).toThrow(/最多写入 10 条/)
  })

  it('title/content 截断：超长不拒绝但裁剪', () => {
    const state = appendNotes('s1', [
      { kind: 'note', title: 'x'.repeat(120), content: 'y'.repeat(3000) }
    ])
    expect(state.items[0].title).toHaveLength(80)
    expect(state.items[0].content).toHaveLength(2000)
  })

  it('会话隔离 + removeNotes + 损坏文件容错 + 未初始化拒写', () => {
    appendNotes('s1', [{ kind: 'note', title: 'a', content: 'x' }])
    expect(readNotes('s2')).toBeNull()
    removeNotes('s1')
    expect(readNotes('s1')).toBeNull()

    appendNotes('s1', [{ kind: 'note', title: 'a', content: 'x' }])
    writeFileSync(join(getNotesBase(), 's1.json'), '{oops', 'utf8')
    expect(readNotes('s1')).toBeNull()

    setNotesBase('')
    expect(() => appendNotes('s1', [{ kind: 'note', title: 'a', content: 'x' }])).toThrow(
      /未初始化/
    )
    expect(readNotes('s1')).toBeNull()
  })
})
