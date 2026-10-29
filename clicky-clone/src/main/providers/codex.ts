// Proveedor ChatGPT: usa la CLI oficial de Codex con "Sign in with ChatGPT" (Plus, Pro, Business…).
// La app no lee ni guarda credenciales; solo ejecuta `codex` sin OPENAI_API_KEY en el entorno.
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findBinary, runCli } from '../cli'
import { parseAnswer } from '../core/answer'
import { buildCodexAgentArgs, buildCodexAskArgs, subscriptionEnv } from '../core/args'
import { ANSWER_SCHEMA, buildAgentInstructions } from '../core/prompts'
import { friendlyCliError, parseCodexLoginStatus } from '../core/status'
import { LineSplitter, describeCodexEvent, readCodexError, readCodexMessage, safeJson } from '../core/streams'
import { AbortedError, ProviderError, type Provider } from './types'

const INSTALL_URL = 'https://developers.openai.com/codex/cli'

function binary(settings: { codex: { binary: string } }): string {
  const bin = findBinary('codex', settings.codex.binary)
  if (!bin) throw new ProviderError('No encontré Codex ("codex"). Instálalo y vuelve a intentarlo.')
  return bin
}

function collector(onEvent?: (e: Record<string, unknown>) => void): {
  push: (chunk: string) => void
  flush: () => void
  message: () => string | null
  error: () => string | null
} {
  let message: string | null = null
  let error: string | null = null
  const splitter = new LineSplitter((line) => {
    const event = safeJson(line)
    if (!event) return
    message = readCodexMessage(event) ?? message
    error = readCodexError(event) ?? error
    onEvent?.(event)
  })
  return {
    push: (c) => splitter.push(c),
    flush: () => splitter.flush(),
    message: () => message,
    error: () => error
  }
}

async function readIfExists(path: string): Promise<string> {
  return existsSync(path) ? (await readFile(path, 'utf8')).trim() : ''
}

export const codexProvider: Provider = {
  loginCommand: 'codex login',
  installUrl: INSTALL_URL,

  async status(settings) {
    const bin = findBinary('codex', settings.codex.binary)
    if (!bin) {
      return {
        id: 'codex',
        installed: false,
        loggedIn: false,
        usingSubscription: null,
        detail: 'No se encontró Codex. Instálalo y entra con tu cuenta de ChatGPT.'
      }
    }
    const env = subscriptionEnv('codex', process.env)
    const [version, login] = await Promise.all([
      runCli(bin, { args: ['--version'], env, timeoutMs: 20_000 }).catch(() => null),
      runCli(bin, { args: ['login', 'status'], env, timeoutMs: 20_000 }).catch(() => null)
    ])
    const parsed = parseCodexLoginStatus(login?.code ?? 1, `${login?.stdout ?? ''}\n${login?.stderr ?? ''}`)
    return {
      id: 'codex',
      installed: true,
      binaryPath: bin,
      version: version?.stdout.trim().split(/\s+/).pop(),
      ...parsed
    }
  },

  async ask(req, settings, signal) {
    const bin = binary(settings)
    const dir = await mkdtemp(join(tmpdir(), 'buddy-codex-'))
    try {
      const schemaPath = join(dir, 'schema.json')
      const outputPath = join(dir, 'answer.json')
      await writeFile(schemaPath, JSON.stringify(ANSWER_SCHEMA))
      const args = buildCodexAskArgs({
        cwd: dir,
        imagePath: req.image?.path,
        schemaPath,
        outputPath,
        model: settings.codex.model || undefined,
        reasoningEffort: settings.codex.reasoningEffort || undefined
      })
      const out = collector()
      const run = await runCli(bin, {
        args,
        input: `${req.systemPrompt}\n\n${req.userPrompt}`,
        cwd: dir,
        env: subscriptionEnv('codex', process.env),
        timeoutMs: 120_000,
        signal,
        onStdout: out.push
      })
      out.flush()
      if (run.aborted) throw new AbortedError()
      if (run.timedOut) throw new ProviderError('ChatGPT tardó demasiado en responder.')
      const text = (await readIfExists(outputPath)) || out.message() || ''
      if (!text) throw new ProviderError(friendlyCliError('codex', out.error() ?? (run.stderr || `código ${run.code}`)))
      return parseAnswer(text, req.image)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  },

  async agent(req, settings, onNote, signal) {
    const bin = binary(settings)
    const outputPath = join(tmpdir(), `buddy-codex-agent-${req.id}.txt`)
    const args = buildCodexAgentArgs({
      cwd: req.workdir,
      imagePath: req.image?.path,
      outputPath,
      model: settings.codex.model || undefined
    })
    const out = collector((event) => {
      for (const note of describeCodexEvent(event)) onNote(note)
    })
    try {
      const run = await runCli(bin, {
        args,
        input: `${buildAgentInstructions(req.language, Boolean(req.image))}\n\n${req.language === 'es' ? 'Tarea' : 'Task'}: ${req.prompt}`,
        cwd: req.workdir,
        env: subscriptionEnv('codex', process.env),
        timeoutMs: 2 * 60 * 60 * 1000,
        signal,
        onStdout: out.push
      })
      out.flush()
      if (run.aborted) throw new AbortedError()
      if (run.timedOut) throw new ProviderError('La tarea superó el tiempo máximo (2 horas).')
      const text = (await readIfExists(outputPath)) || out.message() || ''
      if (!text || run.code !== 0) {
        if (text && !out.error()) return text
        throw new ProviderError(friendlyCliError('codex', out.error() ?? (run.stderr || `código ${run.code}`)))
      }
      return text
    } finally {
      await rm(outputPath, { force: true }).catch(() => undefined)
    }
  }
}
