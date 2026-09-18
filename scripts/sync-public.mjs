// 发布库源码同步：把私档库（本目录）当前 main 的整棵树搬到公开发布库。
//
// 为什么要有这个脚本（真实教训，2026-09-17）：v0.3.2-alpha 发布时才发现发布库
// 落后了 32 个**已发布版本**的文件（citation-guard.ts / compact.ts / pdf-extract.ts
// / vision.ts / tray.ts / trash.ts / ocr.ts / calculate.ts 等，即 P7/P8 的工具与
// 模块）——「导出 → 推发布库」这一步靠人记，漏了没人会知道，于是 tag 指向了
// 一份对不上安装包的源码。人工流程必须变成一条能自证的命令：
//   · 用 `git checkout <私库树>` 搬运而不是 tar 导出（tar 会把中文文件名
//     `启动Aemeath.bat` 变成乱码 `鍚姩Aemeath.bat`）；
//   · 搬完**逐个断言文件清单**与私库一致（除保留名单），不一致就中止不提交
//     —— 宁可同步失败，也不要再推一份「看着成功、其实缺文件」的源码。
//
// 用法：
//   node scripts/sync-public.mjs                # 同步并推送（无差异则空跑退出）
//   node scripts/sync-public.mjs --dry-run      # 只做同步与断言，不 commit / push
//   node scripts/sync-public.mjs -m "提交信息"
// 环境变量：
//   AEMEATH_PUBLIC_DIR  发布库本地镜像目录（默认与本仓库同级：../.aemeath-public）
//   AEMEATH_GIT_PROXY   git 出站代理（默认 http://127.0.0.1:7890；为空串则直连）
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, resolve, sep } from 'path'

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))
const PUBLIC_REPO = 'https://github.com/taoser258/AemeathAgent.git'
/** 发布库永不包含的文件（AGENTS.md 是代理交接文档；docs/ 与 DEVLOG.md 本就不入 git） */
const EXCLUDE = ['AGENTS.md']

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const msgIdx = argv.findIndex((a) => a === '-m' || a === '--message')
const customMessage = msgIdx >= 0 ? argv[msgIdx + 1] : undefined

// 本机实测（AGENTS.md 排障速查）：git 到 github.com 直连会 TLS unexpected-eof，
// 必须走代理；`gh` 恰好相反（务必直连）。这里只管 git，默认挂上代理。
const proxy = process.env.AEMEATH_GIT_PROXY ?? 'http://127.0.0.1:7890'
const mirror = resolve(process.env.AEMEATH_PUBLIC_DIR ?? join(root, '..', '.aemeath-public'))

/** 报错并中止（退出码 1） */
function fail(message) {
  console.error(`\n[同步中止] ${message}`)
  process.exit(1)
}

/** 跑一条 git 命令；net=true 时临时挂代理（只有 clone/fetch/push 需要） */
function git(cwd, args, { net = false } = {}) {
  const full = net && proxy !== '' ? ['-c', `http.proxy=${proxy}`, ...args] : args
  try {
    return execFileSync('git', full, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch (err) {
    const stderr = err.stderr?.toString().trim()
    fail(`git ${args.join(' ')} 失败${stderr ? `：\n${stderr}` : ''}`)
  }
}

/** 列出某仓库索引里的文件（相对路径） */
function lsFiles(dir) {
  return git(dir, ['ls-files']).split('\n').filter(Boolean)
}

// 护栏：镜像目录绝不能在私库工作区里面——否则脚本的 checkout/clean 会误伤
// 正在开发的源码，而且发布库产物会被 eslint/单测扫到。
if (mirror === root || mirror.startsWith(root + sep)) {
  fail(`镜像目录不能位于本仓库内：${mirror}`)
}

console.log(`私库   ：${root}`)
console.log(`镜像   ：${mirror}`)

// 1. 准备镜像：没有就克隆；已有则对齐到 origin/main（镜像是一次性产物，
//    本地残留脏改动一律丢弃，保证每次同步从同一个干净起点出发）
if (!existsSync(join(mirror, '.git'))) {
  console.log(`克隆发布库 → ${mirror}`)
  git(root, ['clone', PUBLIC_REPO, mirror], { net: true })
} else {
  git(mirror, ['fetch', 'origin', 'main'], { net: true })
  git(mirror, ['checkout', '-q', 'main'])
  git(mirror, ['reset', '--hard', '-q', 'origin/main'])
  git(mirror, ['clean', '-fdq'])
}

// 2. 把私库 main 的整棵树搬进镜像的索引与工作区
const privPath = root.replace(/\\/g, '/')
const remotes = git(mirror, ['remote']).split('\n').filter(Boolean)
if (remotes.includes('priv')) git(mirror, ['remote', 'set-url', 'priv', privPath])
else git(mirror, ['remote', 'add', 'priv', privPath])
git(mirror, ['fetch', '-q', 'priv', '+refs/heads/main:refs/remotes/priv/main'])
const privTree = git(mirror, ['ls-tree', '-r', '--name-only', 'priv/main'])
  .split('\n')
  .filter(Boolean)
// 私库已删除的文件不能留在发布库：先按树清单剔掉索引里的孤儿，再搬运其余全部内容
const privSet = new Set(privTree)
const stale = lsFiles(mirror).filter((f) => !privSet.has(f))
if (stale.length > 0) git(mirror, ['rm', '-rqf', '--ignore-unmatch', ...stale])
git(mirror, ['checkout', 'priv/main', '--', '.'])
git(mirror, ['clean', '-fdq'])

// 3. 删掉发布库不该带的文件（AGENTS.md 由私库带入）
for (const file of EXCLUDE) {
  if (lsFiles(mirror).includes(file)) git(mirror, ['rm', '-qf', '--ignore-unmatch', file])
}

// 4. 断言：除保留名单外，发布库文件清单必须与私库逐字一致
const expected = lsFiles(root).filter((f) => !EXCLUDE.includes(f))
const actual = lsFiles(mirror)
const missing = expected.filter((f) => !actual.includes(f))
const extra = actual.filter((f) => !expected.includes(f))
if (missing.length > 0 || extra.length > 0) {
  const lines = []
  if (missing.length > 0)
    lines.push(`发布库缺少 ${missing.length} 个文件：\n  ${missing.join('\n  ')}`)
  if (extra.length > 0) lines.push(`发布库多出 ${extra.length} 个文件：\n  ${extra.join('\n  ')}`)
  fail(lines.join('\n'))
}
console.log(`清单校验通过：${actual.length} 个文件与私库一致（已排除 ${EXCLUDE.join('、')}）`)

// 5. 提交与推送
const privSha = git(root, ['rev-parse', '--short', 'HEAD'])
if (git(mirror, ['status', '--porcelain']) === '') {
  console.log(`发布库已是最新（私库 HEAD ${privSha}），无需提交`)
  process.exit(0)
}
const message = customMessage ?? `chore: 同步源码自私档库 ${privSha}`

if (dryRun) {
  console.log('\n[dry-run] 待提交改动：')
  console.log(git(mirror, ['status', '--short']))
  console.log(`[dry-run] 未提交、未推送（提交信息将为：${message}）`)
  process.exit(0)
}

git(mirror, ['commit', '-q', '-m', message])
git(mirror, ['push', 'origin', 'main'], { net: true })
console.log(`已推送发布库：${message}`)
