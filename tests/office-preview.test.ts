/**
 * Office 文本级预览单测：用 Python zipfile 生成的真实 deflate ZIP fixture，
 * 同时覆盖 readZip 的 inflate 路径与三种格式的块提取。
 */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { describe, expect, it } from 'vitest'
import { parseOffice, readZip } from '../src/main/workspace/office-preview'

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'office')
const load = (name: string): Buffer => readFileSync(join(FIX, name))

describe('readZip', () => {
  it('能解出 OOXML 内部条目并解压', () => {
    const zip = readZip(load('sample.docx'))
    expect(zip.has('word/document.xml')).toBe(true)
    expect(zip.get('word/document.xml')!.data.toString('utf8')).toContain('项目周报')
  })
  it('非 ZIP 抛错', () => {
    expect(() => readZip(Buffer.from('这不是 zip 内容'))).toThrow(/ZIP|EOCD/)
  })
})

describe('parseOffice · docx', () => {
  const p = parseOffice(load('sample.docx'), '.docx')
  it('识别格式且未截断', () => {
    expect(p.format).toBe('docx')
    expect(p.truncated).toBe(false)
  })
  it('Heading1 段落 → heading 块', () => {
    const h = p.blocks.find((b) => b.type === 'heading')
    expect(h).toEqual({ type: 'heading', level: 1, text: '项目周报' })
  })
  it('多个 w:t 拼接 + 实体解码（&amp; → &）', () => {
    const para = p.blocks.find((b) => b.type === 'para' && b.text.includes('预览功能'))
    expect(para).toBeDefined()
    expect((para as { text: string }).text).toBe('本周完成 预览功能，进展 & 顺利。')
  })
  it('表格 → 2 行 2 列', () => {
    const tbl = p.blocks.find((b) => b.type === 'table')
    expect(tbl).toBeDefined()
    const rows = (tbl as { rows: string[][] }).rows
    expect(rows).toEqual([
      ['指标', '数值'],
      ['用例', '481']
    ])
  })
})

describe('parseOffice · xlsx', () => {
  const p = parseOffice(load('sample.xlsx'), '.xlsx')
  it('两个工作表名按 workbook.xml 声明', () => {
    const sheets = p.blocks
      .filter((b) => b.type === 'sheet')
      .map((b) => (b as { name: string }).name)
    expect(sheets).toEqual(['销售', '库存'])
  })
  it('sharedStrings 索引 + 数字 + inlineStr 混排', () => {
    const tables = p.blocks.filter((b) => b.type === 'table') as Array<{ rows: string[][] }>
    const allRows = tables.flatMap((t) => t.rows)
    expect(allRows).toContainEqual(['季度', '金额']) // sharedStrings
    expect(allRows).toContainEqual(['Q1', '1200']) // 数字 v
  })
  it('稀疏列补空对齐（A3 + C3，中间 B3 空）', () => {
    const tables = p.blocks.filter((b) => b.type === 'table') as Array<{ rows: string[][] }>
    const sparse = tables.flatMap((t) => t.rows).find((r) => r.includes('跳过B列'))
    expect(sparse).toEqual(['Q2', '', '跳过B列'])
  })
})

describe('parseOffice · pptx', () => {
  const p = parseOffice(load('sample.pptx'), '.pptx')
  it('两张幻灯片分隔块', () => {
    const slides = p.blocks.filter((b) => b.type === 'slide') as Array<{ index: number }>
    expect(slides.map((s) => s.index)).toEqual([1, 2])
  })
  it('文本框段落提取', () => {
    const paras = p.blocks.filter((b) => b.type === 'para').map((b) => (b as { text: string }).text)
    expect(paras).toContain('开场标题')
    expect(paras).toContain('副标题一行')
  })
  it('表格提取', () => {
    const tbl = p.blocks.find((b) => b.type === 'table') as { rows: string[][] } | undefined
    expect(tbl?.rows).toEqual([['列A', '列B']])
  })
})

describe('parseOffice · 异常兜底', () => {
  it('OLE2（加密/旧格式）抛人话错误', () => {
    const buf = Buffer.alloc(64)
    buf.writeUInt32LE(0xe011cfd2, 0)
    expect(() => parseOffice(buf, '.docx')).toThrow(/加密|旧格式/)
  })
  it('docx 缺 document.xml 抛错', () => {
    // 借用一个合法但非 docx 的 zip（pptx）→ 找不到 word/document.xml
    expect(() => parseOffice(load('sample.pptx'), '.docx')).toThrow(/document.xml|损坏/)
  })
})
