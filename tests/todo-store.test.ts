// todo 存储单测：整表替换 / **宽容归一** / 隔离 / 恢复读取。
//
// ★ 语义变更：status 不再只认 pending/done——
// 她提交 in_progress 被整表拒掉之后，就再也没敢碰这个工具，清单永远停在 0/5。
// 下面的用例把那次的**原样载荷**钉成回归。

import { existsSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getTodoBase, readTodos, setTodoBase, writeTodos } from '../src/main/agent/tools/todo-store'

let root = ''

beforeEach(() => {
  root = join(tmpdir(), 'aemeath-todo-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6))
  setTodoBase(join(root, 'todos'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('todo-store', () => {
  it('整表替换：写入后可读回，id 按序生成，文件落盘', () => {
    const { state } = writeTodos('s1', [
      { text: '读配置', status: 'done' },
      { text: '写报告', status: 'pending' }
    ])
    expect(state.items.map((i) => i.id)).toEqual(['t0', 't1'])
    expect(state.items[0].status).toBe('done')
    const back = readTodos('s1')
    expect(back?.items).toHaveLength(2)
    expect(back?.items[1].text).toBe('写报告')
    expect(existsSync(join(getTodoBase(), 's1.json'))).toBe(true)
  })

  it('★ 回归：status="in_progress" 不再整表拒绝，按未完成记', () => {
    const { state, coerced } = writeTodos('s1', [
      { text: '建结构：创建 笔记/ 与 汇总/ 目录骨架', status: 'in_progress' },
      { text: '拆大纲：把 大纲.md 三章拆成分章笔记文件', status: 'pending' }
    ])
    expect(state.items).toHaveLength(2)
    expect(state.items[0].status).toBe('pending') // 保守方向：不误报进度
    // 别名是**预期写法**，不算"认不出"——回执不该说"认不出"去吓模型
    //
    expect(coerced).toBe(0)
  })

  it('真认不出的 status 才计数（回执要如实告知），且仍不拒整表', () => {
    const { state, coerced } = writeTodos('s1', [
      { text: 'a', status: 'blocked' }, // 不认识 → 按未完成 + 计数
      { text: 'b', status: 'in_progress' }, // 认识的别名 → 折算但不计数
      { text: 'c', status: 'done' }
    ])
    expect(state.items.map((i) => i.status)).toEqual(['pending', 'pending', 'done'])
    expect(coerced).toBe(1)
  })

  it('status 别名归一：completed / doing / todo / 已完成 都认', () => {
    const { state } = writeTodos('s1', [
      { text: 'a', status: 'completed' },
      { text: 'b', status: 'finished' },
      { text: 'c', status: 'doing' },
      { text: 'd', status: 'in-progress' },
      { text: 'e', status: '已完成' },
      { text: 'f', status: 'todo' },
      { text: 'g', status: true },
      { text: 'h' } // 缺 status → 未完成
    ])
    expect(state.items.map((i) => i.status)).toEqual([
      'done',
      'done',
      'pending',
      'pending',
      'done',
      'pending',
      'done',
      'pending'
    ])
  })

  it('条目写法宽容：字符串数组 / title·label·content 字段都认', () => {
    const { state } = writeTodos('s1', ['建目录骨架', { title: '拆大纲', status: 'done' }])
    expect(state.items[0].text).toBe('建目录骨架')
    expect(state.items[0].status).toBe('pending')
    expect(state.items[1].text).toBe('拆大纲')
    expect(state.items[1].status).toBe('done')
  })

  it('超量：截断到 20 项并回报 dropped（不再整表拒）', () => {
    const big = Array.from({ length: 23 }, (_, i) => ({ text: 't' + i, status: 'pending' }))
    const { state, dropped } = writeTodos('s1', big)
    expect(state.items).toHaveLength(20)
    expect(dropped).toBe(3)
    expect(state.items[19].text).toBe('t19')
  })

  it('text 截断到 200：超长不拒绝但裁剪', () => {
    const { state } = writeTodos('s1', [{ text: 'x'.repeat(500), status: 'pending' }])
    expect(state.items[0].text).toHaveLength(200)
  })

  it('真的读不出内容才报错：全空白 / 非数组', () => {
    expect(() => writeTodos('s1', [{ text: '   ', status: 'pending' }])).toThrow(/text/)
    expect(() => writeTodos('s1', [null, 42])).toThrow(/text/)
    expect(() => writeTodos('s1', 'not-array' as unknown as unknown[])).toThrow(/数组/)
  })

  it('读不出文字的条目被跳过，其余照收（不为一条废条目报废整表）', () => {
    const { state } = writeTodos('s1', [
      { text: '好的', status: 'pending' },
      { text: '', status: 'pending' },
      { text: '也好', status: 'done' }
    ])
    expect(state.items.map((i) => i.text)).toEqual(['好的', '也好'])
  })

  it('会话隔离：s1 与 s2 各自独立；清空清单（空数组）合法', () => {
    writeTodos('s1', [{ text: 'a', status: 'pending' }])
    writeTodos('s2', [{ text: 'b', status: 'done' }])
    expect(readTodos('s1')?.items[0].text).toBe('a')
    expect(readTodos('s2')?.items[0].text).toBe('b')
    writeTodos('s1', [])
    expect(readTodos('s1')?.items).toHaveLength(0)
    expect(readTodos('s2')?.items).toHaveLength(1)
  })

  it('无清单读 null；损坏文件读 null 不抛', () => {
    expect(readTodos('none')).toBeNull()
    writeTodos('s1', [{ text: 'a', status: 'pending' }])
    writeFileSync(join(getTodoBase(), 's1.json'), '{oops', 'utf8')
    expect(readTodos('s1')).toBeNull()
  })
})
