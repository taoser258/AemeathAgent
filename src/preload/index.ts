import { contextBridge, ipcRenderer } from 'electron'
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
  TokenUsageResult,
  UpdateStatus,
  WorkspaceGitResult,
  WorkspaceReadResult,
  WorkspaceTreeResult
} from '../shared/types'
import type { MemoryEntry } from '../shared/memory'
import type { StreamEvent } from '../shared/protocol'
import {
  CHAT_ANSWER,
  CHAT_APPROVE,
  CHAT_CANCEL,
  CHAT_COMPACT,
  CHAT_NUDGE,
  CHAT_SEND,
  CHAT_STREAM,
  CHECKPOINT_DISCARD,
  CHECKPOINT_GET,
  CHECKPOINT_RESUME,
  DIALOG_PICK_FILES,
  DIALOG_PICK_DIRECTORY,
  PET_BUBBLE,
  SESSION_DELETE,
  SESSION_LIST,
  SESSION_TOKEN_USAGE,
  WORKSPACE_TREE,
  WORKSPACE_READ,
  WORKSPACE_GIT,
  WORKSPACE_REVEAL,
  WORKSPACE_OPEN_EXTERNAL,
  BROWSER_SET_BOUNDS,
  BROWSER_OPEN_LINK,
  BROWSER_NAVIGATE,
  BROWSER_GO_BACK,
  BROWSER_GO_FORWARD,
  BROWSER_RELOAD,
  BROWSER_STATE,
  MEMORY_LIST,
  MEMORY_UPDATE,
  MEMORY_DELETE,
  MEMORY_CLEAR,
  SEARCH_CONTENT,
  WORKSPACE_OPEN_PATH,
  TERMINAL_SPAWN,
  TERMINAL_WRITE,
  TERMINAL_RESIZE,
  TERMINAL_KILL,
  TERMINAL_DATA,
  WORKSPACE_TODO_TOGGLE,
  SESSION_MESSAGES_GET,
  SESSION_SET_HIDDEN,
  SESSION_SYNC,
  SESSIONS_CHANGED,
  SETTINGS_CHANGED,
  SETTINGS_GET,
  SETTINGS_HAS_API_KEY,
  SETTINGS_SET,
  SETTINGS_SET_API_KEY,
  SETTINGS_TEST_CONNECTION,
  UPDATE_CHECK,
  UPDATE_DOWNLOAD,
  UPDATE_QUIT_INSTALL,
  UPDATE_OPEN_RELEASES,
  UPDATE_STATUS,
  STICKER_LIST,
  WIN_WINDOW_SET_BOUNDS,
  WIN_WINDOW_MOVE_TO,
  WIN_WINDOW_DRAG_BEGIN,
  WIN_WINDOW_MAXIMIZED,
  WIN_WINDOW_MAXIMIZED_GET,
  WIN_OPEN_SETTINGS,
  WIN_PET_MOVE,
  WIN_PET_SCALE,
  WIN_SHOW_PET,
  WIN_SHOW_PET_MENU,
  WIN_TOGGLE_CLICK_THROUGH,
  WIN_WINDOW_CONTROL,
  LEDGER_LIST,
  TODO_GET,
  NOTES_GET,
  PROGRESS_GET,
  REVIEW_DUE,
  REVIEW_GRADE,
  SKILLS_LIST,
  SKILLS_OPEN_DIR,
  NOTES_EXPORT,
  MCP_SET_SECRET,
  MCP_TEST,
  MCP_BUILTIN_RESTORE
} from '../shared/ipc-channels'

// 预加载脚本：向渲染进程暴露受控 API。
// T2 起：模板遗留的 window.electron（含裸 ipcRenderer）已整体移除，
// 渲染进程唯一入口是 window.petAPI —— 新增能力必须在此白名单登记并同步 index.d.ts。

const petAPI = {
  /** 读取应用配置（不含任何密钥字段）。等价于 settingsGet().config，保留给桌宠区使用 */
  getConfig: async (): Promise<AppConfig> => {
    const res = (await ipcRenderer.invoke(SETTINGS_GET)) as SettingsReadModel
    return res.config
  },

  /** 设置读模型：配置 + 可用人设列表 + 密钥状态（绝不含密钥明文） */
  settingsGet: (): Promise<SettingsReadModel> => ipcRenderer.invoke(SETTINGS_GET),

  /** 局部写回配置（model / persona 字段）；返回写回后的完整配置 */
  settingsSet: (patch: SettingsPatch): Promise<AppConfig> =>
    ipcRenderer.invoke(SETTINGS_SET, patch),

  /** 保存指定档案的 API Key（safeStorage 加密落盘）；密钥永远无法被渲染层读回 */
  setApiKey: (profileId: string, key: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(SETTINGS_SET_API_KEY, { id: profileId, key }),

  /** 密钥是否已配置 */
  hasApiKey: (): Promise<boolean> => ipcRenderer.invoke(SETTINGS_HAS_API_KEY),

  /** 测试连接：apiKey 留空时使用指定档案已保存的密钥（支持"先测后存"） */
  testConnection: (options: {
    baseUrl: string
    model: string
    apiKey?: string
    profileId?: string
  }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(SETTINGS_TEST_CONNECTION, options),

  /** 自动更新：检查 / 下载 / 重启安装 / 打开 Releases + 状态订阅 */
  updateCheck: (): Promise<UpdateStatus> => ipcRenderer.invoke(UPDATE_CHECK),
  updateDownload: (): Promise<UpdateStatus> => ipcRenderer.invoke(UPDATE_DOWNLOAD),
  updateQuitInstall: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(UPDATE_QUIT_INSTALL),
  updateOpenReleases: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(UPDATE_OPEN_RELEASES),
  onUpdateStatus: (cb: (s: UpdateStatus) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, s: UpdateStatus): void => cb(s)
    ipcRenderer.on(UPDATE_STATUS, listener)
    return (): void => {
      ipcRenderer.removeListener(UPDATE_STATUS, listener)
    }
  },

  /** 发送一条聊天消息（可带附件）；runId 随后经 onChatStream 关联流式事件 */
  chatSend: (
    sessionId: string,
    text: string,
    attachments: ChatAttachmentPayload[] | undefined,
    mode?: 'chat' | 'work' | 'learn'
  ): Promise<ChatSendResult> => ipcRenderer.invoke(CHAT_SEND, sessionId, text, attachments, mode),

  /** 工作中插话：任务运行中把消息注入下一轮上下文；false = 没有活跃任务（回退普通发送） */
  chatNudge: (sessionId: string, text: string): Promise<boolean> =>
    ipcRenderer.invoke(CHAT_NUDGE, sessionId, text),

  /** 手动压缩上下文（P8-T1）：把该会话更早的对话摘要成转述，下次请求起生效 */
  chatCompact: (sessionId: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(CHAT_COMPACT, sessionId),
  // 记忆管理
  memoryList: (): Promise<MemoryEntry[]> => ipcRenderer.invoke(MEMORY_LIST),
  memoryUpdate: (id: string, content: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(MEMORY_UPDATE, id, content),
  memoryDelete: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(MEMORY_DELETE, id),
  memoryClear: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(MEMORY_CLEAR),
  // 工作区内容检索
  searchContent: (
    query: string,
    limit?: number
  ): Promise<{
    hits: Array<{ rel: string; name: string; line: number; snippet: string; score: number }>
    scanned: number
    truncated: boolean
    error?: string
  }> => ipcRenderer.invoke(SEARCH_CONTENT, query, limit),

  /** 表情包文件名列表（内容经 sticker:// 协议按需加载） */
  stickersList: (): Promise<string[]> => ipcRenderer.invoke(STICKER_LIST),

  /** 任务清单：按会话读 todo（进度卡恢复）；无清单返回 null */
  todoGet: (
    sessionId: string
  ): Promise<{
    items: Array<{ id: string; text: string; status: 'pending' | 'done' }>
    updatedAt: number
  } | null> => ipcRenderer.invoke(TODO_GET, sessionId),

  /** 学习笔记：按会话读笔记（笔记卡）；无档返回 null */
  notesGet: (
    sessionId: string
  ): Promise<{
    items: Array<{ ts: number; kind: 'note' | 'card'; title: string; content: string }>
    updatedAt: number
  } | null> => ipcRenderer.invoke(NOTES_GET, sessionId),

  /** 学习笔记导出：另存对话框写 Markdown；返回保存路径 */
  notesExport: (
    sessionId: string
  ): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke(NOTES_EXPORT, sessionId),

  /** 复习队列：取今日到期的闪卡（含新卡）与汇总 */
  reviewDue: (
    sessionId: string
  ): Promise<{
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
  } | null> => ipcRenderer.invoke(REVIEW_DUE, sessionId),

  /** 复习评分：给一张卡打分（again/good/easy），返回新汇总 */
  reviewGrade: (
    sessionId: string,
    cardId: string,
    grade: 'again' | 'good' | 'easy'
  ): Promise<{
    ok: boolean
    summary?: { due: number; total: number; started: number; mature: number; mastery: number }
    error?: string
  }> => ipcRenderer.invoke(REVIEW_GRADE, sessionId, cardId, grade),

  /** 学习进度：掌握度 + 学习计划（学习模式进度卡） */
  progressGet: (
    sessionId: string
  ): Promise<{
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
  } | null> => ipcRenderer.invoke(PROGRESS_GET, sessionId),

  /** 技能清单：双来源合并 + enabled 已按 config 反演（主窗技能面板） */
  skillsList: (): Promise<SkillMeta[]> => ipcRenderer.invoke(SKILLS_LIST),

  /** 打开用户技能目录（userData/skills/，不存在先建）——技能面板「打开技能文件夹」 */
  skillsOpenDir: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(SKILLS_OPEN_DIR),

  /** 变更账本：全局只读列表（时间倒序，含 undo 标记）——设置页「变更账本」分区 */
  ledgerList: (): Promise<
    Array<{
      ts: number
      sessionId: string
      tool: string
      targetAbsPath: string
      action: 'create' | 'update'
      kind: 'change' | 'undo'
      undone: boolean
    }>
  > => ipcRenderer.invoke(LEDGER_LIST),

  /** 弹原生文件选择对话框（可多选），主进程读取内容后直接返回附件 */
  pickFiles: (): Promise<{
    attachments: ChatAttachmentPayload[]
    warnings: string[]
  }> => ipcRenderer.invoke(DIALOG_PICK_FILES),

  /** 弹原生目录选择对话框；取消返回 null */
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(DIALOG_PICK_DIRECTORY),

  /** 保存某 MCP server 的 env 密钥：加密落盘，渲染层永远读不回明文 */
  mcpSetSecret: (payload: {
    namespace: string
    varName: string
    value: string
  }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(MCP_SET_SECRET, payload),

  /** MCP 测试连接：按未保存的配置临时连一次并返回工具清单 */
  mcpTest: (config: McpServerConfig): Promise<McpTestResult> =>
    ipcRenderer.invoke(MCP_TEST, { config }),

  /** 恢复内置 MCP 服务器：从"已删除"名单移回并立即补齐 */
  mcpRestoreBuiltin: (key: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(MCP_BUILTIN_RESTORE, { key }),

  /** 中断一次进行中的流式回复 */
  chatCancel: (runId: string): void => {
    ipcRenderer.send(CHAT_CANCEL, runId)
  },

  /** 审批决策回执：decision = allow / allow-always / deny */
  approve: (
    approvalId: string,
    decision: 'allow' | 'allow-always' | 'deny'
  ): Promise<{ ok: boolean }> => ipcRenderer.invoke(CHAT_APPROVE, { approvalId, decision }),

  /** 提问答案回执：askId + 各题答案回灌挂起的循环 */
  answer: (
    askId: string,
    answers: Array<{ questionId: string; value: string | string[] }>
  ): Promise<{ ok: boolean }> => ipcRenderer.invoke(CHAT_ANSWER, { askId, answers }),

  /** 任务存档：读取未完成标记 / 续跑 / 放弃 */
  checkpointGet: (sessionId: string): Promise<{ steps: number; updatedAt: number } | null> =>
    ipcRenderer.invoke(CHECKPOINT_GET, sessionId),
  checkpointResume: (
    sessionId: string,
    mode?: 'chat' | 'work' | 'learn'
  ): Promise<ChatSendResult> => ipcRenderer.invoke(CHECKPOINT_RESUME, sessionId, mode),
  checkpointDiscard: (sessionId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(CHECKPOINT_DISCARD, sessionId),

  /** 订阅流式事件（token/done/error）；返回解绑函数 */
  onChatStream: (callback: (event: StreamEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: StreamEvent): void => {
      callback(payload)
    }
    ipcRenderer.on(CHAT_STREAM, listener)
    return () => {
      ipcRenderer.removeListener(CHAT_STREAM, listener)
    }
  },

  /** 会话注册表：全量同步元信息（主窗 store 每次变更后调用；主进程落盘并广播） */
  sessionsSync: (list: SessionMeta[]): void => {
    ipcRenderer.send(SESSION_SYNC, list)
  },

  /** 会话注册表：读取全量（含已隐藏） */
  sessionsList: (): Promise<SessionMeta[]> => ipcRenderer.invoke(SESSION_LIST),
  tokenUsage: (): Promise<TokenUsageResult> => ipcRenderer.invoke(SESSION_TOKEN_USAGE),
  // 右侧边栏（学 成熟实现better-sidebar）：工作区目录树 + 文件预览
  workspaceTree: (rel: string): Promise<WorkspaceTreeResult> =>
    ipcRenderer.invoke(WORKSPACE_TREE, rel),
  workspaceRead: (rel: string): Promise<WorkspaceReadResult> =>
    ipcRenderer.invoke(WORKSPACE_READ, rel),
  // 右侧栏扩展（v15）：Git 概览 / 资源管理器跳转 / 简易终端 / 任务勾选
  workspaceGit: (): Promise<WorkspaceGitResult> => ipcRenderer.invoke(WORKSPACE_GIT),
  workspaceReveal: (rel: string): Promise<boolean> => ipcRenderer.invoke(WORKSPACE_REVEAL, rel),
  /** 用系统默认应用打开工作区文件（pptx 等不支持内联预览的格式） */
  workspaceOpenPath: (rel: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(WORKSPACE_OPEN_PATH, rel),
  /** 用系统默认浏览器打开外链（右侧栏浏览器 ↗ 按钮） */
  openExternal: (url: string): void => {
    ipcRenderer.send(WORKSPACE_OPEN_EXTERNAL, url)
  },
  // 内嵌浏览器（v17 主进程 WebContentsView）：bounds 上报 + 导航 + 状态回推
  browserSetBounds: (
    rect: { x: number; y: number; width: number; height: number } | null
  ): void => {
    ipcRenderer.send(BROWSER_SET_BOUNDS, rect)
  },
  browserNavigate: (url: string): void => {
    void ipcRenderer.invoke(BROWSER_NAVIGATE, url)
  },
  browserGoBack: (): void => {
    ipcRenderer.send(BROWSER_GO_BACK)
  },
  browserGoForward: (): void => {
    ipcRenderer.send(BROWSER_GO_FORWARD)
  },
  browserReload: (): void => {
    ipcRenderer.send(BROWSER_RELOAD)
  },
  onBrowserState: (
    cb: (s: { url: string; loading: boolean; canBack: boolean; canForward: boolean }) => void
  ) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      s: { url: string; loading: boolean; canBack: boolean; canForward: boolean }
    ): void => cb(s)
    ipcRenderer.on(BROWSER_STATE, listener)
    return (): void => {
      ipcRenderer.removeListener(BROWSER_STATE, listener)
    }
  },
  // 主窗 will-navigate 兜底：漏网外链被主进程拦下后转发到这里 → 侧栏浏览器
  onOpenLink: (cb: (url: string) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, url: string): void => cb(url)
    ipcRenderer.on(BROWSER_OPEN_LINK, listener)
    return (): void => {
      ipcRenderer.removeListener(BROWSER_OPEN_LINK, listener)
    }
  },
  // 终端 v2
  terminalSpawn: (
    cols: number,
    rows: number
  ): Promise<{ ok: boolean; error?: string; cwd?: string }> =>
    ipcRenderer.invoke(TERMINAL_SPAWN, cols, rows),
  terminalWrite: (data: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(TERMINAL_WRITE, data),
  terminalResize: (cols: number, rows: number): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(TERMINAL_RESIZE, cols, rows),
  terminalKill: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(TERMINAL_KILL),
  onTerminalStream: (cb: (d: { chunk: string; exit?: boolean }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, d: { chunk: string; exit?: boolean }): void =>
      cb(d)
    ipcRenderer.on(TERMINAL_DATA, listener)
    return (): void => {
      ipcRenderer.removeListener(TERMINAL_DATA, listener)
    }
  },
  workspaceTodoToggle: (
    sessionId: string,
    todoId: string
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(WORKSPACE_TODO_TOGGLE, sessionId, todoId),

  /** 读取指定会话的持久化消息 */
  sessionMessages: (id: string): Promise<SessionMessagesResult> =>
    ipcRenderer.invoke(SESSION_MESSAGES_GET, id),

  /** 设置页：恢复/隐藏会话 */
  sessionSetHidden: (id: string, hidden: boolean): void => {
    ipcRenderer.send(SESSION_SET_HIDDEN, { id, hidden })
  },

  /** 设置页：永久删除会话 */
  sessionDeleteHard: (id: string): void => {
    ipcRenderer.send(SESSION_DELETE, id)
  },

  /** 订阅会话注册表变更广播；返回解绑函数 */
  onSessionsChanged: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent): void => {
      callback()
    }
    ipcRenderer.on(SESSIONS_CHANGED, listener)
    return () => {
      ipcRenderer.removeListener(SESSIONS_CHANGED, listener)
    }
  },

  /** 订阅配置写回广播（设置页保存后主窗即时刷新）；返回解绑函数 */
  onSettingsChanged: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent): void => {
      callback()
    }
    ipcRenderer.on(SETTINGS_CHANGED, listener)
    return () => {
      ipcRenderer.removeListener(SETTINGS_CHANGED, listener)
    }
  },

  /** 切换桌宠点击穿透，返回切换后的状态 */
  toggleClickThrough: (): Promise<boolean> => ipcRenderer.invoke(WIN_TOGGLE_CLICK_THROUGH),

  /** 请求主进程弹出桌宠右键菜单 */
  showPetMenu: (): void => {
    ipcRenderer.send(WIN_SHOW_PET_MENU)
  },

  /** 手动拖拽：按指针位置移动桌宠窗（DIP 屏幕坐标，见 pet/index.tsx 的指针事件逻辑） */
  movePetTo: (x: number, y: number): void => {
    ipcRenderer.send(WIN_PET_MOVE, x, y)
  },

  /** 手动拖拽：把"发送方窗口"移动到绝对屏幕位置（DIP）。
   * width/height 为按下时锁定的窗口尺寸（防止拖动中尺寸取整棘轮） */
  windowMoveTo: (x: number, y: number, width: number, height: number): void => {
    ipcRenderer.send(WIN_WINDOW_MOVE_TO, x, y, width, height)
  },

  /** 顶条手动拖拽起帧：主进程若处于最大化则先还原，回传还原后的窗口框（DIP）。
   * 渲染层用它计算抓取点偏移（见 src/renderer/window-drag.ts） */
  windowDragBegin: (): Promise<{ x: number; y: number; width: number; height: number } | null> => {
    return ipcRenderer.invoke(WIN_WINDOW_DRAG_BEGIN)
  },

  /** 滑动调节桌宠尺寸（0.5–1.5） */
  applyPetScale: (scale: number): void => {
    ipcRenderer.send(WIN_PET_SCALE, scale)
  },

  /** 找回被隐藏的桌宠（右键菜单 → 隐藏桌宠 之后，从这里或二次启动找回） */
  showPet: (): void => {
    ipcRenderer.send(WIN_SHOW_PET)
  },

  /** 自绘标题栏的窗口控制：最小化 / 最大化还原 / 关闭（关闭=隐藏） */
  windowControl: (action: 'minimize' | 'maximize' | 'close'): void => {
    ipcRenderer.send(WIN_WINDOW_CONTROL, action)
  },

  /** 订阅最大化态变化（手动 workArea 最大化方案的渲染层状态源：图标/拖拽分支） */
  onWindowMaximized: (callback: (maximized: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, maximized: boolean): void => {
      callback(maximized)
    }
    ipcRenderer.on(WIN_WINDOW_MAXIMIZED, listener)
    return () => {
      ipcRenderer.removeListener(WIN_WINDOW_MAXIMIZED, listener)
    }
  },

  /** 挂载首帧对账最大化态（广播早于订阅会丢，invoke 拉一次真值） */
  getWindowMaximized: (): Promise<boolean> => ipcRenderer.invoke(WIN_WINDOW_MAXIMIZED_GET),

  /** 打开独立设置窗口（已开着则聚焦） */
  openSettings: (): void => {
    ipcRenderer.send(WIN_OPEN_SETTINGS)
  },

  /** 自研边缘缩放：提交新窗口 bounds（透明窗不支持系统边缘缩放） */
  windowSetBounds: (bounds: { x: number; y: number; width: number; height: number }): void => {
    ipcRenderer.send(WIN_WINDOW_SET_BOUNDS, bounds)
  },

  /** 订阅头顶气泡文本；返回解绑函数 */
  onPetBubble: (callback: (text: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, text: string): void => {
      callback(text)
    }
    ipcRenderer.on(PET_BUBBLE, listener)
    return () => {
      ipcRenderer.removeListener(PET_BUBBLE, listener)
    }
  }
}

// 渲染进程唯一入口：window.petAPI（白名单），不放出裸 ipcRenderer / electronAPI
contextBridge.exposeInMainWorld('petAPI', petAPI)
