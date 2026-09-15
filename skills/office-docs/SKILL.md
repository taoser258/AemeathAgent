---
name: office-docs
modes: work, learn
description: 生成真正的办公文档文件——Word(.docx)、Excel(.xlsx)、PPT(.pptx)、PDF。当用户要「导出/生成 Word 报告或合同」「做一个 Excel 表格/带公式的表」「做 PPT/幻灯片」「把内容转成 PDF」，或要交付能被 Office/WPS 打开的成品文件时用。内置 run_js（Node 库 docx/exceljs/pptxgenjs）+ export_pdf（Chromium 排版，中文强）。纯改文字/只需 Markdown 时用 note_export，不用本技能。
---

# 办公文档生成（Word / Excel / PPT / PDF）

你有两条造文件的路：**run_js**（跑 JS 用内置库生成 .docx/.xlsx/.pptx）和 **export_pdf**（HTML→PDF）。成品写到工作区，告诉用户路径。

## 选路

| 要什么 | 走哪 |
|---|---|
| Word 文档（段落/表格/样式） | run_js + `docx` |
| Excel（公式/多表/格式） | run_js + `ExcelJS` |
| PPT 幻灯片 | run_js + `PptxGenJS` |
| PDF（报告/讲义，含图表排版） | 先 write_file 写 HTML → export_pdf；或短内容直接传 html |
| 只要纯文本笔记 | note_export（Markdown），别用这里 |

## run_js 用法

代码里 `docx`、`ExcelJS`、`PptxGenJS` 已是全局，直接用，可顶层 await。cwd 是工作区，相对路径写文件就落工作区。console.log 会回给你。**每步真跑**——写完文件用 `require('fs').statSync('x.docx').size` 确认非空再汇报。

### Word（docx）
```js
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType } = docx
const doc = new Document({ sections: [{ children: [
  new Paragraph({ text: '标题', heading: HeadingLevel.HEADING_1 }),
  new Paragraph({ children: [ new TextRun({ text: '加粗', bold: true }), new TextRun('常规') ] }),
  new Table({ width:{size:100,type:WidthType.PERCENTAGE}, rows: [
    new TableRow({ children: [ new TableCell({ children:[new Paragraph('表头')] }) ] })
  ]})
]}]})
require('fs').writeFileSync('报告.docx', await Packer.toBuffer(doc))
```
要点：中文字体一般无需设（Office 端渲染）；列表用 Paragraph+项目符号属性；分页 `new Paragraph({ pageBreakBefore:true })`。

### Excel（exceljs）
```js
const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Sheet1')
ws.columns = [{header:'姓名',key:'n',width:12},{header:'分数',key:'s'}]
ws.addRow({ n:'张三', s:90 }); ws.addRow(['李四', 85])
ws.getCell('C1').value = { formula:'=SUM(B2:B3)', result:175 }  // 公式带缓存值
ws.getRow(1).font = { bold: true }; ws.getRow(1).fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FFF2CC'} }
await wb.xlsx.writeFile('表.xlsx')
```
要点：公式要同时给 result（打开前预览值）；数字右对齐用 `alignment`；冻结首行 `ws.views=[{state:'frozen',ySplit:1}]`。

### PPT（pptxgenjs）
```js
const p = new PptxGenJS(); p.defineLayout({name:'W',width:13.33,height:7.5}); p.layout='W'
const s = p.addSlide()
s.addText('标题', { x:0.5, y:0.4, w:12, h:1, fontSize:36, bold:true, color:'E7548F' })
s.addText('要点一\n要点二', { x:0.5, y:1.8, w:6, h:3, fontSize:18, valign:'top' })
s.addChart(p.ChartType.bar, [{name:'销量',labels:['一','二','三'],values:[10,20,15]}], { x:7, y:1.8, w:5.5, h:4 })
await p.writeFile({ fileName: '演示.pptx' })
```
要点：坐标单位英寸；`addTable` 传二维数组；图表类型 bar/line/pie/donut；一页别塞太满。

## export_pdf 用法

中文/表格/图表排版首选——Chromium 引擎，不会缺字。两种：
- 短文档：直接传 `html` 字符串；
- 长文档（推荐）：先 `write_file` 写好 `.html`（可含 CSS、genui 式 SVG 图表），再 `export_pdf({ html_path, path:'成品.pdf' })`——用户还能先看 HTML 预览。

HTML 排版铁律：`@page { size: A4; margin: 1.6cm }`；分页 `.page { page-break-after: always }`；宽度按 A4（约 18cm 内容区）设计；背景色要 `-webkit-print-color-adjust: exact` 才印得出来。**配色必须自带**：`<head>` 里声明 `:root { color-scheme: light; background: #fff }`（或你的纸面底色）——只写深色文字不写背景，用户在深色模式下预览就是深字压深底，根本看不清。

## 通用纪律

1. **先想清成品结构再生成**：几页/几表/什么章节，别跑三次改三次。
2. **数据来自真实来源**（用户给的、工具查的），不编数字。
3. **写完必验证**：statSync 看字节数>0；拿不准就 unzip 查 .docx/.pptx 是否合法 zip（它们是 zip 包）。
4. **汇报路径**：说清文件在工作区哪里、多大、含什么。
5. 复杂排版（精确到像素的公文）若 run_js 反复调不好，退一步用 export_pdf（HTML 可控性更强）。
