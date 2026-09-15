// 共享类型：主进程与渲染进程都会用到的数据契约。
// 这些结构会在 P0 的会话/设置落盘中原样持久化，后续阶段只增不改，避免破坏旧数据。

import type { ToolCallSpec } from './protocol'

/** 会话元信息，对应 userData/sessions/index.json 注册表 */
export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** 已隐藏会话：不出现在侧栏，可在 设置 → 会话 中恢复或永久删除 */
  hidden?: boolean
  /** 用户手动改过名：自动标题派生对此会话永久禁用 */
  titleIsCustom?: boolean
  /** 所属模式：缺省 = 'work'（历史会话） */
  mode?: ChatMode
  /** 置顶：侧栏同模式内置顶分组优先展示（缺省 false）；不影响改名/隐藏/删除 */
  pinned?: boolean
}

/** API 协议。P0 仅实现 openai 兼容；anthropic 等为字段预留（UI 显示暂不支持） */
export type ApiProtocol = 'openai' | 'anthropic' | 'gemini'

/** 思考强度 */
export type ReasoningEffort = 'default' | 'low' | 'medium' | 'high'

/** 一个可切换的模型配置档案 */
export interface ModelProfile {
  /** 稳定 id：密钥按 id 存取（secrets），删除档案即删密钥 */
  id: string
  /** 昵称（列表展示用，如"千问日常"） */
  name: string
  protocol: ApiProtocol
  baseUrl: string
  /** 模型名（OpenAI 兼容语义）；预设档案默认留空，由用户填写后才能发起聊天 */
  model: string
  /** 上下文窗口（token 数）；0 = 未设置（历史裁剪退化为条数上限） */
  context: number
  /** 是否开启多模态 */
  multimodal: boolean
  /** 思考强度：按协议注入（openai=reasoning_effort / anthropic=thinking 预算 / gemini=thinkingBudget）；缺省 = 不注入 */
  reasoningEffort?: ReasoningEffort
}

/** 应用配置，对应 userData/config/app.json */
export interface AppConfig {
  model: {
    /**
     * 镜像字段 = 当前激活档案的 baseUrl / model（兼容 §5.1 原始契约与旧代码路径，
     * 由 mergeAppConfig / applySettingsPatch 保证同步，勿手改）。
     */
    baseUrl: string
    model: string
    temperature: number
    /** 模型档案列表；为空时由镜像字段合成一条兜底档案 */
    profiles: ModelProfile[]
    /** 当前激活档案 id；merge 后保证存在于 profiles 中 */
    activeId: string
  }
  persona: {
    /** 当前激活的人设目录名，对应项目内 personas/<name>/ */
    active: string
  }
  pet: {
    /** 桌宠窗位置；null = 尚未记录，启动时回退到屏幕右下角 */
    x: number | null
    y: number | null
    clickThrough: boolean
    scale: number
  }
  tools: {
    /**
     * 权限模式：
     * 成熟实现的权限 = 沙箱 × 审批两个旋钮，**沙箱是主要防线、审批只是越界时的逃生口**。
     * Aemeath 没有 OS 级沙箱，用「工作区绑定 + 快照账本」做等价物：
     * - 'confirm' 标准：只读直放；**工作区内**的变更直接执行（变更前有快照可撤销）；
     * 越界（工作区外）或未绑定工作区时才请示
     * - 'plan' 计划模式：本轮出现变更类调用时先出计划，确认后本轮放开（比 confirm 更严）
     * - 'full' 完全访问：不询问，全部直接执行（等价 成熟实现的 danger-full-access）
     * MCP 工具完全不进门禁：接入即信任，边界由该 server 负责。
     */
    permissionMode: 'confirm' | 'plan' | 'full'
    /**
     * 按模式工具可见性：'all' = 全部可见（缺省，兼容 P2）；
     * 数组 = 仅列出的内置工具可见。作用域 = **仅内置工具**（active_window 还要与隐私开关取 AND）；
     * MCP 工具不走此门控——它们由 server 自身的 `enabled` 与 `modes` 管理。
     * chat 模式无工具，不设键。
     */
    visibility: {
      work: 'all' | string[]
      learn: 'all' | string[]
    }
    /**
     * run_shell 的用户扩展白名单：前缀表（小写比较），与内置默认合并去重。
     * 空数组 = 只用内置白名单。硬拦截表不受此配置影响（永远不可放行）。
     */
    shell: { allowlist: string[] }
  }
  /** MCP 服务器。工具名 mcp__<命名空间>__<tool>；
   * **MCP 工具不进权限门禁**：接入即信任，边界由该 server 负责 */
  mcp: {
    servers: McpServerConfig[]
    /**
     * 用户主动删除过的内置服务器 key。
     * 内置项会在启动时自动补齐，所以"删掉"必须留下痕迹——否则删了下次启动又回来。
     */
    removedBuiltins?: string[]
  }
  /** 技能：禁用名单（缺省空 = 全启用）；enabled 是名单的反演，面板开关写这里 */
  skills: {
    disabled: string[]
  }
  /**
   * 工作区绑定：按模式绑定一个绝对路径目录，文件工具的相对路径在该目录内解析。
   * **null = 未绑定 → 工作 / 学习模式不能开始会话**（对齐 成熟实现的
   * 「会话必须有 cwd」）：此前 null 会静默回退应用目录基准，而应用目录常在 Program Files
   * 下（可能没有写权限），是个会出事的默认值，故改为硬门槛。chat 模式无工具，不设键。
   * §11.3：改绑定即生效（工具执行按会话模式取当前绑定）。
   */
  workspace: {
    work: string | null
    learn: string | null
  }
  /** 隐私：全部默认关——显式开启才生效，对应工具才会进 LLM 注册表 */
  privacy: {
    /** 屏幕感知：允许 active_window 工具读取前台窗口（应用名 + 窗口标题） */
    activeWindow: boolean
    /** 长期记忆：自动沉淀关于用户的记忆条目并注入 prompt。默认关——设置页
     * 打开才生效；关闭 = 停止沉淀 + prompt 不注入，已有条目保留 */
    memory: boolean
  }
  /** 外观：全局主题，三窗（主窗/设置/桌宠）共用 */
  appearance: {
    /**
     * 'system' = 跟随系统深浅色（实时响应系统切换）；'light' / 'dark' = 强制指定。
     * 渲染层经 <html data-theme> 切换 global.css 的两套 token 组，改设置即生效。
     */
    theme: 'system' | 'light' | 'dark'
  }
  /** 界面偏好：纯展示开关，默认全关 */
  ui: {
    /** 学习模式顶部的「学习笔记」卡（note_write 计数 + 导出入口）。默认关——显式开启才显示 */
    notesCard: boolean
  }
  /**
   * 用户个人信息（反馈批次④，只增不改）：设置页「个人」分区填写。
   * 用途有二：① 侧栏左下角展示"你自己的"头像与称呼（此前写死显示爱弥斯）；
   * ② 经运行时附录注入 system prompt，让爱弥斯直接知道用户是谁、有什么偏好。
   */
  user: {
    /** 用户希望被怎么称呼（空 = 不指定，模型按人设默认口径称呼） */
    nickname: string
    /** 头像：压缩后的小图 dataURL（data:image/*；null = 未设置，侧栏回退首字圆形占位） */
    avatar: string | null
    /** 用户自述：身份 / 专业 / 喜好 / 习惯 / 沟通偏好等 */
    about: string
  }
}

/** 主窗三模式：chat=纯对话无工具 / work=harness 全工具 / learn=全工具+教学守则 */
export type ChatMode = 'chat' | 'work' | 'learn'

/** 技能元信息：skills/<name>/SKILL.md 扫描结果（主进程扫目录，渲染层经 skills:list 展示） */
export interface SkillMeta {
  /** 技能名 = 目录名（canonical，skill_use 的 name 参数用它；只允许字母数字_-） */
  name: string
  /** 一句话用途（SKILL.md frontmatter description；直接影响模型何时调用） */
  description: string
  /** 来源：builtin = 项目内 skills/（随仓库分发）；user = userData/skills/（用户自装；同名覆盖内置） */
  source: 'builtin' | 'user'
  /** 适用模式（frontmatter modes，缺省全模式）；chat 有清单但无工具入口，实际不注入 */
  modes: ChatMode[]
  /** 是否启用（config.skills.disabled 的反演，主进程算好直供面板开关） */
  enabled: boolean
}

/** 单个 MCP stdio server 配置 */
export interface McpServerConfig {
  /** 稳定 id（渲染层生成，如 mcp-xxx）；仅内部标识，不再进入工具名（见 serverName） */
  id: string
  /** 展示名（设置页与审批卡显示） */
  name: string
  /**
   * 工具命名空间：工具注册名为 mcp__<serverName>__<tool>。
   * 缺省从 id 派生（保证旧配置可用）。**改动等于重命名工具**，会让既有会话历史里的
   * 工具调用记录对不上，所以 UI 上要提示"改名后旧记录不再关联"。
   */
  serverName?: string
  /** 可执行命令（如 npx / node） */
  command: string
  /** 命令参数 */
  args: string[]
  /**
   * 环境变量。值有两种形态：
   * - 明文（如 `NODE_ENV=production`）→ 直接进 app.json（不涉密才这么用）
   * - `${secret:名称}` 引用 → app.json 只存引用，真值经 safeStorage 存 secrets.json（红线③）
   */
  env?: Record<string, string>
  /** 子进程工作目录；缺省继承应用目录 */
  cwd?: string
  /** 单次工具调用超时（毫秒）；缺省 60000 */
  toolCallTimeoutMs?: number
  /**
   * 适用模式：缺省 ['work','learn']（= 与现状一致）。
   * 与 SkillMeta.modes 同语义——"这个能力包适用于哪些模式"。
   * chat 模式无工具，天然不注入（无需配置）。
   */
  modes?: ChatMode[]
  /**
   * 掉线自动重连：缺省 true。
   * 只在"曾经连上过又断开"时生效（首次就连不上通常是配置写错，重试无意义）；
   * 退避序列有上限，用尽即停止，不会无限重试。
   */
  reconnect?: boolean
  /**
   * 内置服务器标识：非空表示这条配置由应用维护（如 'playwright'）。
   * 内置项的命令/参数会被应用按当前安装路径自动校正（过期即重建），
   * 用户只需开关 enabled；名称、参数等仍可改，但下次同步会再校正回标准形态。
   */
  builtin?: string
  /** 启停开关：false = 不连接、工具不出现在工具清单 */
  enabled: boolean
}

/** 续跑提示语：CHECKPOINT_RESUME 以此作为新的用户消息；渲染层本地气泡显示同文 */
export const RESUME_NUDGE_TEXT = '继续上面未完成的任务：从中断的地方接着做，完成后简要汇报结果。'

/** SETTINGS_GET 的读模型：配置 + 可用人设列表 + 密钥状态（绝不含密钥明文） */
export interface SettingsReadModel {
  config: AppConfig
  /** 可用人设 = personas/ 下的目录名（字典序） */
  personas: string[]
  /** 已配置密钥的档案 id 列表（不含明文） */
  keyedProfileIds: string[]
  /** 当前人设 system prompt 的字符数（渲染层估算上下文占用用；加载失败时为 0） */
  personaPromptChars: number
  /**
   * 已配置的 MCP env 密钥 id（形如 `mcp:<命名空间>:<变量名>`，不含明文）。
   * 渲染层据此在设置页显示"已保存 / 未配置"，绝不下发密钥本身（红线③）。
   */
  keyedMcpSecretIds: string[]
}

/** MCP 测试连接的返回：连一次 + 列工具，用完即关，不影响已连接的 server */
export interface McpTestResult {
  ok: boolean
  /** 成功时的工具数 */
  toolCount?: number
  /** 成功时的工具名（截断若干条，给用户看"连上了、能看到什么工具"） */
  toolNames?: string[]
  /** 失败时的可读原因（含超时/命令不存在/env 缺失等分类提示） */
  error?: string
  /** 实际生效的命名空间（渲染层展示"工具将以此前缀注册"） */
  namespace?: string
}

/**
 * 聊天附件（渲染 → 主）。四类：
 * - image：本地图片，dataUrl 为 data:image/* base64（仅多模态档案可发给模型）
 * - text：文本文件，text 为已读取内容（主进程拼进消息正文）
 * - sticker：内置表情包，name 为 resources/stickers 下的文件名（模型只收文字说明）
 * - file：其他二进制，仅以名字占位（模型看不到内容）
 */
export interface ChatAttachmentPayload {
  name: string
  kind: 'image' | 'text' | 'sticker' | 'file'
  size?: number
  dataUrl?: string
  text?: string
  /**
   * 本地绝对路径。用户选的文件本来就落在自己机器上——把路径一并交给模型，
   * 她才能"接着处理这个文件"（读同目录、把结果写回旁边、外部命令处理），而不是满磁盘找它。
   * 图片/表情包不走这里（图片走 dataUrl 多模态）。
   */
  path?: string
}

/** SETTINGS_SET 的局部更新载荷：只允许改 model / persona；pet 走 win:* 通道 */
export interface SettingsPatch {
  model?: Partial<AppConfig['model']>
  persona?: Partial<AppConfig['persona']>
  /** 工具白名单：整体替换 allowedRoots */
  tools?: Partial<AppConfig['tools']>
  /** MCP 服务器列表：整表替换 */
  mcp?: Partial<AppConfig['mcp']>
  /** 技能禁用名单：整表替换 */
  skills?: Partial<AppConfig['skills']>
  /** 工作区绑定：按键局部替换（work / learn 各自独立） */
  workspace?: Partial<AppConfig['workspace']>
  /** 隐私开关：显式设置才覆盖 */
  privacy?: Partial<AppConfig['privacy']>
  /** 外观：按键局部替换 */
  appearance?: Partial<AppConfig['appearance']>
  /** 界面偏好：按键局部替换 */
  ui?: Partial<AppConfig['ui']>
  /** 用户个人信息（反馈批次④）：按键局部替换（只传 nickname 就只改昵称） */
  user?: Partial<AppConfig['user']>
}

/** CHAT_SEND 的 invoke 返回：runId 用于后续流式事件关联与取消 */
export interface ChatSendResult {
  ok: boolean
  runId?: string
  /** ok=false 时的可读错误（未配 Key / 人设缺失等） */
  error?: string
  /**
   * ok=false 时的机器可读错误码（只增）：渲染层据此做差异化处理，
   * 'workspace-missing' / 'workspace-invalid' = 工作区门槛未过（应引导去选目录）。
   */
  code?: 'workspace-missing' | 'workspace-invalid'
}

/**
 * 持久化的单条消息。
 * user 消息的 text 是用户原始输入；附件原样保存（图片 dataUrl 用于重启后回显，
 * LLM 侧投影在发送时按规则推导：表情包/文件转文字、图片仅当轮发 parts）。
 */
export interface PersistedMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  ts: number
  text: string
  attachments?: ChatAttachmentPayload[]
  /**
   * 工具调用字段存储层原样读写（早期恒缺省）。
   * sanitize 只做结构校验不改内容——P1 的工具调用消息落盘即存，往返不丢。
   */
  toolCalls?: ToolCallSpec[] | null
  /** 本条消息是某次工具调用的"结果"时，记录对应调用的 id（role='tool' 时必有） */
  toolCallId?: string
  /** 模型思考内容 */
  thinking?: string
}

/**
 * 一次请求的真实 token 用量（来自 API 响应 usage；T6 上下文环真实化）。
 * promptTokens = 该次请求的完整上下文（system+历史+本轮 user）。
 */
export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/**
 * 会话级遥测累计。随会话文件持久化，每次对话后累加。
 * - rounds：LLM 调用次数
 * - steps/toolMs：工具执行次数与累计耗时
 * - inputTok/outputTok：usage.prompt_tokens / completion_tokens 累计
 * - llmMs：LLM 请求总耗时（发出 → 流结束）
 * - cachedTok/cacheKnown：缓存命中 tokens 累计；cacheKnown=false 表示供应商未上报（显示"—"）
 * - ttftMsLast/ttftMsSum：首 token 延迟最近值与总和（均值 = Sum/samples）
 * - tpsLast：最近一次输出速度（completion_tokens ÷ 生成秒数）
 * - samples：完成的请求数
 */
export interface SessionStats {
  rounds: number
  steps: number
  toolMs: number
  inputTok: number
  outputTok: number
  llmMs: number
  cachedTok: number
  cacheKnown: boolean
  ttftMsLast: number
  ttftMsSum: number
  tpsLast: number
  samples: number
}

/** CHAT_STREAM done 事件的扩展载荷（兼容旧纯字符串：渲染层按 typeof 分支） */
export interface DonePayload {
  /** 结束说明：'' = 正常完成；'已中断' = 用户停止 */
  note: string
  /** 本次请求的真实 token 用量（供应商不支持时缺省） */
  usage?: TokenUsage
  /** 累计后的会话遥测（渲染层直接采用，免重算） */
  stats?: SessionStats
  /** 落盘失败时为 false：渲染层在助手消息尾部显示"未保存"警示；正常缺省 */
  persisted?: boolean
}

/** 右侧边栏（学 成熟实现better-sidebar）：目录树条目 */
export interface WorkspaceTreeEntry {
  name: string
  /** 相对工作区根的路径（/ 分隔） */
  rel: string
  kind: 'file' | 'dir'
  size: number
}

export type WorkspaceTreeResult =
  | { ok: true; root: string; entries: WorkspaceTreeEntry[]; truncated: boolean }
  | { ok: false; error: string }

/** 右侧栏 Git 面板：仓库概览（只读） */
export interface WorkspaceGitResult {
  isRepo: boolean
  hint?: string
  branch?: string
  changes?: Array<{ code: string; rel: string }>
  log?: Array<{ hash: string; date: string; subject: string }>
  aheadBehind?: string
}

export type WorkspaceReadResult =
  | { ok: true; kind: 'text'; rel: string; size: number; text: string }
  | { ok: true; kind: 'image'; rel: string; size: number; dataUrl: string }
  | { ok: true; kind: 'media'; rel: string; size: number; mime: string; dataUrl: string }
  | { ok: true; kind: 'pdf'; rel: string; size: number; dataUrl: string }
  | { ok: true; kind: 'office'; rel: string; size: number; preview: OfficePreview }
  | { ok: true; kind: 'binary'; rel: string; size: number }
  | { ok: false; error: string }

/** Office 文本级预览块（docx 段落/标题/表格、xlsx 工作表/行、pptx 幻灯片/文本框） */
export type OfficeBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'para'; text: string }
  | { type: 'table'; rows: string[][] }
  | { type: 'slide'; index: number }
  | { type: 'sheet'; name: string }

/** parseOffice 的产物（主进程解 ZIP+XML 得到；渲染层按块渲染成轻量 DOM） */
export interface OfficePreview {
  format: 'docx' | 'xlsx' | 'pptx'
  blocks: OfficeBlock[]
  /** 内容/规模超限被截断（渲染层如实标注） */
  truncated: boolean
  /** 提取到的字符数（头部信息条） */
  chars: number
}

/** 自动更新状态机 */
export interface UpdateStatus {
  state:
    'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  percent?: number
  error?: string
  /** dev（未打包）= true：关于页据此显示「仅安装版可用」 */
  dev?: boolean
}

/** 一轮对话的用量明细（usage/log.jsonl 流水；时间范围图表与按模型分组用） */
export interface UsagePoint {
  /** 完成时间戳（毫秒） */
  t: number
  model: string
  inputTok: number
  outputTok: number
  cachedTok: number
  llmMs: number
  rounds: number
}

/** TOKEN_USAGE 的返回：全量聚合 + 最近会话明细（「用量」分区） */
export interface TokenUsageResult {
  totals: {
    inputTok: number
    outputTok: number
    cachedTok: number
    rounds: number
    samples: number
    llmMs: number
  }
  rows: Array<{
    sessionId: string
    title: string
    mode: string
    updatedAt: number
    rounds: number
    samples: number
    inputTok: number
    outputTok: number
    cachedTok: number
    cacheKnown: boolean
    llmMs: number
  }>
  /** 每轮明细流水（usage/log.jsonl，时间升序）。自 v7 起记录，此前无历史 */
  points: UsagePoint[]
}

/** SESSION_MESSAGES_GET 的返回：messages 为该会话全量（最多 200 条，超出 truncated=true） */
export interface SessionMessagesResult {
  messages: PersistedMessage[]
  truncated: boolean
  /** 会话文件损坏（已自动备份 .corrupt-*，内容视为空） */
  corrupted: boolean
  /** 该会话最近一次请求的真实 token 用量（从未发过消息时缺省） */
  usage?: TokenUsage
  /** 该会话的遥测累计（从未发过消息时缺省） */
  stats?: SessionStats
}
