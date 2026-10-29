// Lectura de la salida en streaming de las CLIs (JSON por línea). Módulo puro.

export interface StreamNote {
  kind: 'text' | 'tool' | 'error' | 'info'
  text: string
}

/** Junta trozos de stdout y emite líneas completas. */
export class LineSplitter {
  private buffer = ''
  private readonly onLine: (line: string) => void

  constructor(onLine: (line: string) => void) {
    this.onLine = onLine
  }

  push(chunk: string): void {
    this.buffer += chunk
    let idx = this.buffer.indexOf('\n')
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (line) this.onLine(line)
      idx = this.buffer.indexOf('\n')
    }
  }

  flush(): void {
    const line = this.buffer.trim()
    this.buffer = ''
    if (line) this.onLine(line)
  }
}

export function safeJson(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function short(text: unknown, max = 140): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function describeClaudeTool(name: string, input: Record<string, unknown>): string {
  const target =
    input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url ?? input.command ?? input.description
  if (name === 'TodoWrite' && Array.isArray(input.todos)) return `Plan: ${input.todos.length} pasos`
  return target ? `${name}: ${short(target, 100)}` : name
}

/** Resultado final de `claude -p --output-format stream-json`. */
export interface ClaudeResult {
  isError: boolean
  text: string
  structured?: unknown
  subtype?: string
}

export function readClaudeResult(event: Record<string, unknown>): ClaudeResult | null {
  if (event.type !== 'result') return null
  const isError = Boolean(event.is_error) || (typeof event.subtype === 'string' && event.subtype !== 'success')
  const text = typeof event.result === 'string' ? event.result : ''
  const errors = Array.isArray(event.errors) ? event.errors.map(String).join(' ') : ''
  return {
    isError,
    text: text || errors,
    structured: event.structured_output,
    subtype: typeof event.subtype === 'string' ? event.subtype : undefined
  }
}

/** Detecta que la suscripción de Claude llegó a su límite. */
export function readClaudeRateLimit(event: Record<string, unknown>): string | null {
  if (event.type !== 'rate_limit_event') return null
  const info = (event.rate_limit_info ?? {}) as Record<string, unknown>
  if (info.status !== 'rejected') return null
  const resets = Number(info.resetsAt)
  if (Number.isFinite(resets) && resets > 0) {
    const when = new Date(resets * (resets < 1e12 ? 1000 : 1))
    return `Llegaste al límite de uso de tu plan de Claude. Se reinicia a las ${when.toLocaleTimeString()}.`
  }
  return 'Llegaste al límite de uso de tu plan de Claude.'
}

/** Convierte un evento de Claude Code en notas legibles para el registro del agente. */
export function describeClaudeEvent(event: Record<string, unknown>): StreamNote[] {
  const notes: StreamNote[] = []
  if (event.type === 'system' && event.subtype === 'init') {
    notes.push({ kind: 'info', text: `Claude Code iniciado${event.model ? ` (${String(event.model)})` : ''}` })
  } else if (event.type === 'assistant') {
    const message = (event.message ?? {}) as Record<string, unknown>
    const content = Array.isArray(message.content) ? message.content : []
    for (const block of content as Record<string, unknown>[]) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        notes.push({ kind: 'text', text: block.text.trim() })
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        notes.push({ kind: 'tool', text: describeClaudeTool(block.name, (block.input ?? {}) as Record<string, unknown>) })
      }
    }
  } else if (event.type === 'user') {
    const message = (event.message ?? {}) as Record<string, unknown>
    const content = Array.isArray(message.content) ? message.content : []
    for (const block of content as Record<string, unknown>[]) {
      if (block.type === 'tool_result' && block.is_error) {
        const text = Array.isArray(block.content)
          ? (block.content as Record<string, unknown>[]).map((c) => c.text ?? '').join(' ')
          : block.content
        notes.push({ kind: 'error', text: short(text) || 'La herramienta falló' })
      }
    }
  } else {
    const limit = readClaudeRateLimit(event)
    if (limit) notes.push({ kind: 'error', text: limit })
  }
  return notes
}

/** Convierte un evento JSONL de `codex exec --json` en notas legibles. */
export function describeCodexEvent(event: Record<string, unknown>): StreamNote[] {
  const type = event.type
  if (type === 'error') return [{ kind: 'error', text: short(event.message) }]
  if (type === 'turn.failed') {
    const err = (event.error ?? {}) as Record<string, unknown>
    return [{ kind: 'error', text: short(err.message ?? 'La tarea falló') }]
  }
  if (type === 'thread.started') return [{ kind: 'info', text: 'Codex iniciado' }]
  if (type !== 'item.completed' && type !== 'item.started') return []
  const item = (event.item ?? {}) as Record<string, unknown>
  const started = type === 'item.started'
  switch (item.type) {
    case 'agent_message':
      return started || !item.text ? [] : [{ kind: 'text', text: String(item.text).trim() }]
    case 'command_execution':
      return started
        ? [{ kind: 'tool', text: `Ejecutando: ${short(item.command, 100)}` }]
        : Number(item.exit_code ?? 0) !== 0
          ? [{ kind: 'error', text: `El comando terminó con código ${String(item.exit_code)}` }]
          : []
    case 'file_change': {
      if (started) return []
      const changes = Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]) : []
      return changes.map((c) => ({ kind: 'tool' as const, text: `${String(c.kind ?? 'cambio')}: ${short(c.path, 100)}` }))
    }
    case 'web_search':
      return started ? [] : [{ kind: 'tool', text: `Búsqueda web: ${short(item.query, 100)}` }]
    case 'mcp_tool_call':
      return started ? [] : [{ kind: 'tool', text: `${String(item.server ?? 'mcp')}: ${String(item.tool ?? '')}` }]
    case 'todo_list': {
      if (started) return []
      const items = Array.isArray(item.items) ? item.items : []
      return [{ kind: 'info', text: `Plan: ${items.length} pasos` }]
    }
    case 'error':
      return started ? [] : [{ kind: 'error', text: short(item.message) }]
    default:
      return []
  }
}

/** Último mensaje del agente en un flujo de Codex. */
export function readCodexMessage(event: Record<string, unknown>): string | null {
  if (event.type !== 'item.completed') return null
  const item = (event.item ?? {}) as Record<string, unknown>
  return item.type === 'agent_message' && typeof item.text === 'string' ? item.text : null
}

export function readCodexError(event: Record<string, unknown>): string | null {
  if (event.type === 'turn.failed') {
    const err = (event.error ?? {}) as Record<string, unknown>
    return String(err.message ?? 'La petición a Codex falló')
  }
  if (event.type === 'error' && typeof event.message === 'string' && !/^Reconnecting/i.test(event.message)) {
    return event.message
  }
  return null
}
