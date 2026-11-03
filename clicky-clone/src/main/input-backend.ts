// Quién hace los clics y escribe en las rutinas: el ayudante de macOS (CGEvent) o, en Linux,
// xdotool. En Windows todavía no hay: las rutinas solo pueden mirar y señalar.
import { screen } from 'electron'
import { findBinary, runCli } from './cli'
import { xdotoolClickArgs, xdotoolKeyArgs, xdotoolScrollArgs, xdotoolTypeArgs } from './core/input'
import { parseKeyCombo } from './core/routines'
import type { Point } from './core/routine-runner'
import type { AppleServices } from './apple'

export interface InputBackend {
  name: 'helper' | 'xdotool'
  click(p: Point, double: boolean): Promise<void>
  type(text: string): Promise<void>
  key(combo: string): Promise<void>
  scroll(direction: 'up' | 'down'): Promise<void>
}

function combo(keys: string) {
  const parsed = parseKeyCombo(keys, process.platform)
  if (!parsed) throw new Error(`No entiendo la combinación de teclas «${keys}».`)
  return parsed
}

function helperBackend(apple: AppleServices): InputBackend {
  return {
    name: 'helper',
    click: async (p, double) => void (await apple.input('input.click', { x: p.x, y: p.y, double })),
    type: async (text) => void (await apple.input('input.type', { text })),
    key: async (keys) => {
      const c = combo(keys)
      await apple.input('input.key', { key: c.key, modifiers: c.modifiers })
    },
    scroll: async (direction) => void (await apple.input('input.scroll', { direction, amount: 5 }))
  }
}

function xdotoolBackend(bin: string): InputBackend {
  const run = async (args: string[]): Promise<void> => {
    const r = await runCli(bin, { args, timeoutMs: 30_000 })
    if (r.code !== 0) throw new Error(`xdotool falló: ${(r.stderr || r.stdout).trim() || `código ${r.code}`}`)
  }
  // X11 trabaja en píxeles físicos; Electron en píxeles lógicos (DIP).
  const physical = (p: Point): Point => {
    const d = screen.getDisplayNearestPoint({ x: Math.round(p.x), y: Math.round(p.y) })
    return { x: p.x * d.scaleFactor, y: p.y * d.scaleFactor }
  }
  return {
    name: 'xdotool',
    click: (p, double) => run(xdotoolClickArgs(physical(p), double)),
    type: (text) => run(xdotoolTypeArgs(text)),
    key: (keys) => run(xdotoolKeyArgs(combo(keys))),
    scroll: (direction) => run(xdotoolScrollArgs(direction))
  }
}

/** El mejor backend disponible ahora mismo, o null y el motivo. */
export function pickInputBackend(apple: AppleServices): { backend: InputBackend | null; reason: string } {
  if (apple.hasHelper && (process.platform === 'darwin' || process.env.BUDDY_APPLE_HELPER)) {
    if (!apple.trusted) {
      return {
        backend: null,
        reason: 'Falta el permiso de Accesibilidad para hacer clics y escribir: Ajustes del Sistema → Privacidad y seguridad → Accesibilidad.'
      }
    }
    return { backend: helperBackend(apple), reason: '' }
  }
  if (process.platform === 'linux') {
    const bin = findBinary('xdotool')
    if (bin) return { backend: xdotoolBackend(bin), reason: '' }
    return { backend: null, reason: 'Instala xdotool para que las rutinas puedan hacer clics y escribir.' }
  }
  if (process.platform === 'darwin') return { backend: null, reason: apple.getStatus().detail }
  return { backend: null, reason: 'En este sistema las rutinas todavía no pueden hacer clics ni escribir; solo mirar y señalar.' }
}
