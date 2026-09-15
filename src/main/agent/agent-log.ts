// 子任务执行日志：分身的完整消息序列落 userData/logs/agents/，
// 滚动保留最近 KEEP 份。用途：事后审计（分身到底干了什么）与排查「报告不对劲」时的原始记录。
// 设计取舍：分身对话本身不持久化为会话（不进侧栏），但原始记录必须在——审计是权限语义的一部分。
// 失败静默：日志不是关键路径，落盘失败绝不影响分身结果。

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

/** 滚动保留份数 */
export const AGENT_LOG_KEEP = 20

/** 写一份分身执行日志（name 不含扩展名）并做滚动清理。目录不存在会创建。 */
export function writeAgentLog(agentsDir: string, name: string, payload: unknown): void {
  try {
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(join(agentsDir, `${name}.json`), JSON.stringify(payload, null, 2), 'utf-8')
    // 滚动清理：按修改时间保留最新 KEEP 份
    const files = readdirSync(agentsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, mtime: statSync(join(agentsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const old of files.slice(AGENT_LOG_KEEP)) {
      try {
        unlinkSync(join(agentsDir, old.f))
      } catch {
        /* 单个删不掉不影响其它 */
      }
    }
  } catch {
    // 日志落盘失败不影响分身结果
  }
}
