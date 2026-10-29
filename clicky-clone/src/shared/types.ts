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
    /** Modelo Whisper (ONNX) que se ejecuta localmente con transformers.js. */
    model: string
    device: 'auto' | 'webgpu' | 'wasm'
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
  | { type: 'stop' }
  | { type: 'hide-for-capture' }
  | { type: 'show-after-capture' }

/** Órdenes para el motor de voz (ventana oculta con micrófono, Whisper y síntesis de voz). */
export type VoiceCommand = { type: 'start' } | { type: 'stop' } | { type: 'cancel' }

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

  getSttStatus(): Promise<SttStatus>
  onSttStatus(cb: (s: SttStatus) => void): () => void

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
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}
