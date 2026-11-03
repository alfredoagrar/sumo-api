import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { textResult } from '../src/main/core/mcp.ts'
import { BuddyMcpServer } from '../src/main/mcp-server.ts'

describe('servidor MCP por HTTP', () => {
  const server = new BuddyMcpServer({ name: 'buddy', version: '1.0.0' }, () => [
    { name: 'say', description: 'Di algo', inputSchema: { type: 'object' }, handler: async (args) => textResult(`dicho: ${String(args.text)}`) }
  ])
  let url = ''
  let auth = ''

  before(async () => {
    url = await server.start()
    const config = JSON.parse(server.config()) as { mcpServers: { buddy: { type: string; url: string; headers: { Authorization: string } } } }
    assert.equal(config.mcpServers.buddy.type, 'http')
    assert.equal(config.mcpServers.buddy.url, url)
    auth = config.mcpServers.buddy.headers.Authorization
  })
  after(() => server.stop())

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: auth, ...headers }, body: JSON.stringify(body) })

  it('escucha solo en 127.0.0.1 y exige el token', async () => {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    const res = await fetch(url, { method: 'POST', body: '{}' })
    assert.equal(res.status, 401)
  })

  it('rechaza peticiones de páginas web (Origin ajeno)', async () => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' })
    assert.equal(res.status, 403)
  })

  it('inicializa, acepta notificaciones y llama herramientas', async () => {
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
    assert.equal(init.status, 200)
    assert.ok(init.headers.get('mcp-session-id'))
    assert.equal(((await init.json()) as { result: { protocolVersion: string } }).result.protocolVersion, '2025-06-18')

    const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    assert.equal(note.status, 202)

    const call = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'say', arguments: { text: 'hola' } } })
    assert.deepEqual(await call.json(), { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'dicho: hola' }] } })
  })

  it('no abre un flujo SSE y responde errores de JSON', async () => {
    assert.equal((await fetch(url, { headers: { authorization: auth } })).status, 405)
    const bad = await fetch(url, { method: 'POST', headers: { authorization: auth }, body: '{no es json' })
    assert.equal(bad.status, 400)
  })
})
