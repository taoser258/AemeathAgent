// 流式输出的 token 实时估算（无依赖纯函数，渲染/主进程共用）。
//
// 为什么需要它：监测栏 tok/s 在生成中只能看到 SSE delta，拿不到供应商 usage。
// 旧口径“一个 delta 算一个 token”对攒批发送的端点（百炼 qwen3.8 一条 delta 常含
// 数个 token）会严重偏低，结束时换成真实 usage 又瞬间暴涨（实测 18 → 68）。
// 改用「字符 → token」启发式估算，让实时值与最终 usage 同量级，结束跳变收敛到
// 小范围修正。这是近似值——精确 token 数以供应商流末 usage 为准。
//
// 口径：CJK 文字/假名/韩文/全角符号每个约 1 token；其余非空白字符按 4 个/token
// （英文分词常见经验值，空白不计）。对中英混排、markdown、代码都给稳定非负结果。

/** 是否为东亚/CJK 类字符（按码点区间，避开 U+3000 全角空格） */
function isCjk(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // 韩文 Jamo
    (cp >= 0x2e80 && cp <= 0x2fdf) || // CJK 部首补充 / 康熙部首
    (cp >= 0x3001 && cp <= 0x303f) || // CJK 符号标点（不含全角空格 3000）
    (cp >= 0x3040 && cp <= 0x30ff) || // 平假名 / 片假名
    (cp >= 0x3130 && cp <= 0x318f) || // 韩文兼容字母
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // 统一表意文字
    (cp >= 0xac00 && cp <= 0xd7a3) || // 韩文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容汉字
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
    (cp >= 0xff01 && cp <= 0xff60) // 全角 ASCII 标点/字母（不含非字符）
  )
}

/** 估算一段文本的 token 数（非负整数；空串/纯空白 = 0） */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (isCjk(cp)) {
      cjk += 1
    } else if (/\S/.test(ch)) {
      other += 1
    }
  }
  return cjk + (other > 0 ? Math.ceil(other / 4) : 0)
}
