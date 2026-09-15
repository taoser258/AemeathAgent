// 工具中文名与人话描述：过程时间线/审批卡全是英文看不懂。
// 这里既验翻译本身，也守护「registry 新增工具必须补中文名」——否则界面上又会冒出裸英文。
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  TOOL_LABELS,
  keyArgOf,
  parseArgsLoose,
  summarizeToolCall,
  toolLabel,
  toolNameWithLabel
} from '../src/shared/tool-labels'

describe('工具中文名（tool-labels）', () => {
  it('内置工具：英文名后面跟中文注解', () => {
    expect(toolNameWithLabel('edit_file')).toBe('edit_file（改文件）')
    expect(toolNameWithLabel('run_shell')).toBe('run_shell（跑命令）')
    expect(toolLabel('write_file')).toBe('写文件')
  })

  it('MCP 外部工具：标注命名空间，不假装是内置工具', () => {
    expect(toolLabel('mcp__github__create_issue')).toBe('外部工具：github')
    expect(toolNameWithLabel('mcp__github__create_issue')).toContain('外部工具：github')
  })

  it('未知工具只回英文原名，不瞎编名字', () => {
    expect(toolLabel('some_future_tool')).toBe('')
    expect(toolNameWithLabel('some_future_tool')).toBe('some_future_tool')
  })

  it('★ registry 里每个工具都必须有中文名（新增工具忘补即挂）', () => {
    const src = readFileSync(join(__dirname, '..', 'src/main/agent/tools/registry.ts'), 'utf8')
    const names = [...src.matchAll(/^ {2}name: '([a-z_]+)',$/gm)].map((m) => m[1])
    expect(names.length).toBeGreaterThan(15)
    const missing = names.filter((n) => TOOL_LABELS[n] === undefined)
    expect(missing).toEqual([])
  })
})

describe('参数人话翻译（summarizeToolCall）', () => {
  it('完整 JSON：直取 path / command 等关键字段', () => {
    expect(summarizeToolCall('read_file', '{"path":"notes/today.md"}')).toBe(
      '读取「notes/today.md」的内容'
    )
    expect(summarizeToolCall('write_file', '{"path":"a.md","content":"hi"}')).toContain(
      '把内容写进「a.md」'
    )
    expect(summarizeToolCall('run_shell', '{"command":"npm test"}')).toContain('npm test')
  })

  it('edit_file：能数出改了几处就带上处数', () => {
    const args =
      '{"path":"a.ts","edits":[{"old_string":"x","new_string":"y"},{"old_string":"p","new_string":"q"}]}'
    expect(summarizeToolCall('edit_file', args)).toBe('改动「a.ts」里的内容（共 2 处）')
  })

  it('被截断的 120 字参数：退化为正则抠键值，仍能说出目标路径', () => {
    const truncated = '{"path":"C:\\\\work\\\\big.md","content":"# 标题\\n很长很长'
    expect(parseArgsLoose(truncated).json).toBeNull()
    expect(summarizeToolCall('write_file', truncated)).toBe(
      '把内容写进「C:\\\\work\\\\big.md」（整份文件）'
    )
  })

  it('超长命令截断到一眼能扫完的长度', () => {
    const long = `{"command":"${'x'.repeat(200)}"}`
    const out = summarizeToolCall('run_shell', long)
    expect(out.length).toBeLessThan(130)
    expect(out.endsWith('…')).toBe(true)
  })

  it('参数缺失时说通用话，未知工具返回空串（调用方退回原样显示）', () => {
    expect(summarizeToolCall('read_file', '{}')).toBe('读取文件内容')
    expect(summarizeToolCall('current_time', '{}')).toBe('看看现在几点')
    expect(summarizeToolCall('some_future_tool', '{"a":1}')).toBe('')
  })
})

describe('活动行关键参数（keyArgOf）', () => {
  it('只给目标，不重复造句', () => {
    expect(keyArgOf('run_shell', '{"command":"npm test"}')).toBe('npm test')
    expect(keyArgOf('write_file', '{"path":"notes/a.md","content":"x"}')).toBe('notes/a.md')
    expect(keyArgOf('search_content', '{"query":"鹈鹕"}')).toBe('鹈鹕')
    expect(keyArgOf('current_time', '{}')).toBe('')
  })

  it('超长参数截断（活动行是一行淡字，不能撑满屏）', () => {
    const out = keyArgOf('run_shell', `{"command":"${'y'.repeat(200)}"}`)
    expect(out.length).toBeLessThanOrEqual(61)
    expect(out.endsWith('…')).toBe(true)
  })
})
