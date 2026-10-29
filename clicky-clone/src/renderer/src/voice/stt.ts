import type { SttStatus } from '../../../shared/types'
import SttWorker from './stt.worker?worker'
import type { WorkerRequest, WorkerResponse } from './stt.worker'

// Frases que Whisper "alucina" con silencio o ruido. Si la transcripción es solo esto, la ignoramos.
const HALLUCINATIONS = [
  /^gracias\.?$/i,
  /^muchas gracias\.?$/i,
  /^¡?gracias por ver(lo|el video)?!?\.?$/i,
  /subt[ií]tulos (realizados )?por la comunidad de amara\.org/i,
  /^thank you\.?$/i,
  /^thanks for watching!?\.?$/i,
  /^\[?(m[uú]sica|music|silencio|silence|aplausos|applause)\]?\.?$/i,
  /^\.+$/
]

export function cleanTranscript(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return HALLUCINATIONS.some((re) => re.test(t)) ? '' : t
}

/** Cliente del worker de Whisper. */
export class SpeechToText {
  private readonly worker: Worker
  private model = ''
  private device: 'auto' | 'webgpu' | 'wasm' = 'auto'
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>()

  constructor(onStatus: (s: SttStatus) => void) {
    this.worker = new SttWorker()
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      if (msg.type === 'status') onStatus(msg.status)
      else {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.type === 'result') p.resolve(msg.text)
        else p.reject(new Error(msg.message))
      }
    }
    this.worker.onerror = (e) => onStatus({ state: 'error', message: e.message || 'El motor de voz falló.' })
  }

  configure(model: string, device: 'auto' | 'webgpu' | 'wasm'): void {
    this.model = model
    this.device = device
  }

  /** Descarga/carga el modelo por adelantado para que la primera pregunta sea rápida. */
  warmup(): void {
    this.post({ type: 'load', model: this.model, device: this.device })
  }

  transcribe(audio: Float32Array, language: 'es' | 'en'): Promise<string> {
    this.warmup()
    const id = this.nextId++
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve: (t) => resolve(cleanTranscript(t)), reject })
      this.post({ type: 'transcribe', id, audio, language: language === 'es' ? 'spanish' : 'english' }, [audio.buffer])
    })
  }

  private post(msg: WorkerRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer)
  }
}
