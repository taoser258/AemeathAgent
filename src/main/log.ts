// 轻量调试日志：主进程 console 在打包后不可见，关键失败（会话落盘失败等）
// 追加写入 <userData>/logs/aemeath.log 供排障取证。
// 自写 appendFile，不引入日志库；失败绝不阻塞业务。

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'

const LOG_FILE = 'aemeath.log'
/** 单文件超过 1MB 轮转为 .old（保留一代，防无限增长） */
const ROTATE_BYTES = 1_000_000

/** 追加一行日志；目录不存在自动创建；maxBytes 供测试注入小阈值验证轮转 */
export function appendDebugLog(dir: string, line: string, maxBytes: number = ROTATE_BYTES): void {
  try {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, LOG_FILE)
    if (existsSync(file) && statSync(file).size > maxBytes) {
      try {
        renameSync(file, `${file}.old`)
      } catch {
        /* 轮转失败则继续原文件追加 */
      }
    }
    appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {
    /* 日志是尽力而为的旁路，任何失败都不上抛 */
  }
}
