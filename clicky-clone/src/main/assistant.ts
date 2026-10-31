import { app, screen, type Display } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { IPC } from '../shared/ipc'
import type { BuddyCommand, ChatTurn, ProviderId, ProviderTestResult, SpeechCommand, SttStatus, VoiceCommand } from '../shared/types'
import type { AgentManager } from './agents'
import { captureDisplay, type Shot } from './capture'
import { imagePointToScreen } from './core/answer'
import { describeJevError, pointDistance, shouldPointEarly, type JevLocation, type JevPointer } from './core/jev'
import { buildAnswerSystemPrompt, buildAnswerUserPrompt, parseAgentIntent } from './core/prompts'
import { providers } from './providers'
import { AbortedError } from './providers/types'
import type { SettingsStore } from './settings'
import type { OverlayManager, PromptWindow, VoiceWindow } from './windows'

type Phase = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking'

const MAX_HISTORY = 200
const CONTEXT_TURNS = 4
const CONTEXT_WINDOW_MS = 10 * 60 * 1000

interface Deps {
  settings: SettingsStore
  overlays: OverlayManager
  prompt: PromptWindow
  voice: VoiceWindow
  agents: AgentManager
  jev: JevPointer
}

/**
 * Orquesta una interacción: escuchar → capturar pantalla → preguntar al modelo → señalar y hablar.
 */
export class Assistant extends EventEmitter {
  private phase: Phase = 'idle'
  private displayId: number | null = null
  private controller: AbortController | null = null
  private interaction = 0
  private pendingShot: Promise<Shot | null> | null = null
  private captureWaiter: (() => void) | null = null
  private readonly announcements: string[] = []
  private history: ChatTurn[] = []
  private stt: SttStatus = { state: 'idle' }
  private readonly historyFile = join(app.getPath('userData'), 'history.json')
  private readonly shotsDir = join(app.getPath('temp'), 'buddy-capturas')
  /** Carpeta neutral para ejecutar las CLIs (sin CLAUDE.md ni repositorios). */
  private readonly cliCwd = join(app.getPath('userData'), 'cli')
  private readonly deps: Deps

  constructor(deps: Deps) {
    super()
    this.deps = deps
    mkdirSync(this.cliCwd, { recursive: true })
    try {
      if (existsSync(this.historyFile)) this.history = JSON.parse(readFileSync(this.historyFile, 'utf8')) as ChatTurn[]
    } catch {
      this.history = []
    }
  }

  private get es(): boolean {
    return this.deps.settings.get().language === 'es'
  }

  // ---- Atajos -------------------------------------------------------------------------------

  /** Atajo de voz: la primera pulsación empieza a escuchar; la segunda termina. */
  toggleTalk(): void {
    if (this.phase === 'listening') {
      this.phase = 'transcribing'
      this.voice({ type: 'stop' })
      this.buddy({ type: 'state', state: 'transcribing', text: this.sttText() })
      return
    }
    this.interrupt()
    this.displayId = this.deps.overlays.displayAtCursor().id
    this.phase = 'listening'
    this.voice({ type: 'start' })
    this.buddy({ type: 'state', state: 'listening' })
  }

  /** Atajo de texto: captura la pantalla y abre la barra para escribir. */
  openTypedPrompt(): void {
    if (this.deps.prompt.isVisible()) {
      this.deps.prompt.hide()
      return
    }
    this.interrupt()
    const display = this.deps.overlays.displayAtCursor()
    const cursor = screen.getCursorScreenPoint()
    this.displayId = display.id
    const shot = this.capture(display).catch((err: unknown) => {
      console.warn('[assistant] Captura fallida:', err)
      return null
    })
    this.pendingShot = shot
    // Mostramos la barra cuando la captura terminó, para que no salga en la imagen.
    let shown = false
    const show = (): void => {
      if (shown) return
      shown = true
      this.deps.prompt.show(cursor)
    }
    void shot.then(show)
    setTimeout(show, 700)
  }

  askText(question: string): void {
    this.deps.prompt.hide()
    const shot = this.pendingShot
    this.pendingShot = null
    if (!question.trim()) return
    if (this.displayId === null) this.displayId = this.deps.overlays.displayAtCursor().id
    void this.handleQuestion(question.trim(), shot ?? undefined)
  }

  // ---- Mensajes del overlay -------------------------------------------------------------------

  onTranscript(text: string): void {
    if (this.phase !== 'listening' && this.phase !== 'transcribing') return
    const clean = text.trim()
    if (!clean) {
      this.phase = 'idle'
      this.buddy({ type: 'state', state: 'idle' })
      this.flushAnnouncements()
      return
    }
    void this.handleQuestion(clean)
  }

  onVoiceError(message: string): void {
    if (this.phase !== 'listening' && this.phase !== 'transcribing') return
    this.phase = 'idle'
    this.buddy({ type: 'state', state: 'error', text: message })
  }

  /** Nivel del micrófono (0-1) para animar al buddy mientras escucha. */
  onVoiceLevel(level: number): void {
    if (this.phase === 'listening') this.buddy({ type: 'level', value: level })
  }

  /** El motor de voz dejó de grabar por su cuenta (silencio o tiempo máximo). */
  onVoiceStopped(): void {
    if (this.phase !== 'listening') return
    this.phase = 'transcribing'
    this.buddy({ type: 'state', state: 'transcribing', text: this.sttText() })
  }

  onSttStatus(status: SttStatus): void {
    this.stt = status
    this.emit('stt', status)
    if (this.phase === 'transcribing') this.buddy({ type: 'state', state: 'transcribing', text: this.sttText() })
  }

  getSttStatus(): SttStatus {
    return this.stt
  }

  private sttText(): string | undefined {
    if (this.stt.state !== 'loading') return undefined
    const pct = this.stt.progress !== undefined ? ` ${Math.round(this.stt.progress)}%` : ''
    return this.es ? `Descargando el modelo de voz…${pct}` : `Downloading the speech model…${pct}`
  }

  onCaptureReady(): void {
    this.captureWaiter?.()
  }

  onSpeechDone(): void {
    if (this.phase !== 'speaking') return
    this.phase = 'idle'
    this.buddy({ type: 'state', state: 'idle' })
    this.flushAnnouncements()
  }

  /** Anuncio hablado (p. ej. un agente terminó). Espera a que el buddy esté libre. */
  announce(text: string): void {
    this.announcements.push(text)
    this.flushAnnouncements()
  }

  private flushAnnouncements(): void {
    if (this.phase !== 'idle') return
    const next = this.announcements.shift()
    if (!next) return
    this.displayId = this.deps.overlays.displayAtCursor().id
    this.speak(next)
  }

  // ---- Flujo principal ------------------------------------------------------------------------

  private async handleQuestion(text: string, shotPromise?: Promise<Shot | null>): Promise<void> {
    const id = ++this.interaction
    const s = this.deps.settings.get()
    const display = this.currentDisplay()
    this.phase = 'thinking'
    this.buddy({ type: 'state', state: 'thinking', text })

    let shot: Shot | null = null
    try {
      shot = shotPromise ? await shotPromise : await this.capture(display)
    } catch (err) {
      console.warn('[assistant] Sigo sin captura:', err)
    }
    if (id !== this.interaction) return

    const agentTask = parseAgentIntent(text)
    if (agentTask) {
      this.deps.agents.start(agentTask, shot)
      const say = this.es
        ? 'Entendido, me pongo con eso en segundo plano. Te aviso cuando termine.'
        : "Got it, I'll work on that in the background and let you know when it's done."
      this.record({ question: text, answer: say, provider: s.provider, ms: 0 })
      this.speak(say)
      return
    }

    const controller = new AbortController()
    this.controller = controller
    const started = Date.now()

    // Jev (opcional) localiza el elemento en paralelo mientras el modelo principal prepara la
    // respuesta. Si está seguro, el buddy vuela en cuanto Jev contesta, sin esperar a Claude/ChatGPT.
    let answered = false
    let jevLoc: JevLocation | null = null
    let jevPointed = false
    if (shot && s.pointer.engine === 'jev' && this.deps.jev.configured) {
      const snap = shot
      this.deps.jev.locate(snap, text, controller.signal).then(
        (loc) => {
          if (answered || id !== this.interaction) return
          jevLoc = loc
          if (!shouldPointEarly(loc)) return
          jevPointed = true
          this.pointAt(snap, loc.point, '')
        },
        (err: unknown) => {
          if (!controller.signal.aborted) console.warn('[jev] No se pudo localizar:', describeJevError(err))
        }
      )
    }

    try {
      const answer = await providers[s.provider].ask(
        {
          systemPrompt: buildAnswerSystemPrompt(
            s.language,
            shot ? { width: shot.width, height: shot.height, cursor: shot.cursor } : null,
            s.provider === 'codex'
          ),
          userPrompt: buildAnswerUserPrompt(s.language, text, this.recentContext()),
          image: shot ?? undefined,
          cwd: this.cliCwd
        },
        s,
        controller.signal
      )
      answered = true
      if (id !== this.interaction) return
      const say = answer.say || (this.es ? 'No estoy seguro de qué responder.' : "I'm not sure what to say.")
      // TypeScript no ve las asignaciones hechas dentro del .then de arriba.
      const loc = jevLoc as JevLocation | null
      let pointSource: ChatTurn['pointSource']
      if (jevPointed) {
        // El modelo principal decide si hay que señalar: si dice que no, el buddy vuelve.
        if (answer.point) {
          pointSource = 'jev'
          if (answer.point.label) this.buddy({ type: 'label', label: answer.point.label })
        } else {
          this.buddy({ type: 'unpoint' })
        }
      } else if (answer.point && shot) {
        pointSource = 'model'
        this.pointAt(shot, answer.point, answer.point.label)
      }
      this.record({
        question: text,
        answer: say,
        provider: s.provider,
        ms: Date.now() - started,
        pointed: answer.point?.label,
        pointSource,
        jevMs: loc?.ms,
        jevDeltaPx: loc && answer.point ? pointDistance(loc.point, answer.point) : undefined
      })
      this.speak(say)
    } catch (err) {
      if (id !== this.interaction || err instanceof AbortedError) return
      const message = err instanceof Error ? err.message : String(err)
      this.record({ question: text, answer: message, provider: s.provider, ms: Date.now() - started, error: true })
      this.phase = 'idle'
      this.buddy({ type: 'state', state: 'error', text: message })
    } finally {
      if (this.controller === controller) this.controller = null
    }
  }

  /** Cancela lo que esté pasando (petición, voz, habla). */
  interrupt(): void {
    this.interaction++
    this.controller?.abort()
    this.controller = null
    if (this.phase === 'listening' || this.phase === 'transcribing') this.voice({ type: 'cancel' })
    if (this.phase === 'speaking') this.speech({ type: 'stop' })
    if (this.phase !== 'idle') this.buddy({ type: 'stop' })
    this.phase = 'idle'
  }

  /** Manda al buddy a un punto de la captura (en píxeles de la imagen). */
  private pointAt(shot: Shot, point: { x: number; y: number }, label: string): void {
    const onScreen = imagePointToScreen(point, shot, shot.display.bounds)
    const local = this.deps.overlays.toLocal(shot.display.id, onScreen)
    this.buddy({ type: 'point', x: local.x, y: local.y, label })
  }

  private speak(text: string): void {
    this.phase = 'speaking'
    this.buddy({ type: 'state', state: 'speaking', text })
    this.speech({ type: 'speak', text })
  }

  private speech(cmd: SpeechCommand): void {
    this.deps.voice.send(IPC.speech, cmd)
  }

  /** Oculta el buddy, espera a que el overlay lo confirme y captura la pantalla. */
  private async capture(display: Display): Promise<Shot> {
    this.deps.overlays.send(display.id, IPC.buddy, { type: 'hide-for-capture' } satisfies BuddyCommand)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, 250)
      function done(): void {
        clearTimeout(timer)
        resolve()
      }
      this.captureWaiter = done
    })
    this.captureWaiter = null
    try {
      return await captureDisplay(display, this.shotsDir)
    } finally {
      this.deps.overlays.send(display.id, IPC.buddy, { type: 'show-after-capture' } satisfies BuddyCommand)
    }
  }

  private currentDisplay(): Display {
    const all = screen.getAllDisplays()
    return all.find((d) => d.id === this.displayId) ?? this.deps.overlays.displayAtCursor()
  }

  private buddy(cmd: BuddyCommand): void {
    const target = this.displayId ?? this.deps.overlays.displayAtCursor().id
    if (cmd.type === 'stop') this.deps.overlays.broadcast(IPC.buddy, cmd)
    else this.deps.overlays.send(target, IPC.buddy, cmd)
  }

  private voice(cmd: VoiceCommand): void {
    this.deps.voice.send(IPC.voice, cmd)
  }

  // ---- Historial ------------------------------------------------------------------------------

  getHistory(): ChatTurn[] {
    return this.history
  }

  clearHistory(): void {
    this.history = []
    this.persist()
    this.emit('history', this.history)
  }

  private recentContext(): { question: string; answer: string }[] {
    const since = Date.now() - CONTEXT_WINDOW_MS
    return this.history
      .filter((t) => !t.error && t.at >= since)
      .slice(-CONTEXT_TURNS)
      .map((t) => ({ question: t.question, answer: t.answer }))
  }

  private record(turn: Omit<ChatTurn, 'id' | 'at'>): void {
    this.history = [...this.history, { ...turn, id: randomUUID(), at: Date.now() }].slice(-MAX_HISTORY)
    this.persist()
    this.emit('history', this.history)
  }

  private persist(): void {
    try {
      writeFileSync(this.historyFile, JSON.stringify(this.history))
    } catch {
      // no es grave
    }
  }

  // ---- Prueba de conexión ---------------------------------------------------------------------

  async testProvider(id: ProviderId): Promise<ProviderTestResult> {
    const s = this.deps.settings.get()
    const started = Date.now()
    try {
      const question = this.es ? 'Hola, ¿me escuchas? Responde con una frase corta.' : 'Hi, can you hear me? Reply with one short sentence.'
      const answer = await providers[id].ask(
        {
          systemPrompt: buildAnswerSystemPrompt(s.language, null, id === 'codex'),
          userPrompt: buildAnswerUserPrompt(s.language, question, []),
          cwd: this.cliCwd
        },
        s,
        AbortSignal.timeout(120_000)
      )
      return { ok: true, ms: Date.now() - started, text: answer.say }
    } catch (err) {
      return { ok: false, ms: Date.now() - started, text: err instanceof Error ? err.message : String(err) }
    }
  }
}
