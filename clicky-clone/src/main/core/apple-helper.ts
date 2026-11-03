// Cliente del ayudante nativo de macOS (ver apple-protocol.ts). Sin Electron, para poder probarlo
// con un ayudante simulado. Arranca el proceso cuando hace falta y lo reinicia si se cierra, salvo
// que se cierre una y otra vez.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { LineSplitter, safeJson } from './streams.ts'

export class HelperError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'HelperError'
  }
}

export interface AppleHelperOptions {
  command: string
  args?: string[]
  env?: Record<string, string>
  /** Tiempo máximo por petición, salvo que la petición indique otro. */
  timeoutMs?: number
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
  cleanup: () => void
}

const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 60_000

export class AppleHelper extends EventEmitter {
  private readonly opts: AppleHelperOptions
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private exits: number[] = []
  private failure: string | null = null
  private stopping = false

  constructor(opts: AppleHelperOptions) {
    super()
    this.opts = opts
  }

  get running(): boolean {
    return this.child !== null
  }

  /** Por qué el ayudante dejó de estar disponible (se cerró varias veces o no existe). */
  get broken(): string | null {
    return this.failure
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child
    if (this.failure) throw new HelperError('unavailable', this.failure)
    this.stopping = false
    const child = spawn(this.opts.command, this.opts.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.opts.env ?? (process.env as Record<string, string>)
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const lines = new LineSplitter((line) => this.onLine(line))
    child.stdout.on('data', (chunk: string) => lines.push(chunk))
    child.stderr.on('data', (chunk: string) => this.emit('stderr', chunk))
    child.stdin.on('error', () => {
      // El proceso pudo cerrarse; lo gestiona 'exit'.
    })
    child.on('error', (err) => {
      this.failure = `No se pudo iniciar el ayudante de macOS: ${err.message}`
      this.onExit(null)
    })
    child.on('exit', (code) => this.onExit(code))
    return child
  }

  private onExit(code: number | null): void {
    if (!this.child) return
    this.child = null
    for (const p of this.pending.values()) {
      p.cleanup()
      p.reject(new HelperError('internal', this.failure ?? 'El ayudante de macOS se cerró.'))
    }
    this.pending.clear()
    if (!this.stopping) {
      const now = Date.now()
      this.exits = [...this.exits.filter((t) => now - t < RESTART_WINDOW_MS), now]
      if (this.exits.length >= MAX_RESTARTS && !this.failure) {
        this.failure = 'El ayudante de macOS se cerró varias veces seguidas.'
      }
    }
    this.emit('exit', code)
  }

  private onLine(line: string): void {
    const msg = safeJson(line)
    if (!msg) return
    if (typeof msg.event === 'string') {
      this.emit('event', msg.event, (msg.params ?? {}) as Record<string, unknown>)
      return
    }
    const id = typeof msg.id === 'number' ? msg.id : null
    if (id === null) return
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    p.cleanup()
    if (msg.error && typeof msg.error === 'object') {
      const e = msg.error as { code?: unknown; message?: unknown }
      p.reject(new HelperError(typeof e.code === 'string' ? e.code : 'internal', typeof e.message === 'string' ? e.message : 'Error del ayudante'))
    } else {
      p.resolve(msg.result ?? {})
    }
  }

  private write(msg: Record<string, unknown>): void {
    const child = this.ensure()
    child.stdin.write(`${JSON.stringify(msg)}\n`)
  }

  request<T>(method: string, params: object = {}, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (o.signal?.aborted) {
        reject(new HelperError('cancelled', 'Cancelado'))
        return
      }
      const id = this.nextId++
      const onAbort = (): void => {
        if (!this.pending.has(id)) return
        this.pending.get(id)?.cleanup()
        this.pending.delete(id)
        try {
          this.write({ method: 'cancel', params: { id } })
        } catch {
          // ya no está
        }
        reject(new HelperError('cancelled', 'Cancelado'))
      }
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.get(id)?.cleanup()
        this.pending.delete(id)
        reject(new HelperError('timeout', `El ayudante de macOS no respondió a tiempo (${method}).`))
      }, o.timeoutMs ?? this.opts.timeoutMs ?? 20_000)
      const cleanup = (): void => {
        clearTimeout(timer)
        o.signal?.removeEventListener('abort', onAbort)
      }
      o.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, cleanup })
      try {
        this.write({ id, method, params })
      } catch (err) {
        cleanup()
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** Mensaje sin respuesta (p. ej. audio del dictado). */
  notify(method: string, params: object = {}): void {
    try {
      this.write({ method, params })
    } catch {
      // Si el ayudante no está, el error llega con la siguiente petición.
    }
  }

  stop(): void {
    this.stopping = true
    const child = this.child
    if (!child) return
    try {
      child.stdin.end()
    } catch {
      // nada
    }
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGTERM')
    }, 500).unref()
  }

  /** Vuelve a intentarlo después de un fallo (p. ej. al compilar el ayudante con la app abierta). */
  reset(): void {
    this.failure = null
    this.exits = []
  }
}

/** Convierte audio Float32 a base64 (little-endian, como lo lee el ayudante). */
export function float32ToBase64(samples: Float32Array): string {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64')
}
