import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { boxCenter, describeJevError, JEV_MODEL, JevPointer, jevInstructions, pointDistance, shouldPointEarly } from '../src/main/core/jev.ts'

// JPEG mínimo (cabecera válida) para que el SDK lo acepte como imagen.
const JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]).toString('base64')
const SHOT = { base64: JPEG_BASE64, width: 1000, height: 600 }

interface Captured {
  url: string
  headers: Record<string, string>
  body: string
}

function mockFetch(responses: { status: number; body: unknown }[], captured: Captured[]) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
    const raw = init?.body
    const body =
      raw instanceof Blob
        ? Buffer.from(await raw.arrayBuffer()).toString('latin1')
        : raw instanceof Uint8Array
          ? Buffer.from(raw).toString('latin1')
          : String(raw)
    captured.push({ url, headers, body })
    const next = responses.shift() ?? { status: 500, body: { error: 'sin respuesta simulada' } }
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  }
}

const OK = {
  model: JEV_MODEL,
  answers: {
    needsPoint: { type: 'noul', noul: 0.92 },
    target: { type: 'box', box: { top: 0.4, bottom: 0.5, left: 0.2, right: 0.3 }, confidence: 0.81 }
  },
  usage: { input_tokens: 812, output_tokens: 4 }
}

describe('Jev: lógica', () => {
  it('convierte la caja en el centro en píxeles', () => {
    assert.deepEqual(boxCenter({ top: 0.4, bottom: 0.5, left: 0.2, right: 0.3 }, { width: 1000, height: 600 }), { x: 250, y: 270 })
    assert.deepEqual(boxCenter({ top: -1, bottom: 2, left: 0, right: 0 }, { width: 100, height: 100 }), { x: 0, y: 50 })
  })

  it('solo señala antes de tiempo si está seguro', () => {
    assert.equal(shouldPointEarly({ needsPoint: 0.9, confidence: 0.8 }), true)
    assert.equal(shouldPointEarly({ needsPoint: 0.3, confidence: 0.9 }), false)
    assert.equal(shouldPointEarly({ needsPoint: 0.9, confidence: 0.2 }), false)
    assert.equal(shouldPointEarly({ needsPoint: 0.9, confidence: null }), true)
    assert.equal(shouldPointEarly({ needsPoint: null, confidence: 0.7 }), true)
    assert.equal(shouldPointEarly({ needsPoint: null, confidence: null }), false)
  })

  it('mide la distancia entre dos puntos', () => {
    assert.equal(pointDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5)
  })

  it('incluye la pregunta del usuario sin romper las comillas', () => {
    const t = jevInstructions('¿Dónde está "Guardar"?')
    assert.match(t.target, /'Guardar'/)
    assert.ok(!t.target.includes('"Guardar"'))
  })
})

describe('Jev: SDK con fetch simulado', () => {
  it('pide noul + box a jev-preview con la imagen y la cabecera de imágenes', async () => {
    const captured: Captured[] = []
    const jev = new JevPointer({ getApiKey: () => 'ts-test', client: { fetch: mockFetch([{ status: 200, body: OK }], captured), compression: false } })
    const loc = await jev.locate(SHOT, '¿Dónde guardo?')
    assert.deepEqual(loc.point, { x: 250, y: 270 })
    assert.equal(loc.needsPoint, 0.92)
    assert.equal(loc.confidence, 0.81)
    assert.equal(captured.length, 1)
    const req = captured[0]
    assert.ok(req.url.endsWith('/v1/systemone'))
    assert.equal(req.headers['typesafe-danger-zone-images'], 'true')
    assert.match(req.headers['content-type'] ?? '', /multipart\/form-data/)
    assert.match(req.body, /"model":"jev-preview"/)
    assert.match(req.body, /"type":"box"/)
    assert.match(req.body, /"type":"noul"/)
    assert.ok(req.body.includes('\xff\xd8\xff'), 'la imagen va en el cuerpo multipart')
    assert.equal(req.headers.authorization, 'Bearer ts-test')
  })

  it('si el modelo rechaza la mezcla, repite solo con la caja', async () => {
    const captured: Captured[] = []
    const boxOnly = { ...OK, answers: { target: OK.answers.target } }
    const jev = new JevPointer({
      getApiKey: () => 'ts-test',
      client: { fetch: mockFetch([{ status: 400, body: { error: 'noul not supported' } }, { status: 200, body: boxOnly }, { status: 200, body: boxOnly }], captured), compression: false }
    })
    const first = await jev.locate(SHOT, 'abre ajustes')
    assert.equal(first.needsPoint, null)
    assert.equal(first.confidence, 0.81)
    await jev.locate(SHOT, 'otra')
    assert.equal(captured.length, 3)
    assert.doesNotMatch(captured[2].body, /"type":"noul"/)
  })

  it('explica los errores de autenticación', async () => {
    const jev = new JevPointer({
      getApiKey: () => 'mala',
      client: { fetch: mockFetch([{ status: 401, body: { error: 'invalid key' } }], []), compression: false }
    })
    await assert.rejects(
      () => jev.locate(SHOT, 'x'),
      (err: unknown) => /API key de TypeSafe no es válida/.test(describeJevError(err))
    )
  })

  it('sin API key no llama a la red', async () => {
    const jev = new JevPointer({ getApiKey: () => null })
    assert.equal(jev.configured, false)
    await assert.rejects(() => jev.locate(SHOT, 'x'), /API key/)
  })
})
