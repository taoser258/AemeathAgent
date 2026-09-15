// 主窗「技能」面板：侧栏直达、主窗内切换。
// 技能 = skills/<name>/SKILL.md 目录（零代码接入，双来源：内置随仓库 / 用户自装 userData）。
// 这里只做展示与启用开关：清单经 skills:list 主进程扫描，开关写 config.skills.disabled；
// 对话侧由 prompt 附录（name+description）引导模型按需 skill_use 加载全文。

import { useEffect, useMemo, useState } from 'react'
import type { SkillMeta } from '@shared/types'

type SourceFilter = 'all' | 'builtin' | 'user'

const SOURCE_TABS: Array<{ id: SourceFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'builtin', label: '内置' },
  { id: 'user', label: '用户' }
]

function modeLabel(modes: SkillMeta['modes']): string {
  if (modes.length >= 3) return '全部模式'
  const names = modes.map((m) => (m === 'work' ? '工作' : m === 'learn' ? '学习' : '对话'))
  return `${names.join('·')}可用`
}

export default function SkillsPanel(): React.JSX.Element {
  const [skills, setSkills] = useState<SkillMeta[] | null>(null)
  const [source, setSource] = useState<SourceFilter>('all')
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [howto, setHowto] = useState(false)
  const [dirError, setDirError] = useState('')

  useEffect(() => {
    window.petAPI
      .skillsList()
      .then(setSkills)
      .catch(() => setError('技能清单加载失败'))
  }, [])

  const handleToggle = async (name: string): Promise<void> => {
    if (skills === null) return
    const target = skills.find((s) => s.name === name)
    if (target === undefined) return
    // 禁用名单整表提交：从当前 enabled 反演，翻转目标项
    const disabled = new Set(skills.filter((s) => !s.enabled).map((s) => s.name))
    if (target.enabled) disabled.add(name)
    else disabled.delete(name)
    const next = skills.map((s) => (s.name === name ? { ...s, enabled: !s.enabled } : s))
    setSkills(next) // 乐观更新
    try {
      await window.petAPI.settingsSet({ skills: { disabled: [...disabled] } })
    } catch {
      setSkills(skills) // 失败回滚
    }
  }

  const shown = useMemo(() => {
    if (skills === null) return []
    const q = query.trim().toLowerCase()
    return skills
      .filter((s) => source === 'all' || s.source === source)
      .filter(
        (s) =>
          q === '' || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
      )
  }, [skills, source, query])

  return (
    <div className="side-panel">
      <div className="side-panel-head">
        <div className="side-panel-title">⚡ 技能</div>
        <div className="side-panel-sub">
          技能 = 可复用的能力包：一个目录一份 SKILL.md
          即为技能，零代码接入。对话中命中任务时，爱弥斯会 skill_use
          加载完整说明照做；开关只管「她能不能看到」。
        </div>
      </div>
      <div className="panel-tabs">
        {SOURCE_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={source === tab.id ? 'panel-tab active' : 'panel-tab'}
            onClick={() => setSource(tab.id)}
          >
            {tab.label}
          </button>
        ))}
        <button
          type="button"
          className={howto ? 'panel-tab active' : 'panel-tab'}
          onClick={() => setHowto((v) => !v)}
        >
          📖 怎么自建技能
        </button>
      </div>
      <div className="panel-actions-row">
        <button
          type="button"
          className="panel-open-dir"
          title="在资源管理器打开用户技能文件夹（userData/skills）"
          onClick={() => {
            setDirError('')
            void window.petAPI.skillsOpenDir().then((res) => {
              if (!res.ok) setDirError(res.error ?? '打开失败')
            })
          }}
        >
          📂 打开技能文件夹
        </button>
      </div>
      {dirError !== '' && <div className="panel-empty">⚠️ {dirError}</div>}
      {howto && (
        <div className="panel-howto">
          <p>
            点右上「打开技能文件夹」→ 在里面新建<b>一个以技能名命名的子目录</b>，放进一份
            <code>SKILL.md</code>，保存即生效（无需重启；本面板<b>切走再切回</b>就能看到新技能，
            下次对话她就能用）。
          </p>
          <p className="panel-howto-title">SKILL.md 必须满足：</p>
          <ol>
            <li>
              首行就是 <code>---</code>，到下一个 <code>---</code> 之间是 frontmatter，逐行{' '}
              <code>键: 值</code>：
            </li>
            <li>
              <code>description:</code> <b>必填</b>——写清「什么时候该用我」（触发场景、关键词）。
              她就靠这句话决定加载与否，缺了这行整个技能会被静默跳过。
            </li>
            <li>
              <code>modes:</code> 可选，逗号分隔 <code>chat, work, learn</code>（如{' '}
              <code>modes: work, learn</code>）；不写 = 三模式都可用。
            </li>
            <li>
              frontmatter 之后是正文：给她的完整操作说明。<b>正文约 8000 字符以内</b>
              （超长会被截断，细则请拆进技能目录的 <code>references/*.md</code>——加载时会自动附
              绝对路径清单，让她用 read_file 按需用）。
            </li>
          </ol>
          <p className="panel-howto-title">最小示例（目录 my-skill/SKILL.md）：</p>
          <pre>{`---
description: 当用户要求整理会议纪要时使用——把杂记变成结构化纪要。
modes: work
---

# 步骤
1. 先问清会议主题与参会人……
2. 输出模板：## 结论 / ## 待办（负责人、截止日）/ ## 风险`}</pre>
          <p>
            同名技能<b>用户目录覆盖内置</b>；想改内置技能，把它整个目录拷进用户文件夹再改。
            面板开关只控制她能否看到，文件本身不用动。
          </p>
        </div>
      )}
      <input
        className="panel-search"
        placeholder="搜索技能…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="panel-list">
        {error !== '' && <div className="panel-empty">{error}</div>}
        {error === '' && skills !== null && shown.length === 0 && (
          <div className="panel-empty">
            {skills.length === 0
              ? '还没有技能——在项目 skills/ 或数据目录 userData/skills/ 下建一个 <名字>/SKILL.md 即可'
              : '无匹配技能'}
          </div>
        )}
        {shown.map((skill) => (
          <div key={`${skill.source}-${skill.name}`} className="panel-row">
            <div className="panel-row-main">
              <span className="panel-row-name">
                {skill.name}
                <span className="panel-badge-src">{skill.source === 'user' ? '用户' : '内置'}</span>
                {!skill.enabled && <span className="panel-badge-off">已禁用</span>}
              </span>
              <span className="panel-row-desc">{skill.description}</span>
              <span className="panel-row-desc panel-row-modes">{modeLabel(skill.modes)}</span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={skill.enabled}
              className={skill.enabled ? 'switch on' : 'switch'}
              disabled={skills === null}
              onClick={() => void handleToggle(skill.name)}
            >
              <span className="switch-knob" />
            </button>
          </div>
        ))}
      </div>
      <p className="panel-foot-hint">
        💡 内置技能在项目根 skills/&lt;名字&gt;/（随应用分发）；本机自装放数据目录
        userData/skills/&lt;名字&gt;/SKILL.md（同名覆盖内置），保存即生效、无需重启—— 点右上「📂
        打开技能文件夹」，要求见「📖 怎么自建技能」。
      </p>
    </div>
  )
}
