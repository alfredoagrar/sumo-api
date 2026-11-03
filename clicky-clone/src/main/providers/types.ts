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

/** Pregunta con salida estructurada según `schema` (JSON Schema compatible con ambas CLIs). */
export interface StructuredRequest extends AskRequest {
  schema: object
  /** Modelo para esta llamada (si no, el de los ajustes). */
  model?: string
}

export interface AgentRequest {
  id: string
  prompt: string
  workdir: string
  image?: ImageFile
  language: Language
  /** Orquestador: servidor MCP de Buddy con sus herramientas rápidas (solo Claude). */
  mcp?: {
    /** JSON para `--mcp-config`. */
    config: string
    /** Herramientas permitidas sin preguntar, p. ej. "mcp__buddy". */
    allowedTools: string[]
    /** Instrucciones extra del orquestador. */
    instructions: string
  }
}

export interface Provider {
  status(settings: Settings): Promise<ProviderStatus>
  ask(req: AskRequest, settings: Settings, signal: AbortSignal): Promise<Answer>
  /** Devuelve la salida estructurada tal cual (objeto o texto JSON). */
  structured(req: StructuredRequest, settings: Settings, signal: AbortSignal): Promise<unknown>
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
