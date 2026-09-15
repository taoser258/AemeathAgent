// T7 · IPC 通道唯一性与命名规范测试
// 防回归：后续任务往 ipc-channels.ts 加通道时，重名/漏前缀在这里当场炸掉

import { describe, expect, it } from 'vitest'
import * as channels from '../src/shared/ipc-channels'

/** 合法通道前缀（渲染/主进程语义分组） */
const KNOWN_PREFIXES = [
  'chat:',
  'sticker:',
  'dialog:',
  'session:',
  'ledger:',
  'todo:',
  'notes:',
  // 学习闭环：复习队列与学习进度——与 notes（笔记读写）语义不同
  // （复习调度有自己的档位/到期时间，进度有自己的计划与掌握度），单独分组
  'review:',
  'progress:',
  'skills:',
  'settings:',
  // MCP 专用通道：密钥写入与"测试连接"与设置读写语义不同（前者碰 safeStorage、
  // 后者临时起子进程），所以单独分组而不是塞进 settings:
  'mcp:',
  'pet:',
  'win:',
  'checkpoint:',
  // 右侧边栏（学 成熟实现better-sidebar）：工作区文件树与预览——只读工作区，
  // 与 settings（配置读写）、session（会话档）语义不同，单独分组
  'workspace:',
  // 右侧栏内嵌浏览器（v17 主进程 WebContentsView 方案）
  'browser:',
  // 记忆管理
  'memory:',
  // 工作区内容检索
  'search:',
  // 终端 v2
  'terminal:',
  // 自动更新
  'update:'
]

function channelEntries(): Array<[string, string]> {
  return Object.entries(channels).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  )
}

describe('shared/ipc-channels', () => {
  it('所有通道值全局唯一（重名 = 两路消息串台）', () => {
    const values = channelEntries().map(([, v]) => v)
    expect(new Set(values).size).toBe(values.length)
  })

  it('所有通道都带约定前缀（防裸命名通道混入）', () => {
    for (const [name, value] of channelEntries()) {
      expect(
        KNOWN_PREFIXES.some((p) => value.startsWith(p)),
        `通道 ${name} = "${value}" 不带任何约定前缀`
      ).toBe(true)
    }
  })

  it('常量名小写后与通道值强相关（防复制粘贴错值；允许复数/分词差异，只查冒号前后主段）', () => {
    for (const [name, value] of channelEntries()) {
      const [prefix, ...rest] = value.split(':')
      // 前缀必须出现在常量名开头（CHAT_* → chat，SESSION_* → session…）
      expect(
        name.toLowerCase().startsWith(prefix),
        `通道 ${name} = "${value}" 的前缀 "${prefix}" 未体现在常量名中`
      ).toBe(true)
      expect(rest.length).toBeGreaterThan(0)
    }
  })

  it('核心聊天链路通道就位（send / cancel / stream）', () => {
    expect(channels.CHAT_SEND).toBe('chat:send')
    expect(channels.CHAT_CANCEL).toBe('chat:cancel')
    expect(channels.CHAT_STREAM).toBe('chat:stream')
  })
})
