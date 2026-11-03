// Servidor MCP mínimo (JSON-RPC 2.0) para que Claude Code, como orquestador, use las herramientas
// rápidas de Buddy: mirar la pantalla, comprobar con Jev, hacer clic, escribir y ejecutar rutinas.
// Solo la parte del protocolo; el transporte HTTP está en main/mcp-server.ts. Módulo puro.

export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const

export type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface McpToolResult {
  content: McpContent[]
  isError?: boolean
}

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** Se marca como de solo lectura para el cliente (no cambia nada en tu equipo). */
  readOnly?: boolean
  handler: (args: Record<string, unknown>, signal: AbortSignal) => Promise<McpToolResult>
}

export interface McpServerInfo {
  name: string
  version: string
  instructions?: string
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } }

export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603
} as const

function error(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

export function textResult(text: string, isError = false): McpToolResult {
  return isError ? { content: [{ type: 'text', text }], isError } : { content: [{ type: 'text', text }] }
}

/**
 * Crea el despachador. Devuelve la respuesta, o null si el mensaje era una notificación.
 * `getTools` se llama en cada petición, así las herramientas dependen de los ajustes actuales.
 */
export function createMcpDispatcher(info: McpServerInfo, getTools: () => McpTool[]) {
  return async function dispatch(message: unknown, signal: AbortSignal = new AbortController().signal): Promise<JsonRpcResponse | null> {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return error(null, RPC_ERRORS.invalidRequest, 'Invalid request')
    }
    const req = message as Partial<JsonRpcRequest>
    const isNotification = !('id' in req) || req.id === undefined
    const id = (req.id ?? null) as string | number | null
    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      return isNotification ? null : error(id, RPC_ERRORS.invalidRequest, 'Invalid request')
    }
    // Las notificaciones (initialized, cancelled…) no llevan respuesta.
    if (isNotification) return null

    const params = (req.params && typeof req.params === 'object' ? req.params : {}) as Record<string, unknown>
    switch (req.method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
        const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0]
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: info.name, version: info.version },
            ...(info.instructions ? { instructions: info.instructions } : {})
          }
        }
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: getTools().map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              ...(t.readOnly !== undefined ? { annotations: { readOnlyHint: t.readOnly } } : {})
            }))
          }
        }
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : ''
        const tool = getTools().find((t) => t.name === name)
        if (!tool) return error(id, RPC_ERRORS.invalidParams, `Unknown tool: ${name}`)
        const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>
        try {
          return { jsonrpc: '2.0', id, result: await tool.handler(args, signal) }
        } catch (err) {
          // Los fallos de una herramienta se devuelven como resultado con isError para que el modelo los vea.
          return { jsonrpc: '2.0', id, result: textResult(err instanceof Error ? err.message : String(err), true) }
        }
      }
      default:
        return error(id, RPC_ERRORS.methodNotFound, `Method not found: ${req.method}`)
    }
  }
}

/** Lee un argumento de texto (obligatorio u opcional). */
export function argString(args: Record<string, unknown>, key: string, required = true, max = 2000): string {
  const v = args[key]
  if (typeof v === 'string' && v.trim()) return v.trim().slice(0, max)
  if (required) throw new Error(`Falta el argumento "${key}".`)
  return ''
}

export function argNumber(args: Record<string, unknown>, key: string): number | null {
  const v = args[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
