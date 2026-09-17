// 引用护栏判定单测（chat/citation-guard.ts）。
//
// P7-T1 的教训 DNA 就是 todo-nudge 那条：判定逻辑必须独立纯函数模块 + 单测，
// 不许留在 run 闭包里。这里覆盖三块：URL 抽取/归一（误报防御）、
// 已验证集合的准入（本轮工具结果 / 历史种子 / 白名单）、催办额度（一次）。

import { describe, expect, it } from 'vitest'
import { CitationGuard, extractUrlKeys, normalizeUrl } from '../src/main/chat/citation-guard'

describe('normalizeUrl · 归一口径', () => {
  it('origin + path 一致即同 key：查询参数 / #fragment / 行尾斜杠都不参与比对', () => {
    const base = normalizeUrl('https://a.com/docs/guide')
    expect(normalizeUrl('https://a.com/docs/guide?utm_source=x')).toBe(base)
    expect(normalizeUrl('https://a.com/docs/guide#sec-2')).toBe(base)
    expect(normalizeUrl('https://a.com/docs/guide/')).toBe(base)
    expect(normalizeUrl('https://A.COM/docs/guide')).toBe(base) // 域名大小写归一
  })

  it('同域名不同路径**不算**对上（编造最常见手法：真域名 + 假路径）', () => {
    expect(normalizeUrl('https://a.com/docs/real')).not.toBe(
      normalizeUrl('https://a.com/docs/fake')
    )
  })

  it('剥行尾粘连标点（中英文括号 / markdown 链接尾巴 / 中文标点）', () => {
    const key = normalizeUrl('https://a.com/x')
    expect(normalizeUrl('https://a.com/x)。')).toBe(key)
    expect(normalizeUrl('(https://a.com/x)')).toBe(key)
    expect(normalizeUrl('https://a.com/x]')).toBe(key)
    expect(normalizeUrl('https://zh.wikipedia.org/wiki/%E6%B5%8B%E8%AF%95')).not.toBeNull()
  })

  it('白名单占位域名返回 null（不参与校验）', () => {
    for (const u of [
      'https://example.com/x',
      'https://foo.example.org',
      'http://localhost:3000/api',
      'https://my.app.test',
      'http://127.0.0.1:8080/z'
    ]) {
      expect(normalizeUrl(u), u).toBeNull()
    }
  })

  it('非 http(s) / 残缺 URL 返回 null', () => {
    expect(normalizeUrl('ftp://a.com/x')).toBeNull()
    expect(normalizeUrl('a.com/x')).toBeNull()
    expect(normalizeUrl('https://')).toBeNull()
  })
})

describe('extractUrlKeys · 文本抽取', () => {
  it('中文紧邻 URL 不吞字（RFC 字符集天然截断）', () => {
    const keys = extractUrlKeys('出处见 https://a.com/p是编的，真的在这 https://b.com/q')
    expect(keys).toEqual([normalizeUrl('https://a.com/p'), normalizeUrl('https://b.com/q')])
  })

  it('代码块（围栏与行内）里的 URL 跳过——那是示例代码不是引用', () => {
    const text = [
      '照这个格式填：',
      '```',
      'fetch("https://api.example-data.com/v1")',
      '```',
      '真实出处：https://a.com/report'
    ].join('\n')
    expect(extractUrlKeys(text)).toEqual([normalizeUrl('https://a.com/report')])
    expect(extractUrlKeys('跑 `npm i` 前先开 https://a.com/doc 里的代理')).toEqual([
      normalizeUrl('https://a.com/doc')
    ])
    // 行内代码里的 URL 被跳过
    expect(extractUrlKeys('示例：`https://cdn.fake.com/x`')).toEqual([])
  })

  it('markdown 链接语法里的 URL 正常抽取', () =>
    expect(extractUrlKeys('详见 [官网](https://a.com/home) 和 <https://b.com/w>')).toEqual([
      normalizeUrl('https://a.com/home'),
      normalizeUrl('https://b.com/w')
    ]))
})

describe('CitationGuard · 已验证集合的准入', () => {
  it('本轮工具结果里的链接 → 引用它不催', () => {
    const g = new CitationGuard()
    g.noteToolResult(true, '搜索结果：1. https://a.com/x 2. https://b.com/y?q=1')
    expect(g.finishReminder('给你：https://a.com/x 和 https://b.com/y')).toBeNull()
  })

  it('工具失败（ok=false）的结果不算出处；且失败不置 touched', () => {
    const g = new CitationGuard()
    g.noteToolResult(false, 'https://a.com/x')
    // 纯聊天轮（没成功跑过工具）→ 即便引用了没出处的链接也不催
    expect(g.finishReminder('https://a.com/x')).toBeNull()
  })

  it('历史种子：上一轮工具结果 / 用户消息里的链接算已验证', () => {
    const g = new CitationGuard()
    g.seedFrom(['上轮搜索结果 https://a.com/past', '用户发的 https://b.com/user'])
    g.noteToolResult(true, '本轮只跑了个无关工具 https://c.com/now')
    expect(
      g.finishReminder('如你之前给的 https://b.com/user 和上轮的 https://a.com/past')
    ).toBeNull()
  })

  it('★ 搜索结果 URL 带 utm/签名参数、模型省略参数引用 → 不误催（origin+path 口径）', () => {
    const g = new CitationGuard()
    g.noteToolResult(true, 'https://news.a.com/article/123?spm=2014.71.2.1&from=feed')
    expect(g.finishReminder('来源：https://news.a.com/article/123')).toBeNull()
  })
})

describe('CitationGuard · 催办判定', () => {
  it('编造链接（真域名假路径）→ 催办文案列出该链接', () => {
    const g = new CitationGuard()
    g.noteToolResult(true, 'https://a.com/real')
    const text = g.finishReminder('https://a.com/fake 和 https://a.com/real')
    expect(text).not.toBeNull()
    expect(text).toContain('a.com/fake')
    expect(text).not.toContain('a.com/real')
    expect(text).toContain('fetch_url')
  })

  it('一次额度：催过之后不再催（第二次收尾直接放行）', () => {
    const g = new CitationGuard()
    g.noteToolResult(true, 'https://a.com/real')
    expect(g.finishReminder('https://a.com/fake1')).not.toBeNull()
    // 她没删、又收尾：放行（不无限拉扯）
    expect(g.finishReminder('https://a.com/fake2')).toBeNull()
  })

  it('全部已验证 → 零打扰，且额度不被白白消耗（后续真编造仍能催）', () => {
    const g = new CitationGuard()
    g.noteToolResult(true, 'https://a.com/x')
    expect(g.finishReminder('https://a.com/x')).toBeNull() // 干净收尾
    expect(g.finishReminder('https://a.com/fake')).not.toBeNull() // 第二次才编 → 仍催
  })

  it('同一假链接重复出现只列一次', () => {
    const g = new CitationGuard()
    g.noteToolResult(true, 'ok https://a.com/x')
    const text = g.finishReminder('https://a.com/fake，重复：https://a.com/fake')
    expect((text ?? '').match(/a\.com\/fake/g)?.length).toBe(1)
  })

  it('纯聊天轮（没跑过工具）→ 不启用（同 touched 准入）', () => {
    const g = new CitationGuard()
    expect(g.finishReminder('https://totally-made-up.com/x')).toBeNull()
  })

  it('白名单域名混在回复里不触发催办', () => {
    const g = new CitationGuard()
    g.noteToolResult(true, 'https://a.com/x')
    expect(g.finishReminder('示例见 https://example.com/demo，出处 https://a.com/x')).toBeNull()
  })
})
