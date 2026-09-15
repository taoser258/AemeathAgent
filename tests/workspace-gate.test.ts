import { describe, expect, it } from 'vitest'
import {
  boundWorkspace,
  checkWorkspace,
  modeLabel,
  modeNeedsWorkspace
} from '../src/shared/workspace'
import type { AppConfig } from '../src/shared/types'

type Workspace = AppConfig['workspace']

const UNBOUND: Workspace = { work: null, learn: null }
const BOUND: Workspace = { work: 'E:\\proj\\work', learn: null }

/** 注入式存在性判定：只认白名单里的路径，模拟"目录还在不在" */
const existsIn =
  (paths: string[]) =>
  (dir: string): boolean =>
    paths.includes(dir)

describe('工作区门槛', () => {
  it('工作 / 学习模式需要工作区；对话模式无工具，天然不需要', () => {
    expect(modeNeedsWorkspace('work')).toBe(true)
    expect(modeNeedsWorkspace('learn')).toBe(true)
    expect(modeNeedsWorkspace('chat')).toBe(false)
  })

  it('模式名与界面文案一致', () => {
    expect(modeLabel('work')).toBe('工作')
    expect(modeLabel('learn')).toBe('学习')
    expect(modeLabel('chat')).toBe('对话')
  })

  it('boundWorkspace 取对应模式的绑定；对话模式恒为 null（不误用工作模式的目录）', () => {
    expect(boundWorkspace(BOUND, 'work')).toBe('E:\\proj\\work')
    expect(boundWorkspace({ work: null, learn: 'E:\\proj\\learn' }, 'learn')).toBe(
      'E:\\proj\\learn'
    )
    expect(boundWorkspace(UNBOUND, 'work')).toBeNull()
    // chat 即便 work 有绑定也不算数——对话模式没有工具，工作区对它无意义
    expect(boundWorkspace(BOUND, 'chat')).toBeNull()
  })

  it('★ 纯空白字符串视同未绑定（手改 app.json 塞空格不能绕过门槛）', () => {
    expect(boundWorkspace({ work: '   ', learn: '\t' }, 'work')).toBeNull()
    expect(boundWorkspace({ work: '   ', learn: null }, 'learn')).toBeNull()
    expect(checkWorkspace({ work: '   ', learn: null }, 'work', () => true).ok).toBe(false)
  })

  it('未绑定 → 拦住，并给出可照做的指引（含模式名与去哪里绑）', () => {
    const gate = checkWorkspace(UNBOUND, 'work', () => true)
    expect(gate.ok).toBe(false)
    if (gate.ok) return
    expect(gate.code).toBe('workspace-missing')
    expect(gate.error).toContain('工作模式')
    expect(gate.error).toContain('设置 → 目录')
  })

  it('★ 对话模式不被拦：即使两个模式的绑定都是空', () => {
    expect(checkWorkspace(UNBOUND, 'chat', () => false)).toEqual({ ok: true })
  })

  it('已绑定且目录存在 → 放行', () => {
    expect(checkWorkspace(BOUND, 'work', existsIn(['E:\\proj\\work']))).toEqual({ ok: true })
  })

  it('★ 绑定的目录被删/挪走 → 拦住并提示重绑（而不是让工具在坏基准上静默失败）', () => {
    const gate = checkWorkspace(BOUND, 'work', () => false)
    expect(gate.ok).toBe(false)
    if (gate.ok) return
    expect(gate.code).toBe('workspace-invalid')
    expect(gate.error).toContain('E:\\proj\\work')
    expect(gate.error).toContain('重新绑定')
  })

  it('学习模式独立判定：工作模式绑了不影响学习模式仍被拦', () => {
    const gate = checkWorkspace(BOUND, 'learn', () => true)
    expect(gate.ok).toBe(false)
    if (gate.ok) return
    expect(gate.code).toBe('workspace-missing')
    expect(gate.error).toContain('学习模式')
  })

  it('存盘值两端带空格时按 trim 后的路径判定（不许因空格误报目录不存在）', () => {
    const padded: Workspace = { work: '  E:\\proj\\work  ', learn: null }
    expect(boundWorkspace(padded, 'work')).toBe('E:\\proj\\work')
    expect(checkWorkspace(padded, 'work', existsIn(['E:\\proj\\work']))).toEqual({ ok: true })
  })
})
