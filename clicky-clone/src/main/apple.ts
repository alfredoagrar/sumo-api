// Servicios de Apple a través del ayudante nativo (native/apple): Apple Intelligence, dictado,
// OCR y teclado/ratón. En otros sistemas (o sin el ayudante) todo esto queda desactivado y Buddy
// funciona como antes (Whisper + Claude/ChatGPT).
import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import type { AppleStatus } from '../shared/types'
import { AppleHelper, float32ToBase64, HelperError } from './core/apple-helper'
import type { GenerateParams, GenerateResult, HelperStatus, OcrResult, SttBeginResult } from './core/apple-protocol'

/** Versión de macOS a partir de la de Darwin (Darwin 25 = macOS 26 Tahoe). */
export function macosMajor(): number {
  if (process.platform !== 'darwin') return 0
  const darwin = Number(release().split('.')[0])
  if (!Number.isFinite(darwin)) return 0
  return darwin >= 25 ? darwin + 1 : darwin - 9
}

/** Dónde está el ayudante: variable de entorno (pruebas), dentro de la app o recién compilado. */
export function findHelper(): string | null {
  const override = process.env.BUDDY_APPLE_HELPER
  if (override) return existsSync(override) ? override : null
  if (process.platform !== 'darwin') return null
  // build.sh lo deja en native/apple/bin; dentro de la app va en Resources.
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'buddy-apple')]
    : [join(app.getAppPath(), 'native', 'apple', 'bin', 'buddy-apple'), join(app.getAppPath(), 'native', 'apple', '.build', 'release', 'buddy-apple')]
  return candidates.find((p) => existsSync(p)) ?? null
}

const UNAVAILABLE_REASONS: Record<string, string> = {
  appleIntelligenceNotEnabled: 'Activa Apple Intelligence en Ajustes del Sistema → Apple Intelligence y Siri.',
  deviceNotEligible: 'Este Mac no admite Apple Intelligence (necesita un chip de Apple).',
  modelNotReady: 'El modelo de Apple Intelligence se está descargando. Prueba en un rato.'
}

export class AppleServices extends EventEmitter {
  private readonly helper: AppleHelper | null
  private status: AppleStatus
  private raw: HelperStatus | null = null
  private refreshing: Promise<AppleStatus> | null = null

  constructor() {
    super()
    const path = findHelper()
    const fromEnv = Boolean(process.env.BUDDY_APPLE_HELPER)
    const supported = fromEnv || macosMajor() >= 26
    this.helper = path && supported ? new AppleHelper({ command: path, timeoutMs: 20_000 }) : null
    this.status = this.base(
      this.helper ? 'starting' : process.platform !== 'darwin' && !fromEnv ? 'unsupported' : macosMajor() > 0 && macosMajor() < 26 ? 'unsupported' : 'missing'
    )
    if (this.helper) {
      this.helper.on('event', (name: string, params: Record<string, unknown>) => this.emit(name, params))
      this.helper.on('stderr', (chunk: string) => {
        for (const line of chunk.split('\n')) if (line.trim()) console.warn(`[apple] ${line.trim()}`)
      })
      this.helper.on('exit', () => void this.refresh())
    }
  }

  private base(helper: AppleStatus['helper'], detail?: string): AppleStatus {
    const defaults: Record<AppleStatus['helper'], string> = {
      ready: 'Ayudante de macOS listo.',
      starting: 'Iniciando el ayudante de macOS…',
      missing: 'Falta compilar el ayudante de macOS: ejecuta «npm run build:apple» (necesita Xcode 26 o superior).',
      unsupported:
        process.platform === 'darwin'
          ? 'Necesita macOS 26 (Tahoe) o superior.'
          : 'Apple Intelligence y el dictado de Apple solo están en macOS. Buddy usa Whisper y tu suscripción.',
      error: 'El ayudante de macOS no responde.'
    }
    return {
      helper,
      detail: detail ?? defaults[helper],
      intelligence: { available: false, imageInput: false },
      speech: { available: false },
      ocr: false,
      input: { backend: 'none', trusted: false }
    }
  }

  getStatus(): AppleStatus {
    return this.status
  }

  get intelligence(): boolean {
    return this.status.helper === 'ready' && this.status.intelligence.available
  }

  get imageInput(): boolean {
    return this.intelligence && this.status.intelligence.imageInput
  }

  get speech(): boolean {
    return this.status.helper === 'ready' && this.status.speech.available
  }

  get ocrAvailable(): boolean {
    return this.status.helper === 'ready' && this.status.ocr
  }

  get hasHelper(): boolean {
    return this.status.helper === 'ready'
  }

  get trusted(): boolean {
    return this.raw?.accessibility ?? false
  }

  /** Vuelve a preguntar al ayudante (al arrancar, al abrir Ajustes o si se reinició). */
  refresh(): Promise<AppleStatus> {
    if (!this.helper) return Promise.resolve(this.status)
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      try {
        const raw = await this.helper!.request<HelperStatus>('status', {}, { timeoutMs: 15_000 })
        this.raw = raw
        const reason = raw.intelligence.reason
        this.status = {
          helper: 'ready',
          detail: `Ayudante ${raw.version} en ${raw.os}${raw.sdk27 ? ' · SDK de macOS 27' : ''}`,
          intelligence: {
            available: raw.intelligence.available,
            imageInput: raw.intelligence.imageInput,
            reason: reason ? UNAVAILABLE_REASONS[reason] ?? reason : undefined
          },
          speech: raw.speech,
          ocr: raw.ocr,
          input: { backend: 'helper', trusted: raw.accessibility }
        }
      } catch (err) {
        this.raw = null
        this.status = this.base('error', err instanceof Error ? err.message : String(err))
      } finally {
        this.refreshing = null
      }
      this.emit('status', this.status)
      return this.status
    })()
    return this.refreshing
  }

  private need(): AppleHelper {
    if (!this.helper) throw new HelperError('unavailable', this.status.detail)
    return this.helper
  }

  generate(params: GenerateParams, signal?: AbortSignal): Promise<GenerateResult> {
    return this.need().request<GenerateResult>('generate', params, { timeoutMs: 20_000, signal })
  }

  /** Carga el modelo mientras el usuario habla, para que la decisión llegue antes. */
  prewarm(instructions: string): void {
    if (this.intelligence) this.helper?.request('prewarm', { instructions }, { timeoutMs: 5000 }).catch(() => undefined)
  }

  ocr(imagePath: string, signal?: AbortSignal): Promise<OcrResult> {
    return this.need().request<OcrResult>('ocr', { imagePath, languages: ['es-ES', 'en-US'] }, { timeoutMs: 8000, signal })
  }

  async frontmost(): Promise<string> {
    if (!this.hasHelper) return ''
    try {
      const r = await this.need().request<{ app: string }>('frontmost', {}, { timeoutMs: 2000 })
      return r.app
    } catch {
      return ''
    }
  }

  /** Pide el permiso de Accesibilidad (macOS muestra su diálogo) y actualiza el estado. */
  async requestAccessibility(): Promise<AppleStatus> {
    if (!this.helper) return this.status
    try {
      await this.helper.request('accessibility', { prompt: true }, { timeoutMs: 5000 })
    } catch {
      // se ve en el estado
    }
    return this.refresh()
  }

  // ---- Dictado ------------------------------------------------------------------------------

  sttBegin(sid: string, locale: string, sampleRate: number, contextualStrings: string[]): Promise<SttBeginResult> {
    // La primera vez puede descargar el modelo de dictado: le damos tiempo.
    return this.need().request<SttBeginResult>('stt.begin', { sid, locale, sampleRate, contextualStrings }, { timeoutMs: 180_000 })
  }

  sttAudio(sid: string, samples: Float32Array): void {
    this.helper?.notify('stt.audio', { sid, data: float32ToBase64(samples) })
  }

  async sttEnd(sid: string): Promise<string> {
    const r = await this.need().request<{ text: string }>('stt.end', { sid }, { timeoutMs: 10_000 })
    return r.text
  }

  sttCancel(sid: string): void {
    this.helper?.request('stt.cancel', { sid }, { timeoutMs: 5000 }).catch(() => undefined)
  }

  // ---- Teclado y ratón ----------------------------------------------------------------------

  input(method: 'input.click' | 'input.move' | 'input.type' | 'input.key' | 'input.scroll', params: object): Promise<unknown> {
    return this.need().request(method, params, { timeoutMs: 30_000 })
  }

  stop(): void {
    this.helper?.stop()
  }
}
