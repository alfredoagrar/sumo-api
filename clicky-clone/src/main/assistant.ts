import { app, screen, type Display } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { IPC } from '../shared/ipc'
import type { BuddyCommand, ChatTurn, ProviderId, ProviderTestResult, SpeechCommand, SttStatus, VoiceCommand } from '../shared/types'
import type { AgentManager } from './agents'
import type { AppleServices } from './apple'
import { captureDisplay, type Shot } from './capture'
import { imagePointToScreen } from './core/answer'
import type { OcrLine } from './core/apple-protocol'
import { describeJevError, pointDistance, shouldPointEarly, type JevLocation, type JevPointer } from './core/jev'
import { buildAnswerSystemPrompt, buildAnswerUserPrompt } from './core/prompts'
import type { Point } from './core/routine-runner'
import { matchRoutine } from './core/routines'
import {
  buildTriageInstructions,
  buildTriagePrompt,
  compactOcr,
  dictationVocabulary,
  heuristicRoute,
  matchOcrTarget,
  parseTriage,
  TRIAGE_SCHEMA,
  type Intent,
  type Triage
} from './core/router'
import type { Orchestrator } from './orchestrator'
import { providers } from './providers'
import { AbortedError } from './providers/types'
import type { RoutineHost, RoutineManager } from './routines'
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
  apple: AppleServices
  routines: RoutineManager
}

/** Dictado de Apple en curso: el audio llega antes de que el ayudante esté listo, así que se encola. */
interface Dictation {
  sid: string
  begin: Promise<void> | null
  ready: boolean
  failed: boolean
  queue: Float32Array[]
  partial: string
}

/**
 * Orquesta una interacción: escuchar → capturar pantalla → decidir quién responde → señalar y hablar.
 * Lo sencillo lo resuelven Apple Intelligence y Jev en el equipo; lo complejo, Claude/ChatGPT.
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
  private dictation: Dictation | null = null
  private orchestrator: Orchestrator | null = null
  private readonly historyFile = join(app.getPath('userData'), 'history.json')
  private readonly shotsDir = join(app.getPath('temp'), 'buddy-capturas')
  /** Carpeta neutral para ejecutar las CLIs (sin CLAUDE.md ni repositorios). */
  readonly cliCwd = join(app.getPath('userData'), 'cli')
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
    deps.apple.on('stt.partial', (params: { sid?: string; text?: string }) => {
      const d = this.dictation
      if (!d || params.sid !== d.sid || typeof params.text !== 'string' || !params.text) return
      d.partial = params.text
      if (this.phase === 'listening') this.buddy({ type: 'state', state: 'listening', text: params.text })
    })
    deps.apple.on('stt.assets', () => {
      if (this.phase === 'listening' || this.phase === 'transcribing') {
        this.buddy({ type: 'state', state: this.phase, text: this.es ? 'Descargando el dictado de Apple…' : 'Downloading Apple dictation…' })
      }
    })
  }

  setOrchestrator(orchestrator: Orchestrator): void {
    this.orchestrator = orchestrator
  }

  private get es(): boolean {
    return this.deps.settings.get().language === 'es'
  }

  /** Lo que necesitan las rutinas y el orquestador del asistente. */
  readonly host: RoutineHost = {
    capture: (display) => this.capture(display),
    announce: (text) => this.announce(text),
    say: (text) => {
      if (this.phase === 'idle' || this.phase === 'speaking') this.speak(text)
      else this.announce(text)
    },
    buddy: (cmd, displayId) => this.deps.overlays.send(displayId, IPC.buddy, cmd),
    pointScreen: (p: Point, label: string, displayId: number) => {
      const local = this.deps.overlays.toLocal(displayId, p)
      this.deps.overlays.send(displayId, IPC.buddy, { type: 'point', x: local.x, y: local.y, label } satisfies BuddyCommand)
    },
    isIdle: () => this.phase === 'idle' && !this.deps.prompt.isVisible()
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
    const apple = this.useAppleDictation()
    if (apple) {
      this.dictation = { sid: randomUUID(), begin: null, ready: false, failed: false, queue: [], partial: '' }
      // Mientras hablas, Apple Intelligence se va cargando para decidir rápido.
      this.deps.apple.prewarm(buildTriageInstructions(this.deps.settings.get().language))
    }
    this.voice({ type: 'start', stream: apple })
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

  // ---- Dictado de Apple ---------------------------------------------------------------------

  private useAppleDictation(): boolean {
    const s = this.deps.settings.get()
    return s.stt.engine !== 'whisper' && this.deps.apple.speech
  }

  /** es-MX, es-ES… según el sistema, para que el dictado use la variante del usuario. */
  private dictationLocale(): string {
    const lang = this.deps.settings.get().language
    const system = app.getPreferredSystemLanguages().find((l) => l.toLowerCase().startsWith(lang))
    return system ?? (lang === 'es' ? 'es-MX' : 'en-US')
  }

  onAudioChunk(samples: Float32Array, sampleRate: number): void {
    const d = this.dictation
    if (!d || d.failed || (this.phase !== 'listening' && this.phase !== 'transcribing')) return
    if (!d.begin) {
      const names = this.deps.routines.list().map((r) => r.name)
      d.begin = this.deps.apple.sttBegin(d.sid, this.dictationLocale(), sampleRate, dictationVocabulary(names)).then(
        () => {
          d.ready = true
          for (const chunk of d.queue) this.deps.apple.sttAudio(d.sid, chunk)
          d.queue = []
        },
        (err: unknown) => {
          d.failed = true
          d.queue = []
          console.warn('[apple] El dictado de Apple no arrancó; uso Whisper:', err instanceof Error ? err.message : err)
        }
      )
    }
    if (d.ready) this.deps.apple.sttAudio(d.sid, samples)
    else d.queue.push(samples)
  }

  /** El motor de voz terminó de grabar (dictado de Apple). */
  async onAudioEnd(hadSpeech: boolean): Promise<void> {
    const d = this.dictation
    this.dictation = null
    if (!d) return
    if (!hadSpeech) {
      if (d.begin) this.deps.apple.sttCancel(d.sid)
      this.onTranscript('')
      return
    }
    try {
      if (!d.begin) throw new Error('sin audio')
      await d.begin
      if (d.failed) throw new Error('no arrancó')
      const text = await this.deps.apple.sttEnd(d.sid)
      if (!text.trim()) throw new Error('vacío')
      this.onTranscript(text)
    } catch (err) {
      console.warn('[apple] Uso Whisper para esta frase:', err instanceof Error ? err.message : err)
      this.voice({ type: 'whisper-fallback' })
    }
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
    this.buddy({ type: 'state', state: 'transcribing', text: this.dictation?.partial || this.sttText() })
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

  /** Anuncio hablado (p. ej. un agente o una rutina terminó). Espera a que el buddy esté libre. */
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

    // 1. Frases de mando: no hace falta ningún modelo para saber qué hacer.
    const explicit = heuristicRoute(text)
    if (explicit) {
      this.dispatch(explicit.intent, explicit.text, text, shot)
      return
    }

    const controller = new AbortController()
    this.controller = controller
    const started = Date.now()

    // 2. Jev (opcional) localiza el elemento en paralelo. Si está seguro, el buddy vuela en cuanto
    //    Jev contesta, sin esperar a nadie más.
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

    // 3. Apple Intelligence (en el equipo): corrige el dictado y decide. Lo sencillo lo responde ya.
    let question = text
    if (s.apple.enabled && this.deps.apple.intelligence) {
      const triage = await this.triage(text, shot, controller.signal)
      if (id !== this.interaction) return
      if (triage) {
        const t = triage.triage
        question = t.text
        if (t.intent !== 'answer' && t.intent !== 'complex') {
          answered = true
          controller.abort()
          this.controller = null
          if (jevPointed) this.buddy({ type: 'unpoint' })
          // Si el modelo no extrajo el nombre de la rutina, lo sacamos de la frase corregida.
          const payload = t.intent === 'routine_run' ? t.routine || heuristicRoute(t.text)?.text || t.text : t.text
          this.dispatch(t.intent, payload, text, shot, t.text !== text ? t.text : undefined)
          return
        }
        if (t.intent === 'answer' && t.confident && s.apple.fastAnswers) {
          answered = true
          controller.abort()
          this.controller = null
          const loc = jevLoc as JevLocation | null
          let pointSource: ChatTurn['pointSource']
          if (jevPointed) {
            if (t.target) {
              pointSource = 'jev'
              this.buddy({ type: 'label', label: t.target })
            } else {
              this.buddy({ type: 'unpoint' })
            }
          } else if (t.target && shot) {
            const hit = matchOcrTarget(t.target, triage.ocr)
            if (hit) {
              pointSource = 'ocr'
              this.pointAt(shot, hit, t.target)
            }
          }
          this.record({
            question: text,
            answer: t.say,
            provider: s.provider,
            ms: Date.now() - started,
            pointed: pointSource ? t.target : undefined,
            pointSource,
            jevMs: loc?.ms,
            tier: 'apple',
            corrected: t.text !== text ? t.text : undefined
          })
          this.speak(t.say)
          return
        }
      }
    }

    // 4. Lo complejo: Claude o ChatGPT con tu suscripción.
    try {
      const answer = await providers[s.provider].ask(
        {
          systemPrompt: buildAnswerSystemPrompt(
            s.language,
            shot ? { width: shot.width, height: shot.height, cursor: shot.cursor } : null,
            s.provider === 'codex'
          ),
          userPrompt: buildAnswerUserPrompt(s.language, question, this.recentContext()),
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
        jevDeltaPx: loc && answer.point ? pointDistance(loc.point, answer.point) : undefined,
        corrected: question !== text ? question : undefined
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

  /** Apple Intelligence decide qué hacer (y responde si es sencillo). null si no se pudo. */
  private async triage(text: string, shot: Shot | null, signal: AbortSignal): Promise<{ triage: Triage; ocr: OcrLine[] } | null> {
    const apple = this.deps.apple
    const lang = this.deps.settings.get().language
    try {
      const [ocr, frontApp] = await Promise.all([
        shot && apple.ocrAvailable ? apple.ocr(shot.path, signal).then((r) => r.lines, () => [] as OcrLine[]) : Promise.resolve([] as OcrLine[]),
        apple.frontmost()
      ])
      const out = await apple.generate(
        {
          instructions: buildTriageInstructions(lang),
          prompt: buildTriagePrompt({
            text,
            routines: this.deps.routines.list().map((r) => r.name),
            screenText: compactOcr(ocr, { query: text, maxChars: 1500 }),
            frontApp: frontApp && frontApp !== 'Buddy' && frontApp !== 'Electron' ? frontApp : undefined,
            recent: this.recentContext().slice(-2)
          }),
          schema: TRIAGE_SCHEMA,
          // En macOS 27 el modelo de Apple también ve la captura.
          imagePath: shot && apple.imageInput ? shot.path : undefined,
          maxTokens: 260,
          greedy: true
        },
        signal
      )
      return { triage: parseTriage(out.json ?? out.text ?? '', text), ocr }
    } catch (err) {
      if (!signal.aborted) console.warn('[apple] Apple Intelligence no pudo decidir; respondo con el modelo principal:', err instanceof Error ? err.message : err)
      return null
    }
  }

  /** Rutinas, agentes y tareas del orquestador. */
  private dispatch(intent: Exclude<Intent, 'answer' | 'complex'>, payload: string, original: string, shot: Shot | null, corrected?: string): void {
    const s = this.deps.settings.get()
    const es = this.es
    const record = (answer: string, tier?: ChatTurn['tier']): void =>
      this.record({ question: original, answer, provider: s.provider, ms: 0, tier, corrected })

    if (intent === 'agent') {
      this.deps.agents.start(payload, shot)
      const say = es
        ? 'Entendido, me pongo con eso en segundo plano. Te aviso cuando termine.'
        : "Got it, I'll work on that in the background and let you know when it's done."
      record(say)
      this.speak(say)
      return
    }

    if (intent === 'routine_run') {
      const routines = this.deps.routines.list()
      const routine = matchRoutine(payload, routines)
      if (!routine) {
        const names = routines.map((r) => r.name).slice(0, 5)
        const say = es
          ? `No encontré la rutina «${payload}».${names.length ? ` Tienes: ${names.join(', ')}.` : ' Todavía no tienes rutinas: di «crea una rutina…».'}`
          : `I couldn't find the routine "${payload}".${names.length ? ` You have: ${names.join(', ')}.` : ''}`
        record(say)
        this.speak(say)
        return
      }
      record(es ? `Ejecutando la rutina «${routine.name}».` : `Running routine "${routine.name}".`, 'routine')
      this.phase = 'idle'
      void this.deps.routines.run(routine.id, 'voice').catch((err: unknown) => this.fail(err))
      return
    }

    if (intent === 'routine_create') {
      const say = es
        ? 'Le pido a Claude que defina la rutina. Te aviso cuando esté lista.'
        : "I'm asking Claude to define the routine. I'll let you know when it's ready."
      record(say, 'routine')
      this.speak(say)
      void this.deps.routines.create(payload, shot).then(
        ({ routine }) =>
          this.announce(
            es
              ? `Lista la rutina «${routine.name}», con ${routine.steps.length} pasos. Di «ejecuta la rutina ${routine.name}» para probarla.`
              : `Routine "${routine.name}" is ready with ${routine.steps.length} steps. Say "run routine ${routine.name}" to try it.`
          ),
        (err: unknown) => this.announce(`${es ? 'No pude crear la rutina' : 'I could not create the routine'}: ${err instanceof Error ? err.message : String(err)}`)
      )
      return
    }

    // task: Claude como orquestador, usando la pantalla con las herramientas de Buddy.
    if (!this.orchestrator) return
    const orchestrator = this.orchestrator
    void orchestrator.start(payload, shot).then(
      (task) => {
        const say =
          task.kind === 'orchestrator'
            ? es
              ? 'Me encargo con Claude. Pulsa Esc o mueve el ratón si quieres que pare.'
              : "I'm on it with Claude. Press Esc or move the mouse to stop me."
            : es
              ? 'Me pongo con eso en segundo plano.'
              : "I'll work on that in the background."
        record(say, 'orchestrator')
        this.speak(say)
      },
      (err: unknown) => this.fail(err)
    )
  }

  private fail(err: unknown): void {
    this.phase = 'idle'
    this.buddy({ type: 'state', state: 'error', text: err instanceof Error ? err.message : String(err) })
  }

  /** Cancela lo que esté pasando (petición, voz, habla, rutina u orquestador en pantalla). */
  interrupt(): void {
    this.interaction++
    this.controller?.abort()
    this.controller = null
    if (this.dictation) {
      if (this.dictation.begin) this.deps.apple.sttCancel(this.dictation.sid)
      this.dictation = null
    }
    if (this.phase === 'listening' || this.phase === 'transcribing') this.voice({ type: 'cancel' })
    if (this.phase === 'speaking') this.speech({ type: 'stop' })
    if (this.deps.routines.running) this.deps.routines.stop(this.es ? 'La interrumpiste.' : 'You interrupted it.')
    if (this.orchestrator?.busy) this.orchestrator.stop()
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
