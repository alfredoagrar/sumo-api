import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { AppleHelper, float32ToBase64, HelperError } from '../src/main/core/apple-helper.ts'
import type { HelperStatus } from '../src/main/core/apple-protocol.ts'
import { TRIAGE_SCHEMA } from '../src/main/core/router.ts'

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-apple-helper.mjs')

function helper(env: Record<string, string> = {}): AppleHelper {
  return new AppleHelper({ command: process.execPath, args: [FAKE], env: { ...(process.env as Record<string, string>), FAKE_APPLE_DELAY_MS: '5', ...env }, timeoutMs: 3000 })
}

describe('ayudante de macOS (simulado)', () => {
  it('pide el estado y genera con un esquema', async () => {
    const h = helper()
    try {
      const status = await h.request<HelperStatus>('status')
      assert.equal(status.intelligence.available, true)
      const out = await h.request<{ json: string }>('generate', { instructions: 'x', prompt: 'Transcript: "¿Cuánto es 7 por 8?"', schema: TRIAGE_SCHEMA })
      assert.equal(JSON.parse(out.json).intent, 'answer')
    } finally {
      h.stop()
    }
  })

  it('transmite el dictado y recibe resultados parciales', async () => {
    const h = helper({ FAKE_APPLE_STT_TEXT: 'ejecuta la rutina login' })
    const partials: string[] = []
    h.on('event', (name: string, params: { text: string }) => {
      if (name === 'stt.partial') partials.push(params.text)
    })
    try {
      await h.request('stt.begin', { sid: 's1', locale: 'es-MX', sampleRate: 48000, contextualStrings: ['Login'] })
      const chunk = float32ToBase64(new Float32Array(4800).fill(0.1))
      for (let i = 0; i < 9; i++) h.notify('stt.audio', { sid: 's1', data: chunk })
      const end = await h.request<{ text: string }>('stt.end', { sid: 's1' })
      assert.equal(end.text, 'ejecuta la rutina login')
      assert.deepEqual(partials, ['ejecuta', 'ejecuta la', 'ejecuta la rutina'])
    } finally {
      h.stop()
    }
  })

  it('convierte los errores del ayudante', async () => {
    const h = helper({ FAKE_APPLE_TRUSTED: '0' })
    try {
      await assert.rejects(
        () => h.request('input.click', { x: 1, y: 2 }),
        (err: unknown) => err instanceof HelperError && err.code === 'not_trusted'
      )
    } finally {
      h.stop()
    }
  })

  it('cancela peticiones y respeta el tiempo máximo', async () => {
    const h = helper()
    try {
      const controller = new AbortController()
      const slow = h.request('sleep', { ms: 2000 }, { signal: controller.signal })
      controller.abort()
      await assert.rejects(slow, (err: unknown) => err instanceof HelperError && err.code === 'cancelled')
      await assert.rejects(
        () => h.request('sleep', { ms: 2000 }, { timeoutMs: 100 }),
        (err: unknown) => err instanceof HelperError && err.code === 'timeout'
      )
    } finally {
      h.stop()
    }
  })

  it('se recupera si el ayudante se cierra, salvo que se cierre una y otra vez', async () => {
    const h = helper()
    try {
      await assert.rejects(() => h.request('crash'), /se cerró/)
      const again = await h.request<HelperStatus>('status')
      assert.equal(again.version, 'fake-1')
      await assert.rejects(() => h.request('crash'), /se cerró/)
      await assert.rejects(() => h.request('crash'), /se cerró/)
      await assert.rejects(
        () => h.request('status'),
        (err: unknown) => err instanceof HelperError && err.code === 'unavailable'
      )
      h.reset()
      assert.equal((await h.request<HelperStatus>('status')).version, 'fake-1')
    } finally {
      h.stop()
    }
  })

  it('no existe el binario: falla con un error claro', async () => {
    const h = new AppleHelper({ command: '/no/existe/buddy-apple', timeoutMs: 1000 })
    await assert.rejects(() => h.request('status'), /se cerró|No se pudo iniciar/)
    assert.match(h.broken ?? '', /No se pudo iniciar el ayudante/)
  })
})
