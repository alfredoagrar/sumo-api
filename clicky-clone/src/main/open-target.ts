// Abre una URL o una app (pasos `open` de las rutinas y herramienta `open` del orquestador).
import { shell } from 'electron'
import { runCli } from './cli'

export async function openTarget(target: string, es: boolean): Promise<void> {
  const t = target.trim()
  if (/^https?:\/\//i.test(t)) return shell.openExternal(t)
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(t)) return shell.openExternal(`http://${t}`)
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i.test(t)) return shell.openExternal(`https://${t}`)
  if (process.platform === 'darwin') {
    const r = await runCli('/usr/bin/open', { args: ['-a', t], timeoutMs: 15_000 })
    if (r.code !== 0) throw new Error(es ? `No pude abrir «${t}».` : `Could not open "${t}".`)
    return
  }
  throw new Error(es ? `En este sistema solo sé abrir direcciones web («${t}»).` : `I can only open web addresses here ("${t}").`)
}
