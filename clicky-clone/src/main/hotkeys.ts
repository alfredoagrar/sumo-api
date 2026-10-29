import { globalShortcut } from 'electron'
import { prettyAccelerator as pretty } from '../shared/accelerator'
import type { HotkeyStatus, Settings } from '../shared/types'

export interface HotkeyHandlers {
  talk: () => void
  type: () => void
  panel: () => void
}

/** Registra los atajos globales. Devuelve cuáles se pudieron registrar (otro programa puede tenerlos). */
export function registerHotkeys(settings: Settings, handlers: HotkeyHandlers): HotkeyStatus {
  globalShortcut.unregisterAll()
  const status: HotkeyStatus = { talk: false, type: false, panel: false }
  for (const key of Object.keys(status) as (keyof HotkeyStatus)[]) {
    const accelerator = settings.hotkeys[key]
    if (!accelerator) continue
    try {
      status[key] = globalShortcut.register(accelerator, handlers[key])
    } catch (err) {
      console.warn(`[hotkeys] Atajo inválido "${accelerator}":`, err)
    }
  }
  return status
}

export function prettyAccelerator(accelerator: string): string {
  return pretty(accelerator, process.platform)
}
