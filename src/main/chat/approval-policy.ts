// 审批判定。
//
// ── 成熟实现的模型──
// 成熟实现的权限**不是"要不要确认"这一个开关**，而是两个正交旋钮捆成的预设：
// ① 沙箱 SandboxMode('read-only' | 'workspace-write' | 'danger-full-access')
// —— 内核/OS 级强制文件效果，**这是主要防线**。注意 `read-only` 是沙箱**直接拒绝写入**，
// 而不是"弹窗问一句"。
// ② 审批 ApprovalPolicy('ask' | 'never') —— 要不要问人类，**只是越界时的逃生口**。
// 默认预设 `workspace-write`(=沙箱限工作区 + ask)，"完全不问"那个预设是
// `danger-full-access` + `never`。
//
// 所以 成熟实现的"调用工具基本不弹窗"**不是因为它放行了一切，而是因为沙箱已经把范围锁死、
// 没什么可问的**。另外三条实锤：成熟实现没有"只读工具自动放行"这条规则（放行由策略层决定）；
// MCP 工具在 成熟实现里就是普通工具、不因"是 MCP"而自动弹确认。
//
// ── Aemeath 的等价映射──────────────────────────────────────────
// Aemeath 没有 OS 级沙箱，最接近的等价物是 **工作区绑定+ 快照账本**：
// - 沙箱内的写入 → 工作区目录内的变更 → **免确认**（变更前有快照，可一键撤销）
// - 越界写入 → 工作区目录外 → **弹卡确认**（对应 成熟实现的"需要提权"）
// - danger-full-access → `full` 模式：全部免确认
// - MCP 工具 → **完全不进审批**（接入某个 server 即信任它，
// 边界由该 server 自己负责；对齐 成熟实现里 MCP 就是普通工具）
//
// 本模块是纯函数（无 electron / 无 IO），决策逻辑可直接单测。

import { isAbsolute, relative } from 'path'
import { toolNameWithLabel } from '@shared/tool-labels'

/** 一次调用是否需要审批 */
export interface ApprovalNeed {
  /** true = 需要弹卡等用户决策 */
  required: boolean
  /**
   * 需要审批时给用户看的"为什么问我"。
   * 不写"检测到变更操作"这种废话——要让人一眼看懂**该怎么做才能不再被打断**。
   */
  reason?: string
}

/**
 * target 是否位于 root 之内（含 root 自身）。
 *
 * 关键：不能用 `target.startsWith(root)` —— `E:\ab` 会误判为在 `E:\a` 之内。
 * 用 `path.relative` 判定：结果为 '' 或不是以 '..' 开头、且非绝对路径才在内部。
 * Windows 下 path.relative 本身大小写不敏感，无需额外处理。
 */
export function isPathInside(target: string, root: string): boolean {
  const rel = relative(root, target)
  if (rel === '') return true
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 判断一次工具调用是否需要用户审批。
 *
 * 判定顺序（每一条都是"能免就免"，与 成熟实现的"沙箱兜底"精神一致）：
 * 1. 只读工具 → 免问（权限只管变更）
 * 2. MCP 工具 → 免问
 * 3. 显式豁免（撤销上一步）→ 免问
 * 4. 未绑定工作区 → **问**（没有边界就无法判断越界，fail-closed；reason 会教用户怎么免问）
 * 5. 变更类但取不到目标路径 → **问**（fail-closed）
 * 6. 目标在工作区内 → 免问（有快照可撤销，等价于 成熟实现的 workspace-write 沙箱内）
 * 7. 其余（越界）→ **问**
 */
export function decideToolApproval(input: {
  toolName: string
  /** 该工具是否"变更"类（registry 的口径） */
  mutating: boolean
  /** 本次调用的目标绝对路径；无路径语义（撤销类工具）为 null */
  targetPath: string | null
  /** 会话绑定的工作区绝对路径；null = 未绑定 */
  workspace: string | null
  /** 是否属显式豁免的变更类工具（如撤销上一步） */
  exempt?: boolean
}): ApprovalNeed {
  const { toolName, mutating, targetPath, workspace, exempt } = input

  // 1. 只读：权限只管变更，读取永远不问
  if (!mutating) return { required: false }

  // 2. MCP 外部工具：—— 不进门禁。
  // 理由：MCP server 是用户主动接入的外部能力，其边界由该 server 自己负责；
  // 成熟实现里 MCP 工具同样只是普通工具，不因"是 MCP"而自动弹确认。
  if (toolName.startsWith('mcp__')) return { required: false }

  // 3. 显式豁免：撤销上一步只回滚「应用自己快照过的」内容，是恢复路径。
  // 对"撤销刚发生的错误"再弹一次确认，是把安全机制用在了错误的地方。
  if (exempt === true) return { required: false }

  // 4. 未绑定工作区：没有边界就没有"越界"可言 → fail-closed 询问。
  // reason 顺便告诉用户如何彻底摆脱这个弹窗（绑一个工作目录）。
  if (workspace === null || workspace.trim() === '') {
    return {
      required: true,
      reason: `「${toolNameWithLabel(toolName)}」会改动文件，但这次会话还没绑定工作目录——没有范围，我判断不了改动算不算越界。到 设置 → 目录 绑定一个工作目录后，那个目录里的改动就不用再问你了。`
    }
  }

  // 5. 变更类但解析不出目标路径：宁可多问一次（fail-closed）
  if (targetPath === null) {
    return {
      required: true,
      reason: `「${toolNameWithLabel(toolName)}」会改动文件，但这次调用说不出要改哪个路径。稳妥起见先问你一句；如果这是你常做的事，点"这个会话里都允许"就不再打断你。`
    }
  }

  // 6. 工作区内：等价于 成熟实现的 workspace-write 沙箱内 —— 直接执行，变更前已有快照可撤销
  if (isPathInside(targetPath, workspace)) return { required: false }

  // 7. 越界：对应 成熟实现的"需要提权"，问
  return {
    required: true,
    reason: `要改的东西不在你的工作目录里：${targetPath}（工作目录：${workspace}）。如果你确实想让她改这里，点「允许这次」即可；不想的话就点「不允许」。`
  }
}
