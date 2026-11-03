import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { argString, createMcpDispatcher, MCP_PROTOCOL_VERSIONS, textResult, type McpTool } from '../src/main/core/mcp.ts'

const tools: McpTool[] = [
  {
    name: 'screen_check',
    description: 'Comprueba algo en la pantalla',
    inputSchema: { type: 'object', properties: { condition: { type: 'string' } }, required: ['condition'] },
    readOnly: true,
    handler: async (args) => textResult(`probabilidad de "${argString(args, 'condition')}": 0.9`)
  },
  {
    name: 'boom',
    description: 'Falla',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      throw new Error('se rompió')
    }
  }
]

const dispatch = createMcpDispatcher({ name: 'buddy', version: '1.0.0', instructions: 'Usa las herramientas.' }, () => tools)

describe('MCP', () => {
  it('negocia la versión del protocolo', async () => {
    const res = (await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } })) as {
      result: { protocolVersion: string; serverInfo: { name: string }; capabilities: unknown; instructions: string }
    }
    assert.equal(res.result.protocolVersion, '2025-06-18')
    assert.equal(res.result.serverInfo.name, 'buddy')
    assert.deepEqual(res.result.capabilities, { tools: { listChanged: false } })
    const other = (await dispatch({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })) as {
      result: { protocolVersion: string }
    }
    assert.equal(other.result.protocolVersion, MCP_PROTOCOL_VERSIONS[0])
  })

  it('no responde a las notificaciones', async () => {
    assert.equal(await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
  })

  it('lista y llama herramientas', async () => {
    const list = (await dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/list' })) as { result: { tools: { name: string; annotations?: unknown }[] } }
    assert.deepEqual(
      list.result.tools.map((t) => t.name),
      ['screen_check', 'boom']
    )
    assert.deepEqual(list.result.tools[0].annotations, { readOnlyHint: true })
    const call = (await dispatch({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'screen_check', arguments: { condition: 'un botón' } } })) as {
      result: { content: { text: string }[] }
    }
    assert.equal(call.result.content[0].text, 'probabilidad de "un botón": 0.9')
  })

  it('devuelve los fallos de herramientas como resultado con isError', async () => {
    const failed = (await dispatch({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'boom' } })) as { result: { isError: boolean; content: { text: string }[] } }
    assert.equal(failed.result.isError, true)
    assert.equal(failed.result.content[0].text, 'se rompió')
    const missing = (await dispatch({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'screen_check', arguments: {} } })) as {
      result: { isError: boolean; content: { text: string }[] }
    }
    assert.match(missing.result.content[0].text, /Falta el argumento "condition"/)
  })

  it('responde errores JSON-RPC para peticiones inválidas', async () => {
    assert.deepEqual(await dispatch({ jsonrpc: '2.0', id: 7, method: 'nada' }), { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Method not found: nada' } })
    assert.deepEqual(await dispatch({ id: 8, method: 'ping' }), { jsonrpc: '2.0', id: 8, error: { code: -32600, message: 'Invalid request' } })
    assert.deepEqual(await dispatch({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope' } }), {
      jsonrpc: '2.0',
      id: 9,
      error: { code: -32602, message: 'Unknown tool: nope' }
    })
    assert.deepEqual(await dispatch({ jsonrpc: '2.0', id: 10, method: 'ping' }), { jsonrpc: '2.0', id: 10, result: {} })
  })
})
