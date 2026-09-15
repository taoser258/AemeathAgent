// 分身执行日志单测：落盘为可解析 JSON + 滚动保留最新 20 份。

import { mkdtempSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { AGENT_LOG_KEEP, writeAgentLog } from '../src/main/agent/agent-log'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('分身执行日志', () => {
  it('落盘为可解析 JSON；滚动保留最新 ' + AGENT_LOG_KEEP + ' 份（删最旧）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-log-'))
    const total = AGENT_LOG_KEEP + 5
    for (let i = 0; i < total; i++) {
      writeAgentLog(dir, `r-test-${i}`, { seq: i, report: `第 ${i} 号分身` })
      await sleep(2) // mtime 有序（同毫秒写入会让"最旧"判定不稳定）
    }
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    expect(files).toHaveLength(AGENT_LOG_KEEP)
    // 留下的必须是最新 5 份之外的全部（seq 5..24）
    const seqs = files
      .map((f) => (JSON.parse(readFileSync(join(dir, f), 'utf-8')) as { seq: number }).seq)
      .sort((a, b) => a - b)
    expect(seqs[0]).toBe(total - AGENT_LOG_KEEP)
    expect(seqs[seqs.length - 1]).toBe(total - 1)
    // 最新一份内容可读
    const newest = JSON.parse(readFileSync(join(dir, `r-test-${total - 1}.json`), 'utf-8')) as {
      report: string
    }
    expect(newest.report).toContain('24')
  })
})
