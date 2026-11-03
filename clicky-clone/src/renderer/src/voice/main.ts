// Motor de voz (ventana invisible): micrófono → Whisper local → texto, y texto → voz.
import { api } from '../common/api'
import type { Settings } from '../../../shared/types'
import { Recorder } from './recorder'
import { Speaker } from './speaker'
import { SpeechToText } from './stt'

let settings: Settings = await api.getSettings()

const stt = new SpeechToText((status) => api.sendSttStatus(status))
stt.configure(settings.stt.model, settings.stt.device)
// Precarga de Whisper para que la primera pregunta no espere la descarga. En macOS, con el dictado
// de Apple, Whisper solo es el respaldo: se carga la primera vez que haga falta.
const platform = (await api.getAppInfo()).platform
const whisperFirst = settings.stt.engine === 'whisper' || (settings.stt.engine === 'auto' && platform !== 'darwin')
if (whisperFirst) setTimeout(() => stt.warmup(), 2500)

const speaker = new Speaker()
// Cada grabación tiene su número: si se cancela, su transcripción tardía se descarta.
let session = 0
// Dictado de Apple: el audio va al proceso principal mientras hablas. Guardamos la última frase
// por si hay que transcribirla con Whisper (si el dictado de Apple falla).
let streaming = false
let lastAudio: Float32Array | null = null

const recorder = new Recorder({
  onLevel: (level) => api.sendVoiceLevel(level),
  onAutoStop: () => {
    api.sendVoiceStopped()
    void finish()
  },
  onChunk: (chunk, sampleRate) => {
    if (streaming) api.sendAudioChunk(chunk, sampleRate)
  }
})

function micError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return settings.language === 'es'
      ? 'No tengo permiso para usar el micrófono. Actívalo en los ajustes del sistema.'
      : 'I do not have permission to use the microphone. Enable it in system settings.'
  }
  if (name === 'NotFoundError') {
    return settings.language === 'es' ? 'No encontré ningún micrófono.' : 'No microphone found.'
  }
  return err instanceof Error ? err.message : String(err)
}

async function finish(): Promise<void> {
  // recorder.stop() marca la grabación como terminada de inmediato, así que esto evita dobles llamadas.
  if (!recorder.recording) return
  const mine = session
  try {
    const audio = await recorder.stop()
    const hadSpeech = Boolean(audio && audio.length >= 16_000 * 0.35)
    if (streaming) {
      lastAudio = hadSpeech ? audio : null
      if (mine === session) api.sendAudioEnd(hadSpeech)
      return
    }
    if (!audio || !hadSpeech) {
      if (mine === session) api.sendTranscript('')
      return
    }
    await transcribe(audio, mine)
  } catch (err) {
    if (mine === session) api.sendVoiceError(transcribeError(err))
  }
}

function transcribeError(err: unknown): string {
  return settings.language === 'es'
    ? `No pude transcribir tu voz: ${err instanceof Error ? err.message : String(err)}`
    : `I could not transcribe your voice: ${err instanceof Error ? err.message : String(err)}`
}

async function transcribe(audio: Float32Array, mine: number): Promise<void> {
  const text = await stt.transcribe(audio, settings.language)
  if (mine === session) api.sendTranscript(text)
}

api.onVoice((cmd) => {
  if (cmd.type === 'start') {
    session++
    streaming = cmd.stream === true
    lastAudio = null
    speaker.stop()
    recorder.start().catch((err: unknown) => {
      recorder.cancel()
      api.sendVoiceError(micError(err))
    })
  } else if (cmd.type === 'stop') {
    void finish()
  } else if (cmd.type === 'whisper-fallback') {
    // El dictado de Apple no pudo: transcribimos la misma frase con Whisper.
    const audio = lastAudio
    lastAudio = null
    const mine = session
    if (!audio) api.sendTranscript('')
    else transcribe(audio, mine).catch((err: unknown) => mine === session && api.sendVoiceError(transcribeError(err)))
  } else {
    session++
    recorder.cancel()
  }
})

api.onSpeech((cmd) => {
  if (cmd.type === 'stop') {
    speaker.stop()
    return
  }
  void speaker
    .speak(cmd.text, {
      enabled: settings.voice.enabled,
      language: settings.language,
      voiceURI: settings.voice.voiceURI,
      rate: settings.voice.rate
    })
    .then((completed) => {
      if (completed) api.sendSpeechDone()
    })
})

api.onSettings((next) => {
  const reload =
    next.stt.model !== settings.stt.model || next.stt.device !== settings.stt.device || (next.stt.engine === 'whisper' && settings.stt.engine !== 'whisper')
  settings = next
  if (reload) {
    stt.configure(next.stt.model, next.stt.device)
    stt.warmup()
  }
})
