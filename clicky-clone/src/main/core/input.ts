// Teclado y ratón para las rutinas fuera de macOS: argumentos de `xdotool` (Linux con X11).
// En macOS lo hace el ayudante nativo con CGEvent. Módulo puro.
import type { KeyCombo } from './routines.ts'

const XDOTOOL_KEYS: Record<string, string> = {
  enter: 'Return',
  escape: 'Escape',
  tab: 'Tab',
  space: 'space',
  backspace: 'BackSpace',
  delete: 'Delete',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'Prior',
  pagedown: 'Next',
  '.': 'period',
  ',': 'comma',
  '/': 'slash',
  '-': 'minus',
  '=': 'equal',
  ';': 'semicolon',
  "'": 'apostrophe',
  '[': 'bracketleft',
  ']': 'bracketright',
  '\\': 'backslash',
  '`': 'grave'
}

const XDOTOOL_MODS: Record<KeyCombo['modifiers'][number], string> = {
  cmd: 'super',
  ctrl: 'ctrl',
  alt: 'alt',
  shift: 'shift'
}

export function xdotoolKeyName(key: string): string {
  if (XDOTOOL_KEYS[key]) return XDOTOOL_KEYS[key]
  if (/^f([1-9]|1[0-2])$/.test(key)) return key.toUpperCase()
  return key
}

export function xdotoolKeyArgs(combo: KeyCombo): string[] {
  return ['key', '--clearmodifiers', [...combo.modifiers.map((m) => XDOTOOL_MODS[m]), xdotoolKeyName(combo.key)].join('+')]
}

/** `x` e `y` en píxeles físicos de la pantalla X. */
export function xdotoolClickArgs(p: { x: number; y: number }, double: boolean): string[] {
  return ['mousemove', '--sync', String(Math.round(p.x)), String(Math.round(p.y)), 'click', ...(double ? ['--repeat', '2'] : []), '1']
}

export function xdotoolTypeArgs(text: string): string[] {
  return ['type', '--delay', '8', '--', text]
}

/** Rueda del ratón: botón 4 = arriba, 5 = abajo. */
export function xdotoolScrollArgs(direction: 'up' | 'down', clicks = 5): string[] {
  return ['click', '--repeat', String(clicks), direction === 'up' ? '4' : '5']
}
