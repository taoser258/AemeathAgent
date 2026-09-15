// plot 组件的受限数学表达式求值器（词法 + 递归下降，非 eval——模型输出不可信，
// 这里没有任何代码执行路径：未知符号/非法字符一律抛错，渲染层 catch 后跳过该点）。
// 支持：+ - * / ^ ()、函数 sin cos tan asin acos atan sqrt cbrt exp log ln abs
// floor ceil round min max pow、常量 pi e tau、变量 x 与调用方注入的参数作用域。

const FUNCS: Record<string, (a: number[]) => number> = {
  sin: (a) => Math.sin(a[0] ?? 0),
  cos: (a) => Math.cos(a[0] ?? 0),
  tan: (a) => Math.tan(a[0] ?? 0),
  asin: (a) => Math.asin(a[0] ?? 0),
  acos: (a) => Math.acos(a[0] ?? 0),
  atan: (a) => Math.atan(a[0] ?? 0),
  sqrt: (a) => Math.sqrt(a[0] ?? 0),
  cbrt: (a) => Math.cbrt(a[0] ?? 0),
  exp: (a) => Math.exp(a[0] ?? 0),
  log: (a) => Math.log10(a[0] ?? 0),
  ln: (a) => Math.log(a[0] ?? 0),
  abs: (a) => Math.abs(a[0] ?? 0),
  floor: (a) => Math.floor(a[0] ?? 0),
  ceil: (a) => Math.ceil(a[0] ?? 0),
  round: (a) => Math.round(a[0] ?? 0),
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  pow: (a) => Math.pow(a[0] ?? 0, a[1] ?? 0)
}

const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 }

function tokenize(s: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === ' ' || c === '\t') {
      i++
      continue
    }
    if (/[0-9.]/.test(c ?? '')) {
      let j = i
      while (j < s.length && /[0-9.]/.test(s[j] ?? '')) j++
      out.push(s.slice(i, j))
      i = j
      continue
    }
    if (/[a-zA-Z_]/.test(c ?? '')) {
      let j = i
      while (j < s.length && /[a-zA-Z_]/.test(s[j] ?? '')) j++
      out.push(s.slice(i, j))
      i = j
      continue
    }
    if ('+-*/^(),'.includes(c ?? '')) {
      out.push(c ?? '')
      i++
      continue
    }
    throw new Error(`非法字符：${c}`)
  }
  return out
}

class ExprParser {
  private pos = 0
  constructor(
    private t: string[],
    private scope: Record<string, number>
  ) {}
  private peek(): string | undefined {
    return this.t[this.pos]
  }
  private eat(): string | undefined {
    return this.t[this.pos++]
  }
  atEnd(): boolean {
    return this.pos >= this.t.length
  }
  parseExpr(): number {
    return this.parseAdd()
  }
  private parseAdd(): number {
    let v = this.parseMul()
    while (this.peek() === '+' || this.peek() === '-') {
      const op = this.eat()
      const r = this.parseMul()
      v = op === '+' ? v + r : v - r
    }
    return v
  }
  private parseMul(): number {
    let v = this.parseUnary()
    while (this.peek() === '*' || this.peek() === '/') {
      const op = this.eat()
      const r = this.parseUnary()
      v = op === '*' ? v * r : v / r
    }
    return v
  }
  // 一元负比 ^ 松（-2^2 = -(2^2) = -4，数学惯例），但 ^ 的指数可带一元负（2^-3）
  private parseUnary(): number {
    if (this.peek() === '-') {
      this.eat()
      return -this.parseUnary()
    }
    if (this.peek() === '+') {
      this.eat()
      return this.parseUnary()
    }
    return this.parsePow()
  }
  private parsePow(): number {
    const base = this.parseAtom()
    if (this.peek() === '^') {
      this.eat()
      return Math.pow(base, this.parseUnary()) // 右结合 + 指数允许一元负
    }
    return base
  }
  private parseAtom(): number {
    const tk = this.eat()
    if (tk === undefined) throw new Error('表达式意外结束')
    if (tk === '(') {
      const v = this.parseAdd()
      if (this.eat() !== ')') throw new Error('缺右括号')
      return v
    }
    if (/^[0-9.]/.test(tk)) {
      const v = Number.parseFloat(tk)
      if (!Number.isFinite(v)) throw new Error(`非法数字 ${tk}`)
      return v
    }
    if (FUNCS[tk]) {
      if (this.eat() !== '(') throw new Error(`函数 ${tk} 缺括号`)
      const args: number[] = [this.parseAdd()]
      while (this.peek() === ',') {
        this.eat()
        args.push(this.parseAdd())
      }
      if (this.eat() !== ')') throw new Error('缺右括号')
      return FUNCS[tk]?.(args) ?? NaN
    }
    if (tk in CONSTS) return CONSTS[tk] ?? NaN
    if (tk in this.scope) return this.scope[tk] ?? NaN
    throw new Error(`未知符号：${tk}`)
  }
}

/** 求值：语法错误/未知符号抛 Error（调用方 catch 后按"该点无值"处理） */
export function evalExpr(expr: string, scope: Record<string, number>): number {
  const parser = new ExprParser(tokenize(expr), scope)
  const val = parser.parseExpr()
  if (!parser.atEnd()) throw new Error('表达式有多余字符')
  return val
}
