// run_shell v1 单测：分类器（硬拦截/白名单/拼接升级）+ 真实执行
// （git 直放、超时树杀、输出截断、非零退出码回灌）+ 门禁特判接线。

import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  classifyCommand,
  executeShell,
  peekShellBg,
  resetShellBgForTest,
  startShellBackground,
  stopShellBg,
  SHELL_DEFAULT_TIMEOUT_MS
} from '../src/main/agent/tools/run-shell'
import {
  setShellAllowlist,
  getToolDefinitions,
  type ToolDef
} from '../src/main/agent/tools/registry'
import { clearSessionAllowedTools } from '../src/main/chat/permission'

const defs = getToolDefinitions()
const shellTool = defs.find((d) => d.name === 'run_shell') as ToolDef
const ctx = (
  workspace: string
): {
  signal: AbortSignal
  sessionId: string
  workspace: string
} => ({
  signal: new AbortController().signal,
  sessionId: 'test-session',
  workspace
})

let root: string
beforeEach((): void => {
  root = mkdtempSync(join(tmpdir(), 'aemeath-shell-'))
})
afterEach(() => {
  setShellAllowlist([])
  clearSessionAllowedTools()
})

// ── 分类器 ───────────────────────────────────────────────────────────────
describe('classifyCommand（硬拦截 / 白名单 / 升级审批）', () => {
  it('硬拦截表：任意位置命中即 blocked（含大小写与 .exe 变体）', () => {
    for (const bad of [
      'rm -rf x',
      'del file.txt',
      'format C:',
      'git status && rm x',
      'echo hi & taskkill /f',
      'shutdown /s',
      'regedit',
      'REGEDIT.exe',
      'git push --force',
      'git reset --hard HEAD~1',
      'git clean -fd'
    ]) {
      expect(classifyCommand(bad), bad).toBe('blocked')
    }
  })

  it('白名单直放：只读 git / npm test / 版本查询', () => {
    for (const ok of [
      'git status',
      'git log --oneline -5',
      'git diff HEAD',
      'npm test',
      'npm run typecheck',
      'node --version',
      'npx vitest run',
      'python --version'
    ]) {
      expect(classifyCommand(ok), ok).toBe('allowed')
    }
  })

  it('拼接/重定向符：即使首词在白名单也升级 ask', () => {
    expect(classifyCommand('git status && npm test')).toBe('ask')
    expect(classifyCommand('npm test | tee out.txt')).toBe('ask')
    expect(classifyCommand('git log > log.txt')).toBe('ask')
    expect(classifyCommand('node --version; npm test')).toBe('ask')
  })

  it('非白名单 → ask；curl 不硬拦', () => {
    expect(classifyCommand('curl https://example.com')).toBe('ask')
    expect(classifyCommand('git commit -m x')).toBe('ask')
    expect(classifyCommand('npm install lodash')).toBe('ask') // install 不在默认集
  })

  it('用户扩展白名单合并生效；wrapper 前缀剥离', () => {
    expect(classifyCommand('cargo build', ['cargo build'])).toBe('allowed')
    expect(classifyCommand('timeout 30 npm test')).toBe('allowed') // timeout/time/nohup 剥离
  })

  // ★ 回归：那条被弹卡的命令原文，逐字钉住
  it('★ shell 包装剥离：cmd /c "dir …" 认出只读，不再弹卡', () => {
    expect(classifyCommand('cmd /c "dir /s /b E:\\演示工作区"')).toBe('allowed')
    expect(classifyCommand('cmd.exe /c dir')).toBe('allowed')
    expect(classifyCommand('cmd /d /c dir /b')).toBe('allowed')
    expect(classifyCommand('powershell -Command "get-childitem E:\\x"')).toBe('allowed')
    expect(classifyCommand('pwsh -c tree')).toBe('allowed')
  })

  it('包装剥离不放宽拼接与高危：cmd /c 里裹着 rm / 重定向照样拦', () => {
    expect(classifyCommand('cmd /c "rm x"')).toBe('blocked') // 硬拦截表对剥后的 token 生效
    expect(classifyCommand('cmd /c "dir > out.txt"')).toBe('ask') // 重定向 → 升级审批
    expect(classifyCommand('cmd /c "dir && del x"')).toBe('blocked') // 任意位置的拦截词 → 硬拦
    expect(classifyCommand('bash script.sh')).toBe('ask') // 非 /c 形式不剥：跑脚本不算只读
  })

  it('新增只读命令（where/findstr/tree/get-content…）直放，写操作仍 ask', () => {
    expect(classifyCommand('where node')).toBe('allowed')
    expect(classifyCommand('findstr /s 关键词 *.md')).toBe('allowed')
    expect(classifyCommand('tree /f')).toBe('allowed')
    expect(classifyCommand('type README.md')).toBe('allowed')
    expect(classifyCommand('git push origin main')).toBe('blocked')
  })

  it('空命令 blocked', () => {
    expect(classifyCommand('   ')).toBe('blocked')
  })
})

// ── 真实执行 ─────────────────────────────────────────────────────────────
describe('executeShell（真实进程）', () => {
  it('git status 直放路径：正常返回 exit code 与输出', async () => {
    // 在临时目录跑 git status：非 git 仓库也会返回退出码（回灌语义，不抛错）
    const res = await executeShell('git status', { cwd: root, timeoutMs: 15_000 })
    expect(res.exitCode).not.toBeNull() // 非 git 仓库也有退出码（fatal 提示），回灌语义
  })

  it('非零退出码不是异常：exit code 与输出照常返回', async () => {
    const res = await executeShell('node -e "process.exit(3)"', { cwd: root, timeoutMs: 15_000 })
    expect(res.exitCode).toBe(3)
  })

  it('超时整树强杀：进程不留活口', async () => {
    // 永不退出的 node 脚本（写临时文件避开 cmd 对括号/引号的吞吃）；500ms 超时 → 强杀
    writeFileSync(join(root, 'slow.js'), 'setInterval(() => {}, 1000)', 'utf8')
    await expect(executeShell('node slow.js', { cwd: root, timeoutMs: 500 })).rejects.toThrow(
      /超时/
    )
  }, 10_000)

  it('输出截断：头尾保样（≤8000+标注）', async () => {
    writeFileSync(join(root, 'big.js'), "console.log('x'.repeat(20000))", 'utf8')
    const res = await executeShell('node big.js', { cwd: root, timeoutMs: 15_000 })
    expect(res.output.length).toBeLessThan(8600)
    expect(res.output).toContain('已截断')
  })

  it('默认超时常量符合设计（60s）', () => {
    expect(SHELL_DEFAULT_TIMEOUT_MS).toBe(60_000)
  })
})

// ── 工具定义与门禁语义 ───────────────────────────────────────────────────
describe('run_shell 工具接线', () => {
  it('mutating=true 且未绑工作区直接拒绝', async () => {
    expect(shellTool.mutating).toBe(true)
    await expect(
      shellTool.execute({ command: 'git status' }, { ...ctx(''), workspace: null } as never)
    ).rejects.toThrow(/工作目录/)
  })

  it('硬拦截命令在执行层拒绝（可读错误回灌）', async () => {
    await expect(shellTool.execute({ command: 'rm -rf x' }, ctx(root))).rejects.toThrow(
      /安全策略拒绝/
    )
  })

  it('clearSessionAllowedTools 连带清空命令记忆', () => {
    // 冒烟：不抛错即通过（Map 是模块私有，行为由 permission.test 覆盖）
    expect(() => clearSessionAllowedTools()).not.toThrow()
  })
})

// ── run_shell 后台参数────────

describe('run_shell 后台任务（start/peek/stop）', () => {
  afterEach(() => {
    resetShellBgForTest()
  })

  it('background 启动立即返回 id，peek 能看到运行状态与输出', async () => {
    const id = startShellBackground(
      'node -e "console.log(\'bg-hello\'); setTimeout(()=>{}, 3000)"',
      {
        cwd: process.cwd()
      }
    )
    expect(id).toMatch(/^bg-\d{3}$/)
    // 等输出到达
    let text = ''
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 200))
      text = peekShellBg(id)
      if (text.includes('bg-hello')) break
    }
    expect(text).toContain('bg-hello')
    expect(text).toContain('运行中')
  })

  it('stop 强杀后任务标记退出，无残留进程', async () => {
    const id = startShellBackground('node -e "setInterval(()=>{}, 1000)"', { cwd: process.cwd() })
    await new Promise((r) => setTimeout(r, 500))
    const confirmText = stopShellBg(id)
    expect(confirmText).toContain('终止')
    await new Promise((r) => setTimeout(r, 800))
    const text = peekShellBg(id)
    expect(text).not.toContain('运行中')
  })

  it('peek/stop 不存在的 id → 返回提示而非抛错（含现有任务清单）', () => {
    expect(peekShellBg('bg-999')).toContain('不存在')
    expect(stopShellBg('bg-999')).toContain('不存在')
  })

  it('完成态任务 peek 可见 exit code', async () => {
    const id = startShellBackground('node -e "process.exit(0)"', { cwd: process.cwd() })
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 200))
      if (peekShellBg(id).includes('已退出')) break
    }
    expect(peekShellBg(id)).toContain('exit code: 0')
  })
})
