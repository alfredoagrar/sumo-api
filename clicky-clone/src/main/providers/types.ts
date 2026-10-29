import type { Language, ProviderStatus, Settings } from '../../shared/types'
import type { Answer } from '../core/answer'
import type { StreamNote } from '../core/streams'

export interface ImageFile {
  path: string
  base64: string
  mime: string
  width: number
  height: number
}

export interface AskRequest {
  systemPrompt: string
  userPrompt: string
  image?: ImageFile
  /** Carpeta neutral donde se ejecuta la CLI (sin CLAUDE.md ni repos). */
  cwd: string
}

export interface AgentRequest {
  id: string
  prompt: string
  workdir: string
  image?: ImageFile
  language: Language
}

export interface Provider {
  status(settings: Settings): Promise<ProviderStatus>
  ask(req: AskRequest, settings: Settings, signal: AbortSignal): Promise<Answer>
  agent(req: AgentRequest, settings: Settings, onNote: (n: StreamNote) => void, signal: AbortSignal): Promise<string>
  loginCommand: string
  installUrl: string
}

export class ProviderError extends Error {}

export class AbortedError extends Error {
  constructor() {
    super('Cancelado')
  }
}
