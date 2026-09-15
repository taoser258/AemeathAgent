// 人设目录加载（有 IO，因此与 buildSystemPrompt 纯函数分离；）。
// 契约：新增人设 = 在 personas/ 下新建目录（soul.md + style.md），不改任何代码。
// 本文件不 import electron：目录由调用方传入（paths.personasDir() 依赖 app），
// 单测用 fixtures 目录即可。

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { PersonaFiles } from './prompt'

/** 列出可用人设名（目录名按字典序）；目录不存在返回空表 */
export function listPersonas(baseDir: string): string[] {
  try {
    return readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * 读取人设两件套；任一文件缺失返回 null（调用方给出可读错误，不让应用崩）。
 * 文件读取失败（编码损坏等）同样返回 null，而不是抛异常。
 */
export function loadPersona(baseDir: string, name: string): PersonaFiles | null {
  const dir = join(baseDir, name)
  const soulPath = join(dir, 'soul.md')
  const stylePath = join(dir, 'style.md')
  if (!existsSync(soulPath) || !existsSync(stylePath)) return null
  try {
    return {
      soul: readFileSync(soulPath, 'utf8'),
      style: readFileSync(stylePath, 'utf8')
    }
  } catch {
    return null
  }
}
