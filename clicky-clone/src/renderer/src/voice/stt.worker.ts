// Worker de transcripción: Whisper ejecutándose localmente con transformers.js (WebGPU o WASM).
// El audio nunca sale de tu computadora; solo se descarga el modelo la primera vez.
import { env, pipeline } from '@huggingface/transformers'
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'
import type { SttStatus } from '../../../shared/types'

export type WorkerRequest =
  | { type: 'load'; model: string; device: 'auto' | 'webgpu' | 'wasm' }
  | { type: 'transcribe'; id: number; audio: Float32Array; language: string }

export type WorkerResponse =
  | { type: 'status'; status: SttStatus }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id: number; message: string }

type Transcriber = (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>

env.allowLocalModels = false
env.useBrowserCache = true
// Usamos los binarios de ONNX Runtime empaquetados con la app en vez de un CDN.
const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown } }
if (onnx.wasm) {
  onnx.wasm.wasmPaths = {
    mjs: new URL(ortMjsUrl, self.location.href).href,
    wasm: new URL(ortWasmUrl, self.location.href).href
  }
}

let current: { key: string; promise: Promise<Transcriber> } | null = null

function post(msg: WorkerResponse): void {
  self.postMessage(msg)
}

async function hasWebGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) return false
  try {
    return Boolean(await gpu.requestAdapter())
  } catch {
    return false
  }
}

async function createTranscriber(model: string, device: 'auto' | 'webgpu' | 'wasm'): Promise<{ run: Transcriber; device: string }> {
  const useGpu = device === 'webgpu' || (device === 'auto' && (await hasWebGpu()))
  const resolved = useGpu ? 'webgpu' : 'wasm'
  post({ type: 'status', status: { state: 'loading', progress: 0, device: resolved } })

  const files = new Map<string, { loaded: number; total: number }>()
  let lastPct = -1
  const report = (pct: number): void => {
    const rounded = Math.min(100, Math.floor(pct))
    if (rounded === lastPct) return
    lastPct = rounded
    post({ type: 'status', status: { state: 'loading', progress: rounded, device: resolved } })
  }

  const run = (await pipeline('automatic-speech-recognition', model, {
    device: resolved,
    dtype: useGpu ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
    progress_callback: (info) => {
      if (info.status === 'progress_total') report(info.progress)
      else if (info.status === 'progress') {
        files.set(info.file, { loaded: info.loaded, total: info.total })
        let loaded = 0
        let total = 0
        for (const f of files.values()) {
          loaded += f.loaded
          total += f.total
        }
        if (total > 0) report((loaded / total) * 100)
      }
    }
  })) as unknown as Transcriber
  return { run, device: resolved }
}

/** Carga (o reutiliza) el modelo. Se registra de forma síncrona para que una transcripción posterior lo espere. */
function load(model: string, device: 'auto' | 'webgpu' | 'wasm'): Promise<Transcriber> {
  const key = `${model}|${device}`
  if (current?.key === key) return current.promise
  const created = createTranscriber(model, device)
  const promise = created.then((t) => t.run)
  current = { key, promise }
  created.then(
    (t) => post({ type: 'status', status: { state: 'ready', device: t.device } }),
    (err: unknown) => {
      if (current?.key === key) current = null
      const raw = err instanceof Error ? err.message : String(err)
      const message = /fetch|network|load|404/i.test(raw)
        ? `No se pudo descargar el modelo de voz desde huggingface.co. Revisa tu conexión (${raw}).`
        : raw
      post({ type: 'status', status: { state: 'error', message } })
    }
  )
  return promise
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  if (msg.type === 'load') {
    load(msg.model, msg.device).catch(() => undefined)
    return
  }
  if (msg.type === 'transcribe') {
    try {
      if (!current) throw new Error('El modelo de voz no está cargado.')
      const transcriber = await current.promise
      const output = await transcriber(msg.audio, {
        language: msg.language,
        task: 'transcribe',
        chunk_length_s: 30,
        stride_length_s: 5
      })
      const text = Array.isArray(output) ? output.map((o) => o.text).join(' ') : output.text
      post({ type: 'result', id: msg.id, text: text.trim() })
    } catch (err) {
      post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) })
    }
  }
}
