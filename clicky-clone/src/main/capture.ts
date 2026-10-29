import { desktopCapturer, screen, systemPreferences, type Display } from 'electron'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { captureSize, screenPointToImage } from './core/answer'
import type { ImageFile } from './providers/types'

export interface Shot extends ImageFile {
  display: Display
  /** Posición del cursor dentro de la captura, en píxeles de la imagen. */
  cursor: { x: number; y: number }
}

export class ScreenPermissionError extends Error {}

export function screenPermission(): string {
  if (process.platform !== 'darwin') return 'granted'
  return systemPreferences.getMediaAccessStatus('screen')
}

/** Captura la pantalla indicada, reducida al tamaño que mejor funciona con los modelos. */
export async function captureDisplay(display: Display, dir: string): Promise<Shot> {
  if (screenPermission() === 'denied') {
    throw new ScreenPermissionError('Falta el permiso de Grabación de pantalla (Ajustes del Sistema → Privacidad y seguridad).')
  }
  const physical = {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor)
  }
  const target = captureSize(physical.width, physical.height)
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: target, fetchWindowIcons: false })
  const index = screen.getAllDisplays().findIndex((d) => d.id === display.id)
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[index] ?? sources[0]
  if (!source || source.thumbnail.isEmpty()) {
    throw new ScreenPermissionError(
      process.platform === 'darwin'
        ? 'No pude capturar la pantalla. Da permiso de Grabación de pantalla a la app y reiníciala.'
        : 'No pude capturar la pantalla.'
    )
  }
  const image = source.thumbnail
  const size = image.getSize()
  const jpeg = image.toJPEG(80)

  mkdirSync(dir, { recursive: true })
  cleanup(dir, 6)
  const path = join(dir, `captura-${Date.now()}.jpg`)
  await writeFile(path, jpeg)

  const cursor = screenPointToImage(screen.getCursorScreenPoint(), size, display.bounds)
  return {
    path,
    base64: jpeg.toString('base64'),
    mime: 'image/jpeg',
    width: size.width,
    height: size.height,
    display,
    cursor
  }
}

/** Deja solo las últimas `keep` capturas en disco. */
function cleanup(dir: string, keep: number): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('captura-') && f.endsWith('.jpg'))
      .sort()
    for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(dir, f), { force: true })
  } catch {
    // no es grave
  }
}
