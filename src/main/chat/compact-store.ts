// 上下文摘要存储（P8-T1）：每会话一份 userData/compact/<sessionId>.json。
//
// 为什么必须落盘：压缩只作用于**发送视图**（会话原档一条不删），但摘要本身要跨 run 复用——
// 否则用户在一个长会话里每发一句，都要为同一段旧历史重新付费做一次摘要（既慢又贵），
// 而且"刚压完又满"的观感很差。落盘后：本次 run 结束、重开应用，摘要都还在。
//
// 红线：这里只存**摘要文本**，不存任何原始对话（原始记录只有会话档那一份）。
// 无 electron 依赖：基路径注入（setCompactBase），vitest 可直接单测。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

/** 摘要长度上限（字符）：摘要本身必须是小东西，否则就违背了压缩的初衷 */
export const COMPACT_SUMMARY_MAX_CHARS = 12_000

/** 会话 id 白名单（与会话档同口径，顺带挡住路径穿越） */
const SESSION_ID_RE = /^[A-Za-z0-9-]+$/

let compactBase = ''

export function setCompactBase(dir: string): void {
  compactBase = dir
}

export function getCompactBase(): string {
  return compactBase
}

function summaryPath(sessionId: string): string | null {
  if (compactBase === '' || !SESSION_ID_RE.test(sessionId)) return null
  return join(compactBase, `${sessionId}.json`)
}

/** 读会话摘要；没有/读坏返回 null（摘要坏了按"没有"处理，最坏是多花一次摘要调用） */
export function readCompactSummary(sessionId: string): string | null {
  const path = summaryPath(sessionId)
  if (path === null || !existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { summary?: unknown }
    return typeof parsed.summary === 'string' && parsed.summary.trim() !== ''
      ? parsed.summary
      : null
  } catch {
    return null
  }
}

/** 写会话摘要（超长截断：宁可少说，也不能让"压缩器"自己把上下文撑起来） */
export function writeCompactSummary(sessionId: string, summary: string): boolean {
  const path = summaryPath(sessionId)
  if (path === null) return false
  const text =
    summary.length > COMPACT_SUMMARY_MAX_CHARS
      ? `${summary.slice(0, COMPACT_SUMMARY_MAX_CHARS)}\n…（摘要过长已截断）`
      : summary
  try {
    mkdirSync(dirname(path), { recursive: true }) // 启动只 setBase 不建目录，写入时自建
    writeFileSync(
      path,
      `${JSON.stringify({ summary: text, updatedAt: Date.now() }, null, 2)}\n`,
      'utf8'
    )
    return true
  } catch {
    return false
  }
}

/** 清会话摘要（会话被删/用户手动清空时用；失败静默——最坏是留个孤儿文件，启动清扫也会收） */
export function clearCompactSummary(sessionId: string): void {
  const path = summaryPath(sessionId)
  if (path === null) return
  try {
    rmSync(path, { force: true })
  } catch {
    /* 忽略 */
  }
}
