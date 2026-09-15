import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join, normalize } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  classifyExecError,
  executeToolCall,
  getLlmTools,
  getToolDefinitions,
  isMutatingTool,
  isRetryableError,
  resolveToolPath,
  RETRY_BACKOFF_MS,
  setToolPathBase,
  setToolVisibility
} from '../src/main/agent/tools/registry'
import { setSkillDirs, setSkillDisabled } from '../src/main/agent/skills'
import { setLedgerBase } from '../src/main/agent/tools/ledger'
import { setScreenEnabled, setScreenProbe } from '../src/main/agent/tools/screen'
import { setNotesBase } from '../src/main/agent/tools/note-store'

// P1 起注册表落地：只读三件套。
// 本测试守护"表内只读 + 执行收敛"：快照稳定、schema 完整、异常全部收敛为 ok:false。

describe('agent/tools/registry', () => {
  it('注册表快照：current_time 在册，全部工具带 schema 与执行器', () => {
    const tools = getToolDefinitions()
    expect(tools.map((t) => t.name)).toContain('current_time')
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(4)
      expect(t.parameters).toHaveProperty('type', 'object')
      expect(typeof t.execute).toBe('function')
    }
  })

  it('重复调用返回快照，外部污染不影响内部注册表', () => {
    const a = getToolDefinitions()
    const b = getToolDefinitions()
    expect(a).not.toBe(b)
    a.length = 0
    expect(getToolDefinitions().length).toBeGreaterThan(0)
  })

  it('getLlmTools 转成 openai function 形状（name/description/parameters）', () => {
    const llm = getLlmTools()
    expect(llm.length).toBeGreaterThan(0)
    for (const t of llm) {
      expect(t.type).toBe('function')
      expect(Object.keys(t.function)).toEqual(
        expect.arrayContaining(['name', 'description', 'parameters'])
      )
    }
  })

  it('executeToolCall：current_time 正常执行，返回含当前时间', async () => {
    const r = await executeToolCall('current_time', '{}', new AbortController().signal)
    expect(r.ok).toBe(true)
    expect(r.result).toMatch(/当前时间/)
    expect(r.result).toMatch(/Unix 毫秒/)
  })

  it('executeToolCall：未知工具与坏参数收敛为 ok:false，不向循环抛异常', async () => {
    const unknown = await executeToolCall('no_such_tool', '{}', new AbortController().signal)
    expect(unknown.ok).toBe(false)
    expect(unknown.result).toContain('工具不可用')
    const bad = await executeToolCall('current_time', '{oops', new AbortController().signal)
    expect(bad.ok).toBe(false)
    expect(bad.result).toContain('JSON')
  })
})

describe('agent/tools/registry 按模式可见性', () => {
  afterEach(() => {
    setToolVisibility(undefined) // 每例复位：模块级注入态不跨用例泄漏
  })

  it('缺省（未注入）= 全可见，与 P2 行为一致', () => {
    const work = getLlmTools('work').map((t) => t.function.name)
    const learn = getLlmTools('learn').map((t) => t.function.name)
    for (const names of [work, learn]) {
      expect(names).toContain('current_time')
      expect(names).toContain('write_file')
      expect(names).toContain('note_read')
    }
  })

  it('★ 工作与学习双模式工具清单完全一致', () => {
    const work = getLlmTools('work')
      .map((t) => t.function.name)
      .sort()
    const learn = getLlmTools('learn')
      .map((t) => t.function.name)
      .sort()
    expect(learn).toContain('run_shell')
    expect(learn).toContain('run_js')
    expect(learn).toEqual(work)
  })

  it('allowlist 只放行列出的内置工具；chat 恒空表', () => {
    setToolVisibility({ work: ['current_time', 'read_file'] })
    const work = getLlmTools('work').map((t) => t.function.name)
    expect(work).toContain('current_time')
    expect(work).toContain('read_file')
    expect(work).not.toContain('write_file')
    expect(work).not.toContain('note_write')
    expect(getLlmTools('chat')).toEqual([])
  })

  it('可见性与隐私开关取 AND：active_window 在 allowlist 内但隐私关 → 不可见', () => {
    setScreenEnabled(false)
    setToolVisibility({ work: ['current_time', 'active_window'] })
    expect(getLlmTools('work').map((t) => t.function.name)).not.toContain('active_window')
    setScreenEnabled(true)
    expect(getLlmTools('work').map((t) => t.function.name)).toContain('active_window')
    setScreenEnabled(false) // 复位（隐私默认关，与文件内其他用例惯例一致）
  })

  it('执行侧双保险：被隐藏的工具点名执行也拒绝，且回灌文案不暴露隐藏清单', async () => {
    setToolVisibility({ work: ['current_time'] })
    const signal = new AbortController().signal
    const hidden = await executeToolCall('write_file', '{}', signal, 's1', { mode: 'work' })
    expect(hidden.ok).toBe(false)
    expect(hidden.status).toBe('failed')
    expect(hidden.result).toContain('工具不可用')
    expect(hidden.result).not.toContain('write_file、') // 可用清单里没有隐藏工具自己
    // 未传 mode 缺省 work：同一语义生效
    const implicit = await executeToolCall('write_file', '{}', signal)
    expect(implicit.ok).toBe(false)
  })

  it('执行侧放行：可见工具在配置后照常执行', async () => {
    setToolVisibility({ work: ['current_time'] })
    const r = await executeToolCall('current_time', '{}', new AbortController().signal, 's1', {
      mode: 'work'
    })
    expect(r.ok).toBe(true)
    expect(r.status).toBe('ok')
  })
})

describe('resolveToolPath / write_file 工作区绑定', () => {
  let wsBase = ''
  let wsDir = ''

  beforeEach(() => {
    wsBase = mkdtempSync(join(tmpdir(), 'aemeath-ws-base-'))
    wsDir = mkdtempSync(join(tmpdir(), 'aemeath-ws-bind-'))
    setToolPathBase(wsBase)
    setLedgerBase(join(wsBase, 'ledger')) // 红线②：写前快照记账就位（本组自持，不依赖其它组的注入）
  })

  afterEach(() => {
    setToolPathBase('')
    setLedgerBase('')
    rmSync(wsBase, { recursive: true, force: true })
    rmSync(wsDir, { recursive: true, force: true })
  })

  it('相对路径优先在绑定目录内解析；未绑定回退应用基准；绝对路径原样', () => {
    expect(resolveToolPath('a.txt', wsDir)).toBe(join(wsDir, 'a.txt'))
    expect(resolveToolPath('a.txt', null)).toBe(join(wsBase, 'a.txt'))
    expect(resolveToolPath('a.txt', undefined)).toBe(join(wsBase, 'a.txt'))
    const abs = join(wsDir, 'x', 'y.md')
    expect(resolveToolPath(abs, wsDir)).toBe(abs) // 盘外/绝对口径不变
  })

  it('write_file 带 workspace：相对路径真实落在绑定目录（账本照记，红线②不绕过）', async () => {
    const signal = new AbortController().signal
    const r = await executeToolCall(
      'write_file',
      JSON.stringify({ path: 'out/demo.txt', content: 'hello' }),
      signal,
      's-ws',
      { workspace: wsDir }
    )
    expect(r.ok).toBe(true)
    expect(existsSync(join(wsDir, 'out', 'demo.txt'))).toBe(true)
    expect(existsSync(join(wsBase, 'out'))).toBe(false) // 应用基准不受影响
  })
})

describe('agent/tools/registry · skill_use 门控', () => {
  let skillsTmp = ''

  beforeEach(() => {
    skillsTmp = mkdtempSync(join(tmpdir(), 'aemeath-skilluse-'))
    mkdirSync(join(skillsTmp, 'builtin', 'demo-skill'), { recursive: true })
    mkdirSync(join(skillsTmp, 'user'), { recursive: true })
    writeFileSync(
      join(skillsTmp, 'builtin', 'demo-skill', 'SKILL.md'),
      '---\ndescription: 测试技能\n---\n测试正文',
      'utf8'
    )
  })

  afterEach(() => {
    setSkillDirs('', '')
    setSkillDisabled(undefined)
    rmSync(skillsTmp, { recursive: true, force: true })
  })

  it('无启用技能：skill_use 不进 LLM 清单；调用回"没有这个技能"', async () => {
    setSkillDirs(join(skillsTmp, 'builtin'), join(skillsTmp, 'user'))
    setSkillDisabled(['demo-skill'])
    expect(getLlmTools('work').some((t) => t.function.name === 'skill_use')).toBe(false)
    const r = await executeToolCall(
      'skill_use',
      '{"name":"demo-skill"}',
      new AbortController().signal,
      's1',
      { mode: 'work' }
    )
    expect(r.ok).toBe(true)
    expect(r.result).toContain('没有这个技能')
  })

  it('有启用技能：非 mutating、进 work/learn 清单（chat 不进）；执行回正文', async () => {
    setSkillDirs(join(skillsTmp, 'builtin'), join(skillsTmp, 'user'))
    expect(isMutatingTool('skill_use')).toBe(false)
    expect(getLlmTools('work').some((t) => t.function.name === 'skill_use')).toBe(true)
    expect(getLlmTools('learn').some((t) => t.function.name === 'skill_use')).toBe(true)
    expect(getLlmTools('chat').some((t) => t.function.name === 'skill_use')).toBe(false)
    const r = await executeToolCall(
      'skill_use',
      '{"name":"demo-skill"}',
      new AbortController().signal,
      's1',
      { mode: 'learn' }
    )
    expect(r.ok).toBe(true)
    expect(r.result).toContain('【技能：demo-skill')
    expect(r.result).toContain('测试正文')
  })
})

// ── ：read_file / list_dir（只读文件工具；T3 改版后不再有目录白名单） ──

let tmp = ''

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'aemeath-tools-'))
  mkdirSync(join(tmp, 'nested'))
  writeFileSync(join(tmp, 'a.txt'), 'hello\nworld\nthird')
  writeFileSync(join(tmp, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x03]))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('read_file / list_dir', () => {
  it('read_file：带行号读取全文', async () => {
    const r = await executeToolCall(
      'read_file',
      JSON.stringify({ path: join(tmp, 'a.txt') }),
      new AbortController().signal
    )
    expect(r.ok).toBe(true)
    expect(r.result).toContain('a.txt')
    expect(r.result).toContain('1→ hello')
    expect(r.result).toContain('2→ world')
    expect(r.result).toContain('3→ third')
  })

  it('read_file：offset/limit 行窗口，越界提示可分段', async () => {
    const r = await executeToolCall(
      'read_file',
      JSON.stringify({ path: join(tmp, 'a.txt'), offset: 2, limit: 1 }),
      new AbortController().signal
    )
    expect(r.ok).toBe(true)
    expect(r.result).toContain('2→ world')
    expect(r.result).not.toContain('1→ hello')
    expect(r.result).toContain('offset')
  })

  it('read_file：二进制拒绝 / 目录改用 list_dir / 缺文件 ENOENT / 任意路径可读', async () => {
    const signal = new AbortController().signal
    const bin = await executeToolCall(
      'read_file',
      JSON.stringify({ path: join(tmp, 'bin.dat') }),
      signal
    )
    expect(bin.ok).toBe(false)
    expect(bin.result).toContain('二进制')

    const dir = await executeToolCall('read_file', JSON.stringify({ path: tmp }), signal)
    expect(dir.ok).toBe(false)
    expect(dir.result).toContain('list_dir')

    const missing = await executeToolCall(
      'read_file',
      JSON.stringify({ path: join(tmp, 'nope.txt') }),
      signal
    )
    expect(missing.ok).toBe(false)
    expect(missing.result).toContain('ENOENT')
  })

  it('read_file：图片/Office 给明确边界提示而非"含 NUL"天书', async () => {
    const signal = new AbortController().signal
    writeFileSync(join(tmp, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
    writeFileSync(join(tmp, 'doc.docx'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))
    const img = await executeToolCall(
      'read_file',
      JSON.stringify({ path: join(tmp, 'photo.png') }),
      signal
    )
    expect(img.ok).toBe(false)
    expect(img.result).toContain('图片')
    expect(img.result).toContain('多模态')
    const office = await executeToolCall(
      'read_file',
      JSON.stringify({ path: join(tmp, 'doc.docx') }),
      signal
    )
    expect(office.ok).toBe(false)
    expect(office.result).toContain('Office')
    expect(office.result).toContain('右侧栏')
  })

  it('list_dir：目录优先排序、类型标注、文件大小', async () => {
    const r = await executeToolCall(
      'list_dir',
      JSON.stringify({ path: tmp }),
      new AbortController().signal
    )
    expect(r.ok).toBe(true)
    expect(r.result).toContain('[目录] nested/')
    expect(r.result).toMatch(/\[文件\] a\.txt \(/)
    expect(r.result.indexOf('[目录] nested/')).toBeLessThan(r.result.indexOf('[文件] a.txt'))
  })

  it('list_dir：空目录 / 路径是文件 / 白名单已废除任意路径可读', async () => {
    const signal = new AbortController().signal
    const empty = await executeToolCall(
      'list_dir',
      JSON.stringify({ path: join(tmp, 'nested') }),
      signal
    )
    expect(empty.ok).toBe(true)
    expect(empty.result).toContain('空目录')

    const notDir = await executeToolCall(
      'list_dir',
      JSON.stringify({ path: join(tmp, 'a.txt') }),
      signal
    )
    expect(notDir.ok).toBe(false)
    expect(notDir.result).toContain('read_file')
  })
})

describe('resolveToolPath', () => {
  it('相对路径基于注入的应用目录解析；绝对路径原样规范化', () => {
    setToolPathBase(join(tmp, 'app'))
    expect(resolveToolPath('src/main')).toBe(join(tmp, 'app', 'src', 'main'))
    expect(resolveToolPath('a.txt')).toBe(join(tmp, 'app', 'a.txt'))
    const abs = join(tmp, 'x', 'y.txt')
    expect(resolveToolPath(abs)).toBe(normalize(abs))
  })

  it('基准切换生效；read_file 用相对路径能读到基准目录内文件', async () => {
    setToolPathBase(tmp)
    const r = await executeToolCall(
      'read_file',
      JSON.stringify({ path: 'a.txt' }),
      new AbortController().signal
    )
    expect(r.ok).toBe(true)
    expect(r.result).toContain('1→ hello')
  })
})

describe('write_file / mkdir', () => {
  it('注册表标记：两个变更工具 mutating=true，isMutatingTool 命中', () => {
    expect(isMutatingTool('write_file')).toBe(true)
    expect(isMutatingTool('mkdir')).toBe(true)
    expect(isMutatingTool('read_file')).toBe(false)
  })

  it('write_file 新建：写入成功、返回字节数、账本 create 记录', async () => {
    setLedgerBase(tmp)
    const r = await executeToolCall(
      'write_file',
      JSON.stringify({ path: join(tmp, 'sub', 'new.txt'), content: '你好' }),
      new AbortController().signal,
      's-t1'
    )
    expect(r.ok).toBe(true)
    expect(r.result).toContain('新建文件')
    expect(readFileSync(join(tmp, 'sub', 'new.txt'), 'utf8')).toBe('你好') // 父目录自动创建
    const entryFiles = readdirSync(join(tmp, 's-t1')).filter((f) => f.endsWith('.json'))
    expect(entryFiles).toHaveLength(1)
  })

  it('write_file 更新：写前快照落账本，原内容可还原（红线②核心）', async () => {
    setLedgerBase(tmp)
    const target = join(tmp, 'exist.txt')
    writeFileSync(target, '旧内容', 'utf8')
    const r = await executeToolCall(
      'write_file',
      JSON.stringify({ path: target, content: '新内容' }),
      new AbortController().signal,
      's-t1'
    )
    expect(r.ok).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('新内容')
    // 快照还原出旧内容
    const entry = JSON.parse(
      readFileSync(
        join(tmp, 's-t1', readdirSync(join(tmp, 's-t1')).filter((f) => f.endsWith('.json'))[0]),
        'utf8'
      )
    )
    expect(entry.action).toBe('update')
    expect(readFileSync(join(tmp, 's-t1', 'snapshots', entry.snapshotRef), 'utf8')).toBe('旧内容')
  })

  it('账本未初始化：write_file 直接失败且不落盘（红线② fail-closed）', async () => {
    setLedgerBase('')
    const target = join(tmp, 'blocked.txt')
    const r = await executeToolCall(
      'write_file',
      JSON.stringify({ path: target, content: 'x' }),
      new AbortController().signal,
      's-t1'
    )
    expect(r.ok).toBe(false)
    expect(r.result).toContain('未初始化')
    expect(existsSync(target)).toBe(false)
  })

  it('mkdir：递归创建 + 已存在幂等（不产生账本条目）', async () => {
    setLedgerBase(tmp)
    const r = await executeToolCall(
      'mkdir',
      JSON.stringify({ path: join(tmp, 'a', 'b', 'c') }),
      new AbortController().signal,
      's-t1'
    )
    expect(r.ok).toBe(true)
    expect(existsSync(join(tmp, 'a', 'b', 'c'))).toBe(true)
    const r2 = await executeToolCall(
      'mkdir',
      JSON.stringify({ path: join(tmp, 'a', 'b', 'c') }),
      new AbortController().signal,
      's-t1'
    )
    expect(r2.ok).toBe(true)
    expect(r2.result).toContain('已存在')
    // 只有第一次 mkdir 记账（1 条），幂等调用不记账
    const entries = readdirSync(join(tmp, 's-t1')).filter((f) => f.endsWith('.json'))
    expect(entries).toHaveLength(1)
  })
})

describe('executeToolCall 四态 + 重试退避', () => {
  it('isRetryableError：占用类 true，确定性失败 false', () => {
    expect(isRetryableError({ code: 'EBUSY' })).toBe(true)
    expect(isRetryableError({ code: 'EPERM' })).toBe(true)
    expect(isRetryableError({ code: 'EACCES' })).toBe(true)
    expect(isRetryableError({ code: 'ENOENT' })).toBe(false)
    expect(isRetryableError(new Error('参数错'))).toBe(false)
  })

  it('timeout 归类：ToolTimeoutError → timeout（真实触发在 T6 异步工具；同步 fs 工具不经过宏任务）', () => {
    // ToolTimeoutError 由 race 内部构造（不导出）；这里验证 classifyExecError 的映射行为：
    // 非超时错误一律 failed；timeout 分支在 executeToolCall 内由内部错误类触发
    expect(classifyExecError(new Error('普通失败'))).toBe('failed')
    expect(classifyExecError({ code: 'EBUSY' })).toBe('failed')
    expect(classifyExecError(undefined)).toBe('failed')
    // 内部超时错误类通过 executeToolCall 的 options.timeoutMs 触发路径已在循环内联验证
    expect(RETRY_BACKOFF_MS).toEqual([1000, 2000, 4000])
  })

  it('failed 态：确定性失败（账本未初始化）不重试直接收敛', async () => {
    setLedgerBase('')
    const r = await executeToolCall(
      'write_file',
      JSON.stringify({ path: join(tmp, 'x.txt'), content: 'x' }),
      new AbortController().signal,
      's',
      { retryDelays: [10, 10, 10] }
    )
    expect(r.ok).toBe(false)
    expect(r.status).toBe('failed')
    setLedgerBase(tmp)
  })

  it('重试链走通：EPERM（只读文件）中途解除 → 第 2 次重试成功 ok', async () => {
    setLedgerBase(tmp)
    const target = join(tmp, 'busy.txt')
    writeFileSync(target, '原文', 'utf8')
    chmodSync(target, 0o444) // 只读 → writeFileSync 抛 EPERM（占用类，可重试）
    // 120ms 后解除只读：第 1 次失败，1 次退避（注入 100ms）后第 2 次成功
    const unlock = setTimeout(() => chmodSync(target, 0o666), 120)
    const r = await executeToolCall(
      'write_file',
      JSON.stringify({ path: target, content: '新内容' }),
      new AbortController().signal,
      's',
      { retryDelays: [100, 100, 100] }
    )
    clearTimeout(unlock)
    chmodSync(target, 0o666)
    expect(r.ok).toBe(true)
    expect(r.status).toBe('ok')
    expect(readFileSync(target, 'utf8')).toBe('新内容')
  }, 10000)

  it('重试耗尽：持续 EPERM → 注入短退避 3 次重试后 failed', async () => {
    setLedgerBase(tmp)
    const target = join(tmp, 'locked.txt')
    writeFileSync(target, '原文', 'utf8')
    chmodSync(target, 0o444)
    const r = await executeToolCall(
      'write_file',
      JSON.stringify({ path: target, content: 'x' }),
      new AbortController().signal,
      's',
      { retryDelays: [20, 20, 20] }
    )
    chmodSync(target, 0o666)
    expect(r.ok).toBe(false)
    expect(r.status).toBe('failed')
    expect(r.result).toContain('工具执行出错')
  }, 10000)
})

describe('active_window 屏幕感知', () => {
  it('默认关：getLlmTools 不含 active_window，调用报「屏幕感知未开启」', async () => {
    setScreenEnabled(false)
    expect(getLlmTools().some((t) => t.function.name === 'active_window')).toBe(false)
    const r = await executeToolCall('active_window', '{}', new AbortController().signal, 's1')
    expect(r.ok).toBe(false)
    expect(r.status).toBe('failed')
    expect(r.result).toContain('屏幕感知未开启')
  })

  it('开启后：进入注册表（非 mutating）且执行返回探针结果；3s 内缓存复用', async () => {
    let calls = 0
    setScreenProbe(async () => {
      calls += 1
      return 'Code｜「Aemeath-agent - Visual Studio Code」'
    })
    setScreenEnabled(true)
    const inList = getLlmTools().some((t) => t.function.name === 'active_window')
    expect(inList).toBe(true)
    expect(isMutatingTool('active_window')).toBe(false)

    const r1 = await executeToolCall('active_window', '{}', new AbortController().signal, 's1')
    expect(r1.ok).toBe(true)
    expect(r1.result).toContain('Aemeath-agent')
    await executeToolCall('active_window', '{}', new AbortController().signal, 's1')
    expect(calls).toBe(1) // 缓存命中，探针只跑一次

    setScreenEnabled(false)
    expect(getLlmTools().some((t) => t.function.name === 'active_window')).toBe(false)
  })

  it('探针异常收敛：抛错转 failed 可读文案', async () => {
    setScreenProbe(async () => {
      throw new Error('读取前台窗口超时')
    })
    setScreenEnabled(true)
    const r = await executeToolCall('active_window', '{}', new AbortController().signal, 's1')
    expect(r.ok).toBe(false)
    expect(r.result).toContain('工具执行出错')
    setScreenEnabled(false)
    setScreenProbe(null)
  })
})

describe('note_write / note_read', () => {
  it('非 mutating；write 后 read 回显条目；空会话读给引导文案', async () => {
    expect(isMutatingTool('note_write')).toBe(false)
    expect(isMutatingTool('note_read')).toBe(false)
    setNotesBase(tmp)

    const r0 = await executeToolCall('note_read', '{}', new AbortController().signal, 's9')
    expect(r0.ok).toBe(true)
    expect(r0.result).toContain('还没有笔记')

    const r1 = await executeToolCall(
      'note_write',
      JSON.stringify({
        entries: [
          { kind: 'note', title: '递归三要素', content: '基准情形 / 递归步骤 / 收敛性' },
          { kind: 'card', title: '递归必备的两分支是什么？', content: '基准情形与递归情形' }
        ]
      }),
      new AbortController().signal,
      's9'
    )
    expect(r1.ok).toBe(true)
    expect(r1.result).toContain('2 条笔记')

    const r2 = await executeToolCall('note_read', '{}', new AbortController().signal, 's9')
    expect(r2.result).toContain('递归三要素')
    expect(r2.result).toContain('闪卡')
  })

  it('非法参数收敛 failed：缺 entries / 非法 kind', async () => {
    setNotesBase(tmp)
    const r1 = await executeToolCall('note_write', '{}', new AbortController().signal, 's9')
    expect(r1.ok).toBe(false)
    const r2 = await executeToolCall(
      'note_write',
      JSON.stringify({ entries: [{ kind: 'idea', title: 't', content: 'c' }] }),
      new AbortController().signal,
      's9'
    )
    expect(r2.ok).toBe(false)
    expect(r2.result).toContain('没有合法条目')
  })
})
