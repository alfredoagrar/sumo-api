import { net, protocol } from 'electron'
import { extname, join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

// En producción servimos las páginas desde app://bundle/ en vez de file://:
// así tienen un origen estable (Cache API para el modelo de voz, workers, CSP 'self')
// y aislamiento entre orígenes para que el WASM de Whisper use varios hilos.
export const APP_ORIGIN = 'app://bundle'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}

export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ])
}

export function handleAppProtocol(rendererDir: string): void {
  const root = normalize(rendererDir)
  protocol.handle('app', async (request) => {
    const url = new URL(request.url)
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'panel.html'
    const file = normalize(join(root, relative))
    if (file !== root && !file.startsWith(root + sep)) {
      return new Response('Not found', { status: 404 })
    }
    try {
      const res = await net.fetch(pathToFileURL(file).toString())
      if (!res.ok) return new Response('Not found', { status: 404 })
      return new Response(res.body, {
        status: 200,
        headers: {
          'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
          'Cross-Origin-Resource-Policy': 'same-origin'
        }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
