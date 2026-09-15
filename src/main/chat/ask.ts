// ask_user 参数解析与答案格式化——纯逻辑，无 electron 依赖，可单测。
// run.ts 的 executeTool 拦截 ask_user 时调本模块：解析模型给的 questions → 规范化 →
// 交给 requestAsk 挂起等作答 → 把答案格式化成文本回灌给模型。

import type { AskAnswer, AskQuestion } from '@shared/protocol'

/** ask_user 参数上限（防御：模型可能一次塞太多题/选项） */
export const ASK_MAX_QUESTIONS = 4
export const ASK_MAX_OPTIONS = 6

/** 解析结果：非法 → error 文本（不挂起）；合法 → questions + title */
export type AskParse =
  { ok: false; error: string } | { ok: true; title: string | null; questions: AskQuestion[] }

/**
 * 解析并校验 ask_user 的 argsJson → 规范化题目。
 * 选择类缺选项退化成 text（比弹个没选项的空框好）；全部非法则报错不挂起。
 */
export function parseAskArgs(argsJson: string): AskParse {
  let parsed: { title?: unknown; questions?: unknown }
  try {
    parsed = JSON.parse(argsJson) as typeof parsed
  } catch {
    return { ok: false, error: 'ask_user 参数不是合法 JSON，请重发。' }
  }
  const rawQs = Array.isArray(parsed.questions) ? parsed.questions : []
  if (rawQs.length === 0) {
    return { ok: false, error: 'ask_user 缺少 questions（至少一个问题）。' }
  }
  const title = typeof parsed.title === 'string' ? parsed.title : null
  const questions: AskQuestion[] = []
  for (const raw of rawQs.slice(0, ASK_MAX_QUESTIONS)) {
    if (typeof raw !== 'object' || raw === null) continue
    const q = raw as Record<string, unknown>
    const id = typeof q.id === 'string' && q.id.trim() !== '' ? q.id.trim() : null
    const prompt = typeof q.prompt === 'string' && q.prompt.trim() !== '' ? q.prompt.trim() : null
    const type =
      q.type === 'multi' || q.type === 'text' ? q.type : q.type === 'single' ? 'single' : null
    if (id === null || prompt === null || type === null) continue
    const question: AskQuestion = { id, prompt, type }
    if (type !== 'text') {
      const opts = (Array.isArray(q.options) ? q.options : [])
        .filter((o): o is string => typeof o === 'string' && o.trim() !== '')
        .map((o) => o.trim())
        .slice(0, ASK_MAX_OPTIONS)
      if (opts.length >= 1) question.options = opts
      else question.type = 'text'
    }
    if (typeof q.placeholder === 'string' && q.placeholder.trim() !== '') {
      question.placeholder = q.placeholder.trim()
    }
    if (q.required === false) question.required = false
    questions.push(question)
  }
  if (questions.length === 0) {
    return { ok: false, error: 'ask_user 的 questions 全部非法（缺 id/prompt/type），请重发。' }
  }
  return { ok: true, title, questions }
}

/**
 * 答案 → 回灌给模型的文本。空答案（被停止掐断）→ 明确告知"提问被中断，未获回答"，
 * 模型据此决定下一步（能自己定的继续，确实要问的改用一句话问）。
 */
export function formatAskResult(questions: AskQuestion[], answers: AskAnswer[]): string {
  if (answers.length === 0) {
    return '（提问已显示给用户，但任务在对方作答前被中断，未获得回答。请据此调整：能自己合理决定的就继续，确实需要用户输入的在回复里用一句话问。）'
  }
  const byId = new Map(answers.map((a) => [a.questionId, a.value]))
  const lines = questions.map((q) => {
    const v = byId.get(q.id)
    const ans =
      v === undefined || (Array.isArray(v) && v.length === 0) || v === ''
        ? '（跳过）'
        : Array.isArray(v)
          ? v.join('、')
          : v
    return `· ${q.prompt} → ${ans}`
  })
  return `用户回答：\n${lines.join('\n')}`
}

/**
 * 完整流程：解析 → （合法则）挂起等作答 → 格式化。requestAsk 由 run.ts 注入
 * （它持有 controller/sender 等运行时依赖），本函数保持纯净可测。
 */
export async function handleAskTool(
  argsJson: string,
  requestAsk: (title: string | null, questions: AskQuestion[]) => Promise<AskAnswer[]>
): Promise<{ ok: boolean; result: string }> {
  const parsed = parseAskArgs(argsJson)
  if (!parsed.ok) return { ok: false, result: parsed.error }
  const answers = await requestAsk(parsed.title, parsed.questions)
  return { ok: true, result: formatAskResult(parsed.questions, answers) }
}
