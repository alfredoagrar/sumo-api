// "Ojos" rápidos para rutinas y orquestador: Jev (TypeSafe) responde sí/no y localiza elementos en
// ~0.3 s. Si Jev no está configurado o no está seguro, se pregunta al modelo principal (más lento,
// usa tu plan), salvo que lo desactives en Ajustes.
import type { Shot } from './capture'
import { extractJsonObject, imagePointToScreen } from './core/answer'
import { DEFAULT_MIN_CONFIDENCE, describeJevError, type JevPointer } from './core/jev'
import { buildAnswerSystemPrompt } from './core/prompts'
import type { VisionCheck, VisionLocate } from './core/routine-runner'
import { providers } from './providers'
import type { SettingsStore } from './settings'

const CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    visible: { type: 'boolean', description: 'true si la condición se cumple en la captura.' },
    confidence: { type: 'number', description: 'Seguridad de 0 a 1.' }
  },
  required: ['visible', 'confidence']
} as const

function checkSystemPrompt(lang: 'es' | 'en'): string {
  return lang === 'es'
    ? 'Eres un verificador de QA. Mira la captura de pantalla y di si la condición se cumple. Responde solo con lo que ves.'
    : 'You are a QA checker. Look at the screenshot and say whether the condition holds. Answer only from what you see.'
}

export class ScreenVision {
  private readonly jev: JevPointer
  private readonly settings: SettingsStore
  private readonly cliCwd: string

  constructor(deps: { jev: JevPointer; settings: SettingsStore; cliCwd: string }) {
    this.jev = deps.jev
    this.settings = deps.settings
    this.cliCwd = deps.cliCwd
  }

  private toScreen(shot: Shot, p: { x: number; y: number }): { x: number; y: number } {
    return imagePointToScreen(p, shot, shot.display.bounds)
  }

  private canEscalate(): boolean {
    return this.settings.get().routines.escalateToModel
  }

  private noVision(): Error {
    return new Error('Para mirar la pantalla rápido hace falta Jev (Ajustes → Jev), o activa «Preguntar al modelo si Jev no está seguro».')
  }

  async check(shot: Shot, condition: string, signal: AbortSignal): Promise<VisionCheck> {
    if (this.jev.configured) {
      try {
        const r = await this.jev.check(shot, condition, signal)
        return { probability: r.probability, via: 'jev', ms: r.ms }
      } catch (err) {
        if (signal.aborted) throw err
        if (!this.canEscalate()) throw new Error(describeJevError(err))
        console.warn('[vision] Jev falló, pregunto al modelo:', describeJevError(err))
      }
    } else if (!this.canEscalate()) {
      throw this.noVision()
    }
    const s = this.settings.get()
    const started = Date.now()
    const raw = await providers[s.provider].structured(
      {
        systemPrompt: checkSystemPrompt(s.language),
        userPrompt: `${s.language === 'es' ? 'Condición' : 'Condition'}: "${condition}"`,
        image: shot,
        cwd: this.cliCwd,
        schema: CHECK_SCHEMA
      },
      s,
      signal
    )
    const data = (typeof raw === 'string' ? extractJsonObject(raw) : raw) as { visible?: unknown; confidence?: unknown } | null
    const confidence = typeof data?.confidence === 'number' ? Math.min(1, Math.max(0, data.confidence)) : 0.5
    const probability = data?.visible === true ? confidence : 1 - confidence
    return { probability, via: 'model', ms: Date.now() - started }
  }

  async locate(shot: Shot, target: string, signal: AbortSignal): Promise<VisionLocate | null> {
    let unsure: VisionLocate | null = null
    if (this.jev.configured) {
      try {
        const r = await this.jev.find(shot, target, signal)
        const loc: VisionLocate = { point: this.toScreen(shot, r.point), confidence: r.confidence, via: 'jev', ms: r.ms }
        if (r.confidence === null || r.confidence >= DEFAULT_MIN_CONFIDENCE || !this.canEscalate()) return loc
        unsure = loc
      } catch (err) {
        if (signal.aborted) throw err
        if (!this.canEscalate()) throw new Error(describeJevError(err))
        console.warn('[vision] Jev falló, pregunto al modelo:', describeJevError(err))
      }
    } else if (!this.canEscalate()) {
      throw this.noVision()
    }
    const s = this.settings.get()
    const started = Date.now()
    const answer = await providers[s.provider].ask(
      {
        systemPrompt: buildAnswerSystemPrompt(s.language, { width: shot.width, height: shot.height }, s.provider === 'codex'),
        userPrompt:
          s.language === 'es'
            ? `Señala exactamente este elemento: "${target}". Si no está visible, usa "point": null.`
            : `Point exactly at this element: "${target}". If it is not visible, use "point": null.`,
        image: shot,
        cwd: this.cliCwd
      },
      s,
      signal
    )
    if (!answer.point) return unsure
    return { point: this.toScreen(shot, answer.point), confidence: null, via: 'model', ms: Date.now() - started }
  }

  /** Pregunta abierta sobre la captura (pasos `ask`): siempre la responde el modelo principal. */
  async ask(shot: Shot, question: string, signal: AbortSignal): Promise<string> {
    const s = this.settings.get()
    const answer = await providers[s.provider].ask(
      {
        systemPrompt: buildAnswerSystemPrompt(s.language, { width: shot.width, height: shot.height }, s.provider === 'codex'),
        userPrompt: question,
        image: shot,
        cwd: this.cliCwd
      },
      s,
      signal
    )
    return answer.say
  }
}
