// Argumentos para las CLIs oficiales. Módulo puro.
//
// La app nunca toca tokens ni credenciales: solo ejecuta el binario oficial (`claude` o `codex`)
// con la sesión que el propio usuario inició en él, y le quita del entorno las API keys
// para que use la suscripción.

export interface ImageInput {
  base64: string
  mime: string
}

export interface ClaudeAskOptions {
  systemPrompt: string
  schema: object
  model?: string
}

/** `claude -p` sin herramientas, con salida estructurada. La imagen va por stdin (stream-json). */
export function buildClaudeAskArgs(o: ClaudeAskOptions): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--tools', '',
    '--no-session-persistence',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--system-prompt', o.systemPrompt,
    '--json-schema', JSON.stringify(o.schema)
  ]
  if (o.model) args.push('--model', o.model)
  return args
}

export const CLAUDE_AGENT_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite']

export interface ClaudeAgentOptions {
  appendSystemPrompt: string
  model?: string
  allowShell: boolean
}

/** `claude -p` como agente en segundo plano dentro de una carpeta de trabajo. */
export function buildClaudeAgentArgs(o: ClaudeAgentOptions): string[] {
  const tools = [...CLAUDE_AGENT_TOOLS]
  if (o.allowShell) tools.push('Bash')
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'acceptEdits',
    '--tools', tools.join(','),
    '--allowedTools', tools.join(','),
    '--append-system-prompt', o.appendSystemPrompt
  ]
  if (o.model) args.push('--model', o.model)
  return args
}

/** Un mensaje de usuario en formato stream-json (texto + imagen opcional). */
export function buildClaudeUserMessage(text: string, image?: ImageInput): string {
  const content: unknown[] = []
  if (image) {
    content.push({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.base64 } })
  }
  content.push({ type: 'text', text })
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
}

export interface CodexAskOptions {
  cwd: string
  imagePath?: string
  schemaPath: string
  outputPath: string
  model?: string
  reasoningEffort?: string
}

/**
 * `codex exec` en modo solo lectura con salida estructurada. El prompt va por stdin (`-`).
 * Ojo: `--image` acepta varios valores, así que siempre va seguido de otra opción.
 */
export function buildCodexAskArgs(o: CodexAskOptions): string[] {
  const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--json', '--color', 'never', '--sandbox', 'read-only', '--cd', o.cwd]
  if (o.model) args.push('--model', o.model)
  if (o.reasoningEffort) args.push('--config', `model_reasoning_effort=${o.reasoningEffort}`)
  if (o.imagePath) args.push('--image', o.imagePath)
  args.push('--output-schema', o.schemaPath, '--output-last-message', o.outputPath, '-')
  return args
}

export interface CodexAgentOptions {
  cwd: string
  imagePath?: string
  outputPath: string
  model?: string
}

/** `codex exec` como agente: puede escribir solo dentro de su carpeta de trabajo (sandbox). */
export function buildCodexAgentArgs(o: CodexAgentOptions): string[] {
  const args = ['exec', '--skip-git-repo-check', '--json', '--color', 'never', '--sandbox', 'workspace-write', '--cd', o.cwd]
  if (o.model) args.push('--model', o.model)
  if (o.imagePath) args.push('--image', o.imagePath)
  args.push('--output-last-message', o.outputPath, '-')
  return args
}

/** Variables que harían que las CLIs usen una API key en vez de la suscripción. */
export const API_KEY_ENV: Record<'claude' | 'codex', string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY']
}

export function subscriptionEnv(provider: 'claude' | 'codex', base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) env[k] = v
  }
  for (const key of API_KEY_ENV[provider]) delete env[key]
  // Evita que Electron se cuele como "node" si el proceso hijo es un script.
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

/** Cita un argumento para cmd.exe (solo se usa con shims .cmd/.bat en Windows). */
export function quoteForCmd(arg: string): string {
  if (arg === '') return '""'
  if (!/[\s"&|<>^()%!,;=]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}
