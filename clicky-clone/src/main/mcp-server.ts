// Transporte HTTP (Streamable HTTP, solo JSON) del servidor MCP de Buddy. Escucha en 127.0.0.1 con
// un token aleatorio por sesión de la app: solo el Claude Code que lanza Buddy lo conoce.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createMcpDispatcher, RPC_ERRORS, type McpServerInfo, type McpTool } from './core/mcp.ts'

const MAX_BODY = 4 * 1024 * 1024

export class BuddyMcpServer {
  private server: Server | null = null
  private port = 0
  private readonly token = randomBytes(24).toString('hex')
  private readonly dispatch: ReturnType<typeof createMcpDispatcher>

  constructor(info: McpServerInfo, getTools: () => McpTool[]) {
    this.dispatch = createMcpDispatcher(info, getTools)
  }

  /** Arranca (si no lo estaba) y devuelve la URL. */
  async start(): Promise<string> {
    if (this.server) return this.url
    const server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    this.server = server
    this.port = (server.address() as AddressInfo).port
    return this.url
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`
  }

  /** Configuración para `claude --mcp-config`. */
  config(): string {
    return JSON.stringify({
      mcpServers: { buddy: { type: 'http', url: this.url, headers: { Authorization: `Bearer ${this.token}` } } }
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers })
      res.end(body !== undefined ? JSON.stringify(body) : undefined)
    }
    if (!req.url?.startsWith('/mcp')) return send(404, { error: 'not found' })
    if (req.headers.authorization !== `Bearer ${this.token}`) return send(401, { error: 'unauthorized' })
    // Protección contra DNS rebinding: un navegador manda Origin; Claude Code no.
    const origin = req.headers.origin
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) return send(403, { error: 'forbidden origin' })
    if (req.method === 'GET') return send(405, undefined, { allow: 'POST, DELETE' })
    if (req.method === 'DELETE') return send(200, {})
    if (req.method !== 'POST') return send(405, undefined, { allow: 'POST, DELETE' })

    let body = ''
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY) return send(413, { error: 'too large' })
      body += (chunk as Buffer).toString('utf8')
    }
    let message: unknown
    try {
      message = JSON.parse(body)
    } catch {
      return send(400, { jsonrpc: '2.0', id: null, error: { code: RPC_ERRORS.parse, message: 'Parse error' } })
    }
    // Si Claude Code se cancela a mitad de una herramienta, avisamos a la herramienta.
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) controller.abort()
    })
    const messages = Array.isArray(message) ? message : [message]
    const responses = (await Promise.all(messages.map((m) => this.dispatch(m, controller.signal)))).filter((r) => r !== null)
    const isInit = messages.some((m) => (m as { method?: unknown })?.method === 'initialize')
    const headers: Record<string, string> = isInit ? { 'mcp-session-id': randomUUID() } : {}
    if (responses.length === 0) return send(202, undefined, headers)
    send(200, Array.isArray(message) ? responses : responses[0], headers)
  }
}
