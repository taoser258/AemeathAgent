// 本机 OCR 单测（P8-T3 第二条腿）：
// 探针注入式（与 active_window 同款）——识别结果靠注入假探针，纯逻辑真跑。
// 重点守护三件事：① 汉字之间的空格要去掉（Windows OCR 实测会塞空格）；
// ② 左右并排的行要报出来（双栏被拍平会让模型读错意思）；③ 脏数据/失败不炸链路。

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  findSideBySidePairs,
  formatOcrResult,
  isOcrReady,
  normalizeOcrSpacing,
  parseOcrPayload,
  runOcr,
  setOcrProbe,
  type OcrPayload
} from '../src/main/agent/tools/ocr'
import { executeToolCall, setToolPathBase } from '../src/main/agent/tools/registry'

const payload = (lines: OcrPayload['lines'], size = { width: 700, height: 260 }): OcrPayload => ({
  lang: 'zh-Hans-CN',
  width: size.width,
  height: size.height,
  lines
})

describe('本机 OCR · 汉字空格归一（normalizeOcrSpacing）', () => {
  it('汉字之间的空格去掉（Windows OCR 实测行为）', () => {
    expect(normalizeOcrSpacing('月 营 收 12348 元')).toBe('月营收 12348 元')
    expect(normalizeOcrSpacing('错 误 代 码 9 不 是 4')).toBe('错误代码 9 不是 4')
  })

  it('CJK 标点两侧的空格去掉（：．之类）', () => {
    expect(normalizeOcrSpacing('总计 ： 8471 ． 61')).toBe('总计：8471．61')
  })

  it('中英/中数之间的空格保留（更好读，也不动原意）', () => {
    expect(normalizeOcrSpacing('hello world 你好 世界')).toBe('hello world 你好世界')
    expect(normalizeOcrSpacing('版本 v0.3.1 发布')).toBe('版本 v0.3.1 发布')
  })
})

describe('本机 OCR · 版面（findSideBySidePairs / formatOcrResult）', () => {
  it('左右并排的两行要报出来（y 重叠、x 不相交）', () => {
    const two = payload([
      { text: '左栏第一行', x: 20, y: 40, w: 200, h: 30 },
      { text: '右栏第一行', x: 420, y: 42, w: 200, h: 30 },
      { text: '左栏第二行', x: 20, y: 90, w: 200, h: 30 }
    ])
    expect(findSideBySidePairs(two)).toEqual([[1, 2]])
    const text = formatOcrResult(two)
    expect(text).toContain('左右并排')
    expect(text).toContain('第 1 与 2 行')
  })

  it('正常单栏不报版面（不制造噪声）', () => {
    const one = payload([
      { text: '第一行', x: 20, y: 40, w: 200, h: 30 },
      { text: '第二行', x: 20, y: 90, w: 200, h: 30 }
    ])
    expect(findSideBySidePairs(one)).toEqual([])
    expect(formatOcrResult(one)).not.toContain('左右并排')
  })

  it('逐行编号 + 尺寸 + 语言 + 两条引用纪律都在结果里', () => {
    const text = formatOcrResult(
      payload([
        { text: '月 营 收 12348 元', x: 27, y: 39, w: 279, h: 36 },
        { text: '错误代码 9', x: 27, y: 110, w: 297, h: 35 }
      ])
    )
    expect(text).toContain('zh-Hans-CN')
    expect(text).toContain('700×260')
    expect(text).toContain('1. 月营收 12348 元')
    expect(text).toContain('2. 错误代码 9')
    expect(text).toContain('核对')
    expect(text).toContain('describe_image')
  })

  it('一个字都没识别出来 → 说明白（而不是返回空串）', () => {
    const text = formatOcrResult(payload([]))
    expect(text).toContain('没有识别出任何文字')
  })
})

describe('本机 OCR · 探针输出防御（parseOcrPayload）', () => {
  it('正常 JSON 解析出 lang/尺寸/行', () => {
    const p = parseOcrPayload(
      '{"lang":"zh-Hans-CN","width":700,"height":260,"lines":[{"text":"甲","x":1,"y":2,"w":3,"h":4}]}'
    )
    expect(p?.lang).toBe('zh-Hans-CN')
    expect(p?.lines[0]).toEqual({ text: '甲', x: 1, y: 2, w: 3, h: 4 })
  })

  it('坏 JSON / 缺 lines / 脏字段一律收敛（不抛）', () => {
    expect(parseOcrPayload('不是 JSON')).toBeNull()
    expect(parseOcrPayload('{"lang":"en"}')).toBeNull()
    expect(parseOcrPayload('[]')).toBeNull()
    const p = parseOcrPayload('{"lines":[{"text":"甲","x":"坏了"},42,{"nope":1}]}')
    expect(p?.lang).toBe('未知')
    expect(p?.lines).toHaveLength(1)
    expect(p?.lines[0].x).toBe(0) // 脏数字回退 0，不让版面判断崩
  })
})

describe('本机 OCR · 探针注入与工具端到端', () => {
  let tmp = ''

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aemeath-ocr-'))
    setToolPathBase(tmp)
    writeFileSync(join(tmp, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(join(tmp, 'note.txt'), 'hi')
  })

  afterEach(() => {
    setOcrProbe(null)
    rmSync(tmp, { recursive: true, force: true })
  })

  it('未注入探针 → 明说未就绪（不静默失败）', async () => {
    expect(isOcrReady()).toBe(false)
    await expect(runOcr(join(tmp, 'shot.png'))).rejects.toThrow('尚未就绪')
  })

  it('注入假探针 → ocr_image 返回分行文字（探针收到的是绝对路径）', async () => {
    const seen: string[] = []
    setOcrProbe(async (absPath) => {
      seen.push(absPath)
      return payload([
        { text: '月 营 收 12348 元', x: 27, y: 39, w: 279, h: 36 },
        { text: '错 误 代 码 9', x: 27, y: 110, w: 297, h: 35 }
      ])
    })
    expect(isOcrReady()).toBe(true)
    const r = await executeToolCall(
      'ocr_image',
      JSON.stringify({ path: join(tmp, 'shot.png') }),
      new AbortController().signal,
      's1'
    )
    expect(r.ok).toBe(true)
    expect(r.result).toContain('1. 月营收 12348 元')
    expect(r.result).toContain('2. 错误代码 9')
    expect(seen[0]).toBe(join(tmp, 'shot.png'))
  })

  it('探针抛错（没装语言包等）→ 收敛为可读失败，不抛异常', async () => {
    setOcrProbe(async () => {
      throw new Error('本机没有可用的 OCR 语言包——请在 Windows 设置里添加「光学字符识别」。')
    })
    const r = await executeToolCall(
      'ocr_image',
      JSON.stringify({ path: join(tmp, 'shot.png') }),
      new AbortController().signal
    )
    expect(r.ok).toBe(false)
    expect(r.result).toContain('OCR 语言包')
  })

  it('非图片路径 → 明确报错并指路（PDF 走 read_file）', async () => {
    setOcrProbe(async () => payload([]))
    const r = await executeToolCall(
      'ocr_image',
      JSON.stringify({ path: join(tmp, 'note.txt') }),
      new AbortController().signal
    )
    expect(r.ok).toBe(false)
    expect(r.result).toContain('read_file')
  })
})
