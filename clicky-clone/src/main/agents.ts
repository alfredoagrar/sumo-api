import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentTask } from '../shared/types'
import type { Shot } from './capture'
import { agentTitle, slugify } from './core/prompts'
import { providers } from './providers'
import { AbortedError } from './providers/types'
import type { SettingsStore } from './settings'

const MAX_TASKS = 50
const MAX_EVENTS = 400

function stamp(d = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`
}

/**
 * Tareas en segundo plano ("agente: …"). Cada tarea corre la CLI del proveedor elegido
 * dentro de su propia carpeta de trabajo y va registrando lo que hace.
 */
export class AgentManager extends EventEmitter {
  private readonly file = join(app.getPath('userData'), 'agents.json')
  private tasks: AgentTask[] = []
  private readonly controllers = new Map<string, AbortController>()
  private emitTimer: NodeJS.Timeout | null = null
  private readonly settings: SettingsStore

  constructor(settings: SettingsStore) {
    super()
    this.settings = settings
    try {
      if (existsSync(this.file)) {
        const stored = JSON.parse(readFileSync(this.file, 'utf8')) as AgentTask[]
        this.tasks = stored.map((t) =>
          t.status === 'running'
            ? { ...t, status: 'error', finishedAt: t.finishedAt ?? Date.now(), result: 'Se interrumpió al cerrar la app.' }
            : t
        )
      }
    } catch {
      this.tasks = []
    }
  }

  list(): AgentTask[] {
    return this.tasks
  }

  get(id: string): AgentTask | undefined {
    return this.tasks.find((t) => t.id === id)
  }

  start(prompt: string, shot: Shot | null): AgentTask {
    const s = this.settings.get()
    const id = randomUUID()
    const workdir = join(s.agents.workspaceDir, `${stamp()}_${slugify(prompt)}`)
    mkdirSync(workdir, { recursive: true })
    let image = shot ?? undefined
    if (shot) {
      const copy = join(workdir, 'captura.jpg')
      try {
        copyFileSync(shot.path, copy)
        image = { ...shot, path: copy }
      } catch {
        // seguimos con la captura temporal
      }
    }

    const task: AgentTask = {
      id,
      title: agentTitle(prompt),
      prompt,
      provider: s.provider,
      status: 'running',
      startedAt: Date.now(),
      workdir,
      events: [{ at: Date.now(), kind: 'info', text: `Carpeta de trabajo: ${workdir}` }]
    }
    this.tasks = [task, ...this.tasks].slice(0, MAX_TASKS)
    this.changed(true)

    const controller = new AbortController()
    this.controllers.set(id, controller)
    const provider = providers[task.provider]

    provider
      .agent({ id, prompt, workdir, image, language: s.language }, s, (note) => this.addEvent(id, note), controller.signal)
      .then((result) => this.finish(id, 'done', result || 'Tarea terminada.'))
      .catch((err: unknown) => {
        if (err instanceof AbortedError || controller.signal.aborted) this.finish(id, 'cancelled', 'Cancelada.')
        else this.finish(id, 'error', err instanceof Error ? err.message : String(err))
      })
      .finally(() => this.controllers.delete(id))

    return task
  }

  cancel(id: string): void {
    this.controllers.get(id)?.abort()
  }

  cancelAll(): void {
    for (const c of this.controllers.values()) c.abort()
  }

  private update(id: string, fn: (t: AgentTask) => AgentTask): AgentTask | undefined {
    let updated: AgentTask | undefined
    this.tasks = this.tasks.map((t) => {
      if (t.id !== id) return t
      updated = fn(t)
      return updated
    })
    return updated
  }

  private addEvent(id: string, note: Omit<AgentEvent, 'at'>): void {
    this.update(id, (t) => ({ ...t, events: [...t.events, { ...note, at: Date.now() }].slice(-MAX_EVENTS) }))
    this.changed(false)
  }

  private finish(id: string, status: AgentTask['status'], result: string): void {
    // Si terminó bien, el resultado ya es el último mensaje del agente; no lo repetimos en el registro.
    const extra: AgentEvent[] = status === 'done' ? [] : [{ at: Date.now(), kind: status === 'error' ? 'error' : 'info', text: result }]
    const task = this.update(id, (t) => ({
      ...t,
      status,
      result,
      finishedAt: Date.now(),
      events: [...t.events, ...extra].slice(-MAX_EVENTS)
    }))
    this.changed(true)
    if (task) this.emit('finished', task)
  }

  /** Avisa a la interfaz como mucho cada 250 ms (los agentes pueden emitir muchos eventos). */
  private changed(immediate: boolean): void {
    const flush = (): void => {
      this.emitTimer = null
      this.emit('change', this.tasks)
      this.persist()
    }
    if (immediate) {
      if (this.emitTimer) clearTimeout(this.emitTimer)
      flush()
    } else if (!this.emitTimer) {
      this.emitTimer = setTimeout(flush, 250)
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.tasks))
    } catch {
      // no es grave
    }
  }
}
