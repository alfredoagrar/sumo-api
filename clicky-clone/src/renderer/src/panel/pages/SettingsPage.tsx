import { useEffect, useState } from 'react'
import type { JevStatus, JevTestResult, Settings } from '../../../../shared/types'
import { api } from '../../common/api'
import type { AppData } from '../App'
import { Card, Field, HotkeyInput, TextSetting, Toggle } from '../components'

const CLAUDE_MODELS = [
  { value: 'haiku', label: 'Haiku — el más rápido' },
  { value: 'sonnet', label: 'Sonnet — rápido y preciso (recomendado)' },
  { value: 'opus', label: 'Opus — el más capaz, más lento' },
  { value: '', label: 'El predeterminado de tu cuenta' }
]

const STT_MODELS = [
  { value: 'onnx-community/whisper-tiny', label: 'Whisper Tiny — ~40 MB, muy rápido' },
  { value: 'onnx-community/whisper-base', label: 'Whisper Base — ~80 MB, equilibrado (recomendado)' },
  { value: 'onnx-community/whisper-small', label: 'Whisper Small — ~250 MB, más preciso' }
]

function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => speechSynthesis.getVoices())
  useEffect(() => {
    const update = (): void => setVoices(speechSynthesis.getVoices())
    speechSynthesis.addEventListener('voiceschanged', update)
    update()
    return () => speechSynthesis.removeEventListener('voiceschanged', update)
  }, [])
  return voices
}

/** Experimento: señalar más rápido con Jev (TypeSafe AI). */
function JevCard({ data }: { data: AppData }) {
  const { settings: s, save } = data
  const [status, setStatus] = useState<JevStatus | null>(null)
  const [key, setKey] = useState('')
  const [test, setTest] = useState<JevTestResult | 'running' | null>(null)
  useEffect(() => void api.getJevStatus().then(setStatus), [])

  const saveKey = async (): Promise<void> => {
    setStatus(await api.setJevKey(key))
    setKey('')
    setTest(null)
  }
  const runTest = async (): Promise<void> => {
    setTest('running')
    setTest(await api.testJev())
  }

  return (
    <Card
      title="Señalar más rápido con Jev (experimental)"
      subtitle="Jev, de TypeSafe AI, localiza el elemento de tu pantalla en paralelo y en menos de un segundo, así el buddy vuela antes. Lo que te dice Buddy sigue viniendo de Claude o ChatGPT, que además decide si hace falta señalar."
    >
      <Toggle
        label="Usar Jev para señalar"
        hint={status?.configured ? 'Si Jev no está seguro o falla, se usa el punto del modelo principal.' : 'Primero guarda tu API key de TypeSafe.'}
        checked={s.pointer.engine === 'jev'}
        onChange={(v) => void save({ pointer: { engine: v ? 'jev' : 'model' } })}
      />
      <Field
        label="API key de TypeSafe"
        hint={
          status?.fromEnv
            ? 'Se usa la variable de entorno TYPESAFE_API_KEY.'
            : status?.configured
              ? 'Guardada y cifrada en este equipo. Es de pago por uso (no es tu suscripción).'
              : 'Consíguela en typesafe.ai. Es de pago por uso (no es tu suscripción).'
        }
      >
        <div className="inline-controls">
          <input
            className="input mono"
            type="password"
            value={key}
            placeholder={status?.configured ? '•••••••• (guardada)' : 'ts-…'}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveKey()
            }}
          />
          <button type="button" className="btn small" disabled={!key.trim()} onClick={() => void saveKey()}>
            Guardar
          </button>
          {status?.configured && !status.fromEnv && (
            <button type="button" className="btn small ghost" onClick={() => void api.setJevKey('').then(setStatus)}>
              Borrar
            </button>
          )}
        </div>
      </Field>
      <div className="row">
        <span className="row-text">
          <span>Conexión</span>
          <small className="muted">En Conversaciones verás cuánto tardó Jev y a cuántos píxeles quedó del punto del modelo.</small>
        </span>
        <div className="row-control">
          <button type="button" className="btn small ghost" disabled={!status?.configured || test === 'running'} onClick={() => void runTest()}>
            Probar Jev
          </button>
          {test && test !== 'running' && (
            <small className={test.ok ? 'muted' : 'bad-text'}>
              {' '}
              {test.text} ({(test.ms / 1000).toFixed(2)} s)
            </small>
          )}
        </div>
      </div>
    </Card>
  )
}

export function SettingsPage({ data }: { data: AppData }) {
  const { settings: s, save, info, hotkeys } = data
  const voices = useVoices().filter((v) => v.lang.toLowerCase().startsWith(s.language))
  const claudeModelKnown = CLAUDE_MODELS.some((m) => m.value === s.claude.model)

  const testVoice = (): void => {
    speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(s.language === 'es' ? 'Hola, soy Buddy. Así sueno.' : "Hi, I'm Buddy. This is how I sound.")
    const v = voices.find((x) => x.voiceURI === s.voice.voiceURI)
    if (v) u.voice = v
    u.lang = v?.lang ?? (s.language === 'es' ? 'es-MX' : 'en-US')
    u.rate = s.voice.rate
    speechSynthesis.speak(u)
  }

  const set = (patch: Parameters<AppData['save']>[0]): void => void save(patch)

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Ajustes</h1>
          <p className="muted">Los cambios se guardan al momento.</p>
        </div>
      </header>

      <Card title="Inteligencia" subtitle="Elige qué suscripción responde. Puedes cambiarla también desde el icono de la barra de menú.">
        <div className="segmented">
          {(['claude', 'codex'] as Settings['provider'][]).map((id) => (
            <button key={id} type="button" className={s.provider === id ? 'active' : ''} onClick={() => set({ provider: id })}>
              {id === 'claude' ? 'Claude (Pro / Max)' : 'ChatGPT (Plus / Pro)'}
            </button>
          ))}
        </div>

        {s.provider === 'claude' ? (
          <>
            <Field label="Modelo para responder" hint="Haiku responde en ~3 s; Sonnet señala mejor en interfaces complejas.">
              <select
                className="input"
                value={claudeModelKnown ? s.claude.model : '__custom'}
                onChange={(e) => e.target.value !== '__custom' && set({ claude: { model: e.target.value } })}
              >
                {CLAUDE_MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
                {!claudeModelKnown && <option value="__custom">{s.claude.model}</option>}
              </select>
            </Field>
            <Field label="Modelo exacto (opcional)" hint="Alias o nombre completo, p. ej. claude-sonnet-5-5.">
              <TextSetting value={s.claude.model} placeholder="sonnet" mono onSave={(v) => set({ claude: { model: v } })} />
            </Field>
            <Field label="Modelo para agentes" hint="Vacío = el predeterminado de tu cuenta.">
              <TextSetting value={s.claude.agentModel} placeholder="predeterminado" mono onSave={(v) => set({ claude: { agentModel: v } })} />
            </Field>
            <Field label="Ruta de «claude»" hint="Déjalo vacío para detectarlo automáticamente.">
              <TextSetting value={s.claude.binary} placeholder="automático" mono onSave={(v) => set({ claude: { binary: v } })} />
            </Field>
          </>
        ) : (
          <>
            <Field label="Modelo" hint="Vacío = el de tu configuración de Codex.">
              <TextSetting value={s.codex.model} placeholder="predeterminado" mono onSave={(v) => set({ codex: { model: v } })} />
            </Field>
            <Field label="Razonamiento" hint="Menos razonamiento = respuestas más rápidas.">
              <select
                className="input"
                value={s.codex.reasoningEffort}
                onChange={(e) => set({ codex: { reasoningEffort: e.target.value as Settings['codex']['reasoningEffort'] } })}
              >
                <option value="minimal">Mínimo</option>
                <option value="low">Bajo (recomendado)</option>
                <option value="medium">Medio</option>
                <option value="high">Alto</option>
                <option value="">Predeterminado</option>
              </select>
            </Field>
            <Field label="Ruta de «codex»" hint="Déjalo vacío para detectarlo automáticamente.">
              <TextSetting value={s.codex.binary} placeholder="automático" mono onSave={(v) => set({ codex: { binary: v } })} />
            </Field>
          </>
        )}
      </Card>

      <JevCard data={data} />

      <Card title="Idioma y voz">
        <Field label="Idioma" hint="Idioma en el que hablas y en el que responde Buddy.">
          <select className="input" value={s.language} onChange={(e) => set({ language: e.target.value as Settings['language'], voice: { voiceURI: '' } })}>
            <option value="es">Español</option>
            <option value="en">English</option>
          </select>
        </Field>
        <Toggle label="Responder en voz alta" checked={s.voice.enabled} onChange={(v) => set({ voice: { enabled: v } })} />
        <Field label="Voz" hint="Voces del sistema. En macOS puedes descargar voces «Mejoradas» en Accesibilidad → Contenido leído.">
          <div className="inline-controls">
            <select className="input" value={s.voice.voiceURI} onChange={(e) => set({ voice: { voiceURI: e.target.value } })}>
              <option value="">Automática</option>
              {voices.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </select>
            <button type="button" className="btn small ghost" onClick={testVoice}>
              Probar
            </button>
          </div>
        </Field>
        <Field label="Velocidad" hint={`${s.voice.rate.toFixed(2)}×`}>
          <input
            type="range"
            min={0.7}
            max={1.6}
            step={0.05}
            value={s.voice.rate}
            onChange={(e) => set({ voice: { rate: Number(e.target.value) } })}
          />
        </Field>
        <Toggle label="Mostrar subtítulos junto al cursor" checked={s.showCaptions} onChange={(v) => set({ showCaptions: v })} />
        <Toggle
          label="Brillo en el borde de la pantalla"
          hint="Indica que Buddy está escuchando o trabajando, para que no lo interrumpas."
          checked={s.screenGlow}
          onChange={(v) => set({ screenGlow: v })}
        />
      </Card>

      <Card title="Dictado" subtitle="Tu voz se transcribe en tu equipo con Whisper: el audio no sale de tu computadora.">
        <Field label="Modelo de transcripción">
          <select className="input" value={s.stt.model} onChange={(e) => set({ stt: { model: e.target.value } })}>
            {STT_MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Aceleración" hint="La GPU (WebGPU) es mucho más rápida si tu equipo la soporta.">
          <select className="input" value={s.stt.device} onChange={(e) => set({ stt: { device: e.target.value as Settings['stt']['device'] } })}>
            <option value="auto">Automática</option>
            <option value="webgpu">GPU (WebGPU)</option>
            <option value="wasm">CPU (WASM)</option>
          </select>
        </Field>
      </Card>

      <Card title="Atajos de teclado" subtitle="Haz clic en un atajo y pulsa la nueva combinación.">
        <Field label="Hablar" hint="Pulsa una vez para empezar y otra para terminar.">
          <HotkeyInput value={s.hotkeys.talk} platform={info.platform} ok={hotkeys.talk} onSave={(v) => set({ hotkeys: { talk: v } })} />
        </Field>
        <Field label="Escribir una pregunta">
          <HotkeyInput value={s.hotkeys.type} platform={info.platform} ok={hotkeys.type} onSave={(v) => set({ hotkeys: { type: v } })} />
        </Field>
        <Field label="Abrir este panel">
          <HotkeyInput value={s.hotkeys.panel} platform={info.platform} ok={hotkeys.panel} onSave={(v) => set({ hotkeys: { panel: v } })} />
        </Field>
      </Card>

      <Card title="Agentes">
        <Field label="Carpeta de trabajo" hint="Cada tarea crea aquí su propia subcarpeta.">
          <TextSetting value={s.agents.workspaceDir} mono onSave={(v) => v && set({ agents: { workspaceDir: v } })} />
        </Field>
        <Toggle
          label="Permitir comandos de terminal (Claude)"
          hint="Desactivado por seguridad. Si lo activas, el agente podrá ejecutar comandos en tu equipo."
          checked={s.agents.allowShell}
          onChange={(v) => set({ agents: { allowShell: v } })}
        />
        <Toggle label="Avisar en voz alta al terminar" checked={s.agents.announce} onChange={(v) => set({ agents: { announce: v } })} />
      </Card>

      <Card title="General">
        <Toggle label="Abrir Buddy al iniciar sesión" checked={s.launchAtLogin} onChange={(v) => set({ launchAtLogin: v })} />
        <p className="muted small-text">Datos de la app: {info.userData}</p>
      </Card>
    </div>
  )
}
