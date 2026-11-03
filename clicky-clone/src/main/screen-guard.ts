// Mientras Buddy (una rutina o Claude como orquestador) usa tu teclado y ratón, puedes recuperar el
// control en cualquier momento: pulsa Esc o mueve el ratón.
import { globalShortcut, screen } from 'electron'
import type { Point } from './core/routine-runner'
import type { InputBackend } from './input-backend'

const MOVE_TOLERANCE = 40

export class ScreenGuard {
  private expected: Point | null = null
  private busy = false
  private timer: NodeJS.Timeout | null = null
  private esc = false
  private readonly onStop: (reason: string) => void

  constructor(opts: { onStop: (reason: string) => void; watchMouse: boolean; es: boolean }) {
    this.onStop = opts.onStop
    const pressed = opts.es ? 'Pulsaste Esc: me detuve.' : 'You pressed Esc: I stopped.'
    const moved = opts.es ? 'Moviste el ratón: me detuve para no estorbarte.' : 'You moved the mouse: I stopped.'
    try {
      this.esc = globalShortcut.register('Escape', () => {
        // Si somos nosotros quienes pulsamos Esc (un paso de la rutina), no cuenta.
        if (!this.busy) this.onStop(pressed)
      })
    } catch {
      this.esc = false
    }
    if (opts.watchMouse) {
      this.timer = setInterval(() => {
        // Solo vigilamos después de mover nosotros el cursor: antes, el ratón sigue siendo tuyo.
        if (this.busy || !this.expected) return
        const now = screen.getCursorScreenPoint()
        if (Math.hypot(now.x - this.expected.x, now.y - this.expected.y) > MOVE_TOLERANCE) this.onStop(moved)
      }, 150)
    }
  }

  /** Envuelve las acciones para saber dónde dejamos el cursor y no confundirlo con el usuario. */
  wrap(backend: InputBackend): InputBackend {
    const act = async <T>(fn: () => Promise<T>, moves: boolean): Promise<T> => {
      this.busy = true
      try {
        return await fn()
      } finally {
        // Dejamos que el sistema coloque el cursor y tomamos esa posición real como referencia
        // (más fiable que el punto pedido: escalado, redondeo o un backend que no mueve el cursor).
        setTimeout(() => {
          if (moves) this.expected = screen.getCursorScreenPoint()
          this.busy = false
        }, 80)
      }
    }
    return {
      name: backend.name,
      click: (p, double) => act(() => backend.click(p, double), true),
      type: (text) => act(() => backend.type(text), false),
      key: (keys) => act(() => backend.key(keys), false),
      scroll: (direction) => act(() => backend.scroll(direction), false)
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.esc) globalShortcut.unregister('Escape')
    this.esc = false
  }
}
