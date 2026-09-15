// 提问卡：主进程挂起等待用户作答时，在消息区与输入框之间显示。
// 与审批卡同款挂起-唤醒机制（复用 approval-card 样式），区别只在回传的是结构化答案。
// 三种题：single 单选（点一下即选）、multi 多选（勾选）、text 填空。必答校验：
// 全部必答项作答后「发送回答」才可点；可跳过题（required:false）留空即视为跳过。

import { useState } from 'react'
import type { AskQuestion, ToolAskRequestData, AskAnswer } from '@shared/protocol'
import { useChatStore } from './store'

/** 选项组末尾的「其他」自定义输入：没有想要的选项时直接打字。
 * 单选：自定义文本即答案（替换选项）；多选：自定义文本作为一个额外答案并入数组。 */
function QuestionField({
  q,
  value,
  onChange
}: {
  q: AskQuestion
  value: string | string[] | undefined
  onChange: (v: string | string[]) => void
}): React.JSX.Element {
  const isMulti = q.type === 'multi'
  const options = q.options ?? []
  const selected = isMulti ? ((value as string[]) ?? []) : []
  const single = isMulti ? '' : ((value as string) ?? '')
  // 自定义态判定：值里有不属于 options 的内容 → 输入框保持展开并回填
  const customFromValue = isMulti
    ? (selected.find((s) => !options.includes(s)) ?? '')
    : single !== '' && !options.includes(single)
      ? single
      : ''
  const [customOpen, setCustomOpen] = useState(customFromValue !== '')
  const [customText, setCustomText] = useState(customFromValue)
  const shownCustom = customOpen || customText.trim() !== ''

  const applyCustom = (text: string): void => {
    setCustomText(text)
    const t = text.trim()
    if (isMulti) {
      // 多选取选项里「非自定义」的部分 + 当前自定义文本（空则不加）
      const kept = selected.filter((s) => options.includes(s))
      onChange(t === '' ? kept : [...kept, t])
    } else {
      onChange(t)
    }
  }

  return (
    <div className="ask-q">
      <div className="ask-q-prompt">
        {q.prompt}
        {q.required === false && <span className="ask-q-optional">可跳过</span>}
      </div>
      {q.type === 'text' ? (
        <textarea
          className="ask-textarea"
          rows={2}
          placeholder={q.placeholder ?? '请输入…'}
          value={single}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <div className="ask-options">
          {options.map((opt) => {
            const on = isMulti ? selected.includes(opt) : single === opt
            return (
              <button
                key={opt}
                type="button"
                className={on ? 'ask-option is-on' : 'ask-option'}
                aria-pressed={on}
                onClick={() => {
                  if (isMulti) {
                    onChange(
                      selected.includes(opt)
                        ? selected.filter((x) => x !== opt)
                        : [...selected, opt]
                    )
                  } else {
                    // 单选再点一次可取消（改主意）；选回预设就收起并清掉自定义输入
                    setCustomOpen(false)
                    setCustomText('')
                    onChange(single === opt ? '' : opt)
                  }
                }}
              >
                {opt}
              </button>
            )
          })}
          <button
            type="button"
            className={shownCustom ? 'ask-option is-on' : 'ask-option ask-option-custom'}
            aria-pressed={shownCustom}
            onClick={() => {
              if (shownCustom && customText.trim() === '') {
                setCustomOpen(false)
                applyCustom('') // 收起并清掉空自定义
              } else {
                setCustomOpen(true)
              }
            }}
          >
            其他（自己说）
          </button>
          {shownCustom && (
            <input
              className="ask-custom-input"
              autoFocus
              placeholder="输入你的想法…"
              value={customText}
              onChange={(e) => applyCustom(e.target.value)}
            />
          )}
        </div>
      )}
    </div>
  )
}

function AskCard({ req }: { req: ToolAskRequestData }): React.JSX.Element {
  const respond = useChatStore((s) => s.respondAsk)
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({})
  const [sent, setSent] = useState(false)

  // 必答校验：每个 required（缺省即必答）的题都要有非空答案
  const allAnswered = req.questions.every((q) => {
    if (q.required === false) return true
    const v = answers[q.id]
    if (v === undefined || v === '') return false
    if (Array.isArray(v) && v.length === 0) return false
    return true
  })

  const submit = (): void => {
    if (!allAnswered || sent) return
    const payload: AskAnswer[] = req.questions
      .map((q) => ({ questionId: q.id, value: answers[q.id] ?? (q.type === 'multi' ? [] : '') }))
      .filter((a) => a.value !== '' && (!Array.isArray(a.value) || a.value.length > 0))
    setSent(true)
    void respond(req.askId, payload)
  }

  return (
    <div className="approval-card ask-card" role="dialog" aria-label="提问">
      <div className="approval-head">
        <span className="approval-icon">❓</span>
        <div className="approval-titles">
          <div className="approval-title">{req.title ?? '她想问你几个问题'}</div>
          <div className="approval-sub">选好或填好后点「发送回答」，她会按你的意思继续。</div>
        </div>
      </div>
      <div className="ask-questions">
        {req.questions.map((q) => (
          <QuestionField
            key={q.id}
            q={q}
            value={answers[q.id]}
            onChange={(v) => setAnswers((prev) => ({ ...prev, [q.id]: v }))}
          />
        ))}
      </div>
      <div className="approval-actions">
        <button
          type="button"
          className="approval-btn primary"
          disabled={!allAnswered || sent}
          onClick={submit}
        >
          {sent ? '已发送' : '发送回答'}
        </button>
        {!allAnswered && <span className="ask-hint">还有必答项没填完</span>}
      </div>
    </div>
  )
}

/** 会话有未决提问时渲染提问卡；否则不渲染任何内容 */
function AskPanel(): React.JSX.Element | null {
  const req = useChatStore((s) => (s.activeId === null ? undefined : s.askBySession[s.activeId]))
  if (req === undefined) return null
  return <AskCard req={req} />
}

export default AskPanel
