import { app, Menu, nativeImage, Tray } from 'electron'
import { join } from 'node:path'
import type { ProviderId, Settings } from '../shared/types'
import { prettyAccelerator } from './hotkeys'
import { PROVIDER_NAMES } from './providers'

export interface TrayActions {
  talk: () => void
  type: () => void
  panel: () => void
  setProvider: (id: ProviderId) => void
  quit: () => void
}

function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources')
}

export class AppTray {
  private readonly tray: Tray
  private readonly actions: TrayActions

  constructor(actions: TrayActions) {
    this.actions = actions
    const mac = process.platform === 'darwin'
    const icon = nativeImage.createFromPath(join(resourcesDir(), mac ? 'trayTemplate.png' : 'tray.png'))
    if (mac) icon.setTemplateImage(true)
    this.tray = new Tray(icon)
    this.tray.setToolTip('Buddy')
    if (process.platform !== 'darwin') this.tray.on('click', () => actions.panel())
  }

  update(settings: Settings): void {
    const a = this.actions
    const menu = Menu.buildFromTemplate([
      { label: `Hablar con Buddy  (${prettyAccelerator(settings.hotkeys.talk)})`, click: a.talk },
      { label: `Escribir una pregunta  (${prettyAccelerator(settings.hotkeys.type)})`, click: a.type },
      { type: 'separator' },
      {
        label: 'Modelo',
        submenu: (Object.keys(PROVIDER_NAMES) as ProviderId[]).map((id) => ({
          label: id === 'claude' ? 'Claude (suscripción Pro/Max)' : 'ChatGPT (suscripción Plus/Pro)',
          type: 'radio' as const,
          checked: settings.provider === id,
          click: () => a.setProvider(id)
        }))
      },
      { label: 'Abrir panel…', accelerator: settings.hotkeys.panel || undefined, click: a.panel },
      { type: 'separator' },
      { label: 'Salir de Buddy', click: a.quit }
    ])
    this.tray.setContextMenu(menu)
  }
}
