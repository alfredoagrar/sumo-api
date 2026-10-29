import { app, BrowserWindow, screen, type Display, type Point } from 'electron'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import type { CursorUpdate } from '../shared/types'
import { APP_ORIGIN } from './protocol'

type Page = 'overlay' | 'panel' | 'prompt' | 'voice'

const preload = join(__dirname, '../preload/index.js')
const isMac = process.platform === 'darwin'

function loadPage(win: BrowserWindow, page: Page): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) void win.loadURL(`${devUrl}/${page}.html`)
  else void win.loadURL(`${APP_ORIGIN}/${page}.html`)
}

function webPreferences(): Electron.WebPreferences {
  return { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false }
}

/**
 * Una ventana transparente, siempre encima y que deja pasar los clics por cada monitor.
 * Ahí vive el "buddy" que sigue al cursor, graba la voz y habla.
 */
export class OverlayManager {
  private readonly windows = new Map<number, BrowserWindow>()
  private timer: NodeJS.Timeout | null = null
  private last: Point = { x: Number.NaN, y: Number.NaN }
  private activeId: number | null = null
  private rebuildTimer: NodeJS.Timeout | null = null
  private ticks = 0

  start(): void {
    this.rebuild()
    const schedule = (): void => {
      if (this.rebuildTimer) clearTimeout(this.rebuildTimer)
      this.rebuildTimer = setTimeout(() => this.rebuild(), 300)
    }
    screen.on('display-added', schedule)
    screen.on('display-removed', schedule)
    screen.on('display-metrics-changed', schedule)
    this.timer = setInterval(() => this.tick(), 16)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    for (const win of this.windows.values()) if (!win.isDestroyed()) win.destroy()
    this.windows.clear()
  }

  private rebuild(): void {
    const displays = screen.getAllDisplays()
    const ids = new Set(displays.map((d) => d.id))
    for (const [id, win] of this.windows) {
      if (!ids.has(id)) {
        if (!win.isDestroyed()) win.destroy()
        this.windows.delete(id)
      }
    }
    for (const display of displays) {
      const existing = this.windows.get(display.id)
      if (existing && !existing.isDestroyed()) existing.setBounds(display.bounds)
      else this.windows.set(display.id, this.create(display))
    }
    this.last = { x: Number.NaN, y: Number.NaN }
  }

  private create(display: Display): BrowserWindow {
    const win = new BrowserWindow({
      ...display.bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      ...(isMac ? { type: 'panel' } : {}),
      webPreferences: webPreferences()
    })
    win.setIgnoreMouseEvents(true)
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    win.once('ready-to-show', () => {
      win.setBounds(display.bounds)
      win.showInactive()
    })
    loadPage(win, 'overlay')
    return win
  }

  private tick(): void {
    const p = screen.getCursorScreenPoint()
    // Aunque el cursor no se mueva, reenviamos su posición cada ~0.5 s (por si un overlay acaba de cargar).
    const heartbeat = ++this.ticks % 30 === 0
    if (p.x === this.last.x && p.y === this.last.y && !heartbeat) return
    this.last = p
    const display = screen.getDisplayNearestPoint(p)
    const previous = this.activeId
    this.activeId = display.id
    for (const [id, win] of this.windows) {
      if (win.isDestroyed()) continue
      const active = id === display.id
      if (!active && id !== previous) continue
      const b = win.getBounds()
      const update: CursorUpdate = { x: p.x - b.x, y: p.y - b.y, active }
      win.webContents.send(IPC.cursor, update)
    }
  }

  /** Monitor donde está el cursor ahora. */
  displayAtCursor(): Display {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  }

  send(displayId: number, channel: string, payload: unknown): void {
    const win = this.windows.get(displayId) ?? this.windows.get(this.displayAtCursor().id)
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  broadcast(channel: string, payload: unknown): void {
    for (const win of this.windows.values()) if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }

  /** Coordenadas de pantalla → coordenadas dentro del overlay de ese monitor. */
  toLocal(displayId: number, p: Point): Point {
    const win = this.windows.get(displayId)
    const b = win && !win.isDestroyed() ? win.getBounds() : screen.getAllDisplays().find((d) => d.id === displayId)?.bounds
    return b ? { x: p.x - b.x, y: p.y - b.y } : p
  }

  ownsWebContents(id: number): boolean {
    for (const win of this.windows.values()) if (!win.isDestroyed() && win.webContents.id === id) return true
    return false
  }
}

/** Ventana principal: estado, conversaciones, agentes y ajustes. */
export class PanelWindow {
  private win: BrowserWindow | null = null
  quitting = false

  show(): void {
    if (!this.win || this.win.isDestroyed()) this.win = this.create()
    if (this.win.isMinimized()) this.win.restore()
    this.win.show()
    if (isMac) app.focus({ steal: true })
    this.win.focus()
  }

  toggle(): void {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible() && this.win.isFocused()) this.win.hide()
    else this.show()
  }

  send(channel: string, payload: unknown): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload)
  }

  isVisible(): boolean {
    return Boolean(this.win && !this.win.isDestroyed() && this.win.isVisible())
  }

  private create(): BrowserWindow {
    const win = new BrowserWindow({
      width: 1040,
      height: 720,
      minWidth: 760,
      minHeight: 560,
      show: false,
      title: 'Buddy',
      backgroundColor: '#0f1115',
      ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 } } : { autoHideMenuBar: true }),
      webPreferences: webPreferences()
    })
    win.on('close', (e) => {
      if (!this.quitting) {
        e.preventDefault()
        win.hide()
      }
    })
    win.once('ready-to-show', () => win.show())
    loadPage(win, 'panel')
    return win
  }
}

/** Barra flotante para escribir una pregunta (como Spotlight). */
export class PromptWindow {
  private win: BrowserWindow | null = null
  private readonly width = 640
  private readonly height = 132

  /** Se crea por adelantado (después de `app.whenReady`) para que aparezca al instante. */
  constructor() {
    this.win = this.create()
  }

  show(near: Point): void {
    if (!this.win || this.win.isDestroyed()) this.win = this.create()
    const display = screen.getDisplayNearestPoint(near)
    const area = display.workArea
    const x = Math.round(Math.min(Math.max(near.x - this.width / 2, area.x + 8), area.x + area.width - this.width - 8))
    const below = near.y + 28
    const y = Math.round(below + this.height < area.y + area.height ? below : Math.max(area.y + 8, near.y - this.height - 16))
    this.win.setBounds({ x, y, width: this.width, height: this.height })
    this.win.show()
    this.win.focus()
    if (isMac && !this.win.isFocused()) {
      app.focus({ steal: true })
      this.win.focus()
    }
    const contents = this.win.webContents
    if (contents.isLoading()) contents.once('did-finish-load', () => contents.send(IPC.promptShow))
    else contents.send(IPC.promptShow)
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide()
  }

  isVisible(): boolean {
    return Boolean(this.win && !this.win.isDestroyed() && this.win.isVisible())
  }

  private create(): BrowserWindow {
    const win = new BrowserWindow({
      width: this.width,
      height: this.height,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      ...(isMac ? { type: 'panel' } : {}),
      webPreferences: webPreferences()
    })
    win.setAlwaysOnTop(true, 'pop-up-menu')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    win.on('blur', () => this.hide())
    loadPage(win, 'prompt')
    return win
  }
}

/**
 * Ventana invisible que hace de motor de voz: micrófono, transcripción local con Whisper
 * y síntesis de voz. Una sola instancia del modelo para todos los monitores.
 */
export class VoiceWindow {
  private win: BrowserWindow

  constructor() {
    this.win = this.create()
  }

  send(channel: string, payload: unknown): void {
    if (this.win.isDestroyed()) this.win = this.create()
    const contents = this.win.webContents
    if (contents.isLoading()) contents.once('did-finish-load', () => contents.send(channel, payload))
    else contents.send(channel, payload)
  }

  destroy(): void {
    if (!this.win.isDestroyed()) this.win.destroy()
  }

  private create(): BrowserWindow {
    const win = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      skipTaskbar: true,
      focusable: false,
      webPreferences: { ...webPreferences(), autoplayPolicy: 'no-user-gesture-required' }
    })
    win.webContents.on('render-process-gone', (_e, details) => {
      console.error('[voice] El motor de voz se cerró:', details.reason)
    })
    loadPage(win, 'voice')
    return win
  }
}
