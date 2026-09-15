// 全局用量流水。
// 设计取舍：**不动会话档**（每会话整写 JSON 是既定决议，为每轮明细整写太重），
// 另建 usage/log.jsonl 每轮追加一行——追加写便宜、坏行可跳过、超限裁剪即可。
// 注意：流水自本版本起记录，此前的用量只有会话档里的累计值（无时间/模型维度）。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'fs'
import { join } from 'path'

/** 一轮对话的用量明细（一轮 = 一次 agent loop，可能含多步工具调用） */
export interface UsagePoint {
  /** 完成时间戳（毫秒） */
  t: number
  /** 模型名（profile.model，按模型分组用） */
  model: string
  inputTok: number
  outputTok: number
  cachedTok: number
  /** 纯 LLM 耗时（毫秒） */
  llmMs: number
  rounds: number
}

/** 单文件体积上限（约 2MB）：超过即裁剪到最近 5000 行（重度使用也够 30 天回看） */
const MAX_BYTES = 2 * 1024 * 1024
const KEEP_LINES = 5000

export function usageLogPath(dir: string): string {
  return join(dir, 'usage', 'log.jsonl')
}

/** 追加一条用量明细；任何失败都不抛（遥测不能影响对话主链路） */
export function appendUsage(dir: string, point: UsagePoint): void {
  try {
    const file = usageLogPath(dir)
    if (!existsSync(file)) {
      mkdirSync(join(dir, 'usage'), { recursive: true })
    } else if (statSync(file).size > MAX_BYTES) {
      // 裁剪：改名留备份 → 取尾部重写（崩溃中断也只是多一个备份文件，不丢已有数据）
      const lines = readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
      const kept = lines.slice(-KEEP_LINES)
      try {
        renameSync(file, `${file}.old`)
      } catch {
        /* 备份失败不阻塞重写 */
      }
      appendFileSync(file, kept.join('\n') + '\n', 'utf8')
    }
    appendFileSync(file, JSON.stringify(point) + '\n', 'utf8')
  } catch {
    /* 静默：遥测失败不值得打扰用户 */
  }
}

/** 行 → UsagePoint：字段非法按 0 收敛，model 缺失归 '未知'（防御坏行） */
export function parseUsageLine(raw: string): UsagePoint | null {
  try {
    const r = JSON.parse(raw) as Record<string, unknown>
    if (typeof r.t !== 'number' || !Number.isFinite(r.t)) return null
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    return {
      t: r.t,
      model: typeof r.model === 'string' && r.model !== '' ? r.model : '未知',
      inputTok: num(r.inputTok),
      outputTok: num(r.outputTok),
      cachedTok: num(r.cachedTok),
      llmMs: num(r.llmMs),
      rounds: num(r.rounds)
    }
  } catch {
    return null
  }
}

/** 读全部流水（时间升序）；文件缺失/空返回 []，坏行跳过 */
export function readUsage(dir: string): UsagePoint[] {
  const file = usageLogPath(dir)
  if (!existsSync(file)) return []
  try {
    const out: UsagePoint[] = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      const point = parseUsageLine(line)
      if (point !== null) out.push(point)
    }
    return out.sort((a, b) => a.t - b.t)
  } catch {
    return []
  }
}
