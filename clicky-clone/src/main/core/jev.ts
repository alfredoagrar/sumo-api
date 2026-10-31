// Señalar más rápido con Jev (TypeSafe AI). Jev no genera texto: responde preguntas tipadas
// en ~0.1-0.5 s. Le pedimos dos cosas sobre la captura: si hay algo que señalar (`noul`) y
// dónde está (`box`). La respuesta hablada sigue viniendo de Claude o ChatGPT.
//
// Módulo sin Electron para poder probarlo con un `fetch` simulado.
import { BadRequestError, box, Image, noul, TypeSafeClient, type TypeSafeClientConfig } from '@typesafe-ai/sdk'

/** Jev localiza elementos con preguntas `box`, que solo admite este modelo. */
export const JEV_MODEL = 'jev-preview'

/** Las imágenes son experimentales en la API de TypeSafe y hay que pedirlas con esta cabecera. */
export const JEV_IMAGE_HEADER = { 'TypeSafe-Danger-Zone-Images': 'true' }

/** Por encima de esto, señalamos sin esperar a Claude/ChatGPT. */
export const DEFAULT_NEEDS_POINT = 0.6
export const DEFAULT_MIN_CONFIDENCE = 0.5

export interface JevBox {
  top: number
  bottom: number
  left: number
  right: number
}

export interface JevLocation {
  /** Centro del elemento en píxeles de la captura. */
  point: { x: number; y: number }
  /** Probabilidad (0-1) de que haga falta señalar algo; null si no se preguntó. */
  needsPoint: number | null
  /** Confianza de Jev en la caja (0-1), o null si la API no la reporta. */
  confidence: number | null
  ms: number
}

export interface JevImage {
  base64: string
  width: number
  height: number
}

/** Centro de una caja (en fracciones de la imagen) en píxeles de la imagen. */
export function boxCenter(b: JevBox, size: { width: number; height: number }): { x: number; y: number } {
  const clamp = (v: number): number => Math.min(1, Math.max(0, v))
  return {
    x: ((clamp(b.left) + clamp(b.right)) / 2) * size.width,
    y: ((clamp(b.top) + clamp(b.bottom)) / 2) * size.height
  }
}

/** ¿Es lo bastante fiable para señalar antes de que llegue la respuesta del modelo principal? */
export function shouldPointEarly(
  loc: Pick<JevLocation, 'needsPoint' | 'confidence'>,
  thresholds: { needsPoint: number; confidence: number } = { needsPoint: DEFAULT_NEEDS_POINT, confidence: DEFAULT_MIN_CONFIDENCE }
): boolean {
  if (loc.needsPoint !== null && loc.needsPoint < thresholds.needsPoint) return false
  if (loc.confidence !== null && loc.confidence < thresholds.confidence) return false
  // Sin la pregunta `noul` (modelo que no la admite) exigimos al menos una caja con confianza.
  return loc.needsPoint !== null || loc.confidence !== null
}

export function pointDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.round(Math.hypot(a.x - b.x, a.y - b.y))
}

/** Preguntas en inglés (lo más fiable para el modelo); la pregunta del usuario va tal cual. */
export function jevInstructions(question: string): { needsPoint: string; target: string } {
  const q = question.replace(/\s+/g, ' ').trim().slice(0, 300).replace(/"/g, "'")
  return {
    needsPoint: `The user is looking at this screenshot and asked: "${q}". Is there one specific element visible in the screenshot (a button, menu, tab, field, icon or link) that the user should click or look at to do this?`,
    target: `The specific on-screen element (button, menu, tab, field, icon or link) the user should click or look at to: "${q}"`
  }
}

export interface JevPointerOptions {
  /** Devuelve la API key de TypeSafe, o null si no hay. */
  getApiKey: () => string | null
  /** Opciones extra del cliente (p. ej. `fetch` simulado en pruebas). */
  client?: Partial<TypeSafeClientConfig>
  timeoutMs?: number
}

/** Cliente de Jev para localizar el elemento que hay que señalar. */
export class JevPointer {
  private readonly opts: JevPointerOptions
  private client: TypeSafeClient | null = null
  private clientKey: string | null = null
  /** Si el modelo rechaza mezclar `noul` y `box`, preguntamos solo la caja. */
  private boxOnly = false

  constructor(opts: JevPointerOptions) {
    this.opts = opts
  }

  get configured(): boolean {
    return Boolean(this.opts.getApiKey())
  }

  private getClient(): TypeSafeClient {
    const key = this.opts.getApiKey()
    if (!key) throw new Error('Falta la API key de TypeSafe (Jev).')
    if (!this.client || this.clientKey !== key) {
      this.client = new TypeSafeClient({
        apiKey: key,
        defaultModel: JEV_MODEL,
        defaultHeaders: JEV_IMAGE_HEADER,
        timeout: this.opts.timeoutMs ?? 4000,
        // Si falla, Claude/ChatGPT ya trae su propio punto: no vale la pena reintentar.
        retry: { maxRetries: 0 },
        // La captura ya es JPEG: comprimirla otra vez con zstd solo gasta CPU (medido: +20-100 ms).
        compression: false,
        logLevel: 'off',
        ...this.opts.client
      })
      this.clientKey = key
    }
    return this.client
  }

  /** Localiza en la captura el elemento relacionado con la pregunta. */
  async locate(shot: JevImage, question: string, signal?: AbortSignal): Promise<JevLocation> {
    const started = Date.now()
    const client = this.getClient()
    const text = jevInstructions(question)
    const state = Image.fromBase64(shot.base64)
    const ask = async (withNeedsPoint: boolean): Promise<JevLocation> => {
      const target = box(text.target)
      if (withNeedsPoint) {
        const { answers } = await client.systemOne(
          { state, questions: { needsPoint: noul(text.needsPoint), target }, model: JEV_MODEL },
          { signal }
        )
        return {
          point: boxCenter(answers.target.box, shot),
          needsPoint: answers.needsPoint.noul,
          confidence: answers.target.confidence,
          ms: Date.now() - started
        }
      }
      const { answers } = await client.systemOne({ state, questions: { target }, model: JEV_MODEL }, { signal })
      return { point: boxCenter(answers.target.box, shot), needsPoint: null, confidence: answers.target.confidence, ms: Date.now() - started }
    }
    if (this.boxOnly) return ask(false)
    try {
      return await ask(true)
    } catch (err) {
      if (!(err instanceof BadRequestError)) throw err
      this.boxOnly = true
      return ask(false)
    }
  }

  /** Comprueba la API key listando los modelos de la cuenta. */
  async test(): Promise<string[]> {
    const models = await this.getClient().models.list({ timeout: 8000 })
    return models.map((m) => m.name)
  }
}

/** Mensaje claro para los errores del SDK de TypeSafe. */
export function describeJevError(err: unknown): string {
  const status = (err as { status?: unknown })?.status
  if (status === 401 || status === 403) return 'La API key de TypeSafe no es válida o no tiene acceso a Jev.'
  if (status === 429) return 'Jev está limitando las peticiones (429). Prueba en un momento.'
  if (typeof status === 'number') return `Jev respondió con un error ${status}.`
  const name = (err as { name?: unknown })?.name
  if (name === 'APITimeoutError') return 'Jev tardó demasiado en responder.'
  if (name === 'APIConnectionError') return 'No se pudo conectar con api.typesafe.ai. Revisa tu conexión.'
  return err instanceof Error ? err.message : String(err)
}
