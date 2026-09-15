// 渲染层禁用 Node Buffer 守护。
// 渲染进程 nodeIntegration 刻意关闭——源码里写 Buffer.from/new Buffer(...) 编译期无感
// （@types/node 全局可见），运行期才 ReferenceError。base64 → 二进制用浏览器原生 atob。

import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const RENDERER_ROOT = join(__dirname, '..', 'src', 'renderer')

function collectTsSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) collectTsSources(p, out)
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

describe('渲染层不得引用 Node Buffer（nodeIntegration 关闭，运行期必炸）', () => {
  it('src/renderer 下无 Buffer.from / new Buffer / 裸 Buffer 类型引用', () => {
    const offenders: string[] = []
    for (const file of collectTsSources(RENDERER_ROOT)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        // 注释行放行（说明性文字常提到 Buffer）
        const code = line.replace(/\/\/.*$/, '')
        if (/\bBuffer\s*[.(]/.test(code) || /\bnew\s+Buffer\b/.test(code)) {
          offenders.push(`${file.slice(RENDERER_ROOT.length + 1)}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
