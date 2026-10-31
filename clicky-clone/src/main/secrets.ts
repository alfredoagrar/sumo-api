import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface Stored {
  jevApiKey?: { enc: boolean; value: string }
}

/**
 * API keys de servicios externos (por ahora, la de TypeSafe para Jev). Se guardan cifradas con
 * el llavero del sistema (safeStorage) fuera de settings.json y nunca se envían a la interfaz.
 */
export class Secrets {
  private readonly file = join(app.getPath('userData'), 'secrets.json')
  private data: Stored = {}

  constructor() {
    try {
      if (existsSync(this.file)) this.data = JSON.parse(readFileSync(this.file, 'utf8')) as Stored
    } catch {
      this.data = {}
    }
  }

  jevFromEnv(): boolean {
    return Boolean(process.env.TYPESAFE_API_KEY?.trim())
  }

  getJevKey(): string | null {
    const env = process.env.TYPESAFE_API_KEY?.trim()
    if (env) return env
    const stored = this.data.jevApiKey
    if (!stored) return null
    try {
      return stored.enc ? safeStorage.decryptString(Buffer.from(stored.value, 'base64')) : stored.value
    } catch {
      return null
    }
  }

  /** Guarda la key (o la borra si viene vacía). */
  setJevKey(key: string): void {
    const value = key.trim()
    if (!value) delete this.data.jevApiKey
    else if (safeStorage.isEncryptionAvailable()) {
      this.data.jevApiKey = { enc: true, value: safeStorage.encryptString(value).toString('base64') }
    } else {
      this.data.jevApiKey = { enc: false, value }
    }
    writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 })
  }
}
