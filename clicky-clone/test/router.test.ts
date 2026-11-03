import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildTriagePrompt,
  compactOcr,
  dictationVocabulary,
  heuristicRoute,
  matchOcrTarget,
  parseTriage,
  TRIAGE_SCHEMA
} from '../src/main/core/router.ts'

describe('enrutador: frases de mando', () => {
  it('reconoce rutinas, agentes y tareas', () => {
    assert.deepEqual(heuristicRoute('Ejecuta la rutina login QA.'), { intent: 'routine_run', text: 'login QA' })
    assert.deepEqual(heuristicRoute('oye buddy, corre la prueba del checkout'), { intent: 'routine_run', text: 'checkout' })
    assert.deepEqual(heuristicRoute('haz la rutina tablero'), { intent: 'routine_run', text: 'tablero' })
    assert.deepEqual(heuristicRoute('Crea una rutina que entre a localhost y compruebe el login'), {
      intent: 'routine_create',
      text: 'Crea una rutina que entre a localhost y compruebe el login'
    })
    assert.equal(heuristicRoute('crea una prueba de QA para el registro')?.intent, 'routine_create')
    assert.equal(heuristicRoute('make a QA test for signup')?.intent, 'routine_create')
    assert.deepEqual(heuristicRoute('agente, investiga vuelos'), { intent: 'agent', text: 'investiga vuelos' })
    assert.deepEqual(heuristicRoute('Hazlo tú: llena este formulario con datos de prueba'), { intent: 'task', text: 'llena este formulario con datos de prueba' })
  })

  it('no confunde preguntas normales', () => {
    assert.equal(heuristicRoute('¿Dónde cambio los atajos?'), null)
    assert.equal(heuristicRoute('¿qué es una rutina de ejercicio?'), null)
    assert.equal(heuristicRoute('haz una tabla con esto'), null)
  })
})

describe('enrutador: Apple Intelligence', () => {
  it('el esquema genera primero el texto corregido y al final la confianza', () => {
    assert.deepEqual(
      TRIAGE_SCHEMA.properties.map((p) => p.name),
      ['text', 'intent', 'routine', 'say', 'target', 'confident']
    )
  })

  it('valida la decisión y ante la duda manda a Claude', () => {
    const ok = parseTriage(
      JSON.stringify({ text: '¿Dónde cambio los atajos?', intent: 'answer', routine: '', say: 'En Ajustes.', target: 'Ajustes', confident: true }),
      'donde cambio los atajos'
    )
    assert.equal(ok.intent, 'answer')
    assert.equal(ok.text, '¿Dónde cambio los atajos?')
    assert.equal(ok.confident, true)
    assert.equal(parseTriage('no es json', 'hola').intent, 'complex')
    assert.equal(parseTriage({ intent: 'inventado' }, 'hola').intent, 'complex')
    // Sin respuesta no puede estar seguro.
    assert.equal(parseTriage({ intent: 'answer', say: '', confident: true }, 'hola').confident, false)
    // Si "corrige" a otra frase, se queda la original.
    assert.equal(parseTriage({ text: 'compra acciones de Apple', intent: 'complex' }, 'abre la configuración').text, 'abre la configuración')
  })

  it('arma un prompt compacto con rutinas, pantalla y conversación', () => {
    const p = buildTriagePrompt({
      text: 'ejecuta login',
      routines: ['Login QA'],
      screenText: 'Inicio\nAjustes',
      frontApp: 'Safari',
      recent: [{ question: 'hola', answer: 'hola' }]
    })
    assert.match(p, /Saved routines: Login QA/)
    assert.match(p, /Frontmost app: Safari/)
    assert.match(p, /Transcript: "ejecuta login"$/)
  })
})

describe('enrutador: texto de la pantalla', () => {
  const lines = [
    { text: 'Archivo', x: 10, y: 5, w: 50, h: 12 },
    { text: 'Guardar como…', x: 10, y: 40, w: 90, h: 12 },
    { text: 'Ajustes', x: 10, y: 300, w: 60, h: 14 },
    { text: 'Ajustes', x: 400, y: 300, w: 60, h: 14 },
    { text: 'Atajos de teclado', x: 200, y: 120, w: 130, h: 14 }
  ]

  it('prioriza lo relacionado con la pregunta y respeta el orden de lectura', () => {
    const out = compactOcr(lines, { maxChars: 30, query: 'cambiar los atajos de teclado' })
    assert.equal(out, 'Archivo\nAtajos de teclado')
    assert.equal(compactOcr(lines).split('\n').length, 4)
  })

  it('encuentra en el OCR el elemento que nombró el modelo', () => {
    assert.deepEqual(matchOcrTarget('ajustes', lines), { x: 40, y: 307, text: 'Ajustes', score: 1 })
    assert.equal(matchOcrTarget('Exportar', lines), null)
    assert.equal(matchOcrTarget('', lines), null)
  })

  it('limita el vocabulario del dictado', () => {
    const words = dictationVocabulary(Array.from({ length: 200 }, (_v, i) => `Rutina ${i}`))
    assert.equal(words.length, 100)
    assert.equal(words[0], 'Buddy')
  })
})
