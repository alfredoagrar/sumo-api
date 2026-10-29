// Interpretación de la respuesta del modelo y conversión de coordenadas. Módulo puro.

export interface AnswerPoint {
  x: number
  y: number
  label: string
}

export interface Answer {
  say: string
  point: AnswerPoint | null
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Extrae el primer objeto JSON balanceado de un texto (por si el modelo añadió texto o ```json). */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // seguimos buscando
  }
  const start = trimmed.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/**
 * Normaliza la respuesta del modelo. Acepta un objeto ya parseado (salida estructurada) o texto.
 * Si no hay JSON válido, usa el texto tal cual como respuesta hablada.
 */
export function parseAnswer(raw: unknown, size?: { width: number; height: number }): Answer {
  let value: unknown = raw
  if (typeof raw === 'string') {
    const parsed = extractJsonObject(raw)
    if (parsed && typeof parsed === 'object') value = parsed
    else return { say: cleanSpoken(raw), point: null }
  }
  if (!value || typeof value !== 'object') return { say: '', point: null }
  const obj = value as Record<string, unknown>
  const say = typeof obj.say === 'string' ? cleanSpoken(obj.say) : ''
  return { say, point: parsePoint(obj.point, size) }
}

function parsePoint(raw: unknown, size?: { width: number; height: number }): AnswerPoint | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const x = Number(p.x)
  const y = Number(p.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (size && (x < 0 || y < 0 || x > size.width || y > size.height)) return null
  const label = typeof p.label === 'string' ? p.label.trim().slice(0, 40) : ''
  return { x, y, label }
}

/** Quita markdown y símbolos que suenan mal al leerse en voz alta. */
export function cleanSpoken(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,;:!?]|$)/g, '$1$2')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Convierte un punto en píxeles de la captura a coordenadas de pantalla (DIP),
 * sabiendo qué rectángulo de pantalla cubre la captura.
 */
export function imagePointToScreen(
  point: { x: number; y: number },
  image: { width: number; height: number },
  displayBounds: Rect
): { x: number; y: number } {
  const sx = displayBounds.width / image.width
  const sy = displayBounds.height / image.height
  return {
    x: Math.round(displayBounds.x + point.x * sx),
    y: Math.round(displayBounds.y + point.y * sy)
  }
}

/** Inverso de imagePointToScreen: posición del cursor (DIP) dentro de la captura. */
export function screenPointToImage(
  point: { x: number; y: number },
  image: { width: number; height: number },
  displayBounds: Rect
): { x: number; y: number } {
  return {
    x: ((point.x - displayBounds.x) * image.width) / displayBounds.width,
    y: ((point.y - displayBounds.y) * image.height) / displayBounds.height
  }
}

/**
 * Tamaño de la captura que mandamos al modelo. Claude recomienda no pasar de ~1.15 MP
 * ni de 1568 px en el lado largo para que no reescale la imagen (y las coordenadas cuadren).
 */
export function captureSize(width: number, height: number, maxEdge = 1568, maxPixels = 1_150_000): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height), Math.sqrt(maxPixels / (width * height)))
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }
}
