// Movimiento del buddy: sigue al cursor con un muelle suave y vuela en arco hasta lo que señala.

export interface Vec {
  x: number
  y: number
}

export type MotionMode = 'follow' | 'flying' | 'pointing' | 'returning'

/** Separación del buddy respecto a la punta del cursor. */
export const FOLLOW_OFFSET: Vec = { x: 16, y: 18 }

/** La flecha del buddy apunta hacia arriba a la izquierda (-135°). */
const NATIVE_ANGLE = -135

export const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

export function bezier(a: Vec, c: Vec, b: Vec, t: number): Vec {
  const u = 1 - t
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y }
}

export function bezierTangent(a: Vec, c: Vec, b: Vec, t: number): Vec {
  return { x: 2 * (1 - t) * (c.x - a.x) + 2 * t * (b.x - c.x), y: 2 * (1 - t) * (c.y - a.y) + 2 * t * (b.y - c.y) }
}

/** Punto de control para un arco agradable entre dos puntos (curva hacia arriba). */
export function arcControl(a: Vec, b: Vec): Vec {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dist = Math.hypot(dx, dy) || 1
  let nx = -dy / dist
  let ny = dx / dist
  if (ny > 0) {
    nx = -nx
    ny = -ny
  }
  const lift = Math.min(180, dist * 0.35)
  return { x: mid.x + nx * lift, y: mid.y + ny * lift }
}

/** Rotación (grados) para que la flecha apunte en la dirección del vector. */
export function headingFor(v: Vec): number {
  if (Math.hypot(v.x, v.y) < 0.001) return 0
  const deg = (Math.atan2(v.y, v.x) * 180) / Math.PI
  return normalizeAngle(deg - NATIVE_ANGLE)
}

export function normalizeAngle(deg: number): number {
  let a = deg % 360
  if (a > 180) a -= 360
  if (a < -180) a += 360
  return a
}

/** Interpola ángulos por el camino corto. */
export function lerpAngle(from: number, to: number, k: number): number {
  return from + normalizeAngle(to - from) * k
}

export function flightDuration(a: Vec, b: Vec): number {
  return Math.min(900, Math.max(380, Math.hypot(b.x - a.x, b.y - a.y) * 0.9))
}
