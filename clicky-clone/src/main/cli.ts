import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { quoteForCmd } from './core/args'

/** Carpetas donde suelen instalarse `claude` y `codex`, por si la app se abrió desde el Finder sin el PATH del shell. */
function extraBinDirs(): string[] {
  const home = homedir()
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    return [
      join(home, '.local', 'bin'),
      join(appData, 'npm'),
      join(local, 'pnpm'),
      join(home, '.bun', 'bin'),
      join(home, 'scoop', 'shims'),
      join(local, 'Microsoft', 'WinGet', 'Links')
    ]
  }
  return [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, 'Library', 'pnpm'),
    join(home, '.local', 'share', 'pnpm'),
    '/usr/bin',
    '/bin'
  ]
}

/**
 * En macOS/Linux una app abierta desde el escritorio no hereda el PATH de la terminal.
 * Leemos el PATH del shell de inicio de sesión (con nvm, Homebrew, etc.) y lo añadimos.
 */
export async function loadLoginShellPath(): Promise<void> {
  const dirs = new Set((process.env.PATH ?? '').split(delimiter).filter(Boolean))
  if (process.platform !== 'win32') {
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    const marker = '__BUDDY_PATH__'
    const result = await runCli(shell, {
      args: ['-ilc', `printf '${marker}%s${marker}' "$PATH"`],
      timeoutMs: 5000
    }).catch(() => null)
    const match = result?.stdout.match(new RegExp(`${marker}(.*)${marker}`))
    if (match) for (const d of match[1].split(':')) if (d) dirs.add(d)
  }
  for (const d of extraBinDirs()) dirs.add(d)
  process.env.PATH = [...dirs].join(delimiter)
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** Busca un ejecutable en el PATH (o usa la ruta indicada en ajustes). */
export function findBinary(name: string, override?: string): string | null {
  if (override) {
    return isAbsolute(override) && existsSync(override) ? override : findBinary(override)
  }
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

export interface RunOptions {
  args: string[]
  input?: string
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  aborted: boolean
  timedOut: boolean
}

/** Ejecuta un proceso y recoge su salida. Se puede cancelar con `signal`. */
export function runCli(bin: string, o: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32'
    const needsShell = isWin && /\.(cmd|bat)$/i.test(bin)
    const command = needsShell ? quoteForCmd(bin) : bin
    const args = needsShell ? o.args.map(quoteForCmd) : o.args

    let child
    try {
      child = spawn(command, args, {
        cwd: o.cwd,
        env: o.env ?? (process.env as Record<string, string>),
        shell: needsShell,
        windowsHide: true,
        // En Unix creamos un grupo de procesos para poder cancelar también a los hijos.
        detached: !isWin
      })
    } catch (err) {
      reject(err)
      return
    }

    let stdout = ''
    let stderr = ''
    let aborted = false
    let timedOut = false
    let settled = false

    const kill = (): void => {
      if (child.exitCode !== null || child.pid === undefined) return
      try {
        if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        else process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    }

    const timer = o.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          kill()
        }, o.timeoutMs)
      : null

    const onAbort = (): void => {
      aborted = true
      kill()
    }
    if (o.signal) {
      if (o.signal.aborted) onAbort()
      else o.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      o.onStdout?.(chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000)
    })

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      resolve({ code, stdout, stderr, aborted, timedOut })
    }

    child.on('error', (err) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', finish)

    child.stdin.on('error', () => {
      // El proceso pudo cerrar stdin antes de tiempo; el error real llega por 'close'.
    })
    if (o.input !== undefined) child.stdin.end(o.input)
    else child.stdin.end()
  })
}
