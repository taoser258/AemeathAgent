// run_shell v1：白名单命令执行。
// 安全模型四层：工作区 cwd 锁定 → 硬拦截表（不可审批不可配置）→ 白名单直放（含拼接符
// 一律升级审批）→ 非白名单交门禁弹卡。本模块保持无 electron 依赖，vitest 可直接单测。
//
// 白名单口径：
// 只读 git 族 / node-npm 测试构建族 / 版本查询 / Windows 的话 dir·type。curl 不进白名单
// 也不硬拦。

import { spawn, spawnSync } from 'child_process'
import { killProcessTree } from '../../mcp/process-tree'

// ── 硬拦截表（fail-closed：命中即拒绝，不可审批、配置不可覆盖）──────────────
// 定位：防白名单命令被拼接利用与高危误触；PowerShell/cmd 别名与大小写变体一并覆盖。
const HARD_BLOCKED = new Set([
  'rm',
  'rmdir',
  'del',
  'rd',
  'erase',
  'format',
  'mkfs',
  'diskpart',
  'dd',
  'shutdown',
  'restart',
  'taskkill',
  'reg',
  'regedit',
  'bcdedit',
  'cipher',
  'vssadmin',
  'wevtutil',
  'netsh',
  'net',
  'sc',
  'schtasks',
  'sudo',
  'doas',
  'eval',
  'iex',
  'invoke-expression',
  'attrib'
])

/** 命令拼接/重定向/替换符：出现任意一个 → 白名单失效，整条升级为审批（ask）。
 * 注意**不能带 g 标志**：RegExp.test() 的 lastIndex 会跨调用残留，导致检测时灵时不灵。 */
const COMBINATOR_RE = /[&|;<>`]|\$\(/

/** 诊断类安全后缀：git 的写操作子命令进黑名单（push/reset/clean 比整个 git 拦更精细） */
const GIT_BLOCKED_SUB = new Set(['push', 'reset', 'clean', 'rebase', 'filter-branch'])

/** shell 包装前缀 → **标记参数**（去掉前导 - 与 / 后比较，小写）。标记位之前的其它开关
 * 一律跳过（`cmd /d /c dir`、`powershell -NoProfile -Command …` 都常见）。
 * cmd 只认 /c（执行并退出）；/k 是"留下来继续交互"，不剥——那种命令本来也不该直放。 */
const SHELL_WRAPPER_FLAGS: Record<string, readonly string[]> = {
  cmd: ['c'],
  'cmd.exe': ['c'],
  powershell: ['c', 'command', 'cmd'],
  'powershell.exe': ['c', 'command'],
  pwsh: ['c', 'command'],
  sh: ['c'],
  bash: ['c'],
  zsh: ['c']
}

/** 白名单：前缀匹配（小写比较）。 可经配置 tools.shell.allowlist 扩展（运行时合并去重） */
export const DEFAULT_SHELL_ALLOWLIST: readonly string[] = [
  // git 只读族对齐成熟 Agent 口径
  'git status',
  'git log',
  'git diff',
  'git show',
  'git branch',
  'git blame',
  'git remote -v',
  'git stash list',
  // node / npm 族（社区共识：测试/检查/构建直放）
  'node --version',
  'node -v',
  'npm --version',
  'npm -v',
  'npm test',
  'npm run test',
  'npm run lint',
  'npm run typecheck',
  'npm run build',
  'npm ls',
  'npm view',
  'npx tsc --version',
  'npx vitest run',
  // python 查询族
  'python --version',
  'python -v',
  'pip list',
  // Windows 下的 dir/type（只读；我们已有 list_dir/read_file，这里只是补齐习惯）
  'dir',
  'type',
  // P6 补：
  // 这些都是**纯只读**的查询命令——权限只管变更，读取不该打断人。拼接/重定向仍走
  // COMBINATOR_RE 升级审批，所以 `echo x > f`、`findstr x | more` 依旧会被问。
  'where',
  'findstr',
  'tree',
  'echo',
  'whoami',
  'hostname',
  'ipconfig',
  'ver',
  // git-bash 环境下常见的只读命令（cmd 下不存在，存在即只读）
  'ls',
  'cat',
  'pwd',
  'grep',
  'head',
  'tail',
  'wc',
  // PowerShell 只读 cmdlet（她是 Windows 上的模型，偶尔会写 PowerShell 腔）
  'get-childitem',
  'get-content',
  'get-item',
  'get-location',
  'get-command',
  'select-string',
  'test-path',
  'resolve-path'
]

/** 分类结果：blocked = 硬拦截（不可审批）；allowed = 白名单直放；ask = 交门禁弹卡 */
export type ShellVerdict = 'blocked' | 'allowed' | 'ask'

/** 取命令的"动词与首个子词"（小写、去引号），供拦截表匹配 */
function headTokens(command: string): string[] {
  return command
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^["']|["']$/g, ''))
    .filter((t) => t !== '')
}

/** 是否包含拼接/重定向/替换结构（引号内的也算——宁误升级勿漏放行） */
function hasCombinator(command: string): boolean {
  return COMBINATOR_RE.test(command)
}

/**
 * 命令分类（纯函数）：
 * 1. 去掉包装前缀（timeout/time/nohup、以及 cmd /c、powershell -Command 这类 shell 包装）
 * 后逐 token 校验
 * 2. 任一 token 命中硬拦截表 → blocked；git 的写子命令（push/reset/clean/rebase）→ blocked
 * 3. 含拼接符（&& | ; > 等）→ 一律 ask（即使首词在白名单——防 `git status && rm x`）
 * 4. 前缀命中白名单 → allowed；否则 ask
 */
export function classifyCommand(
  command: string,
  extraAllowlist: readonly string[] = []
): ShellVerdict {
  const trimmed = command.trim()
  if (trimmed === '') return 'blocked'
  let tokens = headTokens(trimmed)
  // wrapper 剥离对齐成熟 Agent 口径：timeout 30 npm test → npm test；
  // timeout/time 自带时长参数（如 30、2s）要多剥一个；nohup/nice 直接剥
  const wrappers = new Set(['timeout', 'time', 'nohup', 'nice'])
  while (tokens.length > 1 && wrappers.has(tokens[0] ?? '')) {
    const w = tokens.shift()
    if ((w === 'timeout' || w === 'time') && /^\d+(ms|s|m)?$/.test(tokens[0] ?? '')) {
      tokens.shift()
    }
  }
  // shell 包装剥离：模型在 Windows 上习惯写
  // cmd /c "dir /s /b E:\x"、powershell -Command "Get-ChildItem"
  // 不剥掉这层，白名单前缀永远匹配不上——连 dir 这种只读命令都会被弹卡（实测就是这条）。
  // 只在命中标记位（/c、-Command 之类）时才剥；`bash script.sh` 这种"跑脚本"不剥，
  // 照旧落 ask（脚本内容不可见，不能凭外层声明就认它只读）。
  const wrapperFlags = SHELL_WRAPPER_FLAGS[tokens[0] ?? '']
  if (wrapperFlags !== undefined) {
    let cut = -1
    for (let i = 1; i < tokens.length; i += 1) {
      const t = tokens[i] ?? ''
      if (wrapperFlags.includes(t.replace(/^[-/]+/, ''))) {
        cut = i + 1
        break
      }
      if (!/^[-/]/.test(t)) break // 遇到非选项参数（如 bash script.sh）→ 不是 /c 形式
    }
    if (cut !== -1 && cut < tokens.length) tokens = tokens.slice(cut)
  }
  const exe = (tokens[0] ?? '').replace(/\.exe$|\.cmd$|\.bat$/, '')

  // 硬拦截：任意位置出现拦截词（防拼接藏毒的最后一道；拼接符本身也会触发 ask，
  // 但 `&&` 后半段的裸命令在拆分校验前先被这里兜住）
  if (HARD_BLOCKED.has(exe)) return 'blocked'
  for (const t of tokens) {
    if (HARD_BLOCKED.has(t)) return 'blocked'
  }
  if (exe === 'git' && tokens.length > 1 && GIT_BLOCKED_SUB.has(tokens[1] ?? '')) return 'blocked'

  // 拼接/重定向/替换：白名单不适用，升级审批（检测用原始串——引号内也算，宁误升级勿漏放行）
  if (hasCombinator(trimmed)) return 'ask'

  // 白名单前缀匹配（内置 + 用户扩展）：用 wrapper 剥离并归一空格后的串
  const stripped = tokens.join(' ')
  for (const prefix of [...DEFAULT_SHELL_ALLOWLIST, ...extraAllowlist]) {
    const p = prefix.trim().toLowerCase()
    if (p === '') continue
    if (stripped === p || stripped.startsWith(p + ' ')) return 'allowed'
  }
  return 'ask'
}

export interface ShellExecResult {
  /** 给 LLM 的结果文本（含 exit code 与合并输出；被拦截/超时/空工作区直接 throw） */
  output: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
}

/** 输出上限（头尾保样，中间截断标注） */
const SHELL_OUTPUT_MAX = 8_000
/** 默认/最大命令超时（毫秒） */
export const SHELL_DEFAULT_TIMEOUT_MS = 60_000
export const SHELL_MAX_TIMEOUT_MS = 300_000

/** 头尾保样截断（run-js 同款复用） */
export function clipOutput(text: string, max = SHELL_OUTPUT_MAX): string {
  if (text.length <= max) return text
  const head = text.slice(0, max / 2)
  const tail = text.slice(-max / 2)
  return `${head}\n…（输出过长，中间已截断）…\n${tail}`
}

/**
 * 执行一条命令（cwd 必须是绑定工作区，由 registry 侧校验后传入）。
 * - cmd.exe shell 承载（Windows 下 npm/git 是 .cmd shim，必须经 shell）
 * - 超时整树强杀（复用 MCP 的 taskkill /T /F 终结器，不留孤儿）
 * - stdout+stderr 合并、UTF-8 解码、8000 字符头尾保样
 * - 非零退出码不是错误：结果文本带 exit code，判读交给模型
 */
export function executeShell(
  command: string,
  opts: { cwd: string; timeoutMs: number }
): Promise<ShellExecResult> {
  return new Promise((resolve, reject) => {
    const timeoutMs = Math.min(Math.max(opts.timeoutMs, 1_000), SHELL_MAX_TIMEOUT_MS)
    const t0 = Date.now()
    const child = spawn(command, {
      shell: true, // Windows：经 cmd.exe 才能跑 npm/git 的 .cmd shim
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child.pid ?? 0)
    }, timeoutMs)
    const finish = (code: number | null, err?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // 超时强杀后 close 事件会带（被终止的）退出码到达——只要 timedOut 一律按超时收敛
      if (timedOut) {
        reject(
          new Error(
            `命令超时（${Math.round(timeoutMs / 1000)} 秒）已被强制终止：${command.slice(0, 200)}`
          )
        )
        return
      }
      if (err !== undefined) {
        reject(err)
        return
      }
      const durationMs = Date.now() - t0
      resolve({
        output: clipOutput(out),
        exitCode: code,
        timedOut,
        durationMs
      })
    }
    child.stdout?.on('data', (d: Buffer) => {
      if (out.length < SHELL_OUTPUT_MAX * 2) out += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (out.length < SHELL_OUTPUT_MAX * 2) out += d.toString('utf8')
    })
    child.on('error', (err) => finish(null, err))
    child.on('close', (code) => finish(code))
  })
}

/** 进程存活性探测（测试用：验证超时树杀后无残留） */
export function isProcessAlive(pid: number): boolean {
  const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`], {
    timeout: 5_000,
    windowsHide: true
  })
  const text = result.stdout?.toString('utf8') ?? ''
  return text.includes(String(pid))
}

// ── 后台任务（jobs 的最小面，只加 run_shell 后台参数，
// 不做独立工具）── background:true 立即返回 bgId，输出进内存环形缓冲；
// bg_action:'peek' 查输出 / 'stop' 强杀进程树。长命令（起 dev、长测试）不再阻塞对话。
// 权限语义不变：分类/审批只看 command，后台只是等待策略，无新旁路。

interface ShellBgTask {
  id: string
  command: string
  child: ReturnType<typeof spawn>
  buf: string
  truncated: boolean
  startedAt: number
  done: boolean
  exitCode: number | null
}

const BG_BUF_MAX = 64_000 // 每任务输出缓冲上限（保尾）
const BG_RUNNING_MAX = 4 // 运行中任务上限（防进程泄漏）
const BG_RECORDS_MAX = 8 // 记录保留上限（新任务挤掉最旧的已完成记录）

const bgTasks = new Map<string, ShellBgTask>()
let bgSeq = 0

/** 后台任务表清空（测试用） */
export function resetShellBgForTest(): void {
  for (const t of bgTasks.values()) {
    if (!t.done) killProcessTree(t.child.pid ?? 0)
  }
  bgTasks.clear()
  bgSeq = 0
}

function bgPruneRecords(): void {
  while (bgTasks.size >= BG_RECORDS_MAX) {
    const oldestDone = [...bgTasks.values()].find((t) => t.done)
    if (oldestDone === undefined) break // 没有可挤的完成态就先放着（运行中上限另管）
    bgTasks.delete(oldestDone.id)
  }
}

/** 启动后台命令：立即返回。输出进环形缓冲（保尾）；退出码记录在任务上。 */
export function startShellBackground(command: string, opts: { cwd: string }): string {
  let running = 0
  for (const t of bgTasks.values()) if (!t.done) running += 1
  if (running >= BG_RUNNING_MAX) {
    throw new Error(
      `后台任务已达上限（${BG_RUNNING_MAX} 个运行中）。先用 bg_action:'stop' 停掉不再需要的任务，或等它们退出。`
    )
  }
  bgPruneRecords()
  bgSeq += 1
  const id = `bg-${String(bgSeq).padStart(3, '0')}`
  const child = spawn(command, {
    shell: true, // 与前台同口径：Windows 下经 cmd.exe 才能跑 npm/git 的 .cmd shim
    cwd: opts.cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const task: ShellBgTask = {
    id,
    command,
    child,
    buf: '',
    truncated: false,
    startedAt: Date.now(),
    done: false,
    exitCode: null
  }
  bgTasks.set(id, task)
  const onChunk = (d: Buffer): void => {
    if (task.buf.length >= BG_BUF_MAX) {
      // 保尾：丢前半保留后半
      task.buf = task.buf.slice(-BG_BUF_MAX / 2)
      task.truncated = true
    }
    task.buf += d.toString('utf8')
  }
  child.stdout?.on('data', onChunk)
  child.stderr?.on('data', onChunk)
  child.on('error', (err) => {
    task.buf += `\n[启动失败] ${err.message}`
    task.done = true
    task.exitCode = -1
  })
  child.on('close', (code) => {
    task.done = true
    task.exitCode = code
  })
  return id
}

function formatBgStatus(task: ShellBgTask): string {
  const seconds = Math.round((Date.now() - task.startedAt) / 1000)
  const state = task.done ? `已退出（exit code: ${task.exitCode ?? 'null'}）` : '运行中'
  const head = `$ ${task.command}\n[${task.id}] ${state}，已运行 ${seconds}s`
  const body =
    task.buf.trim() === ''
      ? '（暂无输出）'
      : clipOutput(task.buf.trim(), BG_BUF_MAX / 2) +
        (task.truncated ? '\n…（更早输出已丢弃）' : '')
  return `${head}\n\n${body}`
}

/** 查看后台任务输出与状态；不存在/已被挤出时 throw */
export function peekShellBg(id: string): string {
  const task = bgTasks.get(id)
  if (task === undefined) {
    const known = [...bgTasks.keys()].join(', ') || '（无）'
    return `后台任务 ${id} 不存在或已被清理。当前保留的任务：${known}`
  }
  return formatBgStatus(task)
}

/** 停止后台任务（整树强杀，复用 MCP 的终结器）；返回给 LLM 的确认文本 */
export function stopShellBg(id: string): string {
  const task = bgTasks.get(id)
  if (task === undefined) {
    const known = [...bgTasks.keys()].join(', ') || '（无）'
    return `后台任务 ${id} 不存在或已退出并被清理。当前保留的任务：${known}`
  }
  if (task.done)
    return `[${id}] 已退出（exit code: ${task.exitCode ?? 'null'}），无需停止。\n\n${formatBgStatus(task)}`
  killProcessTree(task.child.pid ?? 0)
  return `[${id}] 已发送终止信号（整树强杀）。\n\n${formatBgStatus(task)}`
}
