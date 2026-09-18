// IPC 通道常量：全局唯一、前缀化命名。
// 约束：渲染进程不允许直接碰 ipcRenderer，只能通过 preload 暴露的 window.petAPI 间接使用这些通道。

/** 聊天：渲染 → 主，发送一条用户消息；主进程生成 runId 并开始流式回复 */
export const CHAT_SEND = 'chat:send'
/** 聊天：渲染 → 主，中断一次进行中的流式回复 */
export const CHAT_CANCEL = 'chat:cancel'
/** 聊天：渲染 → 主，审批决策回执 */
export const CHAT_APPROVE = 'chat:approve'
/** 聊天：渲染 → 主，结构化提问答案回执 */
export const CHAT_ANSWER = 'chat:answer'

/** 任务存档：读取标记 / 续跑 / 放弃未完成任务 */
export const CHECKPOINT_GET = 'checkpoint:get'
export const CHECKPOINT_RESUME = 'checkpoint:resume'
export const CHECKPOINT_DISCARD = 'checkpoint:discard'
/** 聊天：主 → 渲染，流式事件推送（载荷结构见 protocol.ts 的 StreamEvent） */
export const CHAT_STREAM = 'chat:stream'

/** 工作中插话（steering 机制）：任务运行中把用户消息注入下一轮上下文 */
export const CHAT_NUDGE = 'chat:nudge'

/** 手动压缩上下文（P8-T1）：渲染 → 主，把该会话更早的对话摘要成一段转述（下次请求起生效） */
export const CHAT_COMPACT = 'chat:compact'

/** 表情包：渲染 → 主，列出 resources/stickers 下的文件名（sticker:// 协议负责内容服务） */
export const STICKER_LIST = 'sticker:list'

/** 文件选择：渲染 → 主，弹原生文件对话框并读取内容（渲染层 <input type=file> 在透明窗弹窗慢） */
export const DIALOG_PICK_FILES = 'dialog:pick-files'
/** 目录选择：渲染 → 主，弹原生目录选择对话框（工作区绑定用），返回绝对路径或 null */
export const DIALOG_PICK_DIRECTORY = 'dialog:pick-directory'

/** 变更账本：渲染 → 主，列出副作用账本条目（全局，时间倒序；设置页只读视图） */
export const LEDGER_LIST = 'ledger:list'

/** 任务清单：渲染 → 主，按会话读 todo（切会话/重启恢复进度卡） */
export const TODO_GET = 'todo:get'

/** 学习笔记：渲染 → 主，按会话读笔记（笔记卡展示） */
export const NOTES_GET = 'notes:get'
/** 学习笔记导出：渲染 → 主，另存对话框写 Markdown，返回保存路径 */
export const NOTES_EXPORT = 'notes:export'

/** 复习队列：渲染 → 主，按会话取到期卡片与汇总 */
export const REVIEW_DUE = 'review:due'
/** 复习评分：渲染 → 主，给一张卡打分（again/good/easy）并落盘 */
export const REVIEW_GRADE = 'review:grade'
/** 学习进度：渲染 → 主，按会话取掌握度与学习计划 */
export const PROGRESS_GET = 'progress:get'

/** 技能：渲染 → 主，全量技能清单（双来源合并 + enabled 已按 config 反演；主窗技能面板用） */
export const SKILLS_LIST = 'skills:list'

/** 技能：渲染 → 主，在资源管理器打开用户技能目录（不存在先建） */
export const SKILLS_OPEN_DIR = 'skills:open-dir'

/** 会话：新建 / 列表 / 打开 / 重命名 / 删除 */
export const SESSION_CREATE = 'session:create'
export const SESSION_LIST = 'session:list'
/** Token 用量汇总（设置页「用量」分区）：遍历全部会话档的累计遥测 */
export const SESSION_TOKEN_USAGE = 'session:token-usage'
/** 右侧边栏（学 成熟实现better-sidebar）：浏览当前会话工作区的目录树 */
export const WORKSPACE_TREE = 'workspace:tree'
/** 右侧边栏：读取工作区内文件用于预览（文本 / 图片 dataUrl；越界与超大拒绝） */
export const WORKSPACE_READ = 'workspace:read'
/** 右侧栏 Git 面板：工作区仓库概览（只读 status/log；非 git 仓库返回 isRepo:false） */
export const WORKSPACE_GIT = 'workspace:git'
/** 右侧栏：在系统资源管理器中显示文件 */
export const WORKSPACE_REVEAL = 'workspace:reveal'
/** 终端 v2：开 shell（cwd 固定工作区根）/键入/改尺寸/杀 */
export const TERMINAL_SPAWN = 'terminal:spawn'
export const TERMINAL_WRITE = 'terminal:write'
export const TERMINAL_RESIZE = 'terminal:resize'
export const TERMINAL_KILL = 'terminal:kill'
/** 终端 v2 输出流（主进程 → 渲染；raw ANSI，渲染层 AnsiScreen 解析） */
export const TERMINAL_DATA = 'terminal:data'
/** 右侧栏任务面板：勾选切换清单项状态（复用 agent 的 todo-store 落盘） */
export const WORKSPACE_TODO_TOGGLE = 'workspace:todo-toggle'
/** 右侧栏浏览器：外链交给系统默认浏览器 */
export const WORKSPACE_OPEN_EXTERNAL = 'workspace:open-external'

/** 记忆管理：列表 / 编辑一条 / 删除一条 / 清空全部 */
export const MEMORY_LIST = 'memory:list'
export const MEMORY_UPDATE = 'memory:update'
export const MEMORY_DELETE = 'memory:delete'
export const MEMORY_CLEAR = 'memory:clear'

/** 工作区内容检索 */
export const SEARCH_CONTENT = 'search:content'
/** 右侧栏：用系统默认应用打开工作区文件（pptx 等不支持内联预览的格式） */
export const WORKSPACE_OPEN_PATH = 'workspace:open-path'

/** 内嵌浏览器（v17，主进程 WebContentsView）：bounds 上报（null=隐藏） */
export const BROWSER_SET_BOUNDS = 'browser:set-bounds'
/** 主窗 webContents 试图站内导航外链时，主进程拦下后转发渲染层（走侧栏浏览器） */
export const BROWSER_OPEN_LINK = 'browser:open-link'
/** 内嵌浏览器：导航到 url（渲染层 normalize 后传原始串，主进程兜底同规则） */
export const BROWSER_NAVIGATE = 'browser:navigate'
/** 内嵌浏览器：后退 / 前进 / 刷新 */
export const BROWSER_GO_BACK = 'browser:go-back'
export const BROWSER_GO_FORWARD = 'browser:go-forward'
export const BROWSER_RELOAD = 'browser:reload'
/** 内嵌浏览器：状态回推（url/loading/canBack/canForward） */
export const BROWSER_STATE = 'browser:state'
export const SESSION_OPEN = 'session:open'
export const SESSION_RENAME = 'session:rename'
export const SESSION_DELETE = 'session:delete'
/** 会话注册表：渲染层全量同步元信息；主进程落盘并广播变更 */
export const SESSION_SYNC = 'session:sync'
export const SESSIONS_CHANGED = 'session:changed'
/** 会话消息正文：渲染 → 主，读取指定会话的持久化消息 */
export const SESSION_MESSAGES_GET = 'session:messages'
/** 设置页对已隐藏会话的操作：恢复 / 永久删除 */
export const SESSION_SET_HIDDEN = 'session:set-hidden'

/** 设置：读写 app.json、apiKey（safeStorage）、测试模型连接 */
export const SETTINGS_GET = 'settings:get'
export const SETTINGS_SET = 'settings:set'
/** 设置：主 → 渲染，配置写回广播（让主窗的上下文环/模型名等即时刷新，T6） */
export const SETTINGS_CHANGED = 'settings:changed'
export const SETTINGS_SET_API_KEY = 'settings:set-api-key'
export const SETTINGS_HAS_API_KEY = 'settings:has-api-key'
export const SETTINGS_TEST_CONNECTION = 'settings:test-connection'
/** MCP 密钥：渲染 → 主，写入某 server 的 env 密钥（safeStorage 加密，只写不读回） */
export const MCP_SET_SECRET = 'mcp:set-secret'
/** MCP 测试连接：渲染 → 主，按配置临时连一次并返回工具清单（不进管理器，用完即关） */
export const MCP_TEST = 'mcp:test'
/** MCP 恢复内置项：渲染 → 主，把某个内置服务器从"已删除"名单里移回并立即补齐 */
export const MCP_BUILTIN_RESTORE = 'mcp:builtin-restore'

/** 桌宠：主 → pet 渲染层，更新头顶气泡文本 */
export const PET_BUBBLE = 'pet:bubble'
/** 桌宠：pet 渲染层 → 主，被点了一下（按下抬起几乎没动） */
export const PET_TAP = 'pet:tap'
/** 桌宠：pet 渲染层 → 主，一次拖拽结束（移动过） */
export const PET_DRAGGED = 'pet:dragged'

/** 窗口：渲染 → 主，桌宠页右键时请求弹出菜单（打开主窗 / 切穿透 / 退出） */
export const WIN_SHOW_PET_MENU = 'win:show-pet-menu'
/** 窗口：渲染 → 主，找回被隐藏的桌宠（设置页"显示桌宠"按钮） */
export const WIN_SHOW_PET = 'win:show-pet'
/** 窗口：渲染 → 主，滑动调节桌宠尺寸（0.5–1.5） */
export const WIN_PET_SCALE = 'win:pet-scale'
/** 窗口：渲染 → 主，打开独立设置窗口（侧栏底部 ⚙ 按钮） */
export const WIN_OPEN_SETTINGS = 'win:open-settings'
/** 窗口：渲染 → 主，自研边缘缩放提交新 bounds（透明窗不支持系统边缘缩放） */
export const WIN_WINDOW_SET_BOUNDS = 'win:window-set-bounds'
/** 窗口：渲染 → 主，自绘标题栏的窗口控制（payload: 'minimize' | 'maximize' | 'close'） */
export const WIN_WINDOW_CONTROL = 'win:window-control'
/** 窗口：主 → 渲染，最大化态变化广播（手动 workArea 最大化方案的状态单源在渲染层，
 * 按钮图标与拖拽/缩放分支都要读它；load 完成补发一次防订阅竞态） */
export const WIN_WINDOW_MAXIMIZED = 'win:window-maximized'
/** 窗口：渲染 → 主，查询当前最大化态（invoke）：渲染层挂载首帧对账，广播只负责变更 */
export const WIN_WINDOW_MAXIMIZED_GET = 'win:window-maximized-get'
/** 窗口：渲染 → 主，手动拖拽时按指针位置移动桌宠窗（DIP 屏幕坐标） */
export const WIN_PET_MOVE = 'win:pet-move'
/** 窗口：渲染 → 主，手动拖拽起帧（invoke）：若窗口处于最大化，先还原到最大化前的
 * bounds，再把（还原后的）当前窗口框返回给渲染层作为拖拽基准。
 * 背景：app-region:drag 是系统级拖动，无边框窗不会"拖标题栏自动还原"；
 * 改渲染层手动拖拽后，由本通道拿到还原后的真实基准框。 */
export const WIN_WINDOW_DRAG_BEGIN = 'win:window-drag-begin'
/** 窗口：渲染 → 主，手动拖拽：把"发送方窗口"移动到绝对屏幕位置（DIP）。
 * 绝对定位（而非增量）没有累积误差：每帧都由"光标 − 抓取点偏移"直接得出目标位置，
 * 就算某帧丢失，下一帧也会自动校正——抓取点始终钉在光标下。 */
export const WIN_WINDOW_MOVE_TO = 'win:window-move-to'
/** 窗口：渲染 → 主，切换桌宠点击穿透（设置页与右键菜单共用，状态单源） */
export const WIN_TOGGLE_CLICK_THROUGH = 'win:toggle-click-through'
/** 窗口：渲染 → 主，打开主窗（菜单动作目前直接调用主进程函数，此通道留给后续任务使用） */
export const WIN_OPEN_MAIN = 'win:open-main'

/** 自动更新：检查 / 下载 / 重启安装 / 打开 Releases + 状态广播 */
export const UPDATE_CHECK = 'update:check'
/** 自动更新：只读当前状态（渲染层挂载时对账，**不触发网络检查**——每次开窗都真查会白耗流量与时间） */
export const UPDATE_STATUS_GET = 'update:status-get'
export const UPDATE_DOWNLOAD = 'update:download'
export const UPDATE_QUIT_INSTALL = 'update:quit-install'
export const UPDATE_OPEN_RELEASES = 'update:open-releases'
export const UPDATE_STATUS = 'update:status'

/** 提示词优化（P9-T4）：渲染 → 主，把输入框当前原文改写成更清楚的版本（非流式、不自动发送） */
export const PROMPT_OPTIMIZE = 'prompt:optimize'
