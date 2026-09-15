// 可注入的出站 fetch。
//
// 默认走 globalThis.fetch（Node 实现，**不读系统代理**）。main 启动时用 Electron 的
// net.fetch 覆盖——它走 Chromium 网络栈、尊重系统代理：挂了 Clash 的国内用户，被墙的
// DuckDuckGo 因此可达（实测直连 exit=28 超时、走代理首条即正解），一次解决「每次白等
// 12s 才轮到 bing」与「bing 把多词中文查询降级成城市景点」两个症状。
//
// 保持本模块无 electron 依赖：单测用 vi.stubGlobal('fetch', …) 仍拦得住——默认实现
// 在调用时才解析 globalThis.fetch，而非模块加载时捕获。
type FetchFn = typeof globalThis.fetch

let impl: FetchFn | null = null

/** main 注入 Electron net.fetch（或任何 fetch 兼容实现）；传 null 恢复默认 */
export function setNetFetch(fn: FetchFn | null): void {
  impl = fn
}

/** 所有需要走系统代理的出站请求统一入口（web_search / fetch_url / download_file） */
export const netFetch: FetchFn = ((input: RequestInfo | URL, init?: RequestInit) =>
  (impl ?? globalThis.fetch)(input as Parameters<FetchFn>[0], init)) as FetchFn
