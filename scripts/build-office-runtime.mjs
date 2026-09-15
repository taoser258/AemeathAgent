// Office 运行时 bundle 构建：esbuild 把 docx/exceljs/pptxgenjs 打成单文件 CJS。
// 产物 resources/office/office-runtime.cjs 走 extraResources 进包（不进 asar，
// 免 asarUnpack 81 个传递依赖）；run_js 子进程 ELECTRON_RUN_AS_NODE 直接 require。
// 用法：node scripts/build-office-runtime.mjs（已挂进 npm run build 前置）
import { build } from 'esbuild'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [join(root, 'resources/office/runtime-entry.cjs')],
  outfile: join(root, 'resources/office/office-runtime.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  minify: true,
  // exceljs/pptxgenjs 里的可选动态依赖：保持 external，缺失时它们自带降级
  external: ['canvas', 'sharp'],
  define: { 'process.env.DOCX_TMP_DIR': 'undefined' },
  logLevel: 'info'
})
console.log('office-runtime.cjs 构建完成')
