// run_js v1：在受控子进程里执行模型写的 JavaScript，用于生成 Word/Excel/PPT 等
// 办公文档（内置 docx/exceljs/pptxgenjs 三库，esbuild 预打包成 office-runtime.cjs）。
//
// 安全模型（对齐 run_shell 的思路，但机制不同）：
// - 子进程 = 应用自己的 Electron（process.execPath + ELECTRON_RUN_AS_NODE=1，
// 同 mcp/builtin.ts 的内置 Playwright 模式）——用户零安装即可用，不依赖系统 Node/Python。
// - 无 shell：代码经临时 .cjs 文件直传，不经过 cmd.exe，没有命令注入面。
// - cwd 锁定工作区（registry 侧校验）；超时整树强杀（复用 MCP 终结器）。
// - **它是 arbitrary code execution**：mutating=true 且无 path 参数 → confirm 模式下
// 每次必弹审批卡（fail-closed），用户在卡上看代码原文再放行；"本会话允许"记工具名。
// 这是刻意的：等价于 成熟实现的 danger 面，不伪装成"工作区内就安全"。
//
// 本模块保持无 electron 依赖（runtimePath/execPath 注入式），vitest 可直接单测。

import { spawn } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import type { Dirent } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import { killProcessTree } from '../../mcp/process-tree'
import { clipOutput } from './run-shell'

/** 默认/最大执行超时（毫秒）：文档生成通常秒级，留足重循环余量 */
export const JS_DEFAULT_TIMEOUT_MS = 60_000
export const JS_MAX_TIMEOUT_MS = 180_000

export interface JsExecResult {
  output: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  /** 本次执行新建/修改的工作区文件（相对路径、/ 分隔）：聊天文件卡数据源。
   * 仅 exitCode===0 时计算；快照有上限（FILE_SCAN_MAX），超大目录截断不误报。 */
  files: string[]
}

/** office-runtime.cjs 与 Electron 可执行文件路径（main ready 注入；测试注入假值） */
let officeRuntimePath = ''
let nodeExecPath = ''

export function setJsRuntime(paths: { runtimePath: string; execPath: string }): void {
  officeRuntimePath = paths.runtimePath
  nodeExecPath = paths.execPath
}

export function getJsRuntimePaths(): { runtimePath: string; execPath: string } {
  return { runtimePath: officeRuntimePath, execPath: nodeExecPath }
}

// ── 工作区文件快照 diff（run_js 产出文件识别）──────────────────────────────
// 模型代码写哪些文件不可预知（没有 path 参数），执行前后各扫一次工作区，
// mtime+size 变化 = 本次新建/修改。跳过重目录并设文件数上限——超大工作区
// 直接放弃 diff（返回 null → 不产卡），宁可漏报不可误报。

const SKIP_DIRS = new Set(['node_modules', '.git', '.workbuddy', 'dist', 'out', 'build'])
const FILE_SCAN_MAX = 20_000

function snapshotWorkspace(root: string): Map<string, string> | null {
  const out = new Map<string, string>()
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('release-')) continue
        stack.push(p)
      } else {
        try {
          const st = existsSync(p) ? statSync(p) : null
          if (st !== null)
            out.set(relative(root, p).replace(/\\/g, '/'), `${st.mtimeMs}|${st.size}`)
        } catch {
          continue
        }
        if (out.size > FILE_SCAN_MAX) return null
      }
    }
  }
  return out
}

/** 前后快照 → 新增/修改的相对路径清单（删除不算产出；任一快照失效 → 空） */
export function diffWorkspaceFiles(
  before: Map<string, string> | null,
  after: Map<string, string> | null
): string[] {
  if (before === null || after === null) return []
  const changed: string[] = []
  after.forEach((sig, rel) => {
    if (before.get(rel) !== sig) changed.push(rel)
  })
  return changed.sort()
}

/**
 * 执行一段 JS：包进 async IIFE 并注入三库全局（docx / ExcelJS / PptxGenJS），
 * 模型代码可顶层 await。临时文件放系统 tmp（不进工作区、不污染项目），跑完即删。
 */
export function executeJs(
  code: string,
  opts: { cwd: string; timeoutMs: number }
): Promise<JsExecResult> {
  if (officeRuntimePath === '' || nodeExecPath === '') {
    return Promise.reject(
      new Error('run_js 运行时未就绪（office-runtime.cjs 缺失或应用未初始化完成）')
    )
  }
  const timeoutMs = Math.min(Math.max(opts.timeoutMs, 1_000), JS_MAX_TIMEOUT_MS)
  // ★ 每行都以分号收尾 + IIFE 前置防御性分号：模型代码常不带结尾分号，若以 ( 或 [ 开头，
  // ASI 会把上一行与它合并成调用表达式（实测踩过：解构行 + IIFE 合并 → "m is not a function"）
  const wrapped =
    `const __office = require(${JSON.stringify(officeRuntimePath)});\n` +
    `const { docx, ExcelJS, PptxGenJS } = __office;\n` +
    `;(async () => {\n${code}\n})().catch((e) => {\n` +
    `  console.error('RUN_JS_ERROR: ' + (e && e.stack ? e.stack : String(e)));\n` +
    `  process.exitCode = 1;\n})\n`

  let dir = ''
  try {
    dir = mkdtempSync(join(tmpdir(), 'aemeath-runjs-'))
    const file = join(dir, 'main.cjs')
    writeFileSync(file, wrapped, 'utf8')
    // 执行前快照工作区（跑完 diff 出本次产出的文件 → 聊天文件卡）
    const before = snapshotWorkspace(opts.cwd)
    return runChild(file, opts, timeoutMs)
      .then((res) =>
        res.exitCode === 0
          ? { ...res, files: diffWorkspaceFiles(before, snapshotWorkspace(opts.cwd)) }
          : res
      )
      .finally(() => {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          /* 临时目录清理失败无碍（系统 tmp 自管） */
        }
      })
  } catch (err) {
    if (dir !== '') {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 同上 */
      }
    }
    return Promise.reject(err instanceof Error ? err : new Error(String(err)))
  }
}

function runChild(
  file: string,
  opts: { cwd: string; timeoutMs: number },
  timeoutMs: number
): Promise<JsExecResult> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const child = spawn(nodeExecPath, [file], {
      cwd: opts.cwd,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
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
      if (timedOut) {
        reject(new Error(`JS 执行超时（${Math.round(timeoutMs / 1000)} 秒）已被强制终止`))
        return
      }
      if (err !== undefined) {
        reject(new Error(`JS 进程启动失败：${err.message}`))
        return
      }
      resolve({
        output: clipOutput(out),
        exitCode: code,
        timedOut,
        durationMs: Date.now() - t0,
        files: []
      })
    }
    const onChunk = (d: Buffer): void => {
      if (out.length < 16_000) out += d.toString('utf8')
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)
    child.on('error', (err) => finish(null, err))
    child.on('close', (code) => finish(code))
  })
}
