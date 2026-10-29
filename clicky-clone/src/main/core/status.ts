// Interpretación del estado de sesión de las CLIs. Módulo puro.

export interface ParsedLogin {
  loggedIn: boolean
  usingSubscription: boolean | null
  detail: string
}

const CLAUDE_OAUTH_METHODS = new Set(['claude.ai', 'claudeai', 'oauth', 'oauth_token', 'subscription'])
const CLAUDE_KEY_METHODS = new Set(['api_key', 'apikey', 'api-key', 'apikeyhelper', 'api_key_helper'])

/** Lee la salida de `claude auth status --json`. */
export function parseClaudeAuthStatus(stdout: string): ParsedLogin {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    return { loggedIn: false, usingSubscription: null, detail: 'No se pudo leer el estado de Claude Code.' }
  }
  const loggedIn = data.loggedIn === true
  if (!loggedIn) {
    return { loggedIn: false, usingSubscription: null, detail: 'No has iniciado sesión en Claude Code.' }
  }
  const method = String(data.authMethod ?? '').toLowerCase()
  const provider = String(data.apiProvider ?? 'firstParty')
  const plan = typeof data.subscriptionType === 'string' ? data.subscriptionType : ''
  const email = typeof data.email === 'string' ? data.email : ''

  if (provider !== 'firstParty') {
    return { loggedIn, usingSubscription: false, detail: `Claude Code usa un proveedor en la nube (${provider}), no tu suscripción.` }
  }
  if (CLAUDE_KEY_METHODS.has(method)) {
    return { loggedIn, usingSubscription: false, detail: 'Claude Code está usando una API key, no tu suscripción. Ejecuta "claude auth login" para entrar con tu cuenta.' }
  }
  if (CLAUDE_OAUTH_METHODS.has(method)) {
    const who = [plan && `plan ${plan}`, email].filter(Boolean).join(' · ')
    return { loggedIn, usingSubscription: true, detail: `Sesión iniciada con tu cuenta de Claude${who ? ` (${who})` : ''}.` }
  }
  return { loggedIn, usingSubscription: null, detail: `Sesión iniciada (${method || 'método desconocido'}).` }
}

/** Lee la salida de `codex login status`. */
export function parseCodexLoginStatus(exitCode: number | null, output: string): ParsedLogin {
  const text = output.replace(/sk-[A-Za-z0-9_\-*.]+/g, 'sk-…')
  if (/not logged in/i.test(text) || (exitCode !== 0 && !/logged in/i.test(text))) {
    return { loggedIn: false, usingSubscription: null, detail: 'No has iniciado sesión en Codex.' }
  }
  if (/chatgpt/i.test(text)) {
    return { loggedIn: true, usingSubscription: true, detail: 'Sesión iniciada con tu cuenta de ChatGPT.' }
  }
  if (/api key/i.test(text)) {
    return { loggedIn: true, usingSubscription: false, detail: 'Codex está usando una API key. Ejecuta "codex login" y elige "Sign in with ChatGPT".' }
  }
  if (/logged in/i.test(text)) {
    return { loggedIn: true, usingSubscription: null, detail: text.trim().split('\n')[0] }
  }
  return { loggedIn: false, usingSubscription: null, detail: 'No se pudo leer el estado de Codex.' }
}

/** Mensaje claro para errores frecuentes de las CLIs. */
export function friendlyCliError(provider: 'claude' | 'codex', raw: string): string {
  const text = raw.trim()
  if (/unknown option|unexpected argument|unrecognized/i.test(text)) {
    return provider === 'claude'
      ? 'Tu versión de Claude Code es antigua. Actualízala con "claude update".'
      : 'Tu versión de Codex es antigua. Actualízala con "npm i -g @openai/codex" o "brew upgrade codex".'
  }
  if (/login|log in|logged in|authenticat|unauthorized|401|invalid api key|oauth/i.test(text)) {
    return provider === 'claude'
      ? 'Claude Code no tiene una sesión válida. Ejecuta "claude auth login" en tu terminal.'
      : 'Codex no tiene una sesión válida. Ejecuta "codex login" en tu terminal.'
  }
  if (/rate limit|usage limit|limit reached|429/i.test(text)) {
    return provider === 'claude'
      ? 'Llegaste al límite de uso de tu plan de Claude. Espera a que se reinicie.'
      : 'Llegaste al límite de uso de tu plan de ChatGPT. Espera a que se reinicie.'
  }
  const firstLine = text.split('\n').find((l) => l.trim()) ?? ''
  return firstLine.length > 200 ? `${firstLine.slice(0, 199)}…` : firstLine || 'Error desconocido'
}
