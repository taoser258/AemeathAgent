// checkpoint 存档标记：记录"某会话有一个未完成的 harness 任务"。
// 设计：只存进度元数据（步数/时间/状态），不存密钥、不存图片、不重复存消息——
// 具体步骤本来就随会话文件逐步落盘，续跑时从会话历史重建即可。
// 生命周期：运行开始写入 running → 每步边界更新 → 正常完成删除；
// 中断/步数上限/出错保留为 paused（渲染层出"继续任务"横幅）。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface CheckpointMarker {
  sessionId: string
  /** paused = 可续跑；running = 正在跑（理论上渲染层见不到，崩溃残留时按 paused 处理） */
  status: 'running' | 'paused'
  /** 已执行的变更/工具步数 */
  steps: number
  updatedAt: number
}

function markerPath(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.json`)
}

/** 写入/更新标记（原子性靠临时文件+rename 的简化版：先写后改名开销小，此处直接整写小 JSON 足够） */
export function saveCheckpointMarker(dir: string, marker: CheckpointMarker): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(markerPath(dir, marker.sessionId), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
}

/** 读取标记；文件缺失/损坏 = null（损坏文件顺手清掉，不让脏数据长期驻留） */
export function readCheckpointMarker(dir: string, sessionId: string): CheckpointMarker | null {
  const file = markerPath(dir, sessionId)
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    if (
      typeof raw.sessionId !== 'string' ||
      (raw.status !== 'running' && raw.status !== 'paused') ||
      typeof raw.steps !== 'number' ||
      typeof raw.updatedAt !== 'number'
    ) {
      throw new Error('结构非法')
    }
    return {
      sessionId: raw.sessionId,
      status: raw.status,
      steps: raw.steps,
      updatedAt: raw.updatedAt
    }
  } catch {
    try {
      rmSync(file, { force: true })
    } catch {
      // 清理失败不阻塞：下次读取还会再试
    }
    return null
  }
}

/** 清除标记（正常完成 / 用户放弃时调用；文件不存在也视为成功） */
export function clearCheckpointMarker(dir: string, sessionId: string): void {
  try {
    rmSync(markerPath(dir, sessionId), { force: true })
  } catch {
    // 删不掉不阻塞主流程：最坏情况是多显示一次"继续任务"横幅
  }
}
