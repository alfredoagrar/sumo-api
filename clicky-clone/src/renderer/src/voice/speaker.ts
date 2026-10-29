// Síntesis de voz con las voces del sistema (speechSynthesis). Gratis y local.
import type { Language } from '../../../shared/types'

export interface SpeakOptions {
  enabled: boolean
  language: Language
  voiceURI: string
  rate: number
}

const PREFERRED: Record<Language, string[]> = {
  es: ['es-MX', 'es-US', 'es-419', 'es-ES', 'es'],
  en: ['en-US', 'en-GB', 'en']
}

const QUALITY = /(premium|enhanced|neural|natural|siri|google)/i

export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const voices = speechSynthesis.getVoices()
  if (voices.length) return Promise.resolve(voices)
  return new Promise((resolve) => {
    const done = (): void => resolve(speechSynthesis.getVoices())
    speechSynthesis.addEventListener('voiceschanged', done, { once: true })
    setTimeout(done, 1500)
  })
}

export function pickVoice(voices: SpeechSynthesisVoice[], language: Language, voiceURI: string): SpeechSynthesisVoice | undefined {
  if (voiceURI) {
    const chosen = voices.find((v) => v.voiceURI === voiceURI)
    if (chosen) return chosen
  }
  for (const tag of PREFERRED[language]) {
    const matches = voices.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(tag.toLowerCase()))
    if (matches.length) return matches.find((v) => QUALITY.test(v.name)) ?? matches.find((v) => v.localService) ?? matches[0]
  }
  return undefined
}

/** Parte el texto en frases: algunas voces de Chromium se cortan con textos largos. */
export function splitSentences(text: string, max = 220): string[] {
  const parts = text.match(/[^.!?¡¿]+[.!?]+|[^.!?]+$/g) ?? [text]
  const out: string[] = []
  for (const raw of parts) {
    let p = raw.trim()
    while (p.length > max) {
      const cut = p.lastIndexOf(' ', max)
      const at = cut > 40 ? cut : max
      out.push(p.slice(0, at).trim())
      p = p.slice(at).trim()
    }
    if (p) out.push(p)
  }
  return out
}

export class Speaker {
  private generation = 0
  private timer: number | null = null
  // Guardamos referencias para que el recolector de basura no corte los eventos `end`.
  private utterances: SpeechSynthesisUtterance[] = []

  /** Habla el texto. Resuelve `true` si terminó, `false` si se interrumpió. */
  async speak(text: string, opts: SpeakOptions): Promise<boolean> {
    this.stop()
    const gen = ++this.generation
    // Sin voz: dejamos el subtítulo el tiempo que se tardaría en leerlo.
    if (!opts.enabled || !('speechSynthesis' in window)) return this.readingPause(text, gen)
    const voices = await loadVoices()
    if (gen !== this.generation) return false
    // Sin voces instaladas (p. ej. algunos Linux) caemos al modo subtítulo.
    if (voices.length === 0) return this.readingPause(text, gen)
    const voice = pickVoice(voices, opts.language, opts.voiceURI)
    const startedAt = performance.now()
    let failed = false
    for (const sentence of splitSentences(text)) {
      const ok = await new Promise<boolean>((resolve) => {
        const u = new SpeechSynthesisUtterance(sentence)
        if (voice) u.voice = voice
        u.lang = voice?.lang ?? (opts.language === 'es' ? 'es-MX' : 'en-US')
        u.rate = opts.rate
        // Si el motor no avisa del final, no nos quedamos colgados.
        const watchdog = window.setTimeout(() => resolve(gen === this.generation), 4000 + sentence.length * 120)
        u.onend = () => {
          window.clearTimeout(watchdog)
          resolve(gen === this.generation)
        }
        u.onerror = (e) => {
          window.clearTimeout(watchdog)
          if (e.error !== 'interrupted' && e.error !== 'canceled') failed = true
          resolve(gen === this.generation)
        }
        this.utterances.push(u)
        speechSynthesis.speak(u)
      })
      if (!ok) return false
      if (failed) break
    }
    this.utterances = []
    if (gen !== this.generation) return false
    // Si la voz falló, dejamos el subtítulo el tiempo de lectura que falte.
    if (failed) return this.readingPause(text, gen, performance.now() - startedAt)
    return true
  }

  private readingPause(text: string, gen: number, alreadyMs = 0): Promise<boolean> {
    const ms = Math.min(12_000, Math.max(2500, text.length * 55)) - alreadyMs
    return new Promise((resolve) => {
      this.timer = window.setTimeout(() => resolve(gen === this.generation), Math.max(0, ms))
    })
  }

  stop(): void {
    this.generation++
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = null
    this.utterances = []
    if ('speechSynthesis' in window) speechSynthesis.cancel()
  }
}
