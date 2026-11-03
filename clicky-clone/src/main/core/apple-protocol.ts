// Protocolo entre Buddy y su ayudante nativo de macOS (`native/apple`, en Swift).
// Una petición JSON por línea en stdin y una respuesta o evento JSON por línea en stdout:
//   → {"id": 1, "method": "generate", "params": {...}}
//   ← {"id": 1, "result": {...}}          o  {"id": 1, "error": {"code": "...", "message": "..."}}
//   ← {"event": "stt.partial", "params": {"sid": "…", "text": "…"}}
// Un mensaje sin "id" es una notificación (no tiene respuesta), p. ej. "stt.audio".

/** Campo de un esquema de generación guiada (se convierte en DynamicGenerationSchema en Swift). */
export interface AppleField {
  name: string
  description?: string
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'
  /** Solo para `string`: valores permitidos. */
  enum?: string[]
  optional?: boolean
  /** Para `object`, en el orden en que el modelo debe generarlos. */
  properties?: AppleField[]
  /** Para `array`. */
  items?: Omit<AppleField, 'name' | 'optional'>
  minItems?: number
  maxItems?: number
}

export interface AppleSchema {
  name: string
  description?: string
  properties: AppleField[]
}

export interface GenerateParams {
  instructions: string
  prompt: string
  schema?: AppleSchema
  /** Captura que el modelo puede ver (solo macOS 27 o superior). */
  imagePath?: string
  maxTokens?: number
  /** true = la opción más probable siempre (respuestas estables). */
  greedy?: boolean
}

export interface GenerateResult {
  /** JSON generado según el esquema (si se pidió) o el texto. */
  json?: string
  text?: string
  ms: number
  /** El modelo vio la imagen. */
  usedImage: boolean
}

export interface HelperStatus {
  version: string
  os: string
  /** Compilado con el SDK de macOS 27 (imágenes en Apple Intelligence). */
  sdk27: boolean
  intelligence: { available: boolean; reason?: string; imageInput: boolean }
  speech: { available: boolean; detail?: string }
  ocr: boolean
  accessibility: boolean
}

/** Línea reconocida por OCR, en píxeles de la imagen (origen arriba a la izquierda). */
export interface OcrLine {
  text: string
  x: number
  y: number
  w: number
  h: number
  confidence?: number
}

export interface OcrResult {
  lines: OcrLine[]
  width: number
  height: number
  ms: number
}

export interface SttBeginParams {
  sid: string
  /** BCP-47, p. ej. "es-MX". */
  locale: string
  sampleRate: number
  /** Palabras que ayudan al dictado (nombres de rutinas, apps…). */
  contextualStrings: string[]
}

export interface SttBeginResult {
  locale: string
  module: 'speech' | 'dictation'
}

/** Errores conocidos del ayudante (campo `code`). */
export type HelperErrorCode =
  | 'unavailable'
  | 'invalid_params'
  | 'unknown_method'
  | 'not_trusted'
  | 'unsupported_locale'
  | 'assets'
  | 'generation'
  | 'internal'
