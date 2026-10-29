// Motor de voz (ventana invisible): micrófono → Whisper local → texto, y texto → voz.
import { api } from '../common/api'
import type { Settings } from '../../../shared/types'
import { Recorder } from './recorder'
import { Speaker } from './speaker'
import { SpeechToText } from './stt'

let settings: Settings = await api.getSettings()

const stt = new SpeechToText((status) => api.sendSttStatus(status))
stt.configure(settings.stt.model, settings.stt.device)
// Precarga del modelo para que la primera pregunta no espere la descarga.
setTimeout(() => stt.warmup(), 2500)

const speaker = new Speaker()
// Cada grabación tiene su número: si se cancela, su transcripción tardía se descarta.
let session = 0

const recorder = new Recorder({
  onLevel: (level) => api.sendVoiceLevel(level),
  onAutoStop: () => {
    api.sendVoiceStopped()
    void finish()
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
    if (!audio || audio.length < 16_000 * 0.35) {
      if (mine === session) api.sendTranscript('')
      return
    }
    const text = await stt.transcribe(audio, settings.language)
    if (mine === session) api.sendTranscript(text)
  } catch (err) {
    if (mine !== session) return
    api.sendVoiceError(
      settings.language === 'es'
        ? `No pude transcribir tu voz: ${err instanceof Error ? err.message : String(err)}`
        : `I could not transcribe your voice: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

api.onVoice((cmd) => {
  if (cmd.type === 'start') {
    session++
    speaker.stop()
    recorder.start().catch((err: unknown) => {
      recorder.cancel()
      api.sendVoiceError(micError(err))
    })
  } else if (cmd.type === 'stop') {
    void finish()
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
  const reload = next.stt.model !== settings.stt.model || next.stt.device !== settings.stt.device
  settings = next
  if (reload) {
    stt.configure(next.stt.model, next.stt.device)
    stt.warmup()
  }
})
