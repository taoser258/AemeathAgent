// Office 运行时 bundle 入口：把 docx/exceljs/pptxgenjs 打成单文件 CJS，
// 供 run_js 子进程（ELECTRON_RUN_AS_NODE）require。构建脚本 scripts/build-office-runtime.mjs。
'use strict'
const docx = require('docx')
const ExcelJS = require('exceljs')
const PptxGenJS = require('pptxgenjs')

module.exports = { docx, ExcelJS, PptxGenJS }
