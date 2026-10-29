// Proveedor Claude: usa el binario oficial de Claude Code con la sesión de tu plan Pro/Max.
// La app no lee ni guarda credenciales; solo ejecuta `claude` sin ANTHROPIC_API_KEY en el entorno.
import { findBinary, runCli } from '../cli'
import { parseAnswer } from '../core/answer'
import { buildClaudeAgentArgs, buildClaudeAskArgs, buildClaudeUserMessage, subscriptionEnv } from '../core/args'
import { ANSWER_SCHEMA, buildAgentInstructions } from '../core/prompts'
import { friendlyCliError, parseClaudeAuthStatus } from '../core/status'
import {
  LineSplitter,
  describeClaudeEvent,
  readClaudeRateLimit,
  readClaudeResult,
  safeJson,
  type ClaudeResult
} from '../core/streams'
import { AbortedError, ProviderError, type Provider } from './types'

const INSTALL_URL = 'https://code.claude.com/docs/en/quickstart'

function binary(settings: { claude: { binary: string } }): string {
  const bin = findBinary('claude', settings.claude.binary)
  if (!bin) throw new ProviderError('No encontré Claude Code ("claude"). Instálalo y vuelve a intentarlo.')
  return bin
}

/** Lee los eventos stream-json hasta el resultado final. */
function collector(onEvent?: (e: Record<string, unknown>) => void): {
  push: (chunk: string) => void
  flush: () => void
  result: () => ClaudeResult | null
  limit: () => string | null
} {
  let result: ClaudeResult | null = null
  let limit: string | null = null
  const splitter = new LineSplitter((line) => {
    const event = safeJson(line)
    if (!event) return
    result = readClaudeResult(event) ?? result
    limit = readClaudeRateLimit(event) ?? limit
    onEvent?.(event)
  })
  return {
    push: (c) => splitter.push(c),
    flush: () => splitter.flush(),
    result: () => result,
    limit: () => limit
  }
}

export const claudeProvider: Provider = {
  loginCommand: 'claude auth login',
  installUrl: INSTALL_URL,

  async status(settings) {
    const bin = findBinary('claude', settings.claude.binary)
    if (!bin) {
      return {
        id: 'claude',
        installed: false,
        loggedIn: false,
        usingSubscription: null,
        detail: 'No se encontró Claude Code. Instálalo y entra con tu cuenta Pro o Max.'
      }
    }
    const env = subscriptionEnv('claude', process.env)
    const [version, auth] = await Promise.all([
      runCli(bin, { args: ['--version'], env, timeoutMs: 20_000 }).catch(() => null),
      runCli(bin, { args: ['auth', 'status', '--json'], env, timeoutMs: 20_000 }).catch(() => null)
    ])
    const parsed = parseClaudeAuthStatus(auth?.stdout ?? '')
    return {
      id: 'claude',
      installed: true,
      binaryPath: bin,
      version: version?.stdout.trim().split(/\s+/)[0],
      ...parsed
    }
  },

  async ask(req, settings, signal) {
    const bin = binary(settings)
    const args = buildClaudeAskArgs({
      systemPrompt: req.systemPrompt,
      schema: ANSWER_SCHEMA,
      model: settings.claude.model || undefined
    })
    const input = buildClaudeUserMessage(req.userPrompt, req.image && { base64: req.image.base64, mime: req.image.mime })
    const out = collector()
    const run = await runCli(bin, {
      args,
      input,
      cwd: req.cwd,
      env: subscriptionEnv('claude', process.env),
      timeoutMs: 120_000,
      signal,
      onStdout: out.push
    })
    out.flush()
    if (run.aborted) throw new AbortedError()
    if (run.timedOut) throw new ProviderError('Claude tardó demasiado en responder.')
    const result = out.result()
    const limit = out.limit()
    if (limit && (!result || result.isError)) throw new ProviderError(limit)
    if (!result) throw new ProviderError(friendlyCliError('claude', run.stderr || run.stdout || `código ${run.code}`))
    if (result.isError) throw new ProviderError(friendlyCliError('claude', result.text || run.stderr))
    return parseAnswer(result.structured ?? result.text, req.image)
  },

  async agent(req, settings, onNote, signal) {
    const bin = binary(settings)
    const args = buildClaudeAgentArgs({
      appendSystemPrompt: buildAgentInstructions(req.language, Boolean(req.image)),
      model: settings.claude.agentModel || undefined,
      allowShell: settings.agents.allowShell
    })
    const input = buildClaudeUserMessage(req.prompt, req.image && { base64: req.image.base64, mime: req.image.mime })
    const out = collector((event) => {
      for (const note of describeClaudeEvent(event)) onNote(note)
    })
    const run = await runCli(bin, {
      args,
      input,
      cwd: req.workdir,
      env: subscriptionEnv('claude', process.env),
      timeoutMs: 2 * 60 * 60 * 1000,
      signal,
      onStdout: out.push
    })
    out.flush()
    if (run.aborted) throw new AbortedError()
    if (run.timedOut) throw new ProviderError('La tarea superó el tiempo máximo (2 horas).')
    const result = out.result()
    if (!result) throw new ProviderError(out.limit() ?? friendlyCliError('claude', run.stderr || `código ${run.code}`))
    if (result.isError) throw new ProviderError(out.limit() ?? friendlyCliError('claude', result.text || run.stderr))
    return result.text.trim()
  }
}
