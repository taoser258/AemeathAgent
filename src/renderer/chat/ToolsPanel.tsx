// 主窗「工具」面板：侧栏直达、主窗内切换，不进设置页。
// allowlist 语义：勾选 = 启用，缺省全开（'all' 与 P2 行为完全一致）；
// 隐藏的工具模型看不见也调不动（清单 + 执行侧双保险），安全仍由权限审批兜底。

import { useEffect, useMemo, useState } from 'react'

type VisValue = 'all' | string[]
type Visibility = { work: VisValue; learn: VisValue }
type PanelMode = 'work' | 'learn'

/** 内置工具展示清单（与主进程 agent/tools/registry.ts 的 TOOLS 表保持同步——
 * tests/tools-panel.test.ts 有守护：registry 新增工具没进这份清单即挂。
 * 漏补不影响功能——缺省 'all' 全可见，只是不出现在此面板）。 */
const BUILTIN_TOOLS: Array<{ name: string; label: string; desc: string }> = [
  { name: 'current_time', label: '当前时间', desc: '查询今天的日期、星期与精确时间' },
  {
    name: 'calculate',
    label: '算数计算',
    desc: '单条算式精确求值——百分比/多步连算/总价折扣先走它，不让她心算'
  },
  { name: 'read_file', label: '读取文件', desc: '读取本地文本文件内容' },
  { name: 'list_dir', label: '列出目录', desc: '查看目录里有哪些文件与子目录' },
  {
    name: 'write_file',
    label: '写入文件',
    desc: '新建或覆盖文件（变更类，写前自动快照；工作区内免询问）'
  },
  { name: 'mkdir', label: '创建目录', desc: '递归新建文件夹（变更类，记账可撤销）' },
  {
    name: 'mark_temp_files',
    label: '登记中间产物',
    desc: '她主动登记本轮自己产生的中间产物，任务收尾才清理；没登记的一律不动（防误删）'
  },
  {
    name: 'delete_file',
    label: '删除到回收站',
    desc: '把文件/文件夹移入回收站可还原；非完全访问模式每次删除都会请你确认'
  },
  {
    name: 'edit_file',
    label: '编辑文件',
    desc: '锚点精确替换，局部修改不再整文件重写（变更类，记账可撤销）'
  },
  { name: 'search_files', label: '搜索文件', desc: '按文件名通配 + 内容正则，一次找到代码与配置' },
  {
    name: 'search_content',
    label: '全文检索',
    desc: '在工作区里搜内容——找「哪份文件提到过 XX」（千文件级 <1s）'
  },
  { name: 'fetch_url', label: '网页读取', desc: '抓取公网网页正文（标题+纯文本），不用开浏览器' },
  {
    name: 'web_search',
    label: '联网搜索',
    desc: '免 key 多引擎搜索（搜狗优先，DDG/Bing 自动回退），拿到链接再读全文'
  },
  { name: 'download_file', label: '下载文件', desc: '把公网文件下载进工作区（变更类，可撤销）' },
  {
    name: 'note_export',
    label: '导出笔记',
    desc: '笔记/闪卡导出 Markdown，可进 Obsidian（变更类）'
  },
  { name: 'search_history', label: '搜历史会话', desc: '按关键词找回之前聊过的内容与结论' },
  {
    name: 'run_shell',
    label: '执行命令',
    desc: '工作区里跑命令（安全名单外需要你批准）'
  },
  {
    name: 'run_js',
    label: '生成 Office 文档',
    desc: '用随包运行时跑 JS（内置 docx/ExcelJS/PPTX 库）生成 Word/Excel/PPT；每次弹卡看代码'
  },
  {
    name: 'export_pdf',
    label: '导出 PDF',
    desc: '把 HTML 文件打印成 PDF（隐藏沙箱渲染，中文/表格不缺字）'
  },
  { name: 'undo_last_change', label: '撤销变更', desc: '回滚本会话最近一笔改动（变更类）' },
  { name: 'todo_write', label: '任务清单', desc: '多步任务列清单、逐项打勾的进度卡' },
  {
    name: 'active_window',
    label: '屏幕感知',
    desc: '知道你当前在用什么应用（还需在 设置 → 桌宠 → 隐私 开启）'
  },
  {
    name: 'describe_image',
    label: '识图',
    desc: '看工作区里的截图/图表/报错弹窗（图片会发往设置里的「视觉档案」）'
  },
  {
    name: 'ocr_image',
    label: '本机识字',
    desc: '用 Windows 自带 OCR 逐字抄图里的文字（不联网，数字/编号更准）'
  },
  { name: 'note_write', label: '记录学习笔记', desc: '把知识点与闪卡写进学习笔记' },
  { name: 'note_read', label: '回顾学习笔记', desc: '回显本会话已记的笔记与闪卡' },
  {
    name: 'study_progress_write',
    label: '记学习进度',
    desc: '设学习目标与截止日、记知识点掌握度（复习评分会自动回流覆盖自评）'
  },
  {
    name: 'study_progress_read',
    label: '看学习进度',
    desc: '读学习目标、各知识点掌握度、闪卡复习情况'
  },
  {
    name: 'memory_save',
    label: '记住一件事',
    desc: '把偏好/事实/承诺写进长期记忆（需先在 设置 → 记忆 开启）'
  },
  {
    name: 'memory_search',
    label: '回忆',
    desc: '按关键词检索长期记忆条目'
  },
  {
    name: 'skill_use',
    label: '使用技能',
    desc: '按需加载某个技能的完整说明书（技能在 设置 → 技能 管理）'
  },
  {
    name: 'spawn_agent',
    label: '派生子任务',
    desc: '让分身独立去干批量活/大调研，只把结论带回主对话（分身没有撤销与屏幕感知）'
  },
  {
    name: 'ask_user',
    label: '问你问题',
    desc: '拿不准时发结构化提问卡（单选/多选/填空），你点选即答她再继续'
  }
]

const MODES: Array<{ id: PanelMode; label: string }> = [
  { id: 'work', label: '🧰 工作' },
  { id: 'learn', label: '📚 学习' }
]

export default function ToolsPanel(): React.JSX.Element {
  const [vis, setVis] = useState<Visibility | null>(null)
  const [mode, setMode] = useState<PanelMode>('work')
  const [query, setQuery] = useState('')
  const [mcpCount, setMcpCount] = useState(0)

  useEffect(() => {
    window.petAPI.getConfig().then((config) => {
      setVis(config.tools?.visibility ?? { work: 'all', learn: 'all' })
      setMcpCount(config.mcp?.servers.length ?? 0)
    })
  }, [])

  const isChecked = (name: string): boolean => {
    if (vis === null) return false
    const cur = vis[mode]
    return cur === 'all' || cur.includes(name)
  }

  const handleToggle = async (name: string): Promise<void> => {
    if (vis === null) return
    const cur = vis[mode]
    const willCheck = !isChecked(name)
    // 物化：从当前状态推导完整内置工具名单，再加/减勾选项；全勾上时回到 'all'（缺省形状，未来新增工具默认可见）
    const base = cur === 'all' ? BUILTIN_TOOLS.map((t) => t.name) : [...cur]
    const nextList = willCheck ? [...new Set([...base, name])] : base.filter((n) => n !== name)
    const allChecked = BUILTIN_TOOLS.every((t) => nextList.includes(t.name))
    const value: VisValue = allChecked ? 'all' : nextList
    const next = mode === 'work' ? { ...vis, work: value } : { ...vis, learn: value }
    setVis(next) // 乐观更新
    try {
      await window.petAPI.settingsSet({ tools: { visibility: next } })
    } catch {
      setVis(vis) // 失败回滚
    }
  }

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '') return BUILTIN_TOOLS
    return BUILTIN_TOOLS.filter(
      (t) =>
        t.label.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.desc.toLowerCase().includes(q)
    )
  }, [query])

  return (
    <div className="side-panel">
      <div className="side-panel-head">
        <div className="side-panel-title">🧰 工具</div>
        <div className="side-panel-sub">
          管理工具在 {mode === 'work' ? '工作' : '学习'}模式下的可见性：勾选 = 启用，全部勾选 =
          缺省全开。对话模式按设计不带工具。
        </div>
      </div>
      <div className="panel-tabs">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={mode === m.id ? 'panel-tab active' : 'panel-tab'}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <input
        className="panel-search"
        placeholder="搜索工具…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="panel-list">
        {shown.map((tool) => {
          const on = isChecked(tool.name)
          return (
            <div key={tool.name} className="panel-row">
              <div className="panel-row-main">
                <span className="panel-row-name">
                  {tool.label}
                  {!on && <span className="panel-badge-off">已禁用</span>}
                </span>
                <span className="panel-row-desc">{tool.desc}</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                className={on ? 'switch on' : 'switch'}
                disabled={vis === null}
                onClick={() => void handleToggle(tool.name)}
              >
                <span className="switch-knob" />
              </button>
            </div>
          )
        })}
        {shown.length === 0 && <div className="panel-empty">无匹配工具</div>}
      </div>
      <p className="panel-foot-hint">
        🔌 MCP 工具由「设置 → MCP」的服务器启停统一管理
        {mcpCount > 0 ? `（当前 ${mcpCount} 个服务器）` : '（当前未配置服务器）'}。
      </p>
    </div>
  )
}
