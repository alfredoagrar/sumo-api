// Tipos compartidos entre el proceso principal, el preload y los renderers.

export type ProviderId = 'claude' | 'codex'

export type Language = 'es' | 'en'

export interface Settings {
  provider: ProviderId
  language: Language
  claude: {
    /** Ruta al binario `claude`. Vacío = detectar automáticamente. */
    binary: string
    /** Alias (haiku, sonnet, opus…) o nombre completo del modelo. Vacío = el de tu cuenta. */
    model: string
    /** Modelo para las tareas de agente. Vacío = el de tu cuenta. */
    agentModel: string
  }
  codex: {
    /** Ruta al binario `codex`. Vacío = detectar automáticamente. */
    binary: string
    /** Modelo de Codex. Vacío = el de tu configuración de Codex. */
    model: string
    /** Esfuerzo de razonamiento para respuestas rápidas. Vacío = el predeterminado. */
    reasoningEffort: '' | 'minimal' | 'low' | 'medium' | 'high'
  }
  voice: {
    enabled: boolean
    /** voiceURI de speechSynthesis. Vacío = la mejor voz del idioma. */
    voiceURI: string
    rate: number
  }
  stt: {
    /**
     * Motor de dictado. `auto` usa el dictado de Apple (SpeechAnalyzer, en el equipo) si está
     * disponible y, si no, Whisper.
     */
    engine: 'auto' | 'apple' | 'whisper'
    /** Modelo Whisper (ONNX) que se ejecuta localmente con transformers.js. */
    model: string
    device: 'auto' | 'webgpu' | 'wasm'
  }
  apple: {
    /** Usar Apple Intelligence (modelo de Apple en el equipo) para entender lo que pides. */
    enabled: boolean
    /**
     * Responder en el equipo las preguntas sencillas (con Jev para señalar) y dejar
     * Claude/ChatGPT solo para lo complejo.
     */
    fastAnswers: boolean
  }
  routines: {
    /** Detener la rutina si mueves el ratón mientras actúa. */
    stopOnMouseMove: boolean
    /** Si Jev no encuentra algo con seguridad, preguntarle al modelo principal (más lento, usa tu plan). */
    escalateToModel: boolean
  }
  orchestrator: {
    /** Dejar que Claude use la pantalla (clics y teclado) con las herramientas de Buddy. */
    screenControl: boolean
  }
  hotkeys: {
    talk: string
    type: string
    panel: string
  }
  agents: {
    /** Carpeta donde se crean los espacios de trabajo de los agentes. */
    workspaceDir: string
    /** Permite que el agente ejecute comandos de terminal. */
    allowShell: boolean
    /** Anunciar en voz alta cuando termina una tarea. */
    announce: boolean
  }
  /** Mostrar el texto de la respuesta junto al cursor. */
  showCaptions: boolean
  /** Brillo en el borde de la pantalla mientras Buddy escucha o trabaja. */
  screenGlow: boolean
  pointer: {
    /**
     * Quién decide dónde señalar: el mismo modelo que responde, o Jev (TypeSafe AI),
     * que localiza el elemento en paralelo y mucho más rápido. La respuesta hablada
     * siempre viene del modelo principal.
     */
    engine: 'model' | 'jev'
  }
  launchAtLogin: boolean
  onboarded: boolean
}

export interface ProviderStatus {
  id: ProviderId
  installed: boolean
  binaryPath?: string
  version?: string
  loggedIn: boolean
  /** true = sesión con suscripción (Claude Pro/Max, ChatGPT Plus/Pro…); false = API key; null = desconocido. */
  usingSubscription: boolean | null
  detail: string
}

export interface ProviderTestResult {
  ok: boolean
  ms: number
  text: string
}

export type BuddyState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error'

/** Órdenes para el overlay (la parte visual del buddy). */
export type BuddyCommand =
  | { type: 'state'; state: BuddyState; text?: string }
  | { type: 'point'; x: number; y: number; label: string }
  | { type: 'level'; value: number }
  | { type: 'agents'; running: number }
  /** Pone o cambia la etiqueta del punto señalado (llega después de que Jev señale). */
  | { type: 'label'; label: string }
  /** Deja de señalar y vuelve al cursor (el modelo principal decidió que no hacía falta). */
  | { type: 'unpoint' }
  | { type: 'stop' }
  | { type: 'hide-for-capture' }
  | { type: 'show-after-capture' }

/**
 * Órdenes para el motor de voz (ventana oculta con micrófono, Whisper y síntesis de voz).
 * Con `stream`, el audio se manda al proceso principal mientras hablas (dictado de Apple) y
 * Whisper solo se usa si el proceso principal lo pide con `whisper-fallback`.
 */
export type VoiceCommand =
  | { type: 'start'; stream?: boolean }
  | { type: 'stop' }
  | { type: 'cancel' }
  | { type: 'whisper-fallback' }

export type SpeechCommand = { type: 'speak'; text: string } | { type: 'stop' }

export interface SttStatus {
  state: 'idle' | 'loading' | 'ready' | 'error'
  /** 0-100 mientras se descarga el modelo. */
  progress?: number
  message?: string
  device?: string
}

export interface CursorUpdate {
  x: number
  y: number
  active: boolean
}

export interface ChatTurn {
  id: string
  at: number
  question: string
  answer: string
  provider: ProviderId
  ms: number
  pointed?: string
  error?: boolean
  /** Quién puso el punto en pantalla (Jev, el modelo principal o el texto reconocido por OCR). */
  pointSource?: 'jev' | 'model' | 'ocr'
  /** Lo que tardó Jev en localizar el elemento. */
  jevMs?: number
  /** Distancia entre el punto de Jev y el del modelo principal (para comparar precisión). */
  jevDeltaPx?: number
  /**
   * Quién resolvió la petición: Apple Intelligence en el equipo, una rutina, o el orquestador.
   * Sin valor = el modelo principal (Claude/ChatGPT), como siempre.
   */
  tier?: 'apple' | 'routine' | 'orchestrator'
  /** El dictado corregido por Apple Intelligence, si cambió. */
  corrected?: string
}

// ---- Apple (ayudante nativo de macOS) --------------------------------------------------------

export interface AppleStatus {
  /** Estado del ayudante nativo (Swift) que da acceso a Apple Intelligence, dictado, OCR y teclado/ratón. */
  helper: 'ready' | 'starting' | 'missing' | 'unsupported' | 'error'
  detail: string
  intelligence: { available: boolean; reason?: string; imageInput: boolean }
  speech: { available: boolean; detail?: string }
  ocr: boolean
  /** Quién ejecuta los clics y el teclado de las rutinas. */
  input: { backend: 'helper' | 'xdotool' | 'none'; trusted: boolean; detail?: string }
}

// ---- Rutinas (tareas repetitivas estilo QA) --------------------------------------------------

export type RoutineStepKind = 'open' | 'click' | 'type' | 'key' | 'scroll' | 'wait' | 'waitFor' | 'check' | 'point' | 'say' | 'ask'

export interface RoutineStep {
  kind: RoutineStepKind
  /** Elemento visible que hay que encontrar (click, point, type), o la URL/app que se abre (open). */
  target?: string
  /** Texto que se escribe (type) o se dice (say). Admite {{fecha}}, {{hora}} y {{aleatorio}}. */
  text?: string
  /** Combinación de teclas (key), p. ej. "cmd+s" o "enter". */
  keys?: string
  /** Lo que se comprueba en pantalla (check, waitFor) o la pregunta para el modelo (ask). */
  condition?: string
  /** check: true = debe verse; false = no debe verse. */
  expect?: boolean
  /** wait: segundos de espera. waitFor: tiempo máximo en segundos. */
  seconds?: number
  direction?: 'up' | 'down'
  /** Nota corta de para qué sirve el paso. */
  note?: string
}

export interface RoutineSchedule {
  /** Repetir cada N minutos (0 = no). */
  everyMinutes: number
  /** Hora diaria "HH:MM" ("" = no). */
  dailyAt: string
}

export type RoutineRunStatus = 'running' | 'passed' | 'failed' | 'error' | 'cancelled'

export interface Routine {
  id: string
  name: string
  description: string
  steps: RoutineStep[]
  createdAt: number
  updatedAt: number
  source: 'claude' | 'orchestrator' | 'manual'
  schedule: RoutineSchedule | null
  /** Seguir con los demás pasos aunque uno falle. */
  continueOnFailure: boolean
  lastRun?: { runId: string; status: RoutineRunStatus; at: number; passed: number; total: number }
}

export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'error'

export interface StepResult {
  index: number
  status: StepStatus
  ms: number
  detail: string
  /** Probabilidad (check) o confianza (click/point) que dio Jev. */
  score?: number
  /** Quién resolvió el paso visual. */
  via?: 'jev' | 'model' | 'ocr'
}

export interface RoutineRun {
  id: string
  routineId: string
  routineName: string
  trigger: 'manual' | 'voice' | 'schedule' | 'orchestrator'
  status: RoutineRunStatus
  startedAt: number
  finishedAt?: number
  steps: StepResult[]
  summary?: string
  /** Captura del momento en que falló (ruta local). */
  failureShot?: string
}

export interface JevStatus {
  configured: boolean
  /** La key viene de la variable de entorno TYPESAFE_API_KEY. */
  fromEnv: boolean
}

export interface JevTestResult {
  ok: boolean
  ms: number
  text: string
}

export type AgentEventKind = 'text' | 'tool' | 'error' | 'info'

export interface AgentEvent {
  at: number
  kind: AgentEventKind
  text: string
}

export type AgentStatus = 'running' | 'done' | 'error' | 'cancelled'

export interface AgentTask {
  id: string
  title: string
  prompt: string
  provider: ProviderId
  /** `orchestrator`: Claude usa la pantalla con las herramientas rápidas de Buddy. */
  kind?: 'agent' | 'orchestrator'
  status: AgentStatus
  startedAt: number
  finishedAt?: number
  workdir: string
  events: AgentEvent[]
  result?: string
}

export interface HotkeyStatus {
  talk: boolean
  type: boolean
  panel: boolean
}

export interface PermissionStatus {
  platform: string
  microphone: string
  screen: string
}

export interface AppInfo {
  version: string
  platform: string
  userData: string
}

/** API expuesta por el preload en `window.buddy`. */
export interface BuddyApi {
  getSettings(): Promise<Settings>
  setSettings(patch: DeepPartial<Settings>): Promise<Settings>
  onSettings(cb: (s: Settings) => void): () => void

  getProviderStatus(): Promise<ProviderStatus[]>
  testProvider(id: ProviderId): Promise<ProviderTestResult>
  openLogin(id: ProviderId): Promise<string>

  getHistory(): Promise<ChatTurn[]>
  clearHistory(): Promise<void>
  onHistory(cb: (h: ChatTurn[]) => void): () => void

  listAgents(): Promise<AgentTask[]>
  startAgent(prompt: string): Promise<AgentTask>
  cancelAgent(id: string): Promise<void>
  openAgentFolder(id: string): Promise<void>
  onAgents(cb: (a: AgentTask[]) => void): () => void

  getHotkeyStatus(): Promise<HotkeyStatus>
  onHotkeyStatus(cb: (s: HotkeyStatus) => void): () => void
  getPermissions(): Promise<PermissionStatus>
  openPermissionSettings(kind: 'microphone' | 'screen'): Promise<void>
  getAppInfo(): Promise<AppInfo>
  openExternal(url: string): Promise<void>

  // Barra de preguntas escrita
  askText(question: string): Promise<void>
  closePrompt(): void
  onPromptShow(cb: () => void): () => void

  getJevStatus(): Promise<JevStatus>
  setJevKey(key: string): Promise<JevStatus>
  testJev(): Promise<JevTestResult>

  getSttStatus(): Promise<SttStatus>
  onSttStatus(cb: (s: SttStatus) => void): () => void

  getAppleStatus(): Promise<AppleStatus>
  onAppleStatus(cb: (s: AppleStatus) => void): () => void
  /** Pide (o comprueba) el permiso de Accesibilidad que necesitan los clics de las rutinas. */
  requestAccessibility(): Promise<AppleStatus>

  listRoutines(): Promise<Routine[]>
  onRoutines(cb: (r: Routine[]) => void): () => void
  /** Claude convierte la descripción en pasos y la guarda. */
  createRoutine(description: string): Promise<Routine>
  updateRoutine(id: string, patch: Partial<Pick<Routine, 'name' | 'schedule' | 'continueOnFailure' | 'steps'>>): Promise<Routine>
  deleteRoutine(id: string): Promise<void>
  runRoutine(id: string): Promise<void>
  stopRoutine(): Promise<void>
  listRuns(): Promise<RoutineRun[]>
  onRuns(cb: (r: RoutineRun[]) => void): () => void
  openRunShot(runId: string): Promise<void>

  // Overlay
  onCursor(cb: (c: CursorUpdate) => void): () => void
  onBuddy(cb: (c: BuddyCommand) => void): () => void
  sendCaptureReady(): void

  // Motor de voz
  onVoice(cb: (c: VoiceCommand) => void): () => void
  onSpeech(cb: (c: SpeechCommand) => void): () => void
  sendTranscript(text: string): void
  sendVoiceError(message: string): void
  sendVoiceLevel(level: number): void
  sendVoiceStopped(): void
  sendSttStatus(status: SttStatus): void
  sendSpeechDone(): void
  /** Dictado de Apple: un trozo de audio mono (Float32) mientras hablas. */
  sendAudioChunk(samples: Float32Array, sampleRate: number): void
  /** Dictado de Apple: terminó la grabación (`hadSpeech` = false si no se oyó voz). */
  sendAudioEnd(hadSpeech: boolean): void
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}
