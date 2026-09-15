// checkpoint 标记单测：写/读/清生命周期 + 容错（损坏文件清掉返回 null）。

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearCheckpointMarker,
  readCheckpointMarker,
  saveCheckpointMarker
} from '../src/main/checkpoint'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aemeath-ckpt-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('checkpoint 标记', () => {
  it('写→读往返：字段一致；清→读为 null 且文件不存在', () => {
    saveCheckpointMarker(dir, {
      sessionId: 's-1',
      status: 'running',
      steps: 3,
      updatedAt: 1700000000000
    })
    const marker = readCheckpointMarker(dir, 's-1')
    expect(marker).toEqual({
      sessionId: 's-1',
      status: 'running',
      steps: 3,
      updatedAt: 1700000000000
    })

    clearCheckpointMarker(dir, 's-1')
    expect(readCheckpointMarker(dir, 's-1')).toBeNull()
    expect(existsSync(join(dir, 's-1.json'))).toBe(false)
  })

  it('更新即覆盖：running → paused 步数递增', () => {
    saveCheckpointMarker(dir, { sessionId: 's-2', status: 'running', steps: 1, updatedAt: 1 })
    saveCheckpointMarker(dir, { sessionId: 's-2', status: 'paused', steps: 5, updatedAt: 2 })
    const marker = readCheckpointMarker(dir, 's-2')
    expect(marker).toEqual({ sessionId: 's-2', status: 'paused', steps: 5, updatedAt: 2 })
  })

  it('未写入的会话读为 null；clear 不存在的标记也不抛异常', () => {
    expect(readCheckpointMarker(dir, 's-none')).toBeNull()
    expect(() => clearCheckpointMarker(dir, 's-none')).not.toThrow()
  })

  it('损坏文件：读为 null 且文件被顺手清掉', () => {
    writeFileSync(join(dir, 's-bad.json'), '{oops', 'utf8')
    expect(readCheckpointMarker(dir, 's-bad')).toBeNull()
    expect(existsSync(join(dir, 's-bad.json'))).toBe(false)
  })

  it('结构非法（缺字段/状态值不对）：读为 null 并清理', () => {
    writeFileSync(
      join(dir, 's-bad2.json'),
      JSON.stringify({ sessionId: 's-bad2', status: 'weird', steps: 'x' }),
      'utf8'
    )
    expect(readCheckpointMarker(dir, 's-bad2')).toBeNull()
  })
})
