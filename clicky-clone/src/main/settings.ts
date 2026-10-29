import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { DeepPartial, Settings } from '../shared/types'
import { defaultSettings, mergeSettings } from './core/settings-merge'

/** Ajustes persistidos en JSON dentro de la carpeta de datos de la app. */
export class SettingsStore extends EventEmitter {
  private readonly file = join(app.getPath('userData'), 'settings.json')
  private value: Settings

  constructor() {
    super()
    const defaults = defaultSettings(join(app.getPath('documents'), 'Buddy', 'agentes'))
    let stored: unknown = null
    try {
      if (existsSync(this.file)) stored = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (err) {
      console.warn('[settings] No se pudieron leer los ajustes, uso los valores por defecto:', err)
    }
    this.value = mergeSettings(defaults, stored)
  }

  get(): Settings {
    return this.value
  }

  update(patch: DeepPartial<Settings>): Settings {
    const prev = this.value
    this.value = mergeSettings(this.value, patch)
    this.save()
    this.emit('change', this.value, prev)
    return this.value
  }

  private save(): void {
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.value, null, 2))
      renameSync(tmp, this.file)
    } catch (err) {
      console.error('[settings] No se pudieron guardar los ajustes:', err)
    }
  }
}
