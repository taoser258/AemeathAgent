// web_search 单测：四引擎解析（fixture HTML/JSON）+ 回退链 + LRU 缓存。
// 网络全部 stub——只验解析与调度逻辑；真实网络走 E2E。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearEnginePenalties,
  decodeDdgUrl,
  itemsRelevant,
  orderEngines,
  parseBing,
  parseDdgHtml,
  parseDdgLite,
  parseSearxng,
  parseSo,
  parseSogou,
  queryTerms,
  searchWeb,
  uniqueItems,
  clearWebSearchCache
} from '../src/main/agent/tools/web-search'

const SIGNAL = new AbortController().signal

beforeEach(() => {
  clearWebSearchCache()
  clearEnginePenalties()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

// ── 解析 ─────────────────────────────────────────────────────────────────
describe('解析函数（对齐 free-search 的公开页结构）', () => {
  it('decodeDdgUrl：uddg 跳转壳解码 / 直链 / 非法', () => {
    expect(decodeDdgUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1')).toBe(
      'https://example.com/a?b=1'
    )
    expect(decodeDdgUrl('https://direct.example.com/x')).toBe('https://direct.example.com/x')
    expect(decodeDdgUrl(undefined)).toBeNull()
    expect(decodeDdgUrl('/relative/path')).toBeNull()
  })

  it('parseDdgLite：result-link 与 result-snippet 按序配对', () => {
    const html = `
      <table><tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvitejs.dev%2Fguide" class='result-link'>Vite 指南 &amp; 文档</a></td></tr>
      <tr><td class='result-snippet'>新一代前端构建工具，<b>闪电</b>启动。</td></tr>
      <tr><td><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb" class='result-link'>第二条</a></td></tr>
      <tr><td class='result-snippet'>第二条摘要</td></tr></table>`
    const items = parseDdgLite(html)
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({
      url: 'https://vitejs.dev/guide',
      title: 'Vite 指南 & 文档',
      snippet: '新一代前端构建工具， 闪电 启动。'
    })
    expect(items[1].url).toBe('https://example.org/b')
  })

  it('parseDdgHtml：result__a + result__snippet', () => {
    const html = `
      <div class="result results_links results_links_deep web-result">
        <div class="links_main links_deep result__body">
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fmdn.io%2Ffetch">MDN fetch</a>
          <a class="result__snippet">Fetch API 接口说明。</a>
        </div>
      </div>
      </div>
      </div>`
    const items = parseDdgHtml(html)
    expect(items).toHaveLength(1)
    expect(items[0].url).toBe('https://mdn.io/fetch')
    expect(items[0].title).toBe('MDN fetch')
    expect(items[0].snippet).toBe('Fetch API 接口说明。')
  })

  it('parseBing：b_algo 块（h2 锚点 + p 摘要）', () => {
    const html = `
      <ol id="b_results">
        <li class="b_algo"><h2><a href="https://nodejs.org/en/blog">Node.js 博客</a></h2><p>官方发布公告与版本说明。</p></li>
        <li class="b_algo"><h2><a href="https://example.com/2">第二条</a></h2></li>
      </ol>`
    const items = parseBing(html)
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({
      url: 'https://nodejs.org/en/blog',
      title: 'Node.js 博客',
      snippet: '官方发布公告与版本说明。'
    })
    expect(items[1].snippet).toBe('')
  })

  it('parseSearxng：JSON results 数组；脏结构返回空', () => {
    const items = parseSearxng({
      results: [
        { title: 'T1', url: 'https://a.example/1', content: 'C1' },
        { title: 'T2', url: '', content: 'drop' },
        { url: 'https://b.example/2' }
      ]
    })
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({ url: 'https://a.example/1', title: 'T1', snippet: 'C1' })
    expect(items[1].title).toBe('')
    expect(parseSearxng({ nope: 1 })).toEqual([])
    expect(parseSearxng(null)).toEqual([])
  })

  it('parseSogou：vrwrap 块 + data-url 真实链接 + 剥 red 高亮注释', () => {
    // 结构取自真实抓取页：真实 URL 在块级 data-url（href 是 /link?url= 跳转壳），
    // 标题含 <!--red_beg--> 高亮注释要剥掉。
    const html = `
      <div class="vrwrap"><div class="struct201102">
        <div class="vr-title" vrcid="title.1"><a target="_blank" href="/link?url=abc"><em><!--red_beg-->苏州大学<!--red_end--></em>的计算机专业</a></div>
        <div class="fz-mid space-txt">9个回答 - 32人关注</div>
        <div data-url="https://www.zhihu.com/question/326590944"></div>
      </div></div>
      <div class="vrwrap"><div class="vr-title"><a href="/link?url=def">第二条</a></div>
        <div data-url="https://example.org/2"></div></div>
      <div class="vrwrap"><div>没有 data-url 的块应被跳过</div></div>`
    const items = parseSogou(html)
    expect(items).toHaveLength(2)
    expect(items[0].url).toBe('https://www.zhihu.com/question/326590944')
    expect(items[0].title).toBe('苏州大学的计算机专业') // red 注释已剥
    expect(items[0].snippet).toContain('9个回答')
    expect(items[1].url).toBe('https://example.org/2')
  })

  it('parseSo：360 结果块（data-mdurl 真实链接 + h3.res-title + p.res-desc）（9.15 新增引擎）', () => {
    // 结构取自真实抓取页：锚点 href 是 /link?m= 跳转壳，
    // 真实 URL 在块级 data-mdurl；标题/摘要含 <em> 高亮，须按 stripTight 不补空格。
    const html = `
      <li class="res-list"><h3 class="res-title " ><a href="https://www.so.com/link?m=xxx" data-mdurl="https://m.gk100.com/read_1.htm"><em>苏州大学学科评估</em>结果排名</a></h3>
        <p class="res-desc">本文梳理<em>苏州大学</em>最新学科<em>评估</em>结果与专业排名。</p>
        <p class="g-linkinfo"><cite><a href="https://www.so.com/link?m=yyy">m.gk100.com</a></cite></p></li>
      <li class="res-list"><h3 class="res-title"><a href="/link?m=zzz" data-mdurl="https://example.org/2">第二条</a></h3>
        <p class="res-desc">第二条摘要</p></li>
      <li class="res-list"><h3 class="res-title"><a href="/link?m=no">没有 data-mdurl 的块应被跳过</a></h3></li>`
    const items = parseSo(html)
    expect(items).toHaveLength(2)
    expect(items[0].url).toBe('https://m.gk100.com/read_1.htm')
    expect(items[0].title).toBe('苏州大学学科评估结果排名') // 高亮标签已剥且不插空格
    expect(items[0].snippet).toContain('苏州大学最新学科评估结果')
    expect(items[1].url).toBe('https://example.org/2')
  })

  it('uniqueItems：按 URL 去重 + 截断', () => {
    const items = [
      { url: 'https://a/1', title: 'a', snippet: '' },
      { url: 'https://a/1', title: 'dup', snippet: '' },
      { url: 'https://a/2', title: 'b', snippet: '' }
    ]
    expect(uniqueItems(items, 5)).toHaveLength(2)
    expect(uniqueItems(items, 1)).toHaveLength(1)
  })
})

// ── 回退链与缓存 ─────────────────────────────────────────────────────────
describe('searchWeb（引擎链 + 缓存）', () => {
  it('前置引擎失败 → bing 兜底成功：engine 标记正确', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url)
      if (url.includes('duckduckgo')) return new Response('blocked', { status: 403 })
      if (url.includes('bing.com')) {
        // 填充到 >500 字节：fetchText 把过短响应视为疑似反爬挑战页
        const pad = '<!-- ' + '填充内容'.repeat(200) + ' -->'
        return new Response(
          '<li class="b_algo"><h2><a href="https://ok.example/1">测试关键词 命中</a></h2><p>测试关键词 摘要</p></li>' +
            pad,
          { status: 200 }
        )
      }
      return new Response('nope', { status: 500 })
    })
    const out = await searchWeb('测试关键词', { maxResults: 5, signal: SIGNAL })
    expect(out.engine).toBe('bing')
    expect(out.items[0].url).toBe('https://ok.example/1')
    expect(out.cached).toBe(false)
    expect(out.suspect).toBeUndefined() // 结果与查询相关 → 不是 suspect
    // 两个中文引擎（sogou/so）先被试过，才轮到 ddg 两段、bing
    expect(calls.some((u) => u.includes('sogou.com'))).toBe(true)
    expect(calls.some((u) => u.includes('so.com'))).toBe(true)
    expect(calls.some((u) => u.includes('lite.duckduckgo.com'))).toBe(true)
  })

  it('★ 相关性闸门（9.15）：引擎返回降级页（与查询零重叠）→ 判失败继续走链', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url)
      const pad = '<!-- ' + '填充内容'.repeat(200) + ' -->'
      if (url.includes('sogou.com')) {
        // 搜狗返回"降级页"：标题全是节日/日历，与查询零重叠
        return new Response(
          '<div class="vrwrap"><h3 class="vr-title"><a>2026 年元旦放假安排</a></h3>' +
            '<div class="fz-mid">春节假期日历一览</div><a data-url="https://junk.example/1">x</a></div>' +
            pad,
          { status: 200 }
        )
      }
      if (url.includes('so.com')) {
        return new Response(
          '<li class="res-list"><h3 class="res-title"><a data-mdurl="https://good.example/1">2026考研数学一 真题 解析</a></h3>' +
            '<p class="res-desc">2026考研数学一真题第三题官方答案与解析</p>' +
            pad,
          { status: 200 }
        )
      }
      return new Response('nope', { status: 500 })
    })
    const out = await searchWeb('2026考研数学一真题第三题', { maxResults: 5, signal: SIGNAL })
    expect(out.engine).toBe('so') // 降级页被闸门拦下，落到 360
    expect(out.items[0].url).toBe('https://good.example/1')
    expect(out.suspect).toBeUndefined()
  })

  it('★ 全链都只给不相关结果：返回最好的一份但标 suspect（不假装成功）', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const pad = '<!-- ' + '填充内容'.repeat(200) + ' -->'
      if (url.includes('sogou.com')) {
        return new Response(
          '<div class="vrwrap"><h3 class="vr-title"><a>节日日历</a></h3><a data-url="https://junk.example/1">x</a>' +
            '<div class="fz-mid">元旦春节放假</div></div>' +
            pad,
          { status: 200 }
        )
      }
      return new Response('down', { status: 503 })
    })
    const out = await searchWeb('量子纠缠实验装置', { maxResults: 5, signal: SIGNAL })
    expect(out.suspect).toBe(true)
    expect(out.engine).toBe('sogou')
  })

  it('同 query 第二次命中 LRU 缓存（不再发请求）', async () => {
    let fetchCount = 0
    // 完整的 ddg 结果块（parseDdgHtml 需要 result 块包裹）+ 填充到 >500 字节
    const ddgFixture =
      '<div class="result results_links results_links_deep web-result">' +
      '<div class="links_main links_deep result__body">' +
      '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.example%2Fdoc">缓存关键词 文档</a>' +
      '<a class="result__snippet">缓存关键词 摘要</a>' +
      '</div></div></div>' +
      '<!-- ' +
      '填充'.repeat(300) +
      ' -->'
    vi.stubGlobal('fetch', async () => {
      fetchCount += 1
      return new Response(ddgFixture, { status: 200 })
    })
    const first = await searchWeb('缓存关键词', { maxResults: 3, signal: SIGNAL })
    const after1 = fetchCount
    const second = await searchWeb('缓存关键词', { maxResults: 3, signal: SIGNAL })
    expect(second.cached).toBe(true)
    expect(fetchCount).toBe(after1) // 第二次零请求
    expect(second.engine).toBe(first.engine)
  })

  it('全链失败：抛错含各引擎原因', async () => {
    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }))
    await expect(searchWeb('全失败', { maxResults: 3, signal: SIGNAL })).rejects.toThrow(
      /所有搜索引擎均未能返回结果/
    )
  })

  it('★ 引擎健康度降权：搜狗/DDG 失败后被垫到链尾，下次先试可用引擎', async () => {
    const order: string[] = []
    const bingOk =
      '<li class="b_algo"><h2><a href="https://ok.example/1">命中关键词 结果</a></h2><p>命中关键词 摘要</p></li>' +
      '<!-- ' +
      '填充内容'.repeat(200) +
      ' -->'
    vi.stubGlobal('fetch', async (url: string) => {
      const tag = url.includes('sogou')
        ? 'sogou'
        : url.includes('so.com')
          ? 'so'
          : url.includes('duckduckgo')
            ? 'ddg'
            : url.includes('bing')
              ? 'bing'
              : 'other'
      order.push(tag)
      if (tag === 'sogou' || tag === 'ddg') throw new Error('超时') // 模拟国内直连被拦
      if (tag === 'bing') return new Response(bingOk, { status: 200 })
      return new Response('nope', { status: 500 })
    })
    // 第一次：链原序 → 搜狗（置首）失败 → 360 失败 → ddg 两个端点失败 → bing 命中
    await searchWeb('命中关键词', { maxResults: 5, signal: SIGNAL })
    expect(order[0]).toBe('sogou')
    expect(order.filter((x) => x === 'ddg').length).toBeGreaterThanOrEqual(2) // ddg-lite + ddg 两段
    expect(order[order.length - 1]).toBe('bing')
    order.length = 0
    // 第二次（换 query 绕缓存）：sogou/so/ddg 都被降权 → bing 第一个被试，命中即返回
    await searchWeb('命中关键词二', { maxResults: 5, signal: SIGNAL })
    expect(order[0]).toBe('bing')
    expect(order).not.toContain('ddg')
    expect(order).not.toContain('sogou')
  })

  it('orderEngines：未冷却保持原序（两个中文引擎置首，9.15），冷却中的垫后', () => {
    const now = 1_000_000
    expect(orderEngines(now)).toEqual(['sogou', 'so', 'ddg-lite', 'ddg', 'bing', 'searxng'])
  })

  it('★ queryTerms / itemsRelevant：中文 2-gram 与 ASCII 词；阈值=min(2,切片数)', () => {
    const terms = queryTerms('2026考研 数学 one')
    expect(terms).toContain('考研')
    expect(terms).toContain('2026')
    expect(terms).toContain('one')
    expect(itemsRelevant([{ title: '2026考研数学一真题', url: 'u', snippet: '' }], terms)).toBe(
      true
    )
    expect(itemsRelevant([{ title: '元旦放假', url: 'u', snippet: '春节日历' }], terms)).toBe(false)
    // 只蒙对年份的降级页（实测 bing 就这德行）也算不相关——必须 ≥2 个切片
    expect(
      itemsRelevant([{ title: '2026 年元旦放假安排', url: 'u', snippet: '春节' }], terms)
    ).toBe(false)
    expect(itemsRelevant([], terms)).toBe(false)
    expect(itemsRelevant([{ title: '任意', url: 'u', snippet: '' }], [])).toBe(true)
    // 单切片查询：命中 1 个即通过
    const one = queryTerms('换行符')
    expect(one).toEqual(['换行', '行符'])
    expect(itemsRelevant([{ title: '文件换行符', url: 'u', snippet: '' }], one)).toBe(true)
  })
})
