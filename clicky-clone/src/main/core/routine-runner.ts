// Ejecuta los pasos de una rutina. Las dependencias (captura, Jev, teclado/ratón) se inyectan, así
// la lógica se prueba sin Electron y la misma función sirve para el panel, la voz y el orquestador.
import type { RoutineStep, StepResult } from '../../shared/types'
import { expandPlaceholders, isActingStep } from './routines.ts'

export interface Point {
  x: number
  y: number
}

export interface VisionCheck {
  /** Probabilidad (0-1) de que la condición se cumpla en la captura. */
  probability: number
  via: 'jev' | 'model'
  ms: number
}

export interface VisionLocate {
  /** Centro del elemento, en coordenadas de pantalla. */
  point: Point
  /** Confianza (0-1), o null si quien lo localizó no la da. */
  confidence: number | null
  via: 'jev' | 'model' | 'ocr'
  ms: number
}

export interface InputActions {
  click(p: Point, double: boolean): Promise<void>
  type(text: string): Promise<void>
  key(combo: string): Promise<void>
  scroll(direction: 'up' | 'down'): Promise<void>
}

export interface RunnerDeps<S> {
  capture(signal: AbortSignal): Promise<S>
  check(shot: S, condition: string, signal: AbortSignal): Promise<VisionCheck>
  locate(shot: S, target: string, signal: AbortSignal): Promise<VisionLocate | null>
  ask(shot: S, question: string, signal: AbortSignal): Promise<string>
  /** null si este equipo no puede hacer clics ni escribir (sin permiso o sin ayudante). */
  input: InputActions | null
  /** Por qué no hay `input`, para explicarlo en el paso. */
  inputUnavailable?: string
  open(target: string): Promise<void>
  say(text: string): void
  point(p: Point, label: string): void
  /** Avisa de que empieza un paso (hint del buddy, panel). */
  progress(index: number, step: RoutineStep): void
  sleep(ms: number, signal: AbortSignal): Promise<void>
  now(): number
  /** Guarda la captura del momento del fallo y devuelve su ruta. */
  keepShot?(shot: S): string | undefined
}

export interface RunnerOptions {
  /** Probabilidad mínima para dar por buena una comprobación. */
  threshold: number
  /** Confianza mínima de Jev para hacer clic en lo que encontró. */
  minConfidence: number
  /** Pausa tras cada acción para que la interfaz reaccione. */
  settleMs: number
  /** Cada cuánto se vuelve a mirar en `waitFor`. */
  pollMs: number
  continueOnFailure: boolean
}

export const DEFAULT_RUNNER_OPTIONS: RunnerOptions = {
  threshold: 0.6,
  minConfidence: 0.5,
  settleMs: 450,
  pollMs: 350,
  continueOnFailure: false
}

export interface RunnerOutcome {
  status: 'passed' | 'failed' | 'error' | 'cancelled'
  steps: StepResult[]
  failureShot?: string
  /** Motivo de la cancelación (p. ej. "moviste el ratón"). */
  cancelReason?: string
}

class StepFailure extends Error {
  readonly status: 'failed' | 'error'
  readonly score?: number
  constructor(status: 'failed' | 'error', message: string, score?: number) {
    super(message)
    this.status = status
    this.score = score
  }
}

const pct = (p: number): string => `${Math.round(p * 100)}%`

function reasonOf(signal: AbortSignal): string | undefined {
  const r: unknown = signal.reason
  if (typeof r === 'string') return r
  if (r instanceof Error && r.name !== 'AbortError') return r.message
  return undefined
}

export async function executeRoutine<S>(
  steps: RoutineStep[],
  deps: RunnerDeps<S>,
  signal: AbortSignal,
  options: Partial<RunnerOptions>,
  onResult: (r: StepResult) => void
): Promise<RunnerOutcome> {
  const o = { ...DEFAULT_RUNNER_OPTIONS, ...options }
  const results: StepResult[] = []
  let failureShot: string | undefined
  let worst = 'passed' as RunnerOutcome['status']

  const record = (r: StepResult): void => {
    results.push(r)
    onResult(r)
  }

  // Si la rutina hace clics o escribe y este equipo no puede, avisamos antes de empezar.
  const firstActing = steps.findIndex(isActingStep)
  if (firstActing >= 0 && !deps.input) {
    steps.forEach((_s, i) =>
      record({
        index: i,
        status: i === firstActing ? 'error' : 'skipped',
        ms: 0,
        detail: i === firstActing ? deps.inputUnavailable ?? 'Este equipo no puede hacer clics ni escribir por ti.' : ''
      })
    )
    return { status: 'error', steps: results }
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    if (signal.aborted) {
      for (let j = i; j < steps.length; j++) record({ index: j, status: 'skipped', ms: 0, detail: '' })
      return { status: 'cancelled', steps: results, failureShot, cancelReason: reasonOf(signal) }
    }
    deps.progress(i, step)
    const started = deps.now()
    let lastShot: S | null = null
    const capture = async (): Promise<S> => {
      lastShot = await deps.capture(signal)
      return lastShot
    }
    try {
      const { detail, score, via } = await runStep(step, deps, capture, signal, o)
      record({ index: i, status: 'passed', ms: deps.now() - started, detail, score, via })
    } catch (err) {
      if (signal.aborted) {
        record({ index: i, status: 'skipped', ms: deps.now() - started, detail: '' })
        for (let j = i + 1; j < steps.length; j++) record({ index: j, status: 'skipped', ms: 0, detail: '' })
        return { status: 'cancelled', steps: results, failureShot, cancelReason: reasonOf(signal) }
      }
      const failure = err instanceof StepFailure ? err : new StepFailure('error', err instanceof Error ? err.message : String(err))
      record({ index: i, status: failure.status, ms: deps.now() - started, detail: failure.message, score: failure.score })
      if (lastShot !== null && !failureShot) failureShot = deps.keepShot?.(lastShot)
      worst = failure.status === 'error' || worst === 'error' ? 'error' : 'failed'
      if (!o.continueOnFailure) {
        for (let j = i + 1; j < steps.length; j++) record({ index: j, status: 'skipped', ms: 0, detail: '' })
        return { status: worst, steps: results, failureShot }
      }
    }
  }
  return { status: worst, steps: results, failureShot }
}

async function runStep<S>(
  step: RoutineStep,
  deps: RunnerDeps<S>,
  capture: () => Promise<S>,
  signal: AbortSignal,
  o: RunnerOptions
): Promise<{ detail: string; score?: number; via?: StepResult['via'] }> {
  const input = deps.input
  const find = async (target: string): Promise<{ loc: VisionLocate; shot: S }> => {
    const shot = await capture()
    const loc = await deps.locate(shot, target, signal)
    if (!loc) throw new StepFailure('failed', `No encontré «${target}» en la pantalla.`)
    if (loc.confidence !== null && loc.confidence < o.minConfidence) {
      throw new StepFailure('failed', `No encontré «${target}» con seguridad (confianza ${pct(loc.confidence)}).`, loc.confidence)
    }
    return { loc, shot }
  }

  switch (step.kind) {
    case 'open': {
      await deps.open(step.target ?? '')
      await deps.sleep(o.settleMs * 3, signal)
      return { detail: `Abierto: ${step.target}` }
    }
    case 'click': {
      const { loc } = await find(step.target ?? '')
      deps.point(loc.point, step.target ?? '')
      await input!.click(loc.point, false)
      await deps.sleep(o.settleMs, signal)
      return { detail: `Clic en (${Math.round(loc.point.x)}, ${Math.round(loc.point.y)})`, score: loc.confidence ?? undefined, via: loc.via }
    }
    case 'type': {
      let via: StepResult['via']
      let score: number | undefined
      if (step.target) {
        const { loc } = await find(step.target)
        deps.point(loc.point, step.target)
        await input!.click(loc.point, false)
        await deps.sleep(o.settleMs / 2, signal)
        via = loc.via
        score = loc.confidence ?? undefined
      }
      const text = expandPlaceholders(step.text ?? '')
      await input!.type(text)
      await deps.sleep(o.settleMs / 2, signal)
      return { detail: `Escrito: ${text.length > 60 ? `${text.slice(0, 57)}…` : text}`, via, score }
    }
    case 'key': {
      await input!.key(step.keys ?? '')
      await deps.sleep(o.settleMs / 2, signal)
      return { detail: `Pulsado: ${step.keys}` }
    }
    case 'scroll': {
      await input!.scroll(step.direction === 'up' ? 'up' : 'down')
      await deps.sleep(o.settleMs / 2, signal)
      return { detail: step.direction === 'up' ? 'Hacia arriba' : 'Hacia abajo' }
    }
    case 'wait': {
      await deps.sleep((step.seconds ?? 1) * 1000, signal)
      return { detail: `${step.seconds ?? 1} s` }
    }
    case 'waitFor': {
      const timeoutMs = (step.seconds ?? 15) * 1000
      const started = deps.now()
      let last = 0
      for (;;) {
        const shot = await capture()
        const c = await deps.check(shot, step.condition ?? '', signal)
        last = c.probability
        if (c.probability >= o.threshold) {
          return { detail: `Apareció en ${((deps.now() - started) / 1000).toFixed(1)} s (${pct(c.probability)})`, score: c.probability, via: c.via }
        }
        if (deps.now() - started + o.pollMs > timeoutMs) break
        await deps.sleep(o.pollMs, signal)
      }
      throw new StepFailure('failed', `No apareció en ${Math.round(timeoutMs / 1000)} s (última probabilidad ${pct(last)}).`, last)
    }
    case 'check': {
      const shot = await capture()
      const c = await deps.check(shot, step.condition ?? '', signal)
      const expect = step.expect !== false
      const ok = expect ? c.probability >= o.threshold : c.probability <= 1 - o.threshold
      const seen = c.probability >= 0.5 ? `Se ve (${pct(c.probability)})` : `No se ve (${pct(c.probability)})`
      if (!ok) throw new StepFailure('failed', expect ? `${seen}; se esperaba que se viera.` : `${seen}; se esperaba que no se viera.`, c.probability)
      return { detail: seen, score: c.probability, via: c.via }
    }
    case 'point': {
      const { loc } = await find(step.target ?? '')
      deps.point(loc.point, step.target ?? '')
      if (step.text) deps.say(step.text)
      await deps.sleep(1200, signal)
      return { detail: `Señalado en (${Math.round(loc.point.x)}, ${Math.round(loc.point.y)})`, score: loc.confidence ?? undefined, via: loc.via }
    }
    case 'say': {
      deps.say(expandPlaceholders(step.text ?? ''))
      return { detail: step.text ?? '' }
    }
    case 'ask': {
      const shot = await capture()
      const answer = await deps.ask(shot, step.condition ?? '', signal)
      return { detail: answer, via: 'model' }
    }
  }
}
