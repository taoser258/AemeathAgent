/**
 * 轻量 ANSI 解析器单测：覆盖可打印/SGR 颜色/回车覆写/清屏/CSI 吞序列。
 */
import { describe, expect, it } from 'vitest'
import { AnsiScreen, type AnsiChar } from '../src/shared/ansi'

/** 把 render 结果拍平成纯文本（丢样式），方便断言 */
function plain(screen: AnsiScreen): string[] {
  return screen.render().map((line: AnsiChar[]) => line.map((c) => c.ch).join(''))
}

describe('AnsiScreen', () => {
  it('普通文本 + 换行成多行', () => {
    const s = new AnsiScreen()
    s.feed('hello\r\nworld\n')
    // hello 提交、world 提交、末尾空当前行
    expect(plain(s)).toEqual(['hello', 'world', ''])
  })

  it('\\r 回车覆写当前行', () => {
    const s = new AnsiScreen()
    s.feed('abcdef\rXY')
    const lines = plain(s)
    expect(lines[0]).toBe('XYcdef')
  })

  it('SGR 前景色作用于后续字符', () => {
    const s = new AnsiScreen()
    s.feed('\x1b[31mred\x1b[0m plain')
    const line = s.render()[0]
    expect(line[0]).toEqual({ ch: 'r', cls: 'fg-1' }) // 31 → fg-1（红）
    expect(line[3]).toEqual({ ch: ' ', cls: '' }) // 重置后无样式
    expect(line[4]).toEqual({ ch: 'p', cls: '' })
  })

  it('亮色 90-97 映射 fg-8..fg-15', () => {
    const s = new AnsiScreen()
    s.feed('\x1b[92mgreen')
    expect(s.render()[0][0].cls).toBe('fg-10') // 92 → 92-90+8 = fg-10（亮绿）
  })

  it('\\x1b[H\\x1b[2J 清屏组合', () => {
    const s = new AnsiScreen()
    s.feed('a\nb\nc')
    s.feed('\x1b[H\x1b[2J')
    expect(plain(s)).toEqual([''])
  })

  it('未知 CSI（光标移动）被吞不残留', () => {
    const s = new AnsiScreen()
    s.feed('\x1b[2Ax\x1b[10;5Hy')
    expect(plain(s).join('')).toContain('x')
    expect(plain(s).join('')).toContain('y')
    // 不应出现 '[' 或数字残留
    expect(plain(s).join('')).not.toContain('[2A')
  })

  it('OSC 窗口标题序列整体吞掉', () => {
    const s = new AnsiScreen()
    s.feed('\x1b]0;mytitle\x07real')
    expect(plain(s)[0]).toBe('real')
  })

  it('行数上限：超出丢最旧', () => {
    const s = new AnsiScreen({ maxLines: 3 })
    for (let i = 0; i < 10; i++) s.feed(`line${i}\n`)
    const lines = plain(s)
    // 保留最近 3 行 + 当前空行
    expect(lines.length).toBeLessThanOrEqual(4)
    expect(lines.some((l) => l === 'line9')).toBe(true)
    expect(lines.some((l) => l === 'line0')).toBe(false)
  })

  it('制表符近似 4 空格，退格回退一列', () => {
    const s = new AnsiScreen()
    s.feed('a\tb')
    expect(plain(s)[0]).toBe('a    b')
    const s2 = new AnsiScreen()
    s2.feed('abc\x08X')
    // 退格到 col2 再写 X 覆写 c
    expect(plain(s2)[0]).toBe('abX')
  })
})
