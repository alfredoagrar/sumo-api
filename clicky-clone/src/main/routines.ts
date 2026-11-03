// Rutinas guardadas (tareas repetitivas estilo QA): crearlas con Claude, ejecutarlas rápido con Jev
// y el teclado/ratón, programarlas y guardar los resultados.
import { app, screen, type Display } from 'electron'
import { EventEmitter } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BuddyCommand, Routine, RoutineRun, RoutineSchedule, RoutineStep } from '../shared/types'
import type { AppleServices } from './apple'
import type { Shot } from './capture'
import { findBinary } from './cli'
import { extractJsonObject } from './core/answer'
import { executeRoutine, type Point, type RunnerDeps } from './core/routine-runner'
import {
  buildRoutineSystemPrompt,
  buildRoutineUserPrompt,
  describeStep,
  nextRunAt,
  normalizeRoutine,
  normalizeSchedule,
  normalizeStep,
  ROUTINE_SCHEMA,
  routineActs,
  summarizeRun,
  type CompiledRoutine
} from './core/routines'
import { pickInputBackend } from './input-backend'
import { openTarget } from './open-target'
import { providers } from './providers'
import { ScreenGuard } from './screen-guard'
import type { SettingsStore } from './settings'
import type { ScreenVision } from './vision'
import type { ProviderId } from '../shared/types'

const MAX_RUNS = 100
const MAX_SHOTS = 30
const COUNTDOWN_MS = 5000

/** Lo que el gestor necesita del asistente (captura sin el buddy, voz y overlay). */
export interface RoutineHost {
  capture(display: Display): Promise<Shot>
  /** Dice algo cuando el buddy esté libre. */
  announce(text: string): void
  /** Dice algo ya (pasos `say`). */
  say(text: string): void
  buddy(cmd: BuddyCommand, displayId: number): void
  pointScreen(p: Point, label: string, displayId: number): void
  isIdle(): boolean
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class RoutineManager extends EventEmitter {
  private routines: Routine[] = []
  private runs: RoutineRun[] = []
  private current: { run: RoutineRun; controller: AbortController } | null = null
  private host: RoutineHost | null = null
  private scheduler: NodeJS.Timeout | null = null
  private countdown: AbortController | null = null
  private emitTimer: NodeJS.Timeout | null = null
  private readonly startedAt = Date.now()
  private readonly file = join(app.getPath('userData'), 'routines.json')
  private readonly runsFile = join(app.getPath('userData'), 'routine-runs.json')
  private readonly shotsDir = join(app.getPath('userData'), 'routine-shots')
  private readonly deps: { settings: SettingsStore; apple: AppleServices; vision: ScreenVision; cliCwd: string }

  constructor(deps: { settings: SettingsStore; apple: AppleServices; vision: ScreenVision; cliCwd: string }) {
    super()
    this.deps = deps
    this.routines = this.load<Routine[]>(this.file, [])
    this.runs = this.load<RoutineRun[]>(this.runsFile, []).map((r) =>
      r.status === 'running' ? { ...r, status: 'error', finishedAt: r.finishedAt ?? Date.now(), summary: 'Se interrumpió al cerrar la app.' } : r
    )
  }

  setHost(host: RoutineHost): void {
    this.host = host
  }

  private load<T>(file: string, fallback: T): T {
    try {
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback
    } catch {
      return fallback
    }
  }

  private get es(): boolean {
    return this.deps.settings.get().language === 'es'
  }

  list(): Routine[] {
    return this.routines
  }

  listRuns(): RoutineRun[] {
    return this.runs
  }

  get(id: string): Routine | undefined {
    return this.routines.find((r) => r.id === id)
  }

  get running(): RoutineRun | null {
    return this.current?.run ?? null
  }

  /** Claude es el orquestador: define las rutinas si está instalado; si no, el proveedor elegido. */
  orchestratorProvider(): ProviderId {
    const s = this.deps.settings.get()
    return findBinary('claude', s.claude.binary) ? 'claude' : s.provider
  }

  // ---- Crear y editar ---------------------------------------------------------------------

  /** Claude convierte la descripción (y la captura, si hay) en pasos. */
  async create(description: string, shot: Shot | null, signal?: AbortSignal): Promise<{ routine: Routine; warnings: string[] }> {
    const s = this.deps.settings.get()
    const provider = this.orchestratorProvider()
    const raw = await providers[provider].structured(
      {
        systemPrompt: buildRoutineSystemPrompt(s.language, process.platform),
        userPrompt: buildRoutineUserPrompt(
          s.language,
          description,
          this.routines.map((r) => r.name),
          Boolean(shot)
        ),
        image: shot ?? undefined,
        cwd: this.deps.cliCwd,
        schema: ROUTINE_SCHEMA,
        // Definir rutinas es "lo complejo": el modelo de agentes si lo elegiste.
        model: provider === 'claude' ? s.claude.agentModel || undefined : undefined
      },
      s,
      signal ?? AbortSignal.timeout(180_000)
    )
    const { routine, warnings } = normalizeRoutine(typeof raw === 'string' ? extractJsonObject(raw) : raw)
    if (routine.steps.length === 0) {
      throw new Error(this.es ? 'No pude convertir la descripción en pasos. Descríbela con un poco más de detalle.' : 'I could not turn the description into steps.')
    }
    return { routine: this.add(routine, provider === 'claude' ? 'claude' : 'manual'), warnings }
  }

  /** Guarda una rutina ya definida (por ejemplo, la que guarda Claude como orquestador). */
  add(compiled: CompiledRoutine, source: Routine['source']): Routine {
    const names = new Set(this.routines.map((r) => r.name.toLowerCase()))
    let name = compiled.name
    for (let i = 2; names.has(name.toLowerCase()); i++) name = `${compiled.name} ${i}`
    const now = Date.now()
    const routine: Routine = {
      id: randomUUID(),
      name,
      description: compiled.description,
      steps: compiled.steps,
      createdAt: now,
      updatedAt: now,
      source,
      schedule: null,
      continueOnFailure: false
    }
    this.routines = [routine, ...this.routines]
    this.persist()
    return routine
  }

  update(id: string, patch: Partial<Pick<Routine, 'name' | 'schedule' | 'continueOnFailure' | 'steps'>>): Routine {
    const routine = this.get(id)
    if (!routine) throw new Error('No encontré esa rutina.')
    const next: Routine = { ...routine, updatedAt: Date.now() }
    if (typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim().slice(0, 60)
    if ('schedule' in patch) next.schedule = normalizeSchedule(patch.schedule) as RoutineSchedule | null
    if (typeof patch.continueOnFailure === 'boolean') next.continueOnFailure = patch.continueOnFailure
    if (Array.isArray(patch.steps)) {
      const steps = patch.steps.map(normalizeStep).filter((st): st is RoutineStep => st !== null)
      if (steps.length) next.steps = steps
    }
    this.routines = this.routines.map((r) => (r.id === id ? next : r))
    this.persist()
    return next
  }

  delete(id: string): void {
    if (this.current?.run.routineId === id) this.stop()
    this.routines = this.routines.filter((r) => r.id !== id)
    this.persist()
  }

  // ---- Ejecutar -----------------------------------------------------------------------------

  stop(reason?: string): void {
    this.countdown?.abort()
    this.current?.controller.abort(reason ?? (this.es ? 'La detuviste.' : 'You stopped it.'))
  }

  async run(id: string, trigger: RoutineRun['trigger']): Promise<RoutineRun> {
    const routine = this.get(id)
    if (!routine) throw new Error('No encontré esa rutina.')
    if (this.current) throw new Error(this.es ? `Ya está en marcha la rutina «${this.current.run.routineName}».` : 'Another routine is running.')
    const host = this.host
    if (!host) throw new Error('Buddy todavía está arrancando.')
    const s = this.deps.settings.get()
    const lang = s.language
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const controller = new AbortController()
    const run: RoutineRun = {
      id: randomUUID(),
      routineId: routine.id,
      routineName: routine.name,
      trigger,
      status: 'running',
      startedAt: Date.now(),
      steps: []
    }
    this.current = { run, controller }
    this.runs = [run, ...this.runs].slice(0, MAX_RUNS)
    this.changed(true)

    const acts = routineActs(routine.steps)
    if (acts && !this.deps.apple.trusted) await this.deps.apple.refresh()
    const { backend, reason } = acts ? pickInputBackend(this.deps.apple) : { backend: null, reason: '' }
    const guard = acts ? new ScreenGuard({ onStop: (why) => controller.abort(why), watchMouse: s.routines.stopOnMouseMove, es: lang === 'es' }) : null
    const status = (text: string): void => host.buddy({ type: 'state', state: 'thinking', text }, display.id)
    status(`«${routine.name}»`)

    const deps: RunnerDeps<Shot> = {
      capture: () => host.capture(display),
      check: (shot, condition, signal) => this.deps.vision.check(shot, condition, signal),
      locate: (shot, target, signal) => this.deps.vision.locate(shot, target, signal),
      ask: (shot, question, signal) => this.deps.vision.ask(shot, question, signal),
      input: backend && guard ? guard.wrap(backend) : null,
      inputUnavailable: reason,
      open: (target) => openTarget(target, lang === 'es'),
      say: (text) => host.say(text),
      point: (p, label) => host.pointScreen(p, label, display.id),
      progress: (i, step) => status(`«${routine.name}» · ${i + 1}/${routine.steps.length} · ${describeStep(step, lang)}`),
      sleep,
      now: Date.now,
      keepShot: (shot) => this.keepShot(run.id, shot)
    }

    try {
      const out = await executeRoutine(routine.steps, deps, controller.signal, { continueOnFailure: routine.continueOnFailure }, (r) => {
        run.steps = [...run.steps, r]
        this.changed(false)
      })
      run.status = out.status
      run.failureShot = out.failureShot
      run.summary = summarizeRun(run, routine.steps, lang)
      if (out.status === 'cancelled' && out.cancelReason) run.summary = `${run.summary} ${out.cancelReason}`
    } catch (err) {
      run.status = 'error'
      run.summary = err instanceof Error ? err.message : String(err)
    } finally {
      guard?.stop()
      run.finishedAt = Date.now()
      this.current = null
      host.buddy({ type: 'unpoint' }, display.id)
      host.buddy({ type: 'state', state: 'idle' }, display.id)
    }

    const passed = run.steps.filter((st) => st.status === 'passed').length
    this.routines = this.routines.map((r) =>
      r.id === routine.id ? { ...r, lastRun: { runId: run.id, status: run.status, at: run.finishedAt ?? Date.now(), passed, total: routine.steps.length } } : r
    )
    this.persist()
    this.changed(true)
    // El orquestador recibe el resultado por MCP; no hace falta decirlo en voz alta.
    if (trigger !== 'orchestrator' && run.summary) host.announce(run.summary)
    return run
  }

  private keepShot(runId: string, shot: Shot): string | undefined {
    try {
      mkdirSync(this.shotsDir, { recursive: true })
      const dest = join(this.shotsDir, `${runId}.jpg`)
      copyFileSync(shot.path, dest)
      const files = readdirSync(this.shotsDir).filter((f) => f.endsWith('.jpg')).sort()
      for (const f of files.slice(0, Math.max(0, files.length - MAX_SHOTS))) rmSync(join(this.shotsDir, f), { force: true })
      return dest
    } catch {
      return undefined
    }
  }

  // ---- Programación ---------------------------------------------------------------------------

  startScheduler(): void {
    if (this.scheduler) return
    this.scheduler = setInterval(() => void this.tick(), 30_000)
  }

  stopScheduler(): void {
    if (this.scheduler) clearInterval(this.scheduler)
    this.scheduler = null
  }

  private async tick(): Promise<void> {
    if (this.current || this.countdown || !this.host?.isIdle()) return
    const now = Date.now()
    const due = this.routines.find((r) => {
      const next = nextRunAt(r.schedule, r.lastRun?.at ?? null, Math.max(this.startedAt, r.updatedAt), now)
      return next !== null && next <= now
    })
    if (!due) return
    if (routineActs(due.steps)) {
      // Antes de tomar el ratón, avisamos y damos unos segundos para cancelar con Esc.
      const ok = await this.countdownFor(due)
      if (!ok) {
        this.routines = this.routines.map((r) =>
          r.id === due.id ? { ...r, lastRun: { runId: '', status: 'cancelled', at: Date.now(), passed: 0, total: r.steps.length } } : r
        )
        this.persist()
        this.changed(true)
        return
      }
    }
    await this.run(due.id, 'schedule').catch((err: unknown) => console.warn('[routines] No se pudo ejecutar la rutina programada:', err))
  }

  private countdownFor(routine: Routine): Promise<boolean> {
    const host = this.host
    if (!host) return Promise.resolve(false)
    const controller = new AbortController()
    this.countdown = controller
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const guard = new ScreenGuard({ onStop: () => controller.abort(), watchMouse: false, es: this.es })
    host.buddy(
      {
        type: 'state',
        state: 'thinking',
        text: this.es ? `La rutina «${routine.name}» empieza en 5 s · Esc para cancelar` : `Routine "${routine.name}" starts in 5 s · Esc to cancel`
      },
      display.id
    )
    return sleep(COUNTDOWN_MS, controller.signal)
      .then(
        () => true,
        () => false
      )
      .finally(() => {
        guard.stop()
        this.countdown = null
        host.buddy({ type: 'state', state: 'idle' }, display.id)
      })
  }

  // ---- Persistencia ---------------------------------------------------------------------------

  private persist(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.routines, null, 2))
    } catch {
      // no es grave
    }
    this.emit('routines', this.routines)
  }

  /** Avisa al panel como mucho cada 200 ms mientras corre una rutina. */
  private changed(immediate: boolean): void {
    const flush = (): void => {
      this.emitTimer = null
      this.emit('runs', this.runs)
      try {
        writeFileSync(this.runsFile, JSON.stringify(this.runs))
      } catch {
        // no es grave
      }
    }
    if (immediate) {
      if (this.emitTimer) clearTimeout(this.emitTimer)
      flush()
    } else if (!this.emitTimer) {
      this.emitTimer = setTimeout(flush, 200)
    }
  }
}
