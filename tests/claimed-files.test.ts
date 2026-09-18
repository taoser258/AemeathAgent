// 收尾核对单测（chat/claimed-files.ts）。
// 事故五回归：她说"keepme.log 你说留着，那就留着"，清单也标了 done，
// 但那个文件从头到尾没被写出来——用户只能自己去翻目录。

import { describe, expect, it } from 'vitest'
import { findClaimedButMissing, extractFileTokens } from '../src/main/chat/claimed-files'

const WS = 'E:\\Aemeath工作区'

/** 便捷构造：只有列出的文件"存在" */
function checker(existing: string[]) {
  return (abs: string): boolean => existing.includes(abs)
}

describe('extractFileTokens · 只认"像文件路径"的 token', () => {
  it('反引号内的文件名/相对路径都认；命令串按词拆', () => {
    expect(extractFileTokens('已经写好 `probe2.html` 了')).toEqual(['probe2.html'])
    expect(extractFileTokens('跑 `node _probe2.js` 通过')).toEqual(['_probe2.js'])
    expect(extractFileTokens('输出到 `notes/a.md`')).toEqual(['notes/a.md'])
  })

  it('裸写也认（带扩展名的词）', () => {
    expect(extractFileTokens('keepme.log 一行字')).toEqual(['keepme.log'])
  })

  it('★ 不算文件名的都不认：URL / 邮箱 / 版本号 / 没扩展名', () => {
    expect(extractFileTokens('看 https://example.com/a.md')).toEqual([])
    expect(extractFileTokens('发到 me@example.com')).toEqual([])
    expect(extractFileTokens('升级到 v0.3.2')).toEqual([])
    expect(extractFileTokens('读一下 package.json 里的字段')).toEqual(['package.json'])
  })
})

describe('findClaimedButMissing · 声称写好 → 核对存在性', () => {
  it('★ 事故五回归：清单 done + 总结声称，但文件不存在 → 报出来', () => {
    const missing = findClaimedButMissing({
      answerText:
        '三件事都搞定了：\n1. `_probe2.js` — 已写完并跑通。\n2. `probe2.html` — 正式成品，已写好。\n3. `keepme.log` — 一行字，你说留着，那就留着。',
      todos: [
        { text: '写 _probe2.js 并用 node 运行', status: 'done' },
        { text: '写 probe2.html（成品）', status: 'done' },
        { text: '写 keepme.log（保留）', status: 'done' }
      ],
      workspace: WS,
      exists: checker([`${WS}\\_probe2.js`, `${WS}\\probe2.html`])
    })
    expect(missing).toEqual([`${WS}\\keepme.log`])
  })

  it('★ 只是提到（没有完成动词）不进核对——防噪音', () => {
    const missing = findClaimedButMissing({
      answerText: '你可以参考 `notes/other.md` 的写法，双击就能打开 `probe2.html`。',
      todos: [],
      workspace: WS,
      exists: checker([`${WS}\\probe2.html`])
    })
    expect(missing).toEqual([])
  })

  it('都没写完（清单 pending）不核：没声称就不冤枉', () => {
    const missing = findClaimedButMissing({
      answerText: '已写好 `a.js`。',
      todos: [{ text: '写 b.js', status: 'pending' }],
      workspace: WS,
      exists: checker([`${WS}\\a.js`])
    })
    expect(missing).toEqual([])
  })

  it('工作区之外/越界一律忽略（不拿它冤枉人）', () => {
    const missing = findClaimedButMissing({
      answerText: '已写好 `E:\\别的地方\\x.log` 和 `..\\逃逸.log`。',
      todos: [],
      workspace: WS,
      exists: checker([])
    })
    expect(missing).toEqual([])
  })

  it('未绑定工作区 → 什么都不核（fail-closed）', () => {
    expect(
      findClaimedButMissing({
        answerText: '已写好 `a.js`。',
        todos: [],
        workspace: null,
        exists: checker([])
      })
    ).toEqual([])
  })

  it('去重且带上限（重复提到同一个只报一次）', () => {
    const missing = findClaimedButMissing({
      answerText: '已写好 `x.log`。\n已写好 x.log。',
      todos: [{ text: '写 x.log', status: 'done' }],
      workspace: WS,
      exists: checker([])
    })
    expect(missing).toEqual([`${WS}\\x.log`])
  })
})
