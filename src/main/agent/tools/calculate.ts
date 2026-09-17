// calculate 工具的求值内核（P7-T2）：单条算术表达式 → 确定数值。
//
// ── 为什么要有这个工具 ─────────────────────────────────────────────────────
// 她日常算术倾向口算：六位数以上、百分比、多步连算时错误率上升，而且错得形式
// 正常（缺陷报告 2.2）。提示词写"仔细算"不可靠（同款教训），给一个零开销的
// 同步工具，再用系统提示守则把"先算再答"变成习惯。
//
// ── 安全模型（node:vm 不是安全沙箱，但威胁模型够用）────────────────────────
// 输入是模型自己生成的表达式、不是公网攻击者数据；即便如此仍做三层：
// ① 长度 ≤500；② 字符白名单（数字 + 算术运算符 + e/E 科学计数法），
//    process/require/constructor/this/Math 等任何标识符在进 vm 前就挡掉，
//    连等号/比较符都不给（不可能赋值、不可能写循环关键字）；
// ③ vm.runInNewContext 空上下文 + 100ms timeout——白名单漏网的标识符也会
// ReferenceError，死循环/慢表达式被 timeout 砍。逗号在进白名单前剥掉
//（中文语境 = 千位分隔符；不剥的话 "3,842" 会被 JS 逗号运算符静默算成 842）。
//
// 本模块无 electron / 无 IO：纯逻辑可单测。

import { runInNewContext } from 'node:vm'

export const CALC_MAX_LEN = 500
export const CALC_TIMEOUT_MS = 100

/** 白名单：数字、科学计数法 e/E、算术四则 + 取余 + 乘方(两个*) + 括号 + 空白 */
const ALLOWED_CHARS_RE = /^[0-9eE+\-*/%().\t ]+$/

export type CalcResult = { ok: true; value: number; text: string } | { ok: false; error: string }

/**
 * 求一条算术表达式。raw 设为 unknown：注册层直接把 args.expression 传进来，
 * 类型校验在这里收口（非字符串/缺字段都转成可读错误，不抛异常）。
 */
export function safeCalculate(raw: unknown): CalcResult {
  if (typeof raw !== 'string') return { ok: false, error: 'expression 必须是字符串' }
  const input = raw.trim()
  if (input === '') return { ok: false, error: '表达式为空' }
  if (input.length > CALC_MAX_LEN) {
    return { ok: false, error: `表达式过长（上限 ${CALC_MAX_LEN} 字符）` }
  }
  // 逗号按千位分隔符剥掉（3,842 → 3842）；剥完必须还能看见数字
  const expr = input.replace(/,/g, '')
  if (!/\d/.test(expr) || !ALLOWED_CHARS_RE.test(expr)) {
    return {
      ok: false,
      error:
        '只支持数字与 + - * / % ** ( ) 运算符；百分数先换成小数（17.5% 写 0.175）；' +
        '开方/函数/日期等请改用 run_js。'
    }
  }

  let value: unknown
  try {
    // 空上下文：没有 require/process/globalThis/Math；括号包裹保证只当表达式解析
    value = runInNewContext(`(${expr})`, Object.create(null), {
      timeout: CALC_TIMEOUT_MS,
      filename: 'calculate.vm'
    })
  } catch (err) {
    return {
      ok: false,
      error: `表达式无法计算：${err instanceof Error ? err.message : String(err)}`
    }
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, error: '结果不是有限数值（检查除零等写法）' }
  }
  // 浮点收尾：0.1+0.2=0.30000000000000004 这类二进制误差压到 12 位有效数字
  const cleaned = Number(value.toPrecision(12))
  return { ok: true, value: cleaned, text: `计算结果：${input} = ${String(cleaned)}` }
}
