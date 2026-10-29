// Valores por defecto y mezcla validada de ajustes. Módulo puro.
import type { Settings } from '../../shared/types'

export function defaultSettings(workspaceDir: string): Settings {
  return {
    provider: 'claude',
    language: 'es',
    claude: { binary: '', model: 'sonnet', agentModel: '' },
    codex: { binary: '', model: '', reasoningEffort: 'low' },
    voice: { enabled: true, voiceURI: '', rate: 1.05 },
    stt: { model: 'onnx-community/whisper-base', device: 'auto' },
    hotkeys: {
      talk: 'CommandOrControl+Shift+Space',
      type: 'CommandOrControl+Shift+K',
      panel: 'CommandOrControl+Shift+.'
    },
    agents: { workspaceDir, allowShell: false, announce: true },
    showCaptions: true,
    launchAtLogin: false,
    onboarded: false
  }
}

const ENUMS: Record<string, readonly string[]> = {
  provider: ['claude', 'codex'],
  language: ['es', 'en'],
  'codex.reasoningEffort': ['', 'minimal', 'low', 'medium', 'high'],
  'stt.device': ['auto', 'webgpu', 'wasm']
}

const RANGES: Record<string, [number, number]> = {
  'voice.rate': [0.5, 2]
}

/**
 * Mezcla `patch` sobre `base` solo para claves que existen en `base` y con el mismo tipo.
 * Así un ajuste corrupto o de otra versión nunca rompe la app.
 */
export function mergeSettings<T>(base: T, patch: unknown, path = ''): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!(key in out)) continue
    const current = out[key]
    const full = path ? `${path}.${key}` : key
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      out[key] = mergeSettings(current, value, full)
    } else if (typeof value === typeof current) {
      if (ENUMS[full] && !ENUMS[full].includes(value as string)) continue
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) continue
        const range = RANGES[full]
        out[key] = range ? Math.min(range[1], Math.max(range[0], value)) : value
      } else {
        out[key] = typeof value === 'string' ? value.trim() : value
      }
    }
  }
  return out as T
}
