import type {
  AppConfig,
  ChatAttachmentPayload,
  ChatSendResult,
  McpServerConfig,
  McpTestResult,
  SessionMeta,
  SessionMessagesResult,
  SettingsPatch,
  SettingsReadModel,
  SkillMeta,
  UpdateStatus
} from '../shared/types'
import type { StreamEvent } from '../shared/protocol'

/** 渲染进程唯一可用的 API 白名单（window.petAPI），与 preload/index.ts 保持同步 */
export interface PetApi {
  /** 读取应用配置（不含任何密钥字段）。等价于 settingsGet().config */
  getConfig(): Promise<AppConfig>
  /** 设置读模型：配置 + 可用人设列表 + 密钥状态（绝不含密钥明文） */
  settingsGet(): Promise<SettingsReadModel>
  /** 局部写回配置（model / persona / tools / mcp / skills / privacy 字段）；返回写回后的完整配置 */
  settingsSet(patch: SettingsPatch): Promise<AppConfig>
  /** 技能清单：双来源合并 + enabled 已按 config 反演（主窗技能面板） */
  skillsList(): Promise<SkillMeta[]>
  skillsOpenDir(): Promise<{ ok: boolean; error?: string }>
  /** 保存指定档案的 API Key（safeStorage 加密落盘）；密钥永远无法被渲染层读回 */
  setApiKey(profileId: string, key: string): Promise<{ ok: boolean; error?: string }>
  /** 密钥是否已配置 */
  hasApiKey(): Promise<boolean>
  /** 测试连接：apiKey 留空时使用指定档案已保存的密钥（支持"先测后存"） */
  testConnection(options: {
    baseUrl: string
    model: string
    apiKey?: string
    profileId?: string
  }): Promise<{
    ok: boolean
    error?: string
  }>
  /** 自动更新：检查 / 下载 / 重启安装 / 打开 Releases + 状态订阅 */
  updateCheck(): Promise<UpdateStatus>
  updateDownload(): Promise<UpdateStatus>
  updateQuitInstall(): Promise<{ ok: boolean }>
  updateOpenReleases(): Promise<{ ok: boolean }>
  onUpdateStatus(cb: (s: UpdateStatus) => void): () => void
  /** 发送一条聊天消息（可带附件）；runId 随后经 onChatStream 关联流式事件 */
  chatSend(
    sessionId: string,
    text: string,
    attachments: ChatAttachmentPayload[] | undefined,
    mode?: 'chat' | 'work' | 'learn'
  ): Promise<ChatSendResult>

  /** 工作中插话：任务运行中把消息注入下一轮上下文；false = 没有活跃任务（回退普通发送） */
  chatNudge(sessionId: string, text: string): Promise<boolean>

  /** 表情包文件名列表（内容经 sticker:// 协议按需加载） */
  stickersList(): Promise<string[]>
  /** 任务清单：按会话读 todo（进度卡恢复）；无清单返回 null */
  todoGet(sessionId: string): Promise<{
    items: Array<{ id: string; text: string; status: 'pending' | 'done' }>
    updatedAt: number
  } | null>
  /** 学习笔记：按会话读笔记（笔记卡）；无档返回 null */
  notesGet(sessionId: string): Promise<{
    items: Array<{ ts: number; kind: 'note' | 'card'; title: string; content: string }>
    updatedAt: number
  } | null>
  /** 学习笔记导出：另存对话框写 Markdown；返回保存路径 */
  notesExport(
    sessionId: string
  ): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
  /** 复习队列：取今日到期的闪卡（含新卡）与汇总 */
  reviewDue(sessionId: string): Promise<{
    cards: Array<{
      id: string
      title: string
      content: string
      topic: string | null
      isNew: boolean
      level: number
      lapses: number
    }>
    summary: { due: number; total: number; started: number; mature: number; mastery: number }
  } | null>
  /** 复习评分：给一张卡打分（again/good/easy），返回新汇总 */
  reviewGrade(
    sessionId: string,
    cardId: string,
    grade: 'again' | 'good' | 'easy'
  ): Promise<{
    ok: boolean
    summary?: { due: number; total: number; started: number; mature: number; mastery: number }
    error?: string
  }>
  /** 学习进度：掌握度 + 学习计划（学习模式进度卡） */
  progressGet(sessionId: string): Promise<{
    plan: { goal: string; deadline: number; notes: string }
    daysLeft: number | null
    topics: Array<{
      topic: string
      score: number
      measured: boolean
      cards: number
      updatedAt: number
    }>
    review: { due: number; total: number; started: number; mature: number; mastery: number }
    noteCount: number
  } | null>
  /** 变更账本：全局只读列表（时间倒序，含 undo 标记）——设置页「变更账本」分区 */
  ledgerList(): Promise<
    Array<{
      ts: number
      sessionId: string
      tool: string
      targetPath: string
      targetAbsPath: string
      action: 'create' | 'update'
      kind: 'change' | 'undo'
      undone: boolean
      bytesBefore: number
      snapshotRef: string | null
      undoesFile?: string
    }>
  >
  /** 弹原生文件选择对话框（可多选），主进程读取内容后直接返回附件 */
  pickFiles(): Promise<{ attachments: ChatAttachmentPayload[]; warnings: string[] }>
  /** 弹原生目录选择对话框；取消返回 null */
  pickDirectory(): Promise<string | null>
  /** 中断一次进行中的流式回复 */
  chatCancel(runId: string): void
  /** 审批决策回执：decision = allow / allow-always / deny */
  approve(approvalId: string, decision: 'allow' | 'allow-always' | 'deny'): Promise<{ ok: boolean }>
  /** 提问答案回执 */
  answer(
    askId: string,
    answers: Array<{ questionId: string; value: string | string[] }>
  ): Promise<{ ok: boolean }>
  /** 任务存档：读取未完成标记 / 续跑 / 放弃 */
  checkpointGet(sessionId: string): Promise<{ steps: number; updatedAt: number } | null>
  checkpointResume(sessionId: string, mode?: 'chat' | 'work' | 'learn'): Promise<ChatSendResult>
  checkpointDiscard(sessionId: string): Promise<{ ok: boolean }>
  /** 订阅流式事件（token/done/error）；返回解绑函数 */
  onChatStream(callback: (event: StreamEvent) => void): () => void
  /** 会话注册表：全量同步元信息（主窗 store 每次变更后调用；主进程落盘并广播） */
  sessionsSync(list: SessionMeta[]): void
  /** 会话注册表：读取全量（含已隐藏） */
  sessionsList(): Promise<SessionMeta[]>

  /** Token 用量汇总（「用量」分区）：全量聚合 + 最近会话明细 */
  tokenUsage(): Promise<{
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
    points: Array<{
      t: number
      model: string
      inputTok: number
      outputTok: number
      cachedTok: number
      llmMs: number
      rounds: number
    }>
  }>

  /** 右侧边栏：列工作区目录（rel='' = 根，逐层懒加载） */
  workspaceTree(rel: string): Promise<
    | {
        ok: true
        root: string
        entries: Array<{ name: string; rel: string; kind: 'file' | 'dir'; size: number }>
        truncated: boolean
      }
    | { ok: false; error: string }
  >

  /** 右侧边栏：读工作区内文件预览（文本/图片/媒体/PDF/Office/二进制按 kind 分发） */
  workspaceRead(rel: string): Promise<WorkspaceReadResult>
  /** 读取指定会话的持久化消息 */
  sessionMessages(id: string): Promise<SessionMessagesResult>
  /** 设置页：恢复/隐藏会话 */
  sessionSetHidden(id: string, hidden: boolean): void
  /** 设置页：永久删除会话 */
  sessionDeleteHard(id: string): void
  /** 订阅会话注册表变更广播；返回解绑函数 */
  onSessionsChanged(callback: () => void): () => void
  /** 订阅配置写回广播（设置页保存后主窗即时刷新）；返回解绑函数 */
  onSettingsChanged(callback: () => void): () => void
  /** 切换桌宠点击穿透，返回切换后的状态 */
  toggleClickThrough(): Promise<boolean>
  /** 请求主进程弹出桌宠右键菜单 */
  showPetMenu(): void
  /** 手动拖拽：按指针位置移动桌宠窗（DIP 屏幕坐标） */
  movePetTo(x: number, y: number): void
  /** 手动拖拽：把"发送方窗口"移动到绝对屏幕位置（DIP）；width/height 为按下时锁定的窗口尺寸 */
  windowMoveTo(x: number, y: number, width: number, height: number): void
  /** 顶条手动拖拽起帧：主进程若处于最大化则先还原，回传还原后的窗口框（DIP）作为拖拽基准 */
  windowDragBegin(): Promise<{ x: number; y: number; width: number; height: number } | null>
  /** 滑动调节桌宠尺寸（0.5–1.5） */
  applyPetScale(scale: number): void
  /** 找回被隐藏的桌宠（右键菜单 → 隐藏桌宠 之后，从这里或二次启动找回） */
  showPet(): void
  /** 自绘标题栏的窗口控制：最小化 / 最大化还原 / 关闭（关闭=隐藏） */
  windowControl(action: 'minimize' | 'maximize' | 'close'): void
  /** 订阅最大化态变化（手动 workArea 最大化；图标/拖拽分支的状态源）；返回解绑函数 */
  onWindowMaximized(callback: (maximized: boolean) => void): () => void
  /** 挂载首帧对账最大化态 */
  getWindowMaximized(): Promise<boolean>
  /** 打开独立设置窗口（已开着则聚焦） */
  openSettings(): void
  /** 自研边缘缩放：提交新窗口 bounds（透明窗不支持系统边缘缩放） */
  windowSetBounds(bounds: { x: number; y: number; width: number; height: number }): void
  /** 订阅头顶气泡文本；返回解绑函数 */
  onPetBubble(callback: (text: string) => void): () => void
  /** 保存某 MCP server 的 env 密钥：加密落盘，读不回明文 */
  mcpSetSecret(payload: { namespace: string; varName: string; value: string })

  /** 右侧栏 Git 面板：仓库概览（只读） */
  workspaceGit(): Promise<{
    isRepo: boolean
    hint?: string
    branch?: string
    changes?: Array<{ code: string; rel: string }>
    log?: Array<{ hash: string; date: string; subject: string }>
    aheadBehind?: string
  }>

  /** 右侧栏：在系统资源管理器中显示工作区文件 */
  workspaceReveal(rel: string): Promise<boolean>

  /** 终端 v2：开 shell（cwd=工作区根）/键入/改尺寸/杀 */
  terminalSpawn(cols: number, rows: number): Promise<{ ok: boolean; error?: string; cwd?: string }>
  terminalWrite(data: string): Promise<{ ok: boolean }>
  terminalResize(cols: number, rows: number): Promise<{ ok: boolean }>
  terminalKill(): Promise<{ ok: boolean }>
  /** 终端 v2 输出流（raw ANSI；渲染层 AnsiScreen 解析）；exit=true = shell 退出 */
  onTerminalStream(cb: (d: { chunk: string; exit?: boolean }) => void): () => void

  /** 右侧栏任务面板：勾选切换清单项状态 */
  workspaceTodoToggle(sessionId: string, todoId: string): Promise<{ ok: boolean; error?: string }>

  /** 用系统默认浏览器打开外链 */
  openExternal(url: string): void

  /** 内嵌浏览器（v17 主进程 WebContentsView）：占位 rect 上报（null = 隐藏/卸载） */
  browserSetBounds(rect: { x: number; y: number; width: number; height: number } | null): void
  /** 导航（无协议按域名补 https / 搜索词走 Bing，主进程同规则兜底） */
  browserNavigate(url: string): void
  browserGoBack(): void
  browserGoForward(): void
  browserReload(): void
  onBrowserState(
    cb: (s: { url: string; loading: boolean; canBack: boolean; canForward: boolean }) => void
  ): () => void

  /** 用系统默认应用打开工作区文件（pptx 等不支持内联预览的格式） */
  workspaceOpenPath(rel: string): Promise<{ ok: boolean; error?: string }>

  /** 记忆管理：列表（按更新时间倒序）/ 删除一条 / 清空全部（自动快照） */
  memoryList(): Promise<
    Array<{
      id: string
      kind: 'preference' | 'fact' | 'commitment'
      content: string
      keywords: string[]
      sourceSessionId: string
      createdAt: number
      updatedAt: number
      hits: number
    }>
  >
  memoryDelete(id: string): Promise<{ ok: boolean; error?: string }>
  memoryClear(): Promise<{ ok: boolean }>

  /** 工作区内容检索（右侧栏搜索面板） */
  searchContent(
    query: string,
    limit?: number
  ): Promise<{
    hits: Array<{ rel: string; name: string; line: number; snippet: string; score: number }>
    scanned: number
    truncated: boolean
    error?: string
  }>

  /** MCP 测试连接：按未保存的配置临时连一次并返回工具清单 */
  mcpTest(config: McpServerConfig): Promise<McpTestResult>
  /** 恢复内置 MCP 服务器：从"已删除"名单移回并立即补齐 */
  mcpRestoreBuiltin(key: string): Promise<{ ok: boolean }>
}

declare global {
  interface Window {
    petAPI: PetApi
  }
}
