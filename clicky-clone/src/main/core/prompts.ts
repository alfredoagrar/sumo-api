// Prompts y esquema de respuesta del asistente. Módulo puro (sin Electron) para poder probarlo.

export type Lang = 'es' | 'en'

export interface HistoryItem {
  question: string
  answer: string
}

/**
 * Esquema JSON de la respuesta rápida. Compatible con el modo estricto de OpenAI
 * (todas las propiedades requeridas, sin propiedades extra) y con `--json-schema` de Claude Code.
 */
export const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    say: {
      type: 'string',
      description: 'Lo que el asistente dirá en voz alta. Breve, sin markdown.'
    },
    point: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            x: { type: 'number', description: 'Centro del elemento, en píxeles de la captura.' },
            y: { type: 'number', description: 'Centro del elemento, en píxeles de la captura.' },
            label: { type: 'string', description: 'Etiqueta corta del elemento (1-3 palabras).' }
          },
          required: ['x', 'y', 'label']
        }
      ]
    }
  },
  required: ['say', 'point']
} as const

export interface ScreenContext {
  width: number
  height: number
  /** Posición del cursor en píxeles de la captura, si se conoce. */
  cursor?: { x: number; y: number }
}

export function buildAnswerSystemPrompt(lang: Lang, screen: ScreenContext | null, forCodex: boolean): string {
  const es = lang === 'es'
  const lines: string[] = []
  if (es) {
    lines.push(
      'Eres Buddy, un compañero de IA que vive junto al cursor del usuario. El usuario te habla por voz (la transcripción puede tener errores) mientras usa su computadora.'
    )
    if (screen) {
      lines.push(
        `Recibes una captura de la pantalla donde está su cursor. La captura mide ${screen.width}×${screen.height} píxeles, con el origen (0,0) en la esquina superior izquierda.`
      )
      if (screen.cursor) {
        lines.push(`El cursor del usuario está en (${Math.round(screen.cursor.x)}, ${Math.round(screen.cursor.y)}) de la captura.`)
      }
    }
    lines.push(
      '',
      'Cómo responder:',
      '- Responde siempre en español, como en una conversación hablada: breve (normalmente 1 o 2 frases), cálido y directo. Tu respuesta se leerá en voz alta: no uses markdown, listas, emojis ni URLs largas.',
      '- Si el usuario pregunta dónde está algo, cómo hacer algo o qué pulsar, y el elemento está visible en la captura, señálalo: pon en "point" las coordenadas (x, y) del centro del elemento en píxeles de la captura y una etiqueta corta (1 a 3 palabras). En "say" explica el siguiente paso.',
      '- Si el paso necesario no está visible (está dentro de un menú, en otra pestaña o fuera de la vista), señala el elemento que lo revela y di qué hacer después. No comentes que no puedes ver esa otra pantalla.',
      '- Si no hace falta señalar nada, usa "point": null.',
      '- No inventes elementos que no estén en la captura. Si de verdad no estás seguro, dilo en pocas palabras; no añadas advertencias innecesarias.',
      '- Si la pregunta no tiene que ver con la pantalla, respóndela igualmente con "point": null.'
    )
    if (forCodex) {
      lines.push('- No ejecutes comandos ni leas archivos: responde solo con lo que ves en la captura y lo que sabes.')
    }
  } else {
    lines.push(
      'You are Buddy, an AI companion that lives next to the user\'s cursor. The user talks to you by voice (the transcript may contain errors) while using their computer.'
    )
    if (screen) {
      lines.push(
        `You receive a screenshot of the screen the cursor is on. It is ${screen.width}x${screen.height} pixels, origin (0,0) at the top-left corner.`
      )
      if (screen.cursor) {
        lines.push(`The user's cursor is at (${Math.round(screen.cursor.x)}, ${Math.round(screen.cursor.y)}) in the screenshot.`)
      }
    }
    lines.push(
      '',
      'How to answer:',
      '- Always answer in English, like a spoken conversation: short (usually 1 or 2 sentences), warm and direct. Your answer is read aloud: no markdown, lists, emojis or long URLs.',
      '- If the user asks where something is, how to do something or what to click, and the element is visible in the screenshot, point at it: set "point" to the (x, y) center of the element in screenshot pixels and a short label (1 to 3 words). In "say", explain the next step.',
      '- If the needed step is not visible (inside a menu, another tab or off-screen), point at the element that reveals it and say what to do next. Do not mention that you cannot see that other screen.',
      '- If nothing needs pointing at, use "point": null.',
      '- Never invent elements that are not in the screenshot. If you are genuinely unsure, say so briefly; skip unnecessary caveats.',
      '- If the question is unrelated to the screen, still answer it with "point": null.'
    )
    if (forCodex) {
      lines.push('- Do not run commands or read files: answer only from the screenshot and what you know.')
    }
  }
  return lines.join('\n')
}

export function buildAnswerUserPrompt(lang: Lang, question: string, history: HistoryItem[]): string {
  const es = lang === 'es'
  const parts: string[] = []
  if (history.length > 0) {
    parts.push(es ? 'Conversación reciente (de la más antigua a la más reciente):' : 'Recent conversation (oldest first):')
    for (const h of history) {
      parts.push(`${es ? 'Usuario' : 'User'}: ${h.question}`)
      parts.push(`Buddy: ${h.answer}`)
    }
    parts.push('')
  }
  parts.push(`${es ? 'Pregunta actual del usuario' : 'Current user question'}: "${question.trim()}"`)
  return parts.join('\n')
}

/** Instrucciones extra para las tareas en segundo plano. */
export function buildAgentInstructions(lang: Lang, hasScreenshot: boolean): string {
  if (lang === 'es') {
    return [
      'Estás trabajando en segundo plano para el usuario mientras sigue usando su computadora.',
      'Trabaja de forma autónoma: no hagas preguntas, toma decisiones razonables y continúa hasta terminar.',
      'Guarda cualquier entregable (documentos, código, notas, investigaciones) dentro del directorio de trabajo actual.',
      hasScreenshot ? 'Se adjunta una captura de la pantalla del usuario en el momento de pedir la tarea, como contexto.' : '',
      'Cuando termines, responde con un resumen muy breve (1 o 2 frases, sin markdown) de lo que hiciste y qué archivo creaste, porque se leerá en voz alta.'
    ]
      .filter(Boolean)
      .join('\n')
  }
  return [
    'You are working in the background for the user while they keep using their computer.',
    'Work autonomously: do not ask questions, make reasonable decisions and keep going until done.',
    'Save any deliverables (documents, code, notes, research) inside the current working directory.',
    hasScreenshot ? 'A screenshot of the user\'s screen at the moment they asked is attached as context.' : '',
    'When finished, reply with a very short summary (1 or 2 sentences, no markdown) of what you did and which file you created, because it will be read aloud.'
  ]
    .filter(Boolean)
    .join('\n')
}

const AGENT_INTENT = /^\s*(?:oye|hey|ok|okay)?[\s,]*(?:buddy[\s,]+)?(?:agente|agent)\b[\s,:.\-–—]*(.*)$/is

/**
 * Detecta si una frase pide lanzar un agente ("agente: investiga…", "hey agent, build…").
 * Devuelve la tarea sin la palabra clave, o null si no es una petición de agente.
 */
export function parseAgentIntent(text: string): string | null {
  const m = AGENT_INTENT.exec(text)
  if (!m) return null
  const task = m[1].trim()
  return task.length > 0 ? task : null
}

/** Título corto para una tarea de agente. */
export function agentTitle(task: string): string {
  const clean = task.replace(/\s+/g, ' ').trim()
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean
}

/** Nombre de carpeta seguro a partir de la tarea. */
export function slugify(text: string, max = 40): string {
  const slug = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
  return slug || 'tarea'
}
