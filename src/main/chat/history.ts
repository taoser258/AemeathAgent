// 历史投影：持久化消息 ↔ LLM ChatTurn 的纯函数转换。
// 无 electron 依赖（vitest 直接单测）；run.ts 负责落盘与事件，这里只管形态。

import { newPersistedId } from '../sessions/session-store'
import type { ChatTurn } from '../llm/client'
import type { ChatAttachmentPayload, PersistedMessage } from '@shared/types'

/** 单个附件 → 给 LLM 看的文字说明；图片返回 null（当轮走 parts，历史降级为文字说明）
 * 路径：附件是用户自己机器上的文件，路径一并给出——她才能直接读到正文、
 * 或把产物写回同一目录，而不是去磁盘上漫无目的地找。 */
export function attachmentNote(a: ChatAttachmentPayload): string | null {
  const where = a.path !== undefined && a.path !== '' ? `（本地路径：${a.path}）` : ''
  if (a.kind === 'sticker') return `\n[用户发送了一张爱弥斯表情包：${a.name}]`
  if (a.kind === 'text' && typeof a.text === 'string' && a.text !== '') {
    // ★ 「正文已完整内联、别再核对原文件」要说死：正文给了她
    // 仍不信任，去 read_file 被二进制拒绝后改用 run_js/unzip 硬解、还在工作区落了
    // 临时文件——白白烧六次工具调用。截断时文末有「已截断」标注，没标注就是全文。
    return (
      `\n\n[附件文件：${a.name}${where}——正文已完整内联在下方代码块（未标注截断即全文），` +
      `直接据此回答；不要再用 read_file / 解压等方式"核对"原文件]\n\`\`\`\n${a.text}\n\`\`\``
    )
  }
  if (a.kind === 'image') return null
  return `\n[用户添加了附件：${a.name}${where}${binaryHint(a.name)}]`
}

/** 读不了正文的附件给一句可执行的下一步（否则模型会去 list_dir/search_files 瞎找） */
function binaryHint(name: string): string {
  if (/\.pdf$/i.test(name)) {
    // PDF 已能直读（P8-T2）：走到这里说明这份的正文没抽出来
    // （扫描件/加密/损坏）——注意别再说"PDF 读不了"，那是过时口径。
    return '。这份 PDF 没能读出正文（多为扫描件/加密/损坏）——可以先自己用 read_file 再试一次；仍不行请让用户把关键页截图发来或提供文本版，不要为此搜索磁盘'
  }
  if (/\.(doc|xls|ppt)$/i.test(name)) {
    return '。旧版 Office 二进制格式读不了正文——请让用户另存为 .docx/.xlsx/.pptx 再发一次'
  }
  return '（二进制/未知格式，正文未内联；需要内容请让用户说明或换文本格式）'
}

/**
 * 视觉核对提示（P7-T4）：本轮用户发了图片、且**当前模型自己能直接看到图**（多模态）时注入。
 * 措辞必须与「转述」路径区分开——owner 实测：这里错写"经视觉识别转述给你的"，
 * 多模态模型（qwen3.8-flash）真的以为自己没看到图，转头去磁盘找文件、对粘贴图片调 OCR
 * （ENOENT + 全盘搜索，白烧十几轮）。同时说死：聊天里直接发来的图没有磁盘路径。
 * 纯函数可单测；count 仅用于文案单复数。
 */
export function imageVerificationNote(count: number): string {
  const n = count > 1 ? `这 ${count} 张图片` : '这张图片'
  return (
    `\n\n[系统提示：你已直接看到${n}（不是转述，图片就在本轮消息里）。` +
    '引用图中内容时遵守三条：① 标明"根据图片识别"，不要把识别内容说成已核实事实；' +
    '② 关键信息（金额、日期、账号、条款、长数字）必须提醒用户与原图核对，或请用户复述确认后再据此行动；' +
    '③ 看不清的部分直接说看不清，禁止猜测补全。' +
    '注意：这是用户在聊天里直接发来的图片，**没有磁盘路径**——不要去搜索/猜测它的文件位置，' +
    '也不要对它调用 describe_image / ocr_image（那两个工具只处理工作区里有真实路径的图片文件）；' +
    '需要逐字精确认字时，直接说明并请用户把图片存到工作区或补发更清晰的图。]'
  )
}

/**
 * 视觉旁路转述（P8-T3）：当前模型收不了图时，由视觉档案把图转述成文字注入本轮。
 * 与 imageVerificationNote 同一条链路（P7-T4 的教训）——**转述必须标明来源**，
 * 否则她会把自己的转述当成亲眼所见，错得很自然。
 * 纯函数可单测；profileName 是实际干活的视觉档案名（设置里能对上）。
 */
export function visionTranscriptionNote(
  imageName: string,
  profileName: string,
  text: string
): string {
  return (
    `\n\n[系统提示：当前模型看不到图片，以下是视觉档案「${profileName}」对图片的**转述**` +
    '（据识图转述，图中文字/数字可能识别错）。引用时遵守三条：' +
    '① 标明"根据图片识别"，不要说成已核实事实；' +
    '② 关键信息（金额、日期、账号、条款、长数字）必须提醒用户与原图核对；' +
    '③ 看不清的部分直接说看不清，禁止猜测补全。' +
    '另外：这是用户在聊天里直接发来的图片，**没有磁盘路径**——不要去搜索/猜测文件位置；' +
    'ocr_image 也只能读工作区里有真实路径的图片，对聊天图片调用必然 ENOENT。' +
    '需要逐字精确认字时，请用户把图片存到工作区再给路径，或补发更清晰的图。]' +
    `\n【图片 ${imageName} 的识图转述】\n${text}`
  )
}

/** 识图失败时的占位说明（失败不阻断对话，但也不能假装看过了） */
export function visionFailureNote(imageName: string, reason: string): string {
  return `\n\n[系统提示：图片 ${imageName} 的识图转述失败（${reason}）——请如实告诉用户你看不到这张图，不要凭空描述它。]`
}

/** 持久化历史 → LLM ChatTurn 序列：
 * - assistant 带工具调用 → tool_calls 形态；role=tool 结果 → tool_call_id 形态
 * - user 附件降级为文字说明
 * 悬空修补：步数上限/中断可能留下"有调用无结果"的 assistant——补占位结果保证历史合法。
 */
export function projectPersistedHistory(messages: PersistedMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = []
  for (const msg of messages) {
    if (msg.role === 'tool') {
      if (msg.toolCallId) {
        turns.push({ role: 'tool', tool_call_id: msg.toolCallId, content: msg.text })
      }
      continue
    }
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      turns.push({
        role: 'assistant',
        content: msg.text === '' ? null : msg.text,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.argsJson }
        }))
      })
      continue
    }
    if (msg.role === 'assistant') {
      turns.push({ role: 'assistant', content: msg.text })
      continue
    }
    let content = msg.text
    const images: string[] = []
    for (const a of msg.attachments ?? []) {
      const note = attachmentNote(a)
      if (note !== null) content += note
      else images.push(a.name)
    }
    if (images.length > 0) content += `\n[用户发送了图片：${images.join('、')}]`
    turns.push({ role: 'user', content })
  }
  // 悬空修补：占位结果排在块尾（真实结果之后），保持与实际执行一致的时序
  //
  const fixed: ChatTurn[] = []
  let pending: string[] = [] // 当前 assistant 块中悬空调用的 id（按声明顺序）
  const flush = (): void => {
    for (const id of pending) {
      fixed.push({
        role: 'tool',
        tool_call_id: id,
        content: '（达到步数上限，此调用未执行）'
      })
    }
    pending = []
  }
  for (const t of turns) {
    if (t.role !== 'tool' && pending.length > 0) flush() // 进入下一个块前收尾上一块
    fixed.push(t)
    if (t.role === 'assistant' && t.tool_calls) {
      pending = t.tool_calls.filter((c) => c.id !== '').map((c) => c.id)
    } else if (t.role === 'tool' && t.tool_call_id) {
      pending = pending.filter((id) => id !== t.tool_call_id)
    }
  }
  flush() // 序列结尾的悬空调用
  return fixed
}

/** 历史按条数截断（发给模型前的最后一道整理）。
 * **修 bug**：直接 slice(-N) 会把切点落在 assistant(tool_calls) 与它的
 * tool 结果之间，导致序列以孤立 tool 消息开头——服务端直接 400：
 * 「Messages with role 'tool' must be a response to a preceding message with 'tool_calls'」。
 * 长会话（工具调用多）必现。这里截断后丢弃所有前导 tool 消息，保证序列合法。
 * 只丢前导（尾部保留的就是最近的完整上下文），不影响正常历史。 */
export function trimHistoryForRequest(turns: ChatTurn[], limit: number): ChatTurn[] {
  if (limit <= 0) return []
  const kept = turns.slice(-limit)
  let start = 0
  while (start < kept.length && kept[start].role === 'tool') start += 1
  return kept.slice(start)
}

// ── 工具结果裁剪（result-pruner 同款）────────────
// 长会话里旧工具输出（build 日志/搜索结果/大文件读取）一直占上下文，此前只有消息
// 条数截断、单条不裁。落盘保留全文（回放/时间线完整），只裁**发给模型**的请求侧。
const TOOL_RESULT_PRUNE_LIMIT = 8_192
const TOOL_RESULT_KEEP_HEAD = 4_096
const TOOL_RESULT_KEEP_TAIL = 1_024

/** 裁剪请求侧的工具结果：单条超 8192 字符 → 保头 4096 + 尾 1024 + 中间省略标注。
 * 返回新数组（未超限的条目保持原引用），**不修改入参**——loop 的 messages 仍要
 * 原位累积供落盘，这里只投影出喂给 LLM 的视图。 */
export function pruneToolResults(turns: ChatTurn[]): ChatTurn[] {
  return turns.map((t) => {
    if (t.role !== 'tool') return t
    const text = typeof t.content === 'string' ? t.content : ''
    if (text.length <= TOOL_RESULT_PRUNE_LIMIT) return t
    const omitted = text.length - TOOL_RESULT_KEEP_HEAD - TOOL_RESULT_KEEP_TAIL
    return {
      ...t,
      content:
        text.slice(0, TOOL_RESULT_KEEP_HEAD) +
        `\n\n[……中间省略 ${omitted} 字符（原文已存会话记录，可用工具按需重读）……]\n\n` +
        text.slice(-TOOL_RESULT_KEEP_TAIL)
    }
  })
}

/** 循环步边界的 LLM turns → 持久化消息（assistant 带调用清单、tool 带配对 id）。
 * thinking：本步模型的思考，附到本步的 assistant 消息上——历史恢复时
 * 按「思考 → 工具 → 思考 → … → 正文」重建顺序（此前中间步思考不落盘，回看只剩堆叠工具卡）。 */
export function llmTurnsToPersisted(turns: ChatTurn[], thinking = ''): PersistedMessage[] {
  const out: PersistedMessage[] = []
  const stepThinking = thinking.slice(0, 8000)
  let thinkingUsed = false
  for (const t of turns) {
    const ts = Date.now()
    if (t.role === 'assistant') {
      out.push({
        id: newPersistedId(),
        role: 'assistant',
        ts,
        text: typeof t.content === 'string' ? t.content : '',
        // 只挂到本批第一条 assistant（= 本步的 assistant turn），tool 消息不带
        ...(stepThinking !== '' && !thinkingUsed ? { thinking: stepThinking } : {}),
        toolCalls:
          t.tool_calls?.map((c) => ({
            id: c.id,
            name: c.function.name,
            argsJson: c.function.arguments
          })) ?? null
      })
      thinkingUsed = true
    } else if (t.role === 'tool') {
      out.push({
        id: newPersistedId(),
        role: 'tool',
        ts,
        text: typeof t.content === 'string' ? t.content : '',
        toolCallId: t.tool_call_id ?? ''
      })
    }
  }
  return out
}
