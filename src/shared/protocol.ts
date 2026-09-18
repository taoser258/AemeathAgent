// 流式协议与消息契约。
// 基础事件 token | done | error；后续在同一协议上扩展
// tool_call_start / tool_call_result 等，所以事件结构保持开放，别写死成"只有文本"。

/** 一次对话执行的唯一标识：chat:send 时生成，流式事件与 chat:cancel 都靠它关联 */
export type RunId = string

/** 流式事件类型。含工具调用与审批事件；stats 承载实时遥测快照 */
export type StreamEventType =
  | 'token'
  | 'done'
  | 'error'
  | 'stats'
  | 'thinking'
  | 'tool_call_start'
  | 'tool_call_result'
  | 'tool_approval_request'
  // 结构化提问：模型 ask_user → 主进程暂停，渲染层出提问卡，答案经 chat:answer 回灌
  | 'tool_ask_request'
  | 'todo_updated'
  // 子任务分身：分身内部工具调用不透传（防噪声瀑布），折叠为这三种事件
  | 'agent_started'
  | 'agent_progress'
  | 'agent_finished'
  // 运行期状态提示：自动续跑 / 连接重试这类「引擎自己在做事」的说明。
  // 渲染层在流式气泡下显示一行淡色文字——：不要光闪图标，说清在干嘛。
  | 'run_notice'
  // 每轮真实 usage（prompt+completion）：用量环随轮次实时走，
  // 否则多轮任务执行中环一直停在上轮的值、答完才跳变（owner 实测："答完突然暴涨"）。
  | 'usage'

/** thinking 事件载荷：模型思考的增量文本；供应商没给就没有此事件 */
export interface ThinkingEventData {
  text: string
}

/** todo_updated 事件载荷：本会话任务清单整表快照（进度卡渲染用） */
export interface TodoUpdatedData {
  sessionId: string
  items: Array<{ id: string; text: string; status: 'pending' | 'done' }>
}

/** run_notice 事件载荷：引擎侧「正在做什么」的状态说明。
 * auto-continue = 段预算用尽自动接着做 / 截断续写；retry = 瞬时错误自动重试；
 * cleanup = 任务结束后自动清理了临时文件；
 * verify = 收尾核对：她声称写好的文件在工作区里找不到（可能没真写）；
 * compact = 上下文压缩（P8-T1：更早的对话已摘要成一段转述，原始记录仍在会话档案里）。 */
export interface RunNoticeData {
  kind: 'auto-continue' | 'retry' | 'cleanup' | 'verify' | 'compact'
  text: string
  /** 第几次（重试次数 / 第几段续跑）；cleanup 固定 0 */
  attempt: number
  /**
   * cleanup / verify 专用：这条通知同时已作为 notice 消息落盘，这里是它的消息 id。
   * 渲染层据此把"本次会话内的即时显示"与"重启后从盘上恢复的那条"认成同一条，
   * 不会出现两条一样的通报。
   */
  messageId?: string
}

/** agent_started 事件载荷：子任务分身开始运行。
 * toolCallId：派生本次分身的 spawn_agent 调用 id——渲染层靠它把
 * 分身进度挂到消息流里的那张工具卡上。 */
export interface AgentStartedData {
  agentId: string
  objective: string
  toolCallId?: string
}

/** agent_progress 事件载荷：分身运行进度（步数 + 最近工具，T3b 渲染子任务卡） */
export interface AgentProgressData {
  agentId: string
  round: number
  step: number
  lastTool?: string
  toolCallId?: string
}

/** agent_finished 事件载荷：分身终态与最终报告 */
export interface AgentFinishedData {
  agentId: string
  status: 'completed' | 'failed' | 'aborted' | 'budget-exhausted'
  report: string
  rounds: number
  steps: number
  ms: number
  toolCallId?: string
}

/** tool_call_start 事件载荷：harness 即将执行一次工具调用 */
export interface ToolCallEventData {
  toolCallId: string
  name: string
  /** 参数 JSON 的预览（超长截断，仅展示用） */
  argsPreview: string
  /** 审批增强：write_file 的统一 diff（改前/改后）。仅审批载荷携带，tool_call_start 不带 */
  diff?: string
  /** 审批增强：新建文件的全文预览（≤2000 字符截断）。仅审批载荷携带 */
  preview?: string
  /** 涉及的工作区文件（读写类工具都带）：过程时间线里的文件行，点击 → 右侧栏预览 */
  file?: { rel: string; name: string; action: string }
}

/** 工具执行四态：ok 成功 / timeout 超时 / denied 审批拒绝 / failed 其余失败 */
export type ToolExecStatus = 'ok' | 'failed' | 'timeout' | 'denied'

/** tool_call_result 事件载荷：一次工具执行完毕 */
export interface ToolCallResultEventData {
  toolCallId: string
  ok: boolean
  /** 结果预览（超长截断，仅展示用；失败时为错误摘要） */
  resultPreview: string
  durationMs: number
  /** 四态（缺省按 ok 推导，渐进切换）：ok / failed / timeout / denied */
  status?: ToolExecStatus
  /** 产出文件（仅写文件类工具成功时携带）：聊天里附文件卡片，点击 → 右侧栏预览。
   * rel 是相对工作区的路径（右侧栏 IPC 只认工作区内路径）。 */
  file?: { rel: string; name: string; action: string }
  /** 多产出文件（run_js：一次执行可生成多个文档）：与 file 合并去后进卡片列表 */
  files?: Array<{ rel: string; name: string; action: string }>
  /** 变更行数统计（write_file/edit_file 成功时携带）：文件行显示「+N -M」徽标 */
  diff?: { added: number; removed: number }
}

/** 审批决策（chat:approve 载荷）：允许一次 / 本会话允许此工具 / 拒绝 */
export type ApprovalDecision = 'allow' | 'allow-always' | 'deny'

/** ask_user 单题：type 决定渲染控件 */
export interface AskQuestion {
  /** 题目标识，答案按它回填 */
  id: string
  /** 题干（给用户看的一句话） */
  prompt: string
  type: 'single' | 'multi' | 'text'
  /** single/multi 的选项（text 省略） */
  options?: string[]
  /** text 题的输入占位提示（可选） */
  placeholder?: string
  /** 是否必答（缺省 true）。false 时用户可跳过该题 */
  required?: boolean
}

/** tool_ask_request 事件载荷：主进程暂停等待用户作答（复用审批的挂起-唤醒机制） */
export interface ToolAskRequestData {
  askId: string
  /** 卡片标题（可选，默认「她想问你几个问题」） */
  title?: string
  questions: AskQuestion[]
}

/** chat:answer 回执：askId → 各题答案（single/text 为 string，multi 为 string[]） */
export interface AskAnswer {
  questionId: string
  value: string | string[]
}

/** tool_approval_request 事件载荷：主进程暂停等待用户审批 */
export interface ToolApprovalRequestData {
  /** 审批单号：渲染层决策后经 chat:approve 原样带回 */
  approvalId: string
  /** tool = 单次调用确认；plan = 计划模式首轮（整批调用一次确认） */
  kind: 'tool' | 'plan'
  calls: Array<ToolCallEventData>
  /**
   * "为什么问我"。
   * 例如"目标路径在工作区之外：D:\x（工作区：E:\proj）"，或"尚未绑定工作目录"。
   * 有它用户才知道**怎么做才能不再被打断**；缺省时渲染层不显示该行。
   */
  reason?: string
}

/**
 * 消息角色。
 * notice = 系统通知（任务收尾的自动清理结果这类"事实通报"）：**会落盘进会话档案**，
 * 但**永远不进 LLM 上下文**（projectPersistedHistory 直接跳过）——它是给用户看的，
 * 不是对话的一轮。与 system（只存在于请求侧的系统提示）语义严格区分。
 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'notice'

/**
 * 主进程 → 渲染进程的流式事件（经通道 chat:stream 推送）。
 * data 的含义随 type 变化：token = 增量文本；done = 结束说明；error = 可读错误文案。
 */
export interface StreamEvent {
  sessionId: string
  runId: RunId
  type: StreamEventType
  /** 不同事件携带不同负载；token 为文本增量、error 为错误文案 */
  data: unknown
}

/**
 * 工具调用描述。纯文本回复时为 null，不产生任何调用行为。
 * 保留这个结构是为了让会话存储与渲染管线从第一天就"管道全通"，P1 无需迁移数据。
 */
export interface ToolCallSpec {
  /** 本次调用的唯一 id，assistant 消息与工具结果消息靠它配对 */
  id: string
  /** 工具名，对应工具注册表（main/agent/tools/registry.ts）中的 ToolDef.name */
  name: string
  /** 调用参数（JSON 字符串），解析时机由执行方决定 */
  argsJson: string
}

/** 消息：一行一条持久化到 userData/sessions/<id>/messages.jsonl */
export interface Message {
  id: string
  role: MessageRole
  content: string
  /** 时间戳（毫秒） */
  ts: number
  /** 纯文本回复时为 null；工具调用在同一结构上承载 */
  toolCalls?: ToolCallSpec[] | null
  /** 当本条消息是某次工具调用的"结果"时，记录对应调用的 id */
  toolCallId?: string
  /** 模型思考内容 */
  thinking?: string
}
