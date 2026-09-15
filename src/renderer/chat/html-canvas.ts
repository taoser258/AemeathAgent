// 预览注入：自生成 HTML 在深色模式下的画布兜底。纯函数，可单测。

/**
 * 深色模式可读性兜底：很多自生成的 HTML 只写了
 * 深色文字却没声明背景 / color-scheme，系统深色时 iframe 默认画布转深 → 深字压深底。
 * 文档若自己声明了 color-scheme，说明作者有意为之，原样返回不干预；
 * 否则在 <head> 最前注入一条 `color-scheme:light` + 白底，把默认画布钉成浅色。
 * 注入放最前：文档自己后写的 background / color-scheme 在级联中照常覆盖，不受影响。
 */
export function injectLightCanvas(html: string): string {
  if (/color-scheme\s*:/i.test(html)) return html // 作者已声明配色 → 尊重
  const guard = '<style>:root{color-scheme:light;background:#fff}</style>'
  const headMatch = /<head[^>]*>/i.exec(html)
  if (headMatch !== null) {
    const at = headMatch.index + headMatch[0].length
    return html.slice(0, at) + guard + html.slice(at)
  }
  const htmlMatch = /<html[^>]*>/i.exec(html)
  if (htmlMatch !== null) {
    const at = htmlMatch.index + htmlMatch[0].length
    return html.slice(0, at) + '<head>' + guard + '</head>' + html.slice(at)
  }
  return guard + html
}
