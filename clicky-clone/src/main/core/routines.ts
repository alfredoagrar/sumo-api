// Rutinas: tareas repetitivas estilo QA. Claude las define una vez (orquestador) y después se
// repiten rápido con Jev (ver y localizar) y el teclado/ratón, sin volver a gastar tu plan.
// Módulo puro (sin Electron) para poder probarlo.
import type { RoutineRun, RoutineSchedule, RoutineStep, RoutineStepKind } from '../../shared/types'
import { describeStep } from '../../shared/routine-text.ts'
import { matchScore, normalizeText } from './text.ts'

export { describeStep }

export const STEP_KINDS: readonly RoutineStepKind[] = ['open', 'click', 'type', 'key', 'scroll', 'wait', 'waitFor', 'check', 'point', 'say', 'ask']

/** Pasos que mueven el ratón o escriben: necesitan permiso y se pueden interrumpir moviendo el ratón. */
const ACTING: ReadonlySet<RoutineStepKind> = new Set(['click', 'type', 'key', 'scroll'])

export const MAX_STEPS = 60
export const MIN_EVERY_MINUTES = 5
const MAX_WAIT_SECONDS = 120

export function isActingStep(step: RoutineStep): boolean {
  return ACTING.has(step.kind)
}

export function routineActs(steps: RoutineStep[]): boolean {
  return steps.some(isActingStep)
}

/** Sinónimos que a veces usan los modelos para los tipos de paso. */
const KIND_ALIASES: Record<string, RoutineStepKind> = {
  open: 'open',
  navigate: 'open',
  goto: 'open',
  go_to: 'open',
  launch: 'open',
  click: 'click',
  tap: 'click',
  press_button: 'click',
  type: 'type',
  input: 'type',
  fill: 'type',
  write: 'type',
  key: 'key',
  keys: 'key',
  press: 'key',
  hotkey: 'key',
  shortcut: 'key',
  scroll: 'scroll',
  wait: 'wait',
  sleep: 'wait',
  pause: 'wait',
  waitfor: 'waitFor',
  wait_for: 'waitFor',
  wait_until: 'waitFor',
  check: 'check',
  assert: 'check',
  verify: 'check',
  expect: 'check',
  point: 'point',
  show: 'point',
  highlight: 'point',
  say: 'say',
  speak: 'say',
  announce: 'say',
  ask: 'ask',
  analyze: 'ask'
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Valida y limpia un paso. Devuelve null si le falta lo imprescindible. */
export function normalizeStep(raw: unknown): RoutineStep | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kind = KIND_ALIASES[str(r.kind, 30).toLowerCase().replace(/[\s-]+/g, '_')]
  if (!kind) return null
  const target = str(r.target, 200)
  const text = typeof r.text === 'string' ? r.text.trim().slice(0, 2000) : ''
  const keys = str(r.keys, 60)
  const condition = str(r.condition, 300)
  const note = str(r.note, 200)
  const withNote = (step: RoutineStep): RoutineStep => (note ? { ...step, note } : step)
  switch (kind) {
    case 'open':
      return target ? withNote({ kind, target }) : null
    case 'click':
    case 'point':
      if (!target) return null
      return withNote(kind === 'point' && text ? { kind, target, text } : { kind, target })
    case 'type':
      if (!text) return null
      return withNote(target ? { kind, text, target } : { kind, text })
    case 'key':
      return keys && parseKeyCombo(keys) ? withNote({ kind, keys }) : null
    case 'scroll':
      return withNote({ kind, direction: r.direction === 'up' ? 'up' : 'down' })
    case 'wait':
      return withNote({ kind, seconds: num(r.seconds, 1, 0.2, MAX_WAIT_SECONDS) })
    case 'waitFor':
      return condition ? withNote({ kind, condition, seconds: num(r.seconds, 15, 1, MAX_WAIT_SECONDS) }) : null
    case 'check':
      return condition ? withNote({ kind, condition, expect: r.expect !== false }) : null
    case 'say':
      return text ? withNote({ kind, text }) : null
    case 'ask':
      return condition ? withNote({ kind, condition }) : null
  }
}

export interface CompiledRoutine {
  name: string
  description: string
  steps: RoutineStep[]
}

/** Valida lo que devuelve el modelo al definir una rutina. */
export function normalizeRoutine(raw: unknown): { routine: CompiledRoutine; warnings: string[] } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const warnings: string[] = []
  const steps: RoutineStep[] = []
  const list = Array.isArray(r.steps) ? r.steps : []
  list.forEach((s, i) => {
    const step = normalizeStep(s)
    if (step) steps.push(step)
    else warnings.push(`Paso ${i + 1} descartado: le faltan datos o su tipo no es válido.`)
  })
  if (steps.length > MAX_STEPS) {
    warnings.push(`La rutina tenía ${steps.length} pasos; se quedaron los primeros ${MAX_STEPS}.`)
    steps.length = MAX_STEPS
  }
  return {
    routine: {
      name: str(r.name, 60) || 'Rutina',
      description: str(r.description, 400),
      steps
    },
    warnings
  }
}

export function normalizeSchedule(raw: unknown): RoutineSchedule | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const every = typeof r.everyMinutes === 'number' && Number.isFinite(r.everyMinutes) ? Math.round(r.everyMinutes) : 0
  const everyMinutes = every > 0 ? Math.max(MIN_EVERY_MINUTES, Math.min(24 * 60, every)) : 0
  const daily = typeof r.dailyAt === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(r.dailyAt) ? r.dailyAt : ''
  return everyMinutes || daily ? { everyMinutes, dailyAt: daily } : null
}

/** Próxima ejecución programada (ms), o null si no tiene horario. */
export function nextRunAt(schedule: RoutineSchedule | null, lastRunAt: number | null, since: number, now: number): number | null {
  if (!schedule) return null
  const candidates: number[] = []
  if (schedule.everyMinutes >= MIN_EVERY_MINUTES) {
    candidates.push((lastRunAt ?? since) + schedule.everyMinutes * 60_000)
  }
  const m = /^(\d{2}):(\d{2})$/.exec(schedule.dailyAt)
  if (m) {
    const d = new Date(now)
    d.setHours(Number(m[1]), Number(m[2]), 0, 0)
    // Si ya pasó hoy (o ya se ejecutó después de esa hora), toca mañana.
    if (d.getTime() <= now || (lastRunAt !== null && lastRunAt >= d.getTime())) d.setDate(d.getDate() + 1)
    candidates.push(d.getTime())
  }
  return candidates.length ? Math.min(...candidates) : null
}

export type Modifier = 'cmd' | 'ctrl' | 'alt' | 'shift'

export interface KeyCombo {
  key: string
  modifiers: Modifier[]
}

const MODIFIERS: Record<string, Modifier | 'mod'> = {
  cmd: 'cmd',
  command: 'cmd',
  meta: 'cmd',
  super: 'cmd',
  win: 'cmd',
  '⌘': 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  ctl: 'ctrl',
  '⌃': 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  '⌥': 'alt',
  shift: 'shift',
  mayus: 'shift',
  '⇧': 'shift',
  mod: 'mod',
  cmdorctrl: 'mod',
  commandorcontrol: 'mod'
}

const KEYS: Record<string, string> = {
  enter: 'enter',
  return: 'enter',
  intro: 'enter',
  '↩': 'enter',
  esc: 'escape',
  escape: 'escape',
  tab: 'tab',
  tabulador: 'tab',
  space: 'space',
  espacio: 'space',
  backspace: 'backspace',
  borrar: 'backspace',
  delete: 'delete',
  del: 'delete',
  supr: 'delete',
  up: 'up',
  arriba: 'up',
  down: 'down',
  abajo: 'down',
  left: 'left',
  izquierda: 'left',
  right: 'right',
  derecha: 'right',
  home: 'home',
  inicio: 'home',
  end: 'end',
  fin: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown'
}

/**
 * "cmd+shift+s", "Enter", "ctrl+l" → tecla + modificadores. `mod` es ⌘ en macOS y Ctrl en el resto.
 * Devuelve null si no se entiende.
 */
export function parseKeyCombo(combo: string, platform: string = 'darwin'): KeyCombo | null {
  const parts = combo
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
  if (parts.length === 0 || parts.some((p) => !p)) return null
  const modifiers: Modifier[] = []
  let key: string | null = null
  for (const part of parts) {
    const mod = MODIFIERS[part.replace(/\s+/g, '')]
    if (mod) {
      const real: Modifier = mod === 'mod' ? (platform === 'darwin' ? 'cmd' : 'ctrl') : mod
      if (!modifiers.includes(real)) modifiers.push(real)
      continue
    }
    if (key !== null) return null
    if (KEYS[part]) key = KEYS[part]
    else if (/^f([1-9]|1[0-2])$/.test(part)) key = part
    else if ([...part].length === 1) key = part
    else return null
  }
  return key === null ? null : { key, modifiers }
}

/** {{fecha}}, {{hora}}, {{aleatorio}} y {{timestamp}} (también en inglés) dentro del texto a escribir. */
export function expandPlaceholders(text: string, now: Date = new Date(), random: () => number = Math.random): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  return text.replace(/\{\{\s*(fecha|date|hora|time|aleatorio|random|timestamp)\s*\}\}/gi, (_m, name: string) => {
    switch (name.toLowerCase()) {
      case 'fecha':
      case 'date':
        return date
      case 'hora':
      case 'time':
        return time
      case 'timestamp':
        return String(now.getTime())
      default:
        return Math.floor(random() * 36 ** 6)
          .toString(36)
          .padStart(6, '0')
    }
  })
}

/** Busca la rutina que el usuario nombró (tolerando errores de dictado). */
export function matchRoutine<T extends { name: string }>(query: string, routines: T[]): T | null {
  const q = normalizeText(query)
    .replace(/\b(la|el|de|del|mi|the|my|rutina|routine|prueba|test|qa)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!q) return null
  let best: { r: T; score: number } | null = null
  for (const r of routines) {
    const name = normalizeText(r.name)
    const score = Math.max(matchScore(q, name), matchScore(q, name.replace(/\b(rutina|routine|prueba|test|qa)\b/g, ' ').trim()))
    if (!best || score > best.score) best = { r, score }
  }
  return best && best.score >= 0.55 ? best.r : null
}

/** Resumen hablado de una ejecución (si no hay Apple Intelligence para redactarlo). */
export function summarizeRun(run: Pick<RoutineRun, 'status' | 'steps' | 'routineName'>, steps: RoutineStep[], lang: 'es' | 'en' = 'es'): string {
  const es = lang === 'es'
  const done = run.steps.filter((s) => s.status === 'passed').length
  const total = steps.length
  if (run.status === 'passed') return es ? `La rutina «${run.routineName}» pasó: ${done} de ${total} pasos bien.` : `Routine "${run.routineName}" passed: ${done} of ${total} steps OK.`
  if (run.status === 'cancelled') return es ? `Detuve la rutina «${run.routineName}».` : `I stopped routine "${run.routineName}".`
  const failed = run.steps.find((s) => s.status === 'failed' || s.status === 'error')
  if (!failed) return es ? `La rutina «${run.routineName}» no terminó.` : `Routine "${run.routineName}" did not finish.`
  const what = steps[failed.index] ? describeStep(steps[failed.index], lang) : ''
  return es
    ? `La rutina «${run.routineName}» falló en el paso ${failed.index + 1}: ${what}. ${failed.detail}`.trim()
    : `Routine "${run.routineName}" failed at step ${failed.index + 1}: ${what}. ${failed.detail}`.trim()
}

/**
 * Esquema para que Claude (o ChatGPT) convierta una descripción en pasos. Todas las propiedades
 * son obligatorias para que también valga en el modo estricto de OpenAI; las que no aplican van vacías.
 */
export const ROUTINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: 'Nombre corto de la rutina (2 a 5 palabras).' },
    description: { type: 'string', description: 'Qué comprueba la rutina, en una frase.' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: [...STEP_KINDS] },
          target: { type: 'string', description: 'click/point/type: elemento visible. open: URL o nombre de la app. Vacío si no aplica.' },
          text: { type: 'string', description: 'type: texto a escribir. say: frase. point: explicación opcional. Vacío si no aplica.' },
          keys: { type: 'string', description: 'key: combinación como "enter", "tab" o "cmd+s". Vacío si no aplica.' },
          condition: { type: 'string', description: 'check/waitFor: lo que debe verse. ask: la pregunta. Vacío si no aplica.' },
          expect: { type: 'boolean', description: 'check: true si debe verse, false si NO debe verse.' },
          seconds: { type: 'number', description: 'wait: segundos. waitFor: tiempo máximo. 0 si no aplica.' },
          direction: { type: 'string', enum: ['up', 'down'] },
          note: { type: 'string', description: 'Para qué sirve el paso, muy corto. Puede ir vacío.' }
        },
        required: ['kind', 'target', 'text', 'keys', 'condition', 'expect', 'seconds', 'direction', 'note']
      }
    }
  },
  required: ['name', 'description', 'steps']
} as const

export function buildRoutineSystemPrompt(lang: 'es' | 'en', platform: string): string {
  const mac = platform === 'darwin'
  const lines = [
    'You design repeatable routines (QA checks and UI flows) for Buddy, a desktop assistant.',
    'A routine runs later WITHOUT you: a fast vision model (Jev) answers yes/no questions about screenshots and locates elements, and Buddy clicks and types.',
    'So every step must be atomic and concrete. Step kinds:',
    '- open: open a URL or app ("target" = URL like https://… or app name).',
    '- click: click a visible element ("target").',
    '- type: type "text", optionally clicking "target" first to focus it.',
    `- key: press keys ("keys"), e.g. "enter", "tab", "escape", "${mac ? 'cmd' : 'ctrl'}+s".`,
    '- scroll: scroll "direction" up or down.',
    '- wait: wait "seconds" (avoid; prefer waitFor).',
    '- waitFor: wait until "condition" is visible (max "seconds", default 15). Use after navigation, logins and submits.',
    '- check: QA assertion. "condition" must be visible ("expect": true) or must NOT be visible ("expect": false).',
    '- point: point at "target" for the user (guide without clicking).',
    '- say: say a short sentence to the user.',
    '- ask: ask the main model a question about the screen when a judgement needs real reasoning (slow; use rarely).',
    '',
    'Rules:',
    '- Write "target" and "condition" in English as short visual descriptions of what is on screen, e.g. "the blue Save button in the top toolbar", "an error message saying the password is wrong". Mention visible text exactly when there is some.',
    `- Write "name", "description", "note" and "say" text in ${lang === 'es' ? 'Spanish' : 'English'}.`,
    '- Start from the current screen unless the user names a URL or app; then begin with "open" and a "waitFor".',
    '- Add a "check" for every expected result the user mentions, and a "waitFor" after anything that loads.',
    '- In "type" you may use placeholders {{fecha}}, {{hora}}, {{aleatorio}} (6 random characters, useful for unique emails) and {{timestamp}}.',
    '- Only use credentials or data the user gave you. Do not add destructive steps (delete, pay, send to real people) unless the user asked for them.',
    '- At most 40 steps. Fill every field; use "" , 0, true and "down" for fields that do not apply.'
  ]
  return lines.join('\n')
}

export function buildRoutineUserPrompt(lang: 'es' | 'en', description: string, existing: string[], hasScreenshot: boolean): string {
  const parts = [lang === 'es' ? `Rutina que pide el usuario: "${description.trim()}"` : `Routine requested by the user: "${description.trim()}"`]
  if (hasScreenshot) parts.push('The attached screenshot shows the screen when the user asked (where the routine starts).')
  if (existing.length) parts.push(`Existing routines (do not reuse these names): ${existing.join('; ')}`)
  return parts.join('\n')
}

/** Cuántos pasos pasaron de los que se ejecutaron. */
export function runCounts(run: Pick<RoutineRun, 'steps'>, total: number): { passed: number; total: number } {
  return { passed: run.steps.filter((s) => s.status === 'passed').length, total }
}

