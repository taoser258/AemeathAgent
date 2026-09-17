// 本地 OCR（P8-T3 第二条腿）：用 Windows 自带的 Windows.Media.Ocr 逐字识别图片文字。
//
// 为什么要有这条腿（owner 拍板"两者都要"）：两条腿的**失败模式互补**——
// 云端视觉模型擅长版面与语义，但会把长数字读错（P7-T4 的事故来源）；
// 本机 OCR 是逐字识别、不联网、不上传，数字/编号更可靠，但不懂版面。
// 两条一起给，互证才站得住：**同一张图两边结果打架时必须把冲突点出来**。
//
// 约束：图一进来**只跑视觉旁路**（默认那条腿），本工具由她按需调用——
// 自动两条都跑 = 双倍成本 + 双份噪声。
//
// 实现走"探针注入"（与 tools/screen.ts 同款）：本文件不含任何真实 Windows 调用，
// 真实实现（windowsOcrProbe）由主进程 ready 时注入，单测注入假探针。
// 引擎侧用 PowerShell 起 WinRT（Windows.Media.Ocr 是 Win10+ 系统内置，支持中文），
// **不引任何 Node 原生模块、不增安装包体积**；图片路径走环境变量传递，
// 规避路径里空格/引号的转义坑；输出 base64(UTF8) 规避控制台编码坑。

import { spawn } from 'child_process'

/** 探针超时：首次加载 WinRT 组件较慢，留足余量 */
export const OCR_PROBE_TIMEOUT_MS = 20_000

let probe: ((absPath: string) => Promise<OcrPayload>) | null = null

/** 注入真实探针（main ready 时注入 PowerShell 实现；单测注入假探针） */
export function setOcrProbe(fn: ((absPath: string) => Promise<OcrPayload>) | null): void {
  probe = fn
}

export function isOcrReady(): boolean {
  return probe !== null
}

/** 单行 OCR 结果（x/y/w/h 是像素边界框，用于判断"左右并排"这类版面关系） */
export interface OcrLine {
  text: string
  x: number
  y: number
  w: number
  h: number
}

export interface OcrPayload {
  /** 实际使用的识别语言标签（如 zh-Hans-CN） */
  lang: string
  width: number
  height: number
  lines: OcrLine[]
}

// ── 防御校验与纯逻辑（可单测）────────────────────────────────────────────

/** 从 payload 里取数字字段：非数字/非有限一律 0（脏数据不该让排版判断崩掉） */
function toNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** 从探针输出解析 payload；结构不对一律 null（不把脏数据当识别结果） */
export function parseOcrPayload(raw: string): OcrPayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Record<string, unknown>
  if (!Array.isArray(p.lines)) return null
  const lines: OcrLine[] = []
  for (const item of p.lines) {
    if (typeof item !== 'object' || item === null) continue
    const l = item as Record<string, unknown>
    if (typeof l.text !== 'string') continue
    lines.push({
      text: l.text,
      x: toNum(l.x),
      y: toNum(l.y),
      w: toNum(l.w),
      h: toNum(l.h)
    })
  }
  return {
    lang: typeof p.lang === 'string' ? p.lang : '未知',
    width: toNum(p.width),
    height: toNum(p.height),
    lines
  }
}

/** CJK 表意文字（含扩展 A 与兼容区） */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
/** CJK 标点与全角符号（：、。，！？（）「」；．也算，OCR 常把 . 认成全角） */
const CJK_PUNCT = /[\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/

/**
 * 去汉字之间被 OCR 塞进去的空格。
 * 实测（Win10 zh-Hans-CN 引擎）："月营收" 会被识别成 "月 营 收"——
 * 照原样喂给模型会明显影响可读性与引用（她抄出来的引文全是空格）。
 * **只删安全的位置**：两侧都是 CJK，或任一侧是 CJK 标点；
 * 中英/中数之间的空格保留（"月营收 12348 元" 更好读）。
 */
export function normalizeOcrSpacing(text: string): string {
  return text.replace(
    /(\S) (?=\S)/g,
    (match: string, before: string, offset: number, all: string) => {
      const after = all[offset + 2] ?? ''
      const drop =
        (CJK.test(before) && CJK.test(after)) || CJK_PUNCT.test(before) || CJK_PUNCT.test(after)
      return drop ? before : match
    }
  )
}

/**
 * 版面提示：找出"左右并排"的相邻行（y 区间重叠、x 区间水平不相交）。
 * 为什么要管：双栏排版被 OCR 拍平成行列表时，模型会把它当一行的前后半句读，
 * 结论就错了。这里只报事实（哪几行并排），不替她猜顺序。
 */
export function findSideBySidePairs(p: OcrPayload): Array<[number, number]> {
  const pairs: Array<[number, number]> = []
  for (let i = 0; i + 1 < p.lines.length; i += 1) {
    const a = p.lines[i]
    const b = p.lines[i + 1]
    const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
    const horizontalGap = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w)
    if (overlapY > 0.5 * Math.min(a.h, b.h) && horizontalGap > p.width * 0.1) {
      pairs.push([i + 1, i + 2]) // 1-based 行号（对模型说话用行号）
    }
  }
  return pairs
}

/** 识别结果 → 给模型看的文本（纯函数，可单测） */
export function formatOcrResult(p: OcrPayload): string {
  const head = `【本机 OCR 逐字识别 · ${p.lang}】图片 ${p.width}×${p.height}，识别到 ${p.lines.length} 行文字：`
  if (p.lines.length === 0) {
    return `${head}\n（没有识别出任何文字——可能是纯图形/照片，或文字太小、太模糊、倾斜过度。）`
  }
  const body = p.lines.map((l, i) => `${i + 1}. ${normalizeOcrSpacing(l.text).trim()}`).join('\n')
  const pairs = findSideBySidePairs(p)
  const layout =
    pairs.length === 0
      ? ''
      : `\n（版面提示：第 ${pairs.map(([a, b]) => `${a} 与 ${b}`).join('、')} 行是**左右并排**的，不是同一行的前后半句——按行分别理解。）`
  return (
    `${head}\n${body}${layout}\n` +
    '（逐字识别仍可能错认个别字符：关键数字/编号请与用户核对；' +
    '若与 describe_image 的转述不一致，把两边的结果都摆出来让用户定。）'
  )
}

// ── 真实探针（PowerShell + WinRT；不参与单测）───────────────────────────

/**
 * PowerShell 脚本（实测通过：Win10 22H2 / zh-Hans-CN / 中文+数字混排均正确）。
 * 要点：① WinRT 异步方法要用 AsTask 包装后 Wait；② 语言优先级 zh-Hans-CN → zh-Hans
 * → en-US → 用户配置语言；③ 全部不可用时报 OCR_UNAVAILABLE 并列出已装语言；
 * ④ 末行输出 base64(UTF8 JSON)，前面所有噪声（Add-Type 警告等）都不影响取数。
 */
const PS_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$ImagePath=$env:AEMEATH_OCR_IMAGE',
  "if(-not (Test-Path -LiteralPath $ImagePath)){Write-Error 'OCR_NO_FILE';exit 1}",
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  "$asTaskGeneric=([System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'})[0]",
  'function Await($t,$rt){$at=$asTaskGeneric.MakeGenericMethod($rt);$nt=$at.Invoke($null,@($t));$nt.Wait(-1)|Out-Null;$nt.Result}',
  '[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]|Out-Null',
  '[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]|Out-Null',
  '[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null',
  '[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]|Out-Null',
  '$engine=$null',
  'foreach($tag in @("zh-Hans-CN","zh-Hans","en-US")){try{$lang=New-Object Windows.Globalization.Language $tag}catch{$lang=$null};if($lang -ne $null){$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang);if($engine -ne $null){break}}}',
  'if($engine -eq $null){$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()}',
  'if($engine -eq $null){$avail=([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages|ForEach-Object{$_.LanguageTag}) -join ",";Write-Error "OCR_UNAVAILABLE $avail";exit 2}',
  '$file=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])',
  '$stream=Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
  '$decoder=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
  '$bitmap=Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
  '$result=Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
  '$lines=@()',
  'foreach($line in $result.Lines){$xs=@();$ys=@();$xe=@();$ye=@();foreach($w in $line.Words){$r=$w.BoundingRect;$xs+=$r.X;$ys+=$r.Y;$xe+=($r.X+$r.Width);$ye+=($r.Y+$r.Height)};$x=[int](($xs|Measure-Object -Minimum).Minimum);$y=[int](($ys|Measure-Object -Minimum).Minimum);$lines+=[pscustomobject]@{text=$line.Text;x=$x;y=$y;w=[int](($xe|Measure-Object -Maximum).Maximum-$x);h=[int](($ye|Measure-Object -Maximum).Maximum-$y)}}',
  '$payload=[pscustomobject]@{lang=$engine.RecognizerLanguage.LanguageTag;width=$bitmap.PixelWidth;height=$bitmap.PixelHeight;lines=$lines}',
  '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($payload|ConvertTo-Json -Depth 4 -Compress)))'
].join('\n')

/**
 * Windows 真实 OCR 探针：起 PowerShell 跑一次 WinRT OCR，返回分页行数据。
 * 失败一律抛出可读中文（工具层会收敛成 failed 回灌给模型）。
 */
export function windowsOcrProbe(absPath: string): Promise<OcrPayload> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
      { windowsHide: true, env: { ...process.env, AEMEATH_OCR_IMAGE: absPath } }
    )
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error('本机 OCR 超时（Windows 识别引擎没有在预期时间内返回）。'))
    }, OCR_PROBE_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`无法启动本机 OCR（${err.message}）；本功能依赖 Windows 自带的识别引擎。`))
    })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (/OCR_NO_FILE/.test(stderr)) {
        reject(new Error('图片文件不存在或读不到（路径含特殊字符时也可能这样）。'))
        return
      }
      if (/OCR_UNAVAILABLE/.test(stderr)) {
        const avail = /OCR_UNAVAILABLE\s*(.*)/.exec(stderr)?.[1]?.trim() ?? ''
        reject(
          new Error(
            `本机没有可用的 OCR 语言包${avail === '' ? '' : `（已装：${avail}）`}——` +
              '请在 Windows 设置 → 时间和语言 → 语言和区域 里为中文添加「可选语言功能 → 光学字符识别」。'
          )
        )
        return
      }
      const raw = stdout.trim().split(/\r?\n/).pop() ?? ''
      if (raw === '') {
        reject(new Error('本机 OCR 没有返回结果（识别引擎异常退出）。'))
        return
      }
      try {
        const payload = parseOcrPayload(Buffer.from(raw, 'base64').toString('utf8'))
        if (payload === null) {
          reject(new Error('本机 OCR 输出格式异常，无法解析。'))
          return
        }
        resolve(payload)
      } catch (err) {
        reject(
          new Error(`本机 OCR 输出解析失败：${err instanceof Error ? err.message : String(err)}`)
        )
      }
    })
  })
}

/** 识图工具的调用入口（注入探针未就绪时报可读错误） */
export async function runOcr(absPath: string): Promise<string> {
  if (probe === null) {
    throw new Error('本机 OCR 尚未就绪（应用还在启动中），请稍后重试，或先用 describe_image 识图。')
  }
  return formatOcrResult(await probe(absPath))
}
