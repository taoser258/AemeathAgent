/**
 * 轻量 ANSI 终端流解析器。
 *
 * 定位：node-pty 输出的是带 ANSI 转义序列的字符流，直接塞 <pre> 会满屏乱码。
 * xterm.js 是大型依赖，这里做一个「够看」的子集：
 * · 可打印字符 → 按当前样式（SGR 颜色/加粗）累积成字符网格
 * · \r 回车覆写（进度条语义）、\n 换行、\x08 退格
 * · SGR（\x1b[...m）→ 16 色前景 + 加粗 + 重置
 * · \x1b[2J / \x1b[3J / \f → 清屏；\x1b[K → 清行尾
 * · 其余 CSI/OSC（光标移动、窗口标题等）→ 吞掉不渲染
 * 输出为「行数组」，渲染层把每行按样式分段画成 span——DOM 规模由行数上限封顶。
 */

/** 一个字符的样式：'' = 默认；否则为 CSS class 名（fg-2 等，样式表在 chat.css） */
export type AnsiCls = string

export interface AnsiChar {
  ch: string
  cls: AnsiCls
}

export interface AnsiScreenOpts {
  /** 保留的最大行数（超出丢最旧，防 vim/top 类程序刷爆 DOM） */
  maxLines?: number
}

const DEFAULT_MAX_LINES = 2000

export class AnsiScreen {
  private readonly maxLines: number
  /** 已提交的行（含当前行之前的全部） */
  private readonly lines: AnsiChar[][] = []
  /** 当前行字符缓冲 + 覆写光标 */
  private current: AnsiChar[] = []
  private col = 0
  /** 当前 SGR 样式（fg-1..fg-15 / 空；加粗并入 cls 串） */
  private cls = ''

  constructor(opts: AnsiScreenOpts = {}) {
    this.maxLines = opts.maxLines ?? DEFAULT_MAX_LINES
  }

  /** 喂入一段解码后的字符流，更新屏幕状态 */
  feed(chunk: string): void {
    let i = 0
    while (i < chunk.length) {
      const code = chunk.charCodeAt(i)
      if (code === 0x1b && i + 1 < chunk.length) {
        const next = chunk.charCodeAt(i + 1)
        if (next === 0x5b /* [ */) {
          i = this.feedCsi(chunk, i)
          continue
        }
        if (next === 0x5d /* ] */) {
          i = this.feedOsc(chunk, i)
          continue
        }
        // ESC + 其他单字符（(B 字符集切换等）：吞 2 字节
        i += 2
        continue
      }
      if (code === 0x0a /* \n */) {
        this.commitLine()
        i += 1
        continue
      }
      if (code === 0x0d /* \r */) {
        this.col = 0 // 覆写模式：后续写入从行首盖
        i += 1
        continue
      }
      if (code === 0x08 /* 退格 */) {
        this.col = Math.max(0, this.col - 1)
        i += 1
        continue
      }
      if (code === 0x0c /* \f 换页=清屏 */) {
        this.clearScreen()
        i += 1
        continue
      }
      if (code === 0x07 /* 响铃 */ || code === 0x09 /* 制表 */) {
        // 制表按 4 空格近似（终端输出对齐够用）
        if (code === 0x09) this.put('    ')
        i += 1
        continue
      }
      if (code >= 0x20) {
        this.put(chunk[i])
      }
      // 其余控制字符（\x00-\x1f 未处理的）直接忽略
      i += 1
    }
  }

  /** 快照：已提交行 + 当前行（渲染层直接 map 成 DOM） */
  render(): AnsiChar[][] {
    const out = this.lines.slice()
    out.push(this.current)
    return out
  }

  /** 清屏（cls / \x1b[2J / \f 共用） */
  clearScreen(): void {
    this.lines.length = 0
    this.current = []
    this.col = 0
  }

  // ───────────────────────── 内部 ─────────────────────────

  private put(text: string): void {
    for (const ch of text) {
      if (this.col < this.current.length) {
        this.current[this.col] = { ch, cls: this.cls } // \r 后覆写
      } else {
        this.current.push({ ch, cls: this.cls })
      }
      this.col += 1
    }
  }

  private commitLine(): void {
    this.lines.push(this.current)
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines)
    this.current = []
    this.col = 0
  }

  /** CSI：\x1b[ 开头，参数字节 0x30-0x3f，中间字节 0x20-0x2f，终结字母 0x40-0x7e */
  private feedCsi(s: string, start: number): number {
    let j = start + 2
    let param = ''
    while (j < s.length && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x3f) {
      param += s[j]
      j += 1
    }
    while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j += 1 // 中间字节
    if (j >= s.length) return s.length // 流截断：吞到结尾（下次 feed 是新序列，可接受）
    const final = s[j]
    switch (final) {
      case 'm':
        this.applySgr(param)
        break
      case 'J':
        if (param === '2' || param === '3' || param === '') this.clearScreen()
        break
      case 'K':
        this.current = this.current.slice(0, this.col) // 清行尾（简化：从光标截断）
        break
      case 'H':
      case 'f': {
        // 光标定位：仅支持「回原点」（1;1 或空参），其余忽略（ConPTY 大量用 \x1b[H\x1b[2J 清屏组合）
        if (param === '' || param === '1' || param === '1;1') {
          this.col = 0
        }
        break
      }
      default:
        break // A/B/C/D/s/u/... 移动类：忽略
    }
    return j + 1
  }

  /** OSC：\x1b] ... BEL 或 ESC \ 结束（窗口标题等，整体吞掉） */
  private feedOsc(s: string, start: number): number {
    for (let j = start + 2; j < s.length; j++) {
      if (s.charCodeAt(j) === 0x07) return j + 1
      if (s.charCodeAt(j) === 0x1b && s[j + 1] === '\\') return j + 2
    }
    return s.length
  }

  /** SGR 参数：0 重置 / 1 加粗 / 30-37 标准前景 / 90-97 亮前景 / 39 默认前景 */
  private applySgr(param: string): void {
    const codes = (param === '' ? ['0'] : param.split(';')).map((p) => Number(p) || 0)
    for (const c of codes) {
      if (c === 0) this.cls = ''
      else if (c === 1) this.cls = this.cls.includes('bold') ? this.cls : `${this.cls} bold`.trim()
      else if (c >= 30 && c <= 37) this.cls = withFg(this.cls, `fg-${c - 30}`)
      else if (c >= 90 && c <= 97) this.cls = withFg(this.cls, `fg-${c - 90 + 8}`)
      else if (c === 39) this.cls = withFg(this.cls, '')
    }
  }
}

/** 替换 cls 串里的 fg-* 段（bold 等其他样式保留） */
function withFg(cls: string, fg: string): string {
  const rest = cls
    .split(' ')
    .filter((t) => t !== '' && !t.startsWith('fg-'))
    .join(' ')
  return fg === '' ? rest : `${fg} ${rest}`.trim()
}
