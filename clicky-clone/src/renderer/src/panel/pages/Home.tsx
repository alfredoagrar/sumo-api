import { useState } from 'react'
import { prettyAccelerator } from '../../../../shared/accelerator'
import type { ProviderId, ProviderStatus, ProviderTestResult } from '../../../../shared/types'
import { api } from '../../common/api'
import type { AppData } from '../App'
import { Badge, BuddyMark, Card, Icon, type Tone } from '../components'

const PROVIDERS: Record<
  ProviderId,
  { name: string; cli: string; plans: string; install: { unix: string; win: string }; docs: string }
> = {
  claude: {
    name: 'Claude',
    cli: 'Claude Code',
    plans: 'Pro o Max',
    install: { unix: 'curl -fsSL https://claude.ai/install.sh | bash', win: 'irm https://claude.ai/install.ps1 | iex' },
    docs: 'https://code.claude.com/docs/en/quickstart'
  },
  codex: {
    name: 'ChatGPT',
    cli: 'Codex CLI',
    plans: 'Plus, Pro, Business o Enterprise',
    install: { unix: 'npm install -g @openai/codex', win: 'npm install -g @openai/codex' },
    docs: 'https://developers.openai.com/codex/cli'
  }
}

function ProviderCard({ id, status, data }: { id: ProviderId; status: ProviderStatus | undefined; data: AppData }) {
  const meta = PROVIDERS[id]
  const selected = data.settings.provider === id
  const [test, setTest] = useState<ProviderTestResult | 'running' | null>(null)
  const [loginCmd, setLoginCmd] = useState<string | null>(null)
  const win = data.info.platform === 'win32'

  const runTest = async (): Promise<void> => {
    setTest('running')
    setTest(await api.testProvider(id))
  }
  const login = async (): Promise<void> => {
    setLoginCmd(await api.openLogin(id))
  }

  let tone: Tone = 'neutral'
  let summary = 'Comprobando…'
  if (status) {
    if (!status.installed) {
      tone = 'bad'
      summary = 'No instalado'
    } else if (!status.loggedIn) {
      tone = 'warn'
      summary = 'Sin sesión'
    } else if (status.usingSubscription === true) {
      tone = 'ok'
      summary = 'Usando tu suscripción'
    } else if (status.usingSubscription === false) {
      tone = 'warn'
      summary = 'Usando API key'
    } else {
      tone = 'info'
      summary = 'Sesión iniciada'
    }
  }

  return (
    <div className={`provider ${selected ? 'selected' : ''}`}>
      <header className="provider-head">
        <div className={`provider-logo logo-${id}`}>{id === 'claude' ? 'C' : 'G'}</div>
        <div className="provider-title">
          <h3>{meta.name}</h3>
          <small className="muted">
            con {meta.cli} · plan {meta.plans}
          </small>
        </div>
        {selected ? (
          <Badge tone="info">En uso</Badge>
        ) : (
          <button type="button" className="btn small" onClick={() => void data.save({ provider: id })}>
            Usar este
          </button>
        )}
      </header>

      <div className="provider-body">
        <Badge tone={tone}>{summary}</Badge>
        {status?.version && <span className="muted mono small-text">v{status.version}</span>}
        <p className="muted">{status ? status.detail : 'Buscando la CLI en tu equipo…'}</p>

        {status && !status.installed && (
          <div className="howto">
            <span className="muted">Instálalo desde tu terminal:</span>
            <code className="code">{win ? meta.install.win : meta.install.unix}</code>
            <button type="button" className="link" onClick={() => void api.openExternal(meta.docs)}>
              Ver la guía oficial de instalación →
            </button>
          </div>
        )}

        {status?.installed && (!status.loggedIn || status.usingSubscription === false) && (
          <div className="howto">
            <span className="muted">
              Inicia sesión con tu cuenta de {meta.name} (el inicio de sesión se hace en la página oficial; Buddy nunca ve tu contraseña ni tus tokens).
            </span>
            <button type="button" className="btn small primary" onClick={() => void login()}>
              Iniciar sesión en la terminal
            </button>
            {loginCmd && (
              <span className="muted small-text">
                Si no se abrió la terminal, ejecuta <code className="code inline">{loginCmd}</code>
              </span>
            )}
          </div>
        )}

        {test && (
          <div className={`test-result ${test !== 'running' && !test.ok ? 'is-bad' : ''}`}>
            {test === 'running' ? (
              <span className="muted">Preguntando a {meta.name}…</span>
            ) : (
              <>
                <span>{test.text}</span>
                <small className="muted">{(test.ms / 1000).toFixed(1)} s</small>
              </>
            )}
          </div>
        )}
      </div>

      <footer className="provider-foot">
        <button type="button" className="btn small ghost" disabled={!status?.installed || test === 'running'} onClick={() => void runTest()}>
          <Icon name="play" size={14} /> Probar conexión
        </button>
        <button type="button" className="btn small ghost" onClick={data.refreshStatuses}>
          <Icon name="refresh" size={14} /> Revisar
        </button>
      </footer>
    </div>
  )
}

function Check({ label, tone, text, action }: { label: string; tone: Tone; text: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="check">
      <span className={`dot dot-${tone}`} />
      <span className="check-label">{label}</span>
      <span className="muted check-text">{text}</span>
      {action && (
        <button type="button" className="btn small ghost" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  )
}

export function Home({ data }: { data: AppData }) {
  const { settings, info, statuses, hotkeys, permissions, stt } = data
  const platform = info.platform
  const talk = prettyAccelerator(settings.hotkeys.talk, platform)
  const type = prettyAccelerator(settings.hotkeys.type, platform)
  const active = statuses?.find((s) => s.id === settings.provider)
  const activeName = PROVIDERS[settings.provider].name
  const ready = Boolean(active?.installed && active.loggedIn)

  const micOk = !permissions || permissions.microphone === 'granted'
  const screenOk = !permissions || permissions.screen === 'granted'
  const hotkeysOk = hotkeys.talk && hotkeys.type

  let sttTone: Tone = 'neutral'
  let sttText = 'Se descargará al usar la voz por primera vez (~80 MB).'
  if (stt.state === 'loading') {
    sttTone = 'info'
    sttText = `Descargando y preparando… ${stt.progress ?? 0}%`
  } else if (stt.state === 'ready') {
    sttTone = 'ok'
    sttText = `Listo (${stt.device === 'webgpu' ? 'GPU' : 'CPU'}). Tu voz se transcribe en tu equipo.`
  } else if (stt.state === 'error') {
    sttTone = 'bad'
    sttText = stt.message ?? 'No se pudo cargar el modelo.'
  }

  return (
    <div className="page">
      <section className="hero">
        <div className="hero-art" aria-hidden="true">
          <div className="hero-glow" />
          <BuddyMark size={72} />
        </div>
        <div className="hero-copy">
          <h1>Hola, soy Buddy</h1>
          <p>
            Vivo junto a tu cursor. Pregúntame lo que sea sobre lo que tienes en pantalla y te lo explico en voz alta. Si hay que hacer clic en algo, vuelo hasta
            ahí y te lo señalo.
          </p>
          <div className="hero-status">
            {statuses === null ? (
              <Badge>Comprobando {activeName}…</Badge>
            ) : ready ? (
              <Badge tone="ok">Listo con tu cuenta de {activeName}</Badge>
            ) : (
              <Badge tone="warn">Conecta {activeName} para empezar</Badge>
            )}
          </div>
        </div>
      </section>

      <div className="steps">
        <div className="step">
          <span className="step-n">1</span>
          <h4>Habla</h4>
          <p className="muted">
            Pulsa <kbd>{talk}</kbd>, haz tu pregunta y vuelve a pulsar (o simplemente calla un momento).
          </p>
        </div>
        <div className="step">
          <span className="step-n">2</span>
          <h4>O escribe</h4>
          <p className="muted">
            Pulsa <kbd>{type}</kbd> para escribir la pregunta en una barra flotante.
          </p>
        </div>
        <div className="step">
          <span className="step-n">3</span>
          <h4>Delega</h4>
          <p className="muted">
            Empieza con <b>«agente, …»</b> y Buddy trabajará en segundo plano: investiga, redacta o crea archivos.
          </p>
        </div>
      </div>

      <h2>Tu suscripción</h2>
      <p className="muted section-lead">
        Buddy no usa API keys de pago por uso: ejecuta las herramientas oficiales de Anthropic y OpenAI con la sesión de <b>tu</b> plan, en tu equipo.
      </p>
      <div className="grid-2">
        {(['claude', 'codex'] as ProviderId[]).map((id) => (
          <ProviderCard key={id} id={id} status={statuses?.find((s) => s.id === id)} data={data} />
        ))}
      </div>

      <h2>Comprobaciones</h2>
      <Card>
        <Check
          label="Micrófono"
          tone={micOk ? 'ok' : 'warn'}
          text={micOk ? 'Permitido' : 'Buddy necesita el micrófono para escucharte.'}
          action={micOk ? undefined : { label: 'Abrir ajustes', onClick: () => void api.openPermissionSettings('microphone') }}
        />
        <Check
          label="Grabación de pantalla"
          tone={screenOk ? 'ok' : 'warn'}
          text={screenOk ? 'Permitida' : 'Necesaria para ver tu pantalla. Actívala y reinicia Buddy.'}
          action={screenOk ? undefined : { label: 'Abrir ajustes', onClick: () => void api.openPermissionSettings('screen') }}
        />
        <Check label="Dictado local (Whisper)" tone={sttTone} text={sttText} />
        <Check
          label="Atajos de teclado"
          tone={hotkeysOk ? 'ok' : 'bad'}
          text={hotkeysOk ? `${talk} para hablar · ${type} para escribir` : 'Algún atajo está ocupado por otra app. Cámbialo en Ajustes.'}
          action={hotkeysOk ? undefined : { label: 'Cambiar', onClick: () => data.go('settings') }}
        />
      </Card>

      {!settings.onboarded && (
        <div className="cta">
          <button type="button" className="btn primary" onClick={() => void data.save({ onboarded: true })}>
            Listo, ya puedo cerrar esta ventana
          </button>
          <span className="muted">Buddy seguirá en la barra de menú. Ábrelo cuando quieras desde ahí.</span>
        </div>
      )}
    </div>
  )
}
