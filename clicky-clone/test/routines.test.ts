import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  describeStep,
  expandPlaceholders,
  matchRoutine,
  nextRunAt,
  normalizeRoutine,
  normalizeSchedule,
  normalizeStep,
  parseKeyCombo,
  ROUTINE_SCHEMA,
  routineActs,
  summarizeRun
} from '../src/main/core/routines.ts'
import { matchScore, normalizeText, similarity } from '../src/main/core/text.ts'
import { xdotoolClickArgs, xdotoolKeyArgs, xdotoolScrollArgs, xdotoolTypeArgs } from '../src/main/core/input.ts'

describe('texto', () => {
  it('normaliza acentos, mayúsculas y signos', () => {
    assert.equal(normalizeText('¿Dónde está «Configuración»?'), 'donde esta configuracion')
  })
  it('tolera errores de dictado pequeños', () => {
    assert.ok(similarity('login', 'log in') > 0.6)
    assert.equal(matchScore('Ajustes', 'ajustes'), 1)
    assert.ok(matchScore('Ajustes', 'Abrir Ajustes del sistema') > 0.75)
    assert.ok(matchScore('Ajustes', 'Agentes') < 0.6)
  })
})

describe('rutinas: pasos', () => {
  it('acepta sinónimos y limpia los campos que no aplican', () => {
    assert.deepEqual(normalizeStep({ kind: 'tap', target: ' Guardar ', text: '', keys: '', condition: '', expect: true, seconds: 0, direction: 'down', note: '' }), {
      kind: 'click',
      target: 'Guardar'
    })
    assert.deepEqual(normalizeStep({ kind: 'wait_for', condition: 'the dashboard', seconds: 500 }), { kind: 'waitFor', condition: 'the dashboard', seconds: 120 })
    assert.deepEqual(normalizeStep({ kind: 'assert', condition: 'an error', expect: false }), { kind: 'check', condition: 'an error', expect: false })
    assert.deepEqual(normalizeStep({ kind: 'wait', seconds: 0 }), { kind: 'wait', seconds: 1 })
  })

  it('descarta pasos sin lo imprescindible', () => {
    assert.equal(normalizeStep({ kind: 'click', target: '' }), null)
    assert.equal(normalizeStep({ kind: 'key', keys: 'cmd+banana' }), null)
    assert.equal(normalizeStep({ kind: 'explode' }), null)
    assert.equal(normalizeStep('click'), null)
  })

  it('valida una rutina completa y avisa de lo descartado', () => {
    const { routine, warnings } = normalizeRoutine({
      name: '  Login de prueba ',
      description: 'Entra con demo',
      steps: [
        { kind: 'open', target: 'http://localhost:3000/login' },
        { kind: 'type', target: 'the email field', text: 'demo+{{aleatorio}}@test.com' },
        { kind: 'key', keys: 'enter' },
        { kind: 'click' },
        { kind: 'check', condition: 'the dashboard title', expect: true }
      ]
    })
    assert.equal(routine.name, 'Login de prueba')
    assert.equal(routine.steps.length, 4)
    assert.equal(warnings.length, 1)
    assert.ok(routineActs(routine.steps))
    assert.ok(!routineActs([{ kind: 'check', condition: 'x' }]))
  })

  it('el esquema para Claude exige todos los campos (modo estricto de OpenAI)', () => {
    const item = ROUTINE_SCHEMA.properties.steps.items
    assert.deepEqual([...item.required].sort(), Object.keys(item.properties).sort())
  })
})

describe('rutinas: teclas', () => {
  it('entiende combinaciones y sinónimos', () => {
    assert.deepEqual(parseKeyCombo('Cmd+Shift+S'), { key: 's', modifiers: ['cmd', 'shift'] })
    assert.deepEqual(parseKeyCombo('intro'), { key: 'enter', modifiers: [] })
    assert.deepEqual(parseKeyCombo('mod+l', 'linux'), { key: 'l', modifiers: ['ctrl'] })
    assert.deepEqual(parseKeyCombo('mod+l', 'darwin'), { key: 'l', modifiers: ['cmd'] })
    assert.deepEqual(parseKeyCombo('F5'), { key: 'f5', modifiers: [] })
    assert.equal(parseKeyCombo('cmd+'), null)
    assert.equal(parseKeyCombo('a+b'), null)
  })

  it('genera los argumentos de xdotool', () => {
    assert.deepEqual(xdotoolKeyArgs({ key: 'enter', modifiers: [] }), ['key', '--clearmodifiers', 'Return'])
    assert.deepEqual(xdotoolKeyArgs({ key: 's', modifiers: ['ctrl', 'shift'] }), ['key', '--clearmodifiers', 'ctrl+shift+s'])
    assert.deepEqual(xdotoolClickArgs({ x: 10.4, y: 20.6 }, true), ['mousemove', '--sync', '10', '21', 'click', '--repeat', '2', '1'])
    assert.deepEqual(xdotoolTypeArgs('-hola'), ['type', '--delay', '8', '--', '-hola'])
    assert.deepEqual(xdotoolScrollArgs('up'), ['click', '--repeat', '5', '4'])
  })
})

describe('rutinas: marcadores, horarios y nombres', () => {
  it('rellena fecha, hora y texto aleatorio', () => {
    const now = new Date(2026, 10, 3, 9, 5, 7)
    assert.equal(expandPlaceholders('{{fecha}} {{hora}} {{ random }}', now, () => 0.5), '2026-11-03 09:05:07 i00000')
    assert.equal(expandPlaceholders('sin marcadores'), 'sin marcadores')
  })

  it('calcula la próxima ejecución', () => {
    const now = new Date(2026, 10, 3, 10, 0, 0).getTime()
    assert.equal(nextRunAt({ everyMinutes: 30, dailyAt: '' }, now - 10 * 60_000, now - 60 * 60_000, now), now + 20 * 60_000)
    const daily = nextRunAt({ everyMinutes: 0, dailyAt: '09:30' }, null, now, now)
    assert.equal(daily, new Date(2026, 10, 4, 9, 30).getTime())
    const later = nextRunAt({ everyMinutes: 0, dailyAt: '18:00' }, null, now, now)
    assert.equal(later, new Date(2026, 10, 3, 18, 0).getTime())
    assert.equal(nextRunAt(null, null, now, now), null)
  })

  it('valida los horarios', () => {
    assert.deepEqual(normalizeSchedule({ everyMinutes: 1, dailyAt: '25:00' }), { everyMinutes: 5, dailyAt: '' })
    assert.equal(normalizeSchedule({ everyMinutes: 0, dailyAt: '' }), null)
    assert.deepEqual(normalizeSchedule({ everyMinutes: 0, dailyAt: '07:45' }), { everyMinutes: 0, dailyAt: '07:45' })
  })

  it('encuentra la rutina aunque el dictado se equivoque', () => {
    const routines = [{ name: 'Login QA' }, { name: 'Checkout completo' }, { name: 'Revisar tablero' }]
    assert.equal(matchRoutine('log in qa', routines)?.name, 'Login QA')
    assert.equal(matchRoutine('la rutina del checkout', routines)?.name, 'Checkout completo')
    assert.equal(matchRoutine('tablero', routines)?.name, 'Revisar tablero')
    assert.equal(matchRoutine('facturas', routines), null)
  })

  it('describe los pasos y resume la ejecución', () => {
    assert.equal(describeStep({ kind: 'check', condition: 'the dashboard', expect: false }), 'Comprobar que NO: the dashboard')
    const steps = [
      { kind: 'click' as const, target: 'Entrar' },
      { kind: 'check' as const, condition: 'the dashboard' }
    ]
    const failed = summarizeRun(
      {
        routineName: 'Login',
        status: 'failed',
        steps: [
          { index: 0, status: 'passed', ms: 10, detail: '' },
          { index: 1, status: 'failed', ms: 10, detail: 'No se ve (12%).' }
        ]
      },
      steps
    )
    assert.match(failed, /falló en el paso 2: Comprobar: the dashboard\. No se ve \(12%\)\./)
    assert.match(summarizeRun({ routineName: 'Login', status: 'passed', steps: [{ index: 0, status: 'passed', ms: 1, detail: '' }, { index: 1, status: 'passed', ms: 1, detail: '' }] }, steps), /2 de 2/)
  })
})
