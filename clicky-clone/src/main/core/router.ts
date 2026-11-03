// Enrutador: decide quién atiende cada petición para que lo sencillo sea instantáneo.
//   - Rutinas, agentes y tareas: frases explícitas (sin modelo).
//   - Apple Intelligence (en el equipo, gratis): corrige el dictado, responde lo sencillo y clasifica.
//   - Claude/ChatGPT (tu suscripción): lo complejo, definir rutinas y orquestar tareas largas.
// Módulo puro (sin Electron) para poder probarlo.
import type { AppleSchema, OcrLine } from './apple-protocol.ts'
import { parseAgentIntent } from './prompts.ts'
import { matchScore, normalizeText, tokens } from './text.ts'

export type Intent = 'answer' | 'complex' | 'routine_run' | 'routine_create' | 'task' | 'agent'

export const INTENTS: readonly Intent[] = ['answer', 'complex', 'routine_run', 'routine_create', 'task', 'agent']

export interface Triage {
  /** La petición con el dictado corregido. */
  text: string
  intent: Intent
  /** routine_run: nombre de la rutina. */
  routine: string
  /** answer: lo que Buddy dirá. */
  say: string
  /** Texto visible del elemento que hay que señalar (si hay). */
  target: string
  confident: boolean
}

export interface HeuristicRoute {
  intent: Exclude<Intent, 'answer' | 'complex'>
  /** La tarea, la descripción o el nombre de la rutina, sin la frase de mando. */
  text: string
}

const LEAD = String.raw`^\s*(?:oye|hey|ok|okay|vale)?[\s,]*(?:buddy[\s,]+)?(?:por\s+favor[\s,]+)?`

const RUN_ROUTINE = new RegExp(
  `${LEAD}(?:ejecuta|ejecutar|corre|correr|lanza|lanzar|inicia|iniciar|pasa|pasar|repite|repetir|haz|run|start|launch|execute)\\s+(?:la\\s+|el\\s+|mi\\s+|the\\s+|my\\s+)?(?:rutina|routine|prueba|test|qa)\\b[\\s,:.\\-–—]*(?:de\\s+|del\\s+|of\\s+)?(.+)$`,
  'is'
)
const CREATE_ROUTINE = new RegExp(
  `${LEAD}(?:crea|crear|créame|creame|haz(?:me)?|graba|grabar|define|definir|prepara|preparar|nueva|create|make|record|define|build)\\s+(?:una\\s+|un\\s+|a\\s+|an\\s+)?(?:nueva\\s+|new\\s+)?(?:rutina|routine|prueba\\s+de\\s+qa|prueba\\s+qa|test\\s+de\\s+qa|qa\\s+test|qa)\\b`,
  'is'
)
const TASK = new RegExp(
  `${LEAD}(?:hazlo\\s+t[uú]|h[aá]zlo|encárgate|encargate|automatiza|orquesta|toma\\s+el\\s+control|do\\s+it\\s+for\\s+me|take\\s+over|automate)(?=[\\s,:.\\-–—]|$)[\\s,:.\\-–—]*(?:de\\s+)?(.+)$`,
  'is'
)

/** Frases de mando explícitas ("ejecuta la rutina login", "agente, …", "hazlo tú: …"). */
export function heuristicRoute(text: string): HeuristicRoute | null {
  const agent = parseAgentIntent(text)
  if (agent) return { intent: 'agent', text: agent }
  const run = RUN_ROUTINE.exec(text)
  if (run && run[1].trim()) return { intent: 'routine_run', text: run[1].trim().replace(/[.?!¡¿]+$/g, '') }
  // Para crear una rutina, Claude recibe la frase entera: "para el registro" dice más que "el registro".
  if (CREATE_ROUTINE.test(text)) return { intent: 'routine_create', text: text.trim() }
  const task = TASK.exec(text)
  if (task && task[1].trim()) return { intent: 'task', text: task[1].trim() }
  return null
}

/** Esquema de la decisión que toma Apple Intelligence (en este orden). */
export const TRIAGE_SCHEMA: AppleSchema = {
  name: 'Triage',
  properties: [
    { name: 'text', type: 'string', description: "The user's request with speech recognition errors fixed, in the user's language." },
    { name: 'intent', type: 'string', enum: [...INTENTS], description: 'Who should handle the request.' },
    { name: 'routine', type: 'string', description: 'For routine_run: the exact name of the saved routine. Otherwise empty.' },
    { name: 'say', type: 'string', description: 'For answer: what Buddy says aloud, one or two short sentences. Otherwise empty.' },
    { name: 'target', type: 'string', description: 'Exact visible text of the on-screen element to point at, or empty.' },
    { name: 'confident', type: 'boolean', description: 'True only if the answer is surely correct and complete.' }
  ]
}

export function buildTriageInstructions(lang: 'es' | 'en'): string {
  const language = lang === 'es' ? 'Spanish' : 'English'
  return [
    "You are the fast on-device router of Buddy, a voice assistant that lives next to the user's cursor.",
    'The user spoke a request; the transcript may contain speech recognition errors.',
    'Choose the intent:',
    '- answer: a short question you can answer right now from the visible screen text or general knowledge (where is X on the screen, what does this say, a quick fact, simple math, a definition). Write the spoken answer in "say".',
    '- complex: anything that needs careful reasoning, reading a layout or image, code, long or multi-step explanations, or when you are unsure.',
    '- routine_run: run one of the saved routines. Put its exact name in "routine".',
    '- routine_create: create or record a new repeatable routine or QA test.',
    '- task: the user wants Buddy to do actions on the screen for them (fill a form, test a flow, click through an app).',
    "- agent: a long background job that doesn't need the screen (research, writing a document).",
    'Fix obvious recognition errors in "text" using the screen text and the routine names.',
    'If the user asks where something is and its text is visible, put that exact visible text in "target".',
    'Never invent screen content. Set "confident" to true only when the answer is surely right.',
    `Write "text" and "say" in ${language}.`
  ].join('\n')
}

export interface TriageInput {
  text: string
  routines: string[]
  /** Texto visible (ya compactado con compactOcr). */
  screenText: string
  frontApp?: string
  recent: { question: string; answer: string }[]
}

export function buildTriagePrompt(i: TriageInput): string {
  const parts: string[] = []
  if (i.routines.length) parts.push(`Saved routines: ${i.routines.slice(0, 30).join('; ')}`)
  if (i.frontApp) parts.push(`Frontmost app: ${i.frontApp}`)
  if (i.screenText) parts.push(`Visible screen text (top to bottom):\n${i.screenText}`)
  if (i.recent.length) {
    parts.push(`Recent conversation:\n${i.recent.map((r) => `User: ${r.question}\nBuddy: ${r.answer}`).join('\n')}`)
  }
  parts.push(`Transcript: "${i.text.trim()}"`)
  return parts.join('\n\n')
}

function asString(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

/** Valida la respuesta del modelo. Ante cualquier duda, `complex` (lo atiende Claude/ChatGPT). */
export function parseTriage(raw: unknown, original: string): Triage {
  let data: unknown = raw
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw)
    } catch {
      data = null
    }
  }
  const r = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  const intent = INTENTS.includes(r.intent as Intent) ? (r.intent as Intent) : 'complex'
  let text = asString(r.text, 4000)
  // Si "corrige" demasiado (otra frase distinta), nos quedamos con lo que dijo el usuario.
  if (!text || matchScore(text, original) < 0.6) text = original.trim()
  const say = asString(r.say, 600)
  const triage: Triage = {
    text,
    intent,
    routine: asString(r.routine, 120),
    say,
    target: asString(r.target, 160),
    confident: r.confident === true
  }
  if (triage.intent === 'answer' && !triage.say) triage.confident = false
  return triage
}

/**
 * Texto visible para el prompt del modelo en el equipo (tiene un contexto pequeño): primero las
 * líneas que se parecen a la pregunta, y luego en orden de lectura hasta llenar el presupuesto.
 */
export function compactOcr(lines: OcrLine[], opts: { maxChars?: number; query?: string } = {}): string {
  const maxChars = opts.maxChars ?? 1800
  const q = new Set(tokens(opts.query ?? '').filter((t) => t.length > 2))
  const seen = new Set<string>()
  const candidates = lines
    .map((l, i) => ({ l, i, text: l.text.replace(/\s+/g, ' ').trim().slice(0, 90) }))
    .filter((c) => {
      const key = normalizeText(c.text)
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((c) => ({ ...c, score: tokens(c.text).filter((t) => q.has(t)).length }))
  const ranked = [...candidates].sort((a, b) => b.score - a.score || a.i - b.i)
  const chosen: typeof candidates = []
  let used = 0
  for (const c of ranked) {
    if (used + c.text.length + 1 > maxChars) continue
    chosen.push(c)
    used += c.text.length + 1
  }
  chosen.sort((a, b) => a.l.y - b.l.y || a.l.x - b.l.x)
  return chosen.map((c) => c.text).join('\n')
}

/** Busca en el OCR el elemento que nombró el modelo y devuelve su centro (píxeles de la imagen). */
export function matchOcrTarget(target: string, lines: OcrLine[]): { x: number; y: number; text: string; score: number } | null {
  if (!target.trim()) return null
  let best: { line: OcrLine; score: number } | null = null
  for (const line of lines) {
    const score = matchScore(target, line.text)
    if (!best || score > best.score || (score === best.score && line.text.length < best.line.text.length)) best = { line, score }
  }
  if (!best || best.score < 0.6) return null
  return { x: best.line.x + best.line.w / 2, y: best.line.y + best.line.h / 2, text: best.line.text, score: best.score }
}

/** Palabras para el dictado de Apple: nombres de rutinas y de la app. Máximo 100 (límite de Apple). */
export function dictationVocabulary(routineNames: string[]): string[] {
  const base = ['Buddy', 'Jev', 'Claude', 'ChatGPT', 'Codex', 'rutina', 'agente']
  const out: string[] = []
  for (const w of [...base, ...routineNames]) {
    const clean = w.replace(/\s+/g, ' ').trim().slice(0, 40)
    if (clean && !out.includes(clean)) out.push(clean)
    if (out.length >= 100) break
  }
  return out
}
