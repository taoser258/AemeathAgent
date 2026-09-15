// 审批卡：主进程挂起等待用户决策时，在消息区与输入框之间显示。
// 两种形态：tool = 单次调用确认（允许 / 本会话允许此工具 / 拒绝）；
// plan = 计划模式首轮（整批调用一次确认，批准后本轮放开）。
//
// 「英文与专业术语太多，用户难以理解」→ 全卡改口语：
// · 标题/说明/按钮一律说人话（"允许这次"而不是"allow"）；
// · 工具名附中文注解（`edit_file（改文件）`，见 shared/tool-labels.ts）；
// · 参数不再裸奔 JSON——先用一句人话讲"她要干什么"，原始 JSON 折进「技术细节」
// 默认收起（排查时才展开）。

import { useState } from 'react'
import type { ToolApprovalRequestData, ToolCallEventData } from '@shared/protocol'
import { summarizeToolCall, toolNameWithLabel } from '@shared/tool-labels'
import { useChatStore } from './store'

/** 单条待批调用：中文名 + 人话描述；原始参数与 diff/预览按需展开 */
function ApprovalCall({ call }: { call: ToolCallEventData }): React.JSX.Element {
  const [showTech, setShowTech] = useState(false)
  const summary = summarizeToolCall(call.name, call.argsPreview)
  return (
    <div className="approval-call">
      <div className="approval-call-main">
        <span className="approval-call-name">{toolNameWithLabel(call.name)}</span>
        {summary !== '' && <span className="approval-call-why">{summary}</span>}
        {call.argsPreview !== '' && (
          <>
            <button
              type="button"
              className="approval-tech-toggle"
              onClick={() => setShowTech(!showTech)}
            >
              {showTech ? '收起技术细节' : '技术细节'}
            </button>
            {showTech && <code className="approval-call-args">{call.argsPreview}</code>}
          </>
        )}
      </div>
      {typeof call.diff === 'string' && call.diff !== '' && (
        <>
          <div className="approval-block-label">文件内容会这样变：</div>
          <pre className="approval-diff">
            {call.diff.split('\n').map((line, i) => (
              <div
                key={i}
                className={
                  line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-del' : 'diff-ctx'
                }
              >
                {line}
              </div>
            ))}
          </pre>
        </>
      )}
      {typeof call.preview === 'string' && call.preview !== '' && (
        <>
          <div className="approval-block-label">要新建的文件长这样：</div>
          <pre className="approval-preview">{call.preview}</pre>
        </>
      )}
    </div>
  )
}

function ApprovalCard({ req }: { req: ToolApprovalRequestData }): React.JSX.Element {
  const respond = useChatStore((s) => s.respondApproval)
  const plan = req.kind === 'plan'
  return (
    <div className="approval-card" role="alertdialog" aria-label="工具执行审批">
      <div className="approval-head">
        <span className="approval-icon">{plan ? '📋' : '🔔'}</span>
        <div className="approval-titles">
          <div className="approval-title">
            {plan ? '她要连着做几步，先跟你确认一下' : '她要动一下你的项目，先问你一声'}
          </div>
          <div className="approval-sub">
            {plan
              ? '下面是她的打算；你点了开始，这一轮里她会连着做完，中间不再问你。'
              : '你同意了她才动手；不同意的话，她会换个办法，或者直接把结果告诉你。'}
          </div>
        </div>
      </div>
      {/* "为什么问你"：让用户看懂该怎么做才不再被打断 */}
      {typeof req.reason === 'string' && req.reason !== '' && (
        <div className="approval-reason">
          <span className="approval-reason-tag">为什么要问你</span>
          {req.reason}
        </div>
      )}
      <div className="approval-calls">
        {req.calls.map((c) => (
          <ApprovalCall key={c.toolCallId} call={c} />
        ))}
      </div>
      <div className="approval-actions">
        {plan ? (
          <>
            <button
              type="button"
              className="approval-btn primary"
              onClick={() => void respond(req.approvalId, 'allow')}
            >
              好的，开始吧
            </button>
            <button
              type="button"
              className="approval-btn danger"
              onClick={() => void respond(req.approvalId, 'deny')}
            >
              这次先不用工具
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="approval-btn primary"
              onClick={() => void respond(req.approvalId, 'allow')}
            >
              允许这次
            </button>
            <button
              type="button"
              className="approval-btn"
              onClick={() => void respond(req.approvalId, 'allow-always')}
            >
              这个会话里都允许
            </button>
            <button
              type="button"
              className="approval-btn danger"
              onClick={() => void respond(req.approvalId, 'deny')}
            >
              不允许
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** 会话有未决审批时渲染审批卡；否则不渲染任何内容 */
function ApprovalPanel(): React.JSX.Element | null {
  const req = useChatStore((s) =>
    s.activeId === null ? undefined : s.approvalBySession[s.activeId]
  )
  if (req === undefined) return null
  return <ApprovalCard req={req} />
}

export default ApprovalPanel
