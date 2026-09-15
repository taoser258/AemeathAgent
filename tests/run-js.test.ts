// run_js / export_pdf 单测（Office 文档能力）。
// run-js.ts 无 electron 依赖：注入 execPath=process.execPath（测试环境即 Node，
// ELECTRON_RUN_AS_NODE 对其无害）+ runtimePath=已构建的 office-runtime.cjs → 真跑。
// export_pdf 的打印器注入假实现（print-pdf.ts 本体依赖 electron，走 dev/CDP 实测覆盖）。

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executeJs, setJsRuntime } from '../src/main/agent/tools/run-js'
import {
  approvalTargetPath,
  executeToolCall,
  setPdfPrinter
} from '../src/main/agent/tools/registry'
import { decideToolApproval } from '../src/main/chat/approval-policy'
import { setLedgerBase } from '../src/main/agent/tools/ledger'
import {
  parseRunJsMarker,
  producedFilesFromCall,
  RUN_JS_MARKER,
  stripRunJsMarker
} from '../src/shared/produced-file'

const bundle = join(__dirname, '..', 'resources', 'office', 'office-runtime.cjs')
const hasBundle = existsSync(bundle)
const t = hasBundle ? it : it.skip // bundle 未构建（新克隆未跑 build:office）时真跑用例跳过

let ws = ''
const sig = (): AbortSignal => new AbortController().signal

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), 'aemeath-runjs-'))
  setLedgerBase(join(ws, '.ledger'))
  setJsRuntime({ runtimePath: bundle, execPath: process.execPath })
})

afterAll(() => {
  rmSync(ws, { recursive: true, force: true })
})

describe('executeJs（子进程真跑）', () => {
  t(
    'console.log 输出回灌、exit 0',
    async () => {
      const r = await executeJs(`console.log('hi from js')`, { cwd: ws, timeoutMs: 30_000 })
      expect(r.exitCode).toBe(0)
      expect(r.output).toContain('hi from js')
    },
    60_000
  )

  t(
    '三库全局注入可用：真生成 docx 落工作区',
    async () => {
      const code = `
      const { Document, Packer, Paragraph } = docx
      const doc = new Document({ sections: [{ children: [new Paragraph('中文内容测试')] }] })
      const buf = await Packer.toBuffer(doc)
      require('fs').writeFileSync('t1.docx', buf)
      console.log('bytes', buf.length)
    `
      const r = await executeJs(code, { cwd: ws, timeoutMs: 60_000 })
      expect(r.exitCode).toBe(0)
      expect(r.output).toContain('bytes')
      const f = join(ws, 't1.docx')
      expect(existsSync(f)).toBe(true)
      expect(statSync(f).size).toBeGreaterThan(3000)
      // ★ 快照 diff：本次新建的 t1.docx 必须进产出清单
      expect(r.files).toContain('t1.docx')
    },
    90_000
  )

  t(
    'exceljs / pptxgenjs 同验：xlsx 与 pptx 落盘',
    async () => {
      const code = `
      const wb = new ExcelJS.Workbook(); const s = wb.addWorksheet('a')
      s.addRow(['名', 1]); await wb.xlsx.writeFile('t2.xlsx')
      const p = new PptxGenJS(); const slide = p.addSlide()
      slide.addText('测试', { x: 1, y: 1 })
      await p.writeFile({ fileName: 't2.pptx' })
      console.log('ok')
    `
      const r = await executeJs(code, { cwd: ws, timeoutMs: 60_000 })
      expect(r.exitCode).toBe(0)
      expect(readdirSync(ws)).toEqual(expect.arrayContaining(['t2.xlsx', 't2.pptx']))
    },
    90_000
  )

  t(
    '代码抛错：exit 1 + RUN_JS_ERROR 前缀回灌（模型可自纠）',
    async () => {
      const r = await executeJs(`throw new Error('故意炸')`, { cwd: ws, timeoutMs: 30_000 })
      expect(r.exitCode).toBe(1)
      expect(r.output).toContain('RUN_JS_ERROR')
      expect(r.output).toContain('故意炸')
    },
    60_000
  )

  t(
    '超时整树强杀 → reject',
    async () => {
      await expect(
        executeJs(`await new Promise(r => setTimeout(r, 30_000))`, { cwd: ws, timeoutMs: 1_000 })
      ).rejects.toThrow(/超时/)
    },
    30_000
  )
})

describe('run_js 审批口径与门槛（任意代码执行面 fail-closed）', () => {
  it('approvalTargetPath 无 path 参数 → null（解析不出目标）', () => {
    expect(approvalTargetPath('run_js', '{"code":"x"}', ws)).toBeNull()
  })

  it('mutating + 解析不出路径 → confirm 必弹卡（不伪装"工作区内免问"）', () => {
    const need = decideToolApproval({
      toolName: 'run_js',
      mutating: true,
      targetPath: null,
      workspace: ws
    })
    expect(need.required).toBe(true)
  })

  it('未绑定工作区 → 执行层拒绝（spawn 之前，不依赖 bundle）', async () => {
    const r = await executeToolCall('run_js', '{"code":"1"}', sig(), 's', { workspace: null })
    expect(r.ok).toBe(false)
    expect(r.result).toContain('工作目录')
  })
})

describe('export_pdf（假打印器验接线）', () => {
  it('注入假打印器后：收绝对路径、写快照、回灌文件大小', async () => {
    let seenOut = ''
    setPdfPrinter(async (input) => {
      seenOut = input.outPath
      writeFileSync(input.outPath, '%PDF-1.4 fake')
      return { bytes: 12 }
    })
    const r = await executeToolCall(
      'export_pdf',
      JSON.stringify({ html: '<h1>标题</h1>', path: 'out.pdf' }),
      sig(),
      'test-pdf',
      { workspace: ws }
    )
    expect(r.ok).toBe(true)
    expect(seenOut).toBe(join(ws, 'out.pdf'))
    expect(existsSync(join(ws, 'out.pdf'))).toBe(true)
    expect(r.result).toContain('PDF')
  })

  it('path 不以 .pdf 结尾 → 拒绝', async () => {
    setPdfPrinter(async () => ({ bytes: 0 }))
    const r = await executeToolCall(
      'export_pdf',
      JSON.stringify({ html: '<p>x</p>', path: 'out.txt' }),
      sig(),
      't',
      { workspace: ws }
    )
    expect(r.ok).toBe(false)
    expect(r.result).toContain('.pdf')
  })

  it('html 与 html_path 双缺 → 拒绝', async () => {
    const r = await executeToolCall('export_pdf', JSON.stringify({ path: 'a.pdf' }), sig(), 't', {
      workspace: ws
    })
    expect(r.ok).toBe(false)
    expect(r.result).toContain('html')
  })

  it('html_path 指向不存在的文件 → 拒绝（提示先 write_file）', async () => {
    const r = await executeToolCall(
      'export_pdf',
      JSON.stringify({ html_path: 'nope.html', path: 'a.pdf' }),
      sig(),
      't',
      { workspace: ws }
    )
    expect(r.ok).toBe(false)
    expect(r.result).toContain('write_file')
  })
})

// ── 产出文件卡片链路────────
describe('产出文件卡片：标记行解析与历史还原', () => {
  it('parseRunJsMarker：开头整行匹配、/ 归一化、越界与绝对路径过滤', () => {
    const bs = String.fromCharCode(92) // 反斜杠：JSON 里需双写转义，避开转义地狱
    const text =
      RUN_JS_MARKER +
      `["a/b.docx","c${bs}${bs}d.xlsx","..${bs}${bs}evil.pdf","E:${bs}${bs}${bs}${bs}abs.pdf"]` +
      '\nexit code: 0'
    expect(parseRunJsMarker(text)).toEqual(['a/b.docx', 'c/d.xlsx'])
  })

  it('parseRunJsMarker：无标记/JSON 坏 → 空数组', () => {
    expect(parseRunJsMarker('exit code: 0\n正常输出')).toEqual([])
    expect(parseRunJsMarker(`${RUN_JS_MARKER}not-json`)).toEqual([])
  })

  it('stripRunJsMarker：整行移除，正文保留', () => {
    const text = `${RUN_JS_MARKER}["a.docx"]\nexit code: 0\n生成/修改的文件：a.docx`
    const stripped = stripRunJsMarker(text)
    expect(stripped).not.toContain(RUN_JS_MARKER)
    expect(stripped).toContain('exit code: 0')
  })

  it('producedFilesFromCall：run_js 走标记（含多文件），export_pdf 走 path 参数', () => {
    const runjs = producedFilesFromCall(
      'run_js',
      JSON.stringify({ code: 'x' }),
      `${RUN_JS_MARKER}["报告.docx","表.xlsx"]\nexit code: 0`,
      null
    )
    expect(runjs.map((f) => f.rel)).toEqual(['报告.docx', '表.xlsx'])
    expect(runjs[0].action).toBe('已生成')
    const pdf = producedFilesFromCall('export_pdf', JSON.stringify({ path: 'r.pdf' }), 'ok', null)
    expect(pdf).toHaveLength(1)
    expect(pdf[0]).toEqual({ rel: 'r.pdf', name: 'r.pdf', action: '已导出' })
  })

  t(
    'executeToolCall run_js：out 槽收清单 + 结果以标记行开头（截断安全）',
    async () => {
      const out: { files?: string[] } = {}
      const r = await executeToolCall(
        'run_js',
        JSON.stringify({
          code: `require('fs').writeFileSync('card.docx', Buffer.from('PK\\x03\\x04fake'))`
        }),
        sig(),
        's',
        { workspace: ws, out }
      )
      expect(r.ok).toBe(true)
      expect(out.files).toContain('card.docx')
      expect(r.result.startsWith(RUN_JS_MARKER)).toBe(true)
    },
    90_000
  )
})
