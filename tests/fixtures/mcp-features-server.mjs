// 测试夹具：覆盖"动态行为"——env 传递、崩溃、工具清单变更通知、注解优先级。
// 与 mcp-echo-server.mjs 分开：那个是 P2 的稳定基线，这个专门给 的稳定性测试用。
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

/** 运行期动态追加的工具（list_changed 测试用） */
const dynamicTools = []

const BASE_TOOLS = [
  {
    name: 'report_env',
    description: '回报指定环境变量的值（测 env 是否真的传进了子进程）',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '环境变量名' } },
      required: ['name']
    }
  },
  {
    name: 'read_info',
    description: '只读信息（readOnlyHint=true）',
    inputSchema: { type: 'object', properties: {}, required: [] },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'danger',
    description: '自相矛盾的注解：同时标 readOnly 与 destructive（测优先级）',
    inputSchema: { type: 'object', properties: {}, required: [] },
    // ★ 关键：第三方 server 可能这样标注。客户端必须按 destructive 处理（保守）
    annotations: { readOnlyHint: true, destructiveHint: true }
  },
  {
    name: 'crash',
    description: '直接退出进程（测崩溃隔离与自动重连）',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'add_dynamic',
    description: '新增一个工具并发出 tools/list_changed 通知（测工具清单热更新）',
    inputSchema: { type: 'object', properties: {}, required: [] }
  }
]

const server = new Server(
  { name: 'features-fixture', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...BASE_TOOLS, ...dynamicTools]
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name
  if (name === 'report_env') {
    const varName = String(request.params.arguments?.name ?? '')
    return {
      content: [{ type: 'text', text: `env[${varName}]=${process.env[varName] ?? '(未设置)'}` }]
    }
  }
  if (name === 'read_info') {
    return { content: [{ type: 'text', text: 'ok' }] }
  }
  if (name === 'danger') {
    return { content: [{ type: 'text', text: 'danger 已执行' }] }
  }
  if (name === 'add_dynamic') {
    dynamicTools.push({
      name: 'dynamic_tool',
      description: '动态新增的工具',
      inputSchema: { type: 'object', properties: {}, required: [] }
    })
    // 通知客户端工具清单变了
    await server.notification({ method: 'notifications/tools/list_changed' })
    return { content: [{ type: 'text', text: '已新增 dynamic_tool' }] }
  }
  if (name === 'crash') {
    // 延迟一点点再退出，保证调用响应能发出去（模拟"跑着跑着挂了"）
    setTimeout(() => process.exit(1), 50)
    return { content: [{ type: 'text', text: '即将退出' }] }
  }
  return { content: [{ type: 'text', text: `未知工具 ${name}` }], isError: true }
})

const transport = new StdioServerTransport()
await server.connect(transport)
