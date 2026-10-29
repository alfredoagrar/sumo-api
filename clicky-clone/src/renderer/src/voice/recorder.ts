// Grabación del micrófono con detección de voz: corta sola tras un silencio.

export interface RecorderEvents {
  onLevel: (level: number) => void
  onAutoStop: () => void
}

const TARGET_RATE = 16_000
const SILENCE_MS = 1400
const NO_SPEECH_MS = 8000
const MAX_MS = 60_000

export class Recorder {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private chunks: Float32Array[] = []
  private startedAt = 0
  private noiseFloor = 0
  private noiseSamples = 0
  private speechFrames = 0
  private speechDetected = false
  private lastVoiceAt = 0
  private lastLevelAt = 0
  private stopped = true
  private readonly events: RecorderEvents

  constructor(events: RecorderEvents) {
    this.events = events
  }

  get recording(): boolean {
    return !this.stopped
  }

  async start(): Promise<void> {
    this.cancel()
    this.stopped = false
    this.chunks = []
    this.noiseFloor = 0
    this.noiseSamples = 0
    this.speechFrames = 0
    this.speechDetected = false
    this.startedAt = performance.now()
    this.lastVoiceAt = this.startedAt

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
    if (this.stopped) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    this.stream = stream
    const ctx = new AudioContext()
    this.ctx = ctx
    if (ctx.state === 'suspended') await ctx.resume()
    await ctx.audioWorklet.addModule(new URL('./recorder-worklet.js', document.baseURI).href)
    if (this.stopped) return
    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'buddy-recorder')
    this.node = node
    node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onChunk(e.data)
    // Conectamos a un destino mudo para que el grafo de audio procese el nodo.
    const mute = ctx.createGain()
    mute.gain.value = 0
    source.connect(node)
    node.connect(mute)
    mute.connect(ctx.destination)
  }

  private onChunk(chunk: Float32Array): void {
    if (this.stopped) return
    this.chunks.push(chunk)
    let sum = 0
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i]
    const rms = Math.sqrt(sum / chunk.length)
    const now = performance.now()
    const elapsed = now - this.startedAt

    // Los primeros ~300 ms sirven para estimar el ruido de fondo.
    if (elapsed < 300) {
      this.noiseFloor = (this.noiseFloor * this.noiseSamples + rms) / (this.noiseSamples + 1)
      this.noiseSamples++
    }
    const threshold = Math.max(0.012, this.noiseFloor * 3)
    if (rms > threshold) {
      this.speechFrames++
      if (this.speechFrames >= 2) this.speechDetected = true
      this.lastVoiceAt = now
    } else if (rms < threshold * 0.6) {
      this.speechFrames = 0
    }

    if (now - this.lastLevelAt > 50) {
      this.lastLevelAt = now
      this.events.onLevel(Math.min(1, rms * 9))
    }

    const silentFor = now - this.lastVoiceAt
    if ((this.speechDetected && silentFor > SILENCE_MS) || (!this.speechDetected && elapsed > NO_SPEECH_MS) || elapsed > MAX_MS) {
      this.events.onAutoStop()
    }
  }

  /** Termina la grabación y devuelve el audio mono a 16 kHz (o null si no hubo voz). */
  async stop(): Promise<Float32Array | null> {
    if (this.stopped) return null
    const rate = this.ctx?.sampleRate ?? 48_000
    const chunks = this.chunks
    const hadSpeech = this.speechDetected
    this.release()
    if (!hadSpeech || chunks.length === 0) return null
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const audio = new Float32Array(total)
    let offset = 0
    for (const c of chunks) {
      audio.set(c, offset)
      offset += c.length
    }
    return resample(audio, rate, TARGET_RATE)
  }

  cancel(): void {
    this.release()
  }

  private release(): void {
    this.stopped = true
    this.chunks = []
    if (this.node) {
      this.node.port.onmessage = null
      this.node.disconnect()
    }
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.ctx?.close().catch(() => undefined)
    this.node = null
    this.stream = null
    this.ctx = null
  }
}

/** Remuestreo de calidad usando OfflineAudioContext (con filtro antialiasing del navegador). */
async function resample(input: Float32Array, from: number, to: number): Promise<Float32Array> {
  if (from === to) return input
  const length = Math.ceil((input.length * to) / from)
  const offline = new OfflineAudioContext(1, length, to)
  const buffer = offline.createBuffer(1, input.length, from)
  buffer.copyToChannel(new Float32Array(input), 0)
  const src = offline.createBufferSource()
  src.buffer = buffer
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0).slice()
}
