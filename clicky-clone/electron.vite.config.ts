import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// CSP solo en producción (en desarrollo Vite inyecta scripts para HMR).
// connect-src permite descargar el modelo Whisper desde Hugging Face la primera vez.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self' blob: data: https://huggingface.co https://*.huggingface.co https://*.hf.co"
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'buddy-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`)
    }
  }
}

const page = (name: string): string => resolve(__dirname, `src/renderer/${name}.html`)

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react(), contentSecurityPolicy()],
    worker: { format: 'es' },
    build: {
      rolldownOptions: {
        input: {
          overlay: page('overlay'),
          voice: page('voice'),
          prompt: page('prompt'),
          panel: page('panel')
        }
      }
    }
  }
})
