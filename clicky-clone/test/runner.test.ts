import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RoutineStep, StepResult } from '../src/shared/types.ts'
import { executeRoutine, type Point, type RunnerDeps } from '../src/main/core/routine-runner.ts'

interface Fake {
  deps: RunnerDeps<number>
  actions: string[]
  results: StepResult[]
}

/** Dependencias falsas: `seen` dice qué condiciones se ven y `where` dónde está cada elemento. */
function fake(opts: { seen?: Record<string, number[] | number>; where?: Record<string, { point: Point; confidence: number | null }>; input?: boolean }): Fake {
  const actions: string[] = []
  let clock = 0
  let shots = 0
  const calls: Record<string, number> = {}
  const deps: RunnerDeps<number> = {
    capture: async () => ++shots,
    check: async (_shot, condition) => {
      const v = opts.seen?.[condition] ?? 0
      const i = (calls[condition] = (calls[condition] ?? -1) + 1)
      const p = Array.isArray(v) ? v[Math.min(i, v.length - 1)] : v
      return { probability: p, via: 'jev', ms: 5 }
    },
    locate: async (_shot, target) => {
      const w = opts.where?.[target]
      return w ? { ...w, via: 'jev', ms: 5 } : null
    },
    ask: async (_shot, q) => `respuesta a ${q}`,
    input:
      opts.input === false
        ? null
        : {
            click: async (p, double) => void actions.push(`click ${p.x},${p.y}${double ? ' x2' : ''}`),
            type: async (t) => void actions.push(`type ${t}`),
            key: async (k) => void actions.push(`key ${k}`),
            scroll: async (d) => void actions.push(`scroll ${d}`)
          },
    inputUnavailable: 'Falta el permiso de Accesibilidad.',
    open: async (t) => void actions.push(`open ${t}`),
    say: (t) => void actions.push(`say ${t}`),
    point: (p) => void actions.push(`point ${p.x},${p.y}`),
    progress: () => undefined,
    sleep: async (ms, signal) => {
      if (signal.aborted) throw new Error('aborted')
      clock += ms
    },
    now: () => clock,
    keepShot: (shot) => `/tmp/fallo-${shot}.jpg`
  }
  return { deps, actions, results: [] }
}

const LOGIN: RoutineStep[] = [
  { kind: 'open', target: 'http://localhost:3000' },
  { kind: 'waitFor', condition: 'the login form', seconds: 5 },
  { kind: 'type', target: 'the email field', text: 'demo@test.com' },
  { kind: 'key', keys: 'enter' },
  { kind: 'check', condition: 'the dashboard' }
]

describe('ejecutor de rutinas', () => {
  it('ejecuta un login completo con Jev y el teclado', async () => {
    const f = fake({
      seen: { 'the login form': [0.1, 0.2, 0.95], 'the dashboard': 0.9 },
      where: { 'the email field': { point: { x: 300, y: 200 }, confidence: 0.8 } }
    })
    const out = await executeRoutine(LOGIN, f.deps, new AbortController().signal, {}, (r) => f.results.push(r))
    assert.equal(out.status, 'passed')
    assert.deepEqual(
      out.steps.map((s) => s.status),
      ['passed', 'passed', 'passed', 'passed', 'passed']
    )
    assert.deepEqual(f.actions, ['open http://localhost:3000', 'point 300,200', 'click 300,200', 'type demo@test.com', 'key enter'])
    assert.match(out.steps[1].detail, /Apareció en/)
    assert.equal(f.results.length, 5)
  })

  it('para en la primera comprobación que falla y guarda la captura', async () => {
    const f = fake({
      seen: { 'the login form': 1, 'the dashboard': 0.1 },
      where: { 'the email field': { point: { x: 1, y: 2 }, confidence: 0.9 } }
    })
    const steps: RoutineStep[] = [...LOGIN, { kind: 'say', text: 'listo' }]
    const out = await executeRoutine(steps, f.deps, new AbortController().signal, {}, () => undefined)
    assert.equal(out.status, 'failed')
    assert.equal(out.steps[4].status, 'failed')
    assert.match(out.steps[4].detail, /No se ve \(10%\); se esperaba que se viera\./)
    assert.equal(out.steps[5].status, 'skipped')
    assert.ok(out.failureShot?.startsWith('/tmp/fallo-'))
  })

  it('sigue después de un fallo si la rutina lo pide', async () => {
    const f = fake({ seen: { a: 0.1, b: 0.9 } })
    const out = await executeRoutine(
      [
        { kind: 'check', condition: 'a' },
        { kind: 'check', condition: 'b' }
      ],
      f.deps,
      new AbortController().signal,
      { continueOnFailure: true },
      () => undefined
    )
    assert.equal(out.status, 'failed')
    assert.deepEqual(
      out.steps.map((s) => s.status),
      ['failed', 'passed']
    )
  })

  it('las comprobaciones negativas pasan si NO se ve', async () => {
    const f = fake({ seen: { 'an error message': 0.05 } })
    const out = await executeRoutine([{ kind: 'check', condition: 'an error message', expect: false }], f.deps, new AbortController().signal, {}, () => undefined)
    assert.equal(out.status, 'passed')
  })

  it('no hace clic si Jev no está seguro', async () => {
    const f = fake({ where: { Guardar: { point: { x: 5, y: 5 }, confidence: 0.3 } } })
    const out = await executeRoutine([{ kind: 'click', target: 'Guardar' }], f.deps, new AbortController().signal, {}, () => undefined)
    assert.equal(out.status, 'failed')
    assert.match(out.steps[0].detail, /con seguridad \(confianza 30%\)/)
    assert.deepEqual(f.actions, [])
  })

  it('waitFor se rinde al llegar al tiempo máximo', async () => {
    const f = fake({ seen: { 'the page': 0.2 } })
    const out = await executeRoutine([{ kind: 'waitFor', condition: 'the page', seconds: 2 }], f.deps, new AbortController().signal, {}, () => undefined)
    assert.equal(out.status, 'failed')
    assert.match(out.steps[0].detail, /No apareció en 2 s \(última probabilidad 20%\)/)
  })

  it('sin teclado/ratón avisa antes de empezar', async () => {
    const f = fake({ input: false })
    const out = await executeRoutine(LOGIN, f.deps, new AbortController().signal, {}, () => undefined)
    assert.equal(out.status, 'error')
    assert.deepEqual(
      out.steps.map((s) => s.status),
      ['skipped', 'skipped', 'error', 'skipped', 'skipped']
    )
    assert.equal(out.steps[2].detail, 'Falta el permiso de Accesibilidad.')
    assert.deepEqual(f.actions, [])
  })

  it('se detiene al cancelar y explica por qué', async () => {
    const f = fake({ seen: { x: 1 } })
    const controller = new AbortController()
    f.deps.progress = (i) => {
      if (i === 1) controller.abort('Moviste el ratón: detuve la rutina.')
    }
    const out = await executeRoutine(
      [
        { kind: 'check', condition: 'x' },
        { kind: 'wait', seconds: 1 },
        { kind: 'check', condition: 'x' }
      ],
      f.deps,
      controller.signal,
      {},
      () => undefined
    )
    assert.equal(out.status, 'cancelled')
    assert.equal(out.cancelReason, 'Moviste el ratón: detuve la rutina.')
    assert.deepEqual(
      out.steps.map((s) => s.status),
      ['passed', 'skipped', 'skipped']
    )
  })

  it('pregunta al modelo y rellena los marcadores al escribir', async () => {
    const f = fake({})
    const out = await executeRoutine(
      [
        { kind: 'type', text: 'id-{{timestamp}}' },
        { kind: 'ask', condition: '¿El total es correcto?' }
      ],
      f.deps,
      new AbortController().signal,
      {},
      () => undefined
    )
    assert.equal(out.status, 'passed')
    assert.match(f.actions[0], /^type id-\d+$/)
    assert.equal(out.steps[1].detail, 'respuesta a ¿El total es correcto?')
  })
})
