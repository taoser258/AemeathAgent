// 最小 MCP stdio server：一个 echo 工具，验证真实 MCP 连接/清单/调用。
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'echo-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: '回显输入文本（变更类：无 readOnlyHint 注解，按需审批）',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: '要回显的文本' } },
        required: ['text']
      }
    },
    {
      name: 'read_info',
      description: '返回 server 自我介绍（只读：带 readOnlyHint 注解，免审批分级用）',
      inputSchema: { type: 'object', properties: {}, required: [] },
      annotations: { readOnlyHint: true }
    }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'read_info') {
    return { content: [{ type: 'text', text: 'echo-fixture 只读信息：ok' }] }
  }
  const text = String(request.params.arguments?.text ?? '')
  return { content: [{ type: 'text', text: `echo: ${text}` }] }
})

const transport = new StdioServerTransport()
await server.connect(transport)
