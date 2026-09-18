<h1 align="center">Aemeath Agent</h1>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078d4" alt="平台">
  <img src="https://img.shields.io/badge/Electron-39-2b2e3a?logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/license-PolyForm--Noncommercial-yellow" alt="License">
  <img src="https://img.shields.io/badge/MCP-client-orange" alt="MCP">
  <img src="https://img.shields.io/badge/tests-932%20passing-brightgreen" alt="测试">
</p>

以《鸣潮》角色 **爱弥斯** 为主题的 Windows 桌面 AI 伴侣：一个常驻桌宠小窗（透明 / 置顶 / 可拖拽）+ 一个主窗（聊天 / 工作 / 学习）。核心是一套自研的 agent 引擎——工具调用、权限审批、可恢复执行、记忆与检索、学习闭环，桌宠是它的"脸"，聊天只是最初的能力。

| 主窗聊天 | 桌宠 |
| --- | --- |
| ![主窗聊天](assets/screenshots/chat.png) | ![桌宠](assets/screenshots/pet.png) |

> 当前版本 **v0.3.2-alpha**（内测阶段）。到 [Releases](https://github.com/taoser258/AemeathAgent/releases) 下载 Windows 安装包，或按下方步骤从源码运行。

## 快速开始

### 方式一：安装包（推荐给不想折腾的你）

1. 到 [Releases](https://github.com/taoser258/AemeathAgent/releases) 下载 `Aemeath-Agent-<版本>-setup.exe`，双击安装（向导式，可选安装目录）。
2. 首次启动后点主窗左下角 **⚙** → **模型** 分区，选一个厂商卡片（GLM / DeepSeek / 千问 / Kimi / 豆包 预设，或任意 OpenAI 兼容端点），点 **编辑** 填入 **模型名** 与 **API Key** → 保存。
3. 回到主窗发一句话即可流式聊天。改动即时生效，无需重启。

> API Key 经系统 safeStorage 加密后存到用户数据目录（`%AppData%\aemeath-agent`），**不进代码仓库、不进日志、不随安装包分发**。

### 方式二：从源码运行（开发者）

**环境**：Windows 10/11 · Node.js ≥ 22 · npm（用 `package-lock.json`，不用 pnpm/yarn）

```bash
git clone <本仓库地址> AemeathAgent
cd AemeathAgent
npm ci              # 首次安装；Electron 二进制下载慢见「常见问题」
npm run dev         # 启动：桌宠出现在右下角，主窗自动打开
```

配模型同上（设置 → 模型）。没配 Key 就发消息，错误会直接写进气泡，按提示回设置页补全即可。

## 常用脚本

```bash
npm run dev           # 开发模式（渲染层 HMR；改主进程代码需重启一次）
npm test              # vitest 单测（纯逻辑，932 例）
npm run typecheck     # 主进程 + 渲染进程类型检查
npm run lint          # ESLint
npm run format        # Prettier
npm run build:office  # 打包前置：构建 Office 运行时 bundle
npm run dist          # 打 NSIS 安装包（产物目录见 package.json build.directories）
```

## 它能做什么

### 对话与桌宠

- **桌宠窗**：透明 / 置顶 / 拖拽 / 点击穿透可切 / 位置记忆 / 尺寸滑动调节（50%–150%）/ 右键菜单。
- **聊天**：流式输出可中断；Markdown + 代码高亮 + 数学公式；图片、文本、Word / Excel / PPT 附件、**PDF 直读正文（可按页读取，扫描件会如实提示）**；表情包面板。侧栏会话列表在生成中会显示转圈标识（按会话判定，多会话并行也看得清）。
- **三种模式**：💬 对话 / 🧰 工作 / 📚 学习，会话各自独立、侧栏按模式过滤、开场白各写各的；自动标题、置顶、重命名、重启完整恢复。
- **实时监测条**：轮数 · 步数 · 工具耗时 · LLM 耗时 · 首 token 延迟 · tok/s · 缓存命中 · 输入/输出 token（三协议口径统一，带缓存端点的数字也如实）。

### Agent 引擎

- **工具调用循环**：多步"推理 ↔ 工具"自动完成任务；步数上限 + 重复调用熔断防失控；过程时间线用中文标签（`edit_file（改文件）`式）。
- **权限三档**：🔔 标准（只读直放、工作区内改动直放、越界才问）/ 📋 计划模式 / ⚡ 完全访问。
- **可撤销**：写文件 / 改文件前强制快照留底，对话里说"撤销刚才的修改"即可回滚；审批卡带逐行 diff。
- **中间产物回收**：任务里产生的临时脚本 / 中间数据，她自己登记后由系统在任务收尾时移入**回收站**（可还原）；正式的成品（报告 / 网页 / 图片…）与你说过要留的文件一律不动，越界与数量异常都不清。收尾时会**如实通报**清理结果与"为什么某个文件没清"。
- **收尾核对**：她声称写好的文件，收尾时会与工作区实际对一次账，找不到就提醒你核对（防"说做了其实没做"）。
- **断点续跑**：多步任务中断后一键续跑，已完成步骤不重跑。
- **结构化提问**：拿不准先弹选项卡问你，不瞎猜。
- **MCP 插座**：stdio 协议接入外部工具 server，按其自报 `readOnlyHint` 分级。
- **多厂商协议**：OpenAI 兼容 / Anthropic / Gemini 三协议，流式 + 工具调用 + 缓存遥测。
- **思考强度**：档案可声明支持的档位（低/中/高/超高/极致），聊天区右键模型拖动调节；**按厂商端点自动适配**（八家适配器，按 Base URL 识别中转网关，档位折算不报错），三协议自动映射与钳制。
- **上下文压缩**：长会话按真实 token 用量自动把更早对话压成 handoff 摘要（只压发送视图，原文不删），也可在用量浮层手动压；摘要失败会明确告知原因。
- **识图两条腿**：非多模态模型可由「视觉档案」云端转述图片；另有 Windows 本地 OCR 逐字认字，转述内容明确标注、不冒充亲眼所见。

### 检索、记忆与富交互

- **按模式工具可见性**：设置 → 工具，分组勾选内置工具（33 个）。
- **Skill 系统**：`skills/<name>/SKILL.md` 目录即技能（零代码接入），模型按需 `skill_use` 加载；内置 + 用户自装双来源。
- **长期记忆**：跨会话记忆（自动沉淀 + 显式写入），隐私开关默认关。
- **检索**：全文搜索 / 历史会话搜索 / 工作区文件树 + 侧栏内嵌浏览器。
- **子代理**：`spawn_agent` 派分身并行做子任务；**常驻终端**（node-pty）。
- **genui 富组件**：回复里输出围栏 JSON 即渲染图表 / 表格 / 看板 / 交互控件。
- **Office 生成**：`run_js` 子进程写 Word / Excel / PPT（零安装运行时）+ 一键转 PDF。
- **自动更新**：GitHub Releases 渠道（发现新版本时侧栏设置入口亮小圆点提示，去 设置 → 关于 一键下载安装；**不会自动下载**）。

### 学习闭环

- **复习队列（间隔重复）**：闪卡按 1 / 3 / 7 / 16 / 35 天阶梯排期，「今日复习」逐张自测、三档评分。
- **掌握度与学习计划**：目标 + 截止日倒计时；模型自评与复习实测双轨，实测优先。
- **三段式教学**：讲解 → 苏格拉底追问 → 笔记 / 闪卡沉淀，笔记实时更新、可导出 Markdown。

## 目录结构

```
AemeathAgent/
├── personas/                  # 人设包（新增人设 = 新增一个目录，不改代码）
│   └── aemeath/               #   soul.md 世界观性格 + style.md 说话风格
├── skills/                    # 内置技能包（genui / office-docs / course-notes / study-flashcard / …）
├── assets/screenshots/        # 本文档配图
├── src/
│   ├── main/                  # 主进程：一切"智能与 IO"
│   │   ├── agent/             #   提示词组装 + 工具注册表 + 快照 + 笔记/复习/进度存储
│   │   ├── chat/              #   聊天管线：harness 循环 + 权限门禁 + 历史投影 + IPC 编排
│   │   ├── llm/               #   三协议流式客户端 + safeStorage apiKey
│   │   ├── mcp/               #   MCP 客户端管理（stdio server 生命周期）
│   │   ├── sessions/          #   会话持久化 + 注册表 + 一致性清扫
│   │   ├── windows/           #   桌宠窗 + 主窗 + 设置窗 + 缩放面板
│   │   └── ...                #   updater / search / terminal / memory 等
│   ├── preload/               # contextBridge 白名单（window.petAPI）
│   ├── renderer/              # 桌宠页 / 聊天页（含 genui）/ 设置页 / 全局样式
│   └── shared/                # IPC 通道常量 + 流式协议 + 品牌/版本单一来源
├── tests/                     # vitest（只测纯逻辑；932 例）
├── scripts/                   # Office 运行时构建 + 发布库源码同步（sync-public.mjs）
└── build/                     # 打包资源（icon.ico）；release*/ 为打包产物（git 忽略）
```

## 常见问题

- **MCP 怎么配？** 设置 → MCP → 添加（名称 / 命令 / 参数）。例：官方文件服务器 `npx` + `-y @modelcontextprotocol/server-filesystem D:\你的目录`——绑定目录即 AI 可读写范围，写操作照走审批。本期仅 stdio（本地子进程）。
- **`npm ci` 时 Electron 二进制下载慢/失败**：挂镜像重装 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm ci`。
- **`npm run dev` 报端口 5173 被占**：上次异常退出残留孤儿进程，任务管理器结束残留 `node.exe` / `electron.exe` 再启动。
- **改了主进程代码没生效**：electron-vite 只对渲染层 HMR，主进程改动后重启一次 dev。
- **打包报 makensis `Can't open output file`**：项目路径含中文所致（electron-builder 已知坑）。`subst X: "<项目绝对路径>"` 后从 `X:\` 运行 `npm run dist`。
- **打包下载组件卡死/超时**：直连被墙时挂 npmmirror 镜像；但全局代理开着时镜像反而超时——镜像与代理**二选一**。组件缓存在 `%LOCALAPPDATA%\electron-builder\Cache`。
- **想彻底重置数据**：用户数据在 `%AppData%\aemeath-agent`（配置 / 会话 / 密钥加密档），卸载不删除它；手动删该目录即清空。

## 许可与素材署名

**代码许可**：本仓库源码与文档采用 [PolyForm Noncommercial License 1.0.0](LICENSE)——**禁止任何商业用途**（个人使用、学习、研究、修改、非商业分享均允许），详见 LICENSE 文件。

**素材署名与版权**：

- 角色"爱弥斯"形象归《鸣潮》（库洛游戏）所有，本项目仅作同人学习用途，不含任何商业分发意图。
- 桌宠立绘来自小红书 **"Moon月"**。
- 主窗 Q 版头像来自小红书 **"糯米洛"**。

上述二创素材版权归原画师/原作方所有；如权利人希望移除，请提 issue 联系，我会第一时间处理。
