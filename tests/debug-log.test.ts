// T6.5 轻量调试日志测试：追加落盘 / 超限轮转（.old 保留一代）
// 对应修复③：主进程关键失败（会话落盘失败）不再只进打包后不可见的 console

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendDebugLog } from '../src/main/log'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aemeath-log-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('appendDebugLog', () => {
  it('追加多行，每行带 ISO 时间戳；目录自动创建', () => {
    appendDebugLog(dir, 'first line')
    appendDebugLog(dir, 'second line')
    const content = readFileSync(join(dir, 'aemeath.log'), 'utf8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(lines[0]).toContain('first line')
    expect(lines[1]).toContain('second line')
  })

  it('超过 maxBytes 轮转为 .old，新日志从空文件开始', () => {
    appendDebugLog(dir, 'a- rather long line exceeding threshold', 10)
    expect(existsSync(join(dir, 'aemeath.log.old'))).toBe(false)
    appendDebugLog(dir, 'b- second line pushes size past threshold', 10)
    // 第二次写入前超限 → 旧内容轮转为 .old，当前文件只含最新一行
    expect(existsSync(join(dir, 'aemeath.log.old'))).toBe(true)
    expect(readFileSync(join(dir, 'aemeath.log.old'), 'utf8')).toContain('a- rather long')
    expect(readFileSync(join(dir, 'aemeath.log'), 'utf8')).toContain('b- second line')
    const files = readdirSync(dir)
    expect(files.filter((f) => f === 'aemeath.log' || f === 'aemeath.log.old')).toHaveLength(2)
  })

  it('日志是旁路：目录创建失败不抛异常', () => {
    // 用已存在的文件冒充父目录，mkdirSync 必失败 → 内部吞掉不上抛
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x', 'utf8')
    expect(() => appendDebugLog(join(blocker, 'sub'), 'x')).not.toThrow()
  })
})
