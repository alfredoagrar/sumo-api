#!/usr/bin/env node
// Ayudante de macOS simulado: habla el mismo protocolo que native/apple (JSON por línea) para
// probar Buddy en Linux. Variables:
//   FAKE_APPLE_INTELLIGENCE=0   Apple Intelligence no disponible
//   FAKE_APPLE_TRUSTED=0        sin permiso de Accesibilidad (los clics fallan)
//   FAKE_APPLE_STT_TEXT         lo que "transcribe" el dictado
//   FAKE_APPLE_TRIAGE           JSON fijo para la respuesta de Triage
//   FAKE_APPLE_LOG              archivo donde se anotan las acciones (una línea JSON por acción)
//   FAKE_APPLE_DELAY_MS         retraso de generate (por defecto 120 ms)
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const env = process.env
const intelligence = env.FAKE_APPLE_INTELLIGENCE !== '0'
const trusted = env.FAKE_APPLE_TRUSTED !== '0'
const delay = Number(env.FAKE_APPLE_DELAY_MS ?? 120)
const sttText = env.FAKE_APPLE_STT_TEXT ?? '¿Dónde cambio los atajos de teclado?'

function log(entry) {
  if (env.FAKE_APPLE_LOG) appendFileSync(env.FAKE_APPLE_LOG, `${JSON.stringify({ at: Date.now(), ...entry })}\n`)
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

// Texto de la barra lateral y de Inicio del panel de Buddy (1440x900 → 1440x900 en la captura).
const OCR_LINES = [
  { text: 'Buddy', x: 60, y: 40, w: 60, h: 18 },
  { text: 'Inicio', x: 52, y: 120, w: 50, h: 16 },
  { text: 'Conversaciones', x: 52, y: 156, w: 120, h: 16 },
  { text: 'Rutinas', x: 52, y: 192, w: 64, h: 16 },
  { text: 'Agentes', x: 52, y: 228, w: 64, h: 16 },
  { text: 'Ajustes', x: 52, y: 264, w: 60, h: 16 },
  { text: 'Tu compañero junto al cursor', x: 300, y: 120, w: 260, h: 22 }
]

function triage(prompt) {
  if (env.FAKE_APPLE_TRIAGE) return JSON.parse(env.FAKE_APPLE_TRIAGE)
  const m = /Transcript: "([\s\S]*)"\s*$/.exec(prompt)
  const text = m ? m[1] : ''
  const lower = text.toLowerCase()
  const routines = (/Saved routines: (.*)/.exec(prompt)?.[1] ?? '').split(';').map((s) => s.trim()).filter(Boolean)
  if (/cu[aá]nto es/.test(lower)) return { text, intent: 'answer', routine: '', say: 'Son cincuenta y seis.', target: '', confident: true }
  if (/rutina/.test(lower) && /(ejecuta|corre|lanza)/.test(lower)) {
    return { text, intent: 'routine_run', routine: routines[0] ?? '', say: '', target: '', confident: true }
  }
  if (/d[oó]nde|where/.test(lower)) {
    const target = /atajo|ajuste/.test(lower) ? 'Ajustes' : ''
    return { text, intent: 'answer', routine: '', say: target ? 'En Ajustes, en la barra de la izquierda.' : 'No lo veo en la pantalla.', target, confident: Boolean(target) }
  }
  return { text, intent: 'complex', routine: '', say: '', target: '', confident: false }
}

const stt = new Map()

async function handle(method, params) {
  switch (method) {
    case 'hello':
    case 'status':
      return {
        version: 'fake-1',
        os: 'macOS 27.0 (simulado)',
        sdk27: true,
        intelligence: intelligence ? { available: true, imageInput: true } : { available: false, reason: 'appleIntelligenceNotEnabled', imageInput: false },
        speech: { available: true, detail: 'SpeechTranscriber (simulado)' },
        ocr: true,
        accessibility: trusted
      }
    case 'generate': {
      if (!intelligence) throw { code: 'unavailable', message: 'Apple Intelligence no está activado.' }
      await new Promise((r) => setTimeout(r, delay))
      log({ method, schema: params.schema?.name ?? null, image: Boolean(params.imagePath), prompt: params.prompt })
      const name = params.schema?.name
      const content = name === 'Triage' ? triage(params.prompt) : name === 'RunSummary' ? { say: 'Resumen simulado de la rutina.' } : null
      return content ? { json: JSON.stringify(content), ms: delay, usedImage: Boolean(params.imagePath) } : { text: 'Texto simulado.', ms: delay, usedImage: false }
    }
    case 'ocr':
      log({ method, imagePath: params.imagePath })
      return { lines: OCR_LINES, width: 1440, height: 900, ms: 40 }
    case 'stt.begin':
      stt.set(params.sid, { bytes: 0, chunks: 0 })
      log({ method, locale: params.locale, sampleRate: params.sampleRate, vocabulary: params.contextualStrings?.length ?? 0 })
      return { locale: params.locale || 'es-MX', module: 'speech' }
    case 'stt.audio': {
      const s = stt.get(params.sid)
      if (!s) return null
      s.bytes += Buffer.from(params.data ?? '', 'base64').length
      s.chunks++
      if (s.chunks % 3 === 0) {
        const words = sttText.split(' ')
        send({ event: 'stt.partial', params: { sid: params.sid, text: words.slice(0, Math.min(words.length, s.chunks / 3)).join(' ') } })
      }
      return null
    }
    case 'stt.end': {
      const s = stt.get(params.sid)
      stt.delete(params.sid)
      log({ method, bytes: s?.bytes ?? 0 })
      return { text: s && s.bytes > 0 ? sttText : '' }
    }
    case 'stt.cancel':
      stt.delete(params.sid)
      return {}
    case 'prewarm':
      log({ method })
      return {}
    case 'accessibility':
      return { trusted }
    case 'frontmost':
      return { app: 'Buddy', bundleId: 'com.buddy.clickyclone' }
    case 'input.click':
    case 'input.move':
    case 'input.type':
    case 'input.key':
    case 'input.scroll':
      if (!trusted) throw { code: 'not_trusted', message: 'Falta el permiso de Accesibilidad.' }
      log({ method, ...params })
      return { ok: true }
    case 'crash':
      process.exit(3)
      return null
    case 'sleep':
      await new Promise((r) => setTimeout(r, params.ms ?? 1000))
      return { slept: params.ms ?? 1000 }
    case 'cancel':
      return null
    default:
      throw { code: 'unknown_method', message: `Método desconocido: ${method}` }
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params = {} } = msg
  handle(method, params).then(
    (result) => {
      if (id !== undefined && result !== null) send({ id, result })
    },
    (err) => {
      if (id !== undefined) send({ id, error: { code: err.code ?? 'internal', message: err.message ?? String(err) } })
    }
  )
})
