import { spawn } from 'node:child_process'
import type { ProviderId } from '../../shared/types'
import { findBinary } from '../cli'
import { claudeProvider } from './claude'
import { codexProvider } from './codex'
import type { Provider } from './types'

export const providers: Record<ProviderId, Provider> = {
  claude: claudeProvider,
  codex: codexProvider
}

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  claude: 'Claude',
  codex: 'ChatGPT'
}

/**
 * Abre una terminal con el comando oficial de inicio de sesión (`claude auth login` / `codex login`).
 * El inicio de sesión ocurre en el flujo de Anthropic u OpenAI, nunca dentro de esta app.
 * Devuelve el comando para mostrarlo en la interfaz.
 */
export function openLogin(id: ProviderId, binaryOverride: string): string {
  const name = id === 'claude' ? 'claude' : 'codex'
  const bin = findBinary(name, binaryOverride) ?? name
  const sub = id === 'claude' ? 'auth login' : 'login'
  const command = `${bin.includes(' ') ? `"${bin}"` : bin} ${sub}`
  try {
    if (process.platform === 'darwin') {
      const script = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      spawn('osascript', ['-e', 'tell application "Terminal" to activate', '-e', `tell application "Terminal" to do script "${script}"`], {
        detached: true,
        stdio: 'ignore'
      }).unref()
    } else if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', `start "" cmd.exe /k ${command}`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        windowsVerbatimArguments: true
      }).unref()
    } else {
      const term = findBinary('x-terminal-emulator') ?? findBinary('gnome-terminal') ?? findBinary('konsole') ?? findBinary('xterm')
      if (term) {
        const args = term.endsWith('gnome-terminal') ? ['--', 'sh', '-c', `${command}; exec $SHELL`] : ['-e', `sh -c '${command}; exec $SHELL'`]
        spawn(term, args, { detached: true, stdio: 'ignore' }).unref()
      }
    }
  } catch (err) {
    console.warn('[login] No se pudo abrir la terminal:', err)
  }
  return `${name} ${sub}`
}
