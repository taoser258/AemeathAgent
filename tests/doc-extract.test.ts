// 附件文档正文抽取单测：
// 用 docx / exceljs / pptxgenjs **现场生成**真实文档，再交给抽取器读回——
// 闭环验证"发过来的文件她读得到正文"，而不是只留一个文件名让她去磁盘上找。
// 三个库都是 devDependencies（打包时只进 office-runtime.cjs，不进主进程 bundle）。

import { describe, expect, it } from 'vitest'
import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx'
import ExcelJS from 'exceljs'
import PptxGenJS from 'pptxgenjs'
import { DOC_MAX_CHARS, extractOfficeText, isExtractableDoc } from '../src/main/chat/doc-extract'

async function makeDocx(): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun('后三章公式总结')] }),
          new Paragraph({ children: [new TextRun('第一段：质能方程 E=mc² 与推导')] }),
          new Paragraph({ children: [new TextRun('第二段：含特殊字符 & 小于号 < 与引号 "q"')] }),
          new Table({
            rows: [
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('符号')] }),
                  new TableCell({ children: [new Paragraph('含义')] })
                ]
              })
            ]
          })
        ]
      }
    ]
  })
  return Buffer.from(await Packer.toBuffer(doc))
}

async function makeXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('成绩')
  ws.addRow(['姓名', '分数'])
  ws.addRow(['爱弥斯', 98])
  ws.addRow(['漂泊者', 87])
  const out = await wb.xlsx.writeBuffer()
  return Buffer.from(out as ArrayBuffer)
}

async function makePptx(): Promise<Buffer> {
  const pptx = new PptxGenJS()
  pptx.addSlide().addText('第一章 概述', { x: 1, y: 1, w: 6, h: 1 })
  pptx.addSlide().addText('第二章 公式', { x: 1, y: 1, w: 6, h: 1 })
  const out = await pptx.write({ outputType: 'nodebuffer' })
  return Buffer.from(out as Buffer)
}

describe('附件文档正文抽取（doc-extract）', () => {
  it('扩展名口径：只认 docx/xlsx/pptx（旧版二进制 doc 不认）', () => {
    expect(isExtractableDoc('总结.docx')).toBe(true)
    expect(isExtractableDoc('表.XLSX')).toBe(true)
    expect(isExtractableDoc('讲稿.pptx')).toBe(true)
    expect(isExtractableDoc('旧版.doc')).toBe(false)
    expect(isExtractableDoc('论文.pdf')).toBe(false)
    expect(isExtractableDoc('笔记.md')).toBe(false)
  })

  it('★ docx：段落成行、表格成行、实体还原（生成的文档能被自己读回来）', async () => {
    const text = extractOfficeText(await makeDocx(), '后三章公式总结.docx')
    expect(text).not.toBeNull()
    expect(text).toContain('后三章公式总结')
    expect(text).toContain('质能方程 E=mc² 与推导')
    expect(text).toContain('&') // &amp; 还原
    expect(text).toContain('<') // &lt; 还原
    expect(text).toContain('"q"')
    expect(text).toContain('符号') // 表格首行
    expect(text).toContain('含义')
  })

  it('★ xlsx：共享串表按行还原为制表符分隔的纯文本', async () => {
    const text = extractOfficeText(await makeXlsx(), '成绩.xlsx')
    expect(text).not.toBeNull()
    expect(text).toContain('姓名\t分数')
    expect(text).toContain('爱弥斯\t98')
    expect(text).toContain('漂泊者\t87')
  })

  it('★ pptx：逐页抽取，页码可辨', async () => {
    const text = extractOfficeText(await makePptx(), '讲稿.pptx')
    expect(text).not.toBeNull()
    expect(text).toContain('【第 1 页】')
    expect(text).toContain('第一章 概述')
    expect(text).toContain('【第 2 页】')
    expect(text).toContain('第二章 公式')
  })

  it('非 zip / 空缓冲 / 非文档扩展名 → null（调用方退化为仅文件名占位）', async () => {
    expect(extractOfficeText(Buffer.alloc(0), 'a.docx')).toBeNull()
    expect(extractOfficeText(Buffer.from('这不是一个 zip 文件'), 'a.docx')).toBeNull()
    expect(extractOfficeText(await makeDocx(), 'a.txt')).toBeNull()
    expect(extractOfficeText(await makeDocx(), '伪装的.docx.bak')).toBeNull()
  })

  it('超长正文截断并标注（不挤爆上下文）', async () => {
    const long = new Document({
      sections: [
        {
          children: Array.from(
            { length: 400 },
            (_, i) => new Paragraph({ children: [new TextRun(`第 ${i} 段：${'长'.repeat(200)}`)] })
          )
        }
      ]
    })
    const text = extractOfficeText(Buffer.from(await Packer.toBuffer(long)), '长文.docx')
    expect(text).not.toBeNull()
    expect((text as string).length).toBeLessThan(DOC_MAX_CHARS + 200)
    expect(text).toContain('已截断')
  })
})
