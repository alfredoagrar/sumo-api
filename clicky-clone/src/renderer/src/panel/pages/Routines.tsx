import { useState } from 'react'
import { describeSchedule, describeStep } from '../../../../shared/routine-text'
import type { Routine, RoutineRun, RoutineSchedule, StepResult } from '../../../../shared/types'
import { api } from '../../common/api'
import type { AppData } from '../App'
import { Badge, Icon, timeAgo, type Tone } from '../components'

const RUN_STATUS: Record<RoutineRun['status'], { label: string; tone: Tone }> = {
  running: { label: 'En marcha', tone: 'info' },
  passed: { label: 'Pasó', tone: 'ok' },
  failed: { label: 'Falló', tone: 'bad' },
  error: { label: 'Error', tone: 'bad' },
  cancelled: { label: 'Detenida', tone: 'neutral' }
}

const STEP_MARK: Record<StepResult['status'], string> = {
  pending: '·',
  running: '…',
  passed: '✓',
  failed: '✗',
  error: '!',
  skipped: '–'
}

const TRIGGER: Record<RoutineRun['trigger'], string> = {
  manual: 'desde el panel',
  voice: 'por voz',
  schedule: 'programada',
  orchestrator: 'por Claude'
}

const SOURCE: Record<Routine['source'], string> = {
  claude: 'Definida por Claude',
  orchestrator: 'Guardada por el orquestador',
  manual: 'Manual'
}

const IDEAS = [
  'Abre localhost:3000, inicia sesión con demo@demo.com y la contraseña demo, y comprueba que aparece el tablero',
  'Comprueba que la página de precios carga y muestra el botón «Empezar»',
  'Regístrate con un correo aleatorio y verifica que aparece el mensaje de bienvenida'
]

/** Opciones de programación más comunes. */
const SCHEDULES: { id: string; label: string; schedule: RoutineSchedule | null }[] = [
  { id: 'none', label: 'Sin programar', schedule: null },
  { id: '15', label: 'Cada 15 min', schedule: { everyMinutes: 15, dailyAt: '' } },
  { id: '30', label: 'Cada 30 min', schedule: { everyMinutes: 30, dailyAt: '' } },
  { id: '60', label: 'Cada hora', schedule: { everyMinutes: 60, dailyAt: '' } },
  { id: 'daily', label: 'Cada día a una hora…', schedule: { everyMinutes: 0, dailyAt: '09:00' } }
]

function scheduleId(s: RoutineSchedule | null): string {
  if (!s) return 'none'
  if (s.dailyAt) return 'daily'
  return SCHEDULES.find((o) => o.schedule?.everyMinutes === s.everyMinutes)?.id ?? 'none'
}

function StepRows({ routine, run }: { routine: Routine; run: RoutineRun | undefined }) {
  return (
    <ol className="steps-list">
      {routine.steps.map((step, i) => {
        const result = run?.steps.find((r) => r.index === i)
        const status = result?.status ?? (run?.status === 'running' && run.steps.length === i ? 'running' : 'pending')
        return (
          <li key={i} className={`step-row step-${status}`}>
            <span className="step-mark" aria-label={status}>
              {STEP_MARK[status]}
            </span>
            <span className="step-body">
              <span>{describeStep(step)}</span>
              {step.note && <small className="muted"> · {step.note}</small>}
              {result?.detail && <small className={`step-detail ${result.status === 'failed' || result.status === 'error' ? 'bad-text' : 'muted'}`}>{result.detail}</small>}
            </span>
            {result && result.ms > 0 && (
              <small className="muted step-ms">
                {result.via ? `${result.via === 'jev' ? 'Jev' : result.via === 'ocr' ? 'OCR' : 'modelo'} · ` : ''}
                {(result.ms / 1000).toFixed(2)} s
              </small>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function RoutineItem({ routine, runs, busy }: { routine: Routine; runs: RoutineRun[]; busy: boolean }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latest = runs[0]
  const running = latest?.status === 'running'
  const last = routine.lastRun ? RUN_STATUS[routine.lastRun.status] : null

  const run = async (): Promise<void> => {
    setError(null)
    setOpen(true)
    try {
      await api.runRoutine(routine.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const update = (patch: Parameters<typeof api.updateRoutine>[1]): void => {
    void api.updateRoutine(routine.id, patch).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }

  return (
    <li className={`task routine ${running ? 'task-running' : ''}`}>
      <button type="button" className="task-head" onClick={() => setOpen(!open)}>
        <span className={`dot dot-${running ? 'info' : last?.tone ?? 'neutral'} ${running ? 'pulse' : ''}`} />
        <span className="task-title">{routine.name}</span>
        {running ? <Badge tone="info">En marcha</Badge> : last && <Badge tone={last.tone}>{last.label}</Badge>}
        <span className="muted small-text">
          {routine.steps.length} pasos · {describeSchedule(routine.schedule)}
          {routine.lastRun?.at ? ` · ${timeAgo(routine.lastRun.at)}` : ''}
        </span>
      </button>
      {routine.description && <p className="task-result">{routine.description}</p>}
      {latest?.summary && !running && <p className="muted small-text routine-summary">{latest.summary}</p>}

      {open && (
        <div className="routine-body">
          <StepRows routine={routine} run={latest} />
          <div className="routine-options">
            <label className="inline-controls">
              <span className="muted small-text">Repetir</span>
              <select
                className="input"
                value={scheduleId(routine.schedule)}
                onChange={(e) => update({ schedule: SCHEDULES.find((o) => o.id === e.target.value)?.schedule ?? null })}
              >
                {SCHEDULES.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              {routine.schedule?.dailyAt && (
                <input className="input time" type="time" value={routine.schedule.dailyAt} onChange={(e) => update({ schedule: { everyMinutes: 0, dailyAt: e.target.value } })} />
              )}
            </label>
            <label className="inline-controls">
              <input type="checkbox" checked={routine.continueOnFailure} onChange={(e) => update({ continueOnFailure: e.target.checked })} />
              <span className="small-text">Seguir aunque falle un paso</span>
            </label>
            <span className="muted small-text">{SOURCE[routine.source]}</span>
          </div>
          {runs.length > 1 && (
            <ul className="run-history">
              {runs.slice(0, 6).map((r) => (
                <li key={r.id} className="small-text">
                  <Badge tone={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].label}</Badge> {timeAgo(r.startedAt)} · {TRIGGER[r.trigger]} ·{' '}
                  {r.steps.filter((s) => s.status === 'passed').length}/{routine.steps.length} pasos
                  {r.finishedAt ? ` · ${((r.finishedAt - r.startedAt) / 1000).toFixed(1)} s` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <p className="bad-text small-text">{error}</p>}
      <div className="task-actions">
        {running ? (
          <button type="button" className="btn small ghost" onClick={() => void api.stopRoutine()}>
            <Icon name="stop" size={14} /> Detener
          </button>
        ) : (
          <button type="button" className="btn small" disabled={busy} onClick={() => void run()}>
            <Icon name="play" size={14} /> Ejecutar
          </button>
        )}
        {latest?.failureShot && !running && (
          <button type="button" className="btn small ghost" onClick={() => void api.openRunShot(latest.id)}>
            Ver captura del fallo
          </button>
        )}
        <button
          type="button"
          className="btn small ghost"
          disabled={running}
          onClick={() => {
            if (window.confirm(`¿Eliminar la rutina «${routine.name}»?`)) void api.deleteRoutine(routine.id)
          }}
        >
          <Icon name="trash" size={14} /> Eliminar
        </button>
      </div>
    </li>
  )
}

export function Routines({ data }: { data: AppData }) {
  const [text, setText] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { apple, routines, runs } = data
  const running = runs.some((r) => r.status === 'running')
  const canAct = apple.input.trusted || apple.input.backend === 'xdotool'

  const create = async (): Promise<void> => {
    const description = text.trim()
    if (!description) return
    setCreating(true)
    setError(null)
    try {
      await api.createRoutine(description)
      setText('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Rutinas</h1>
          <p className="muted">
            Tareas repetitivas estilo QA. <b>Claude</b> (tu suscripción) las define una vez; después Buddy las repite con <b>Jev</b> y tu teclado y ratón,
            en segundos y sin volver a gastar tu plan. Mientras una rutina actúa, pulsa <kbd>Esc</kbd> o mueve el ratón para detenerla.
          </p>
        </div>
      </header>

      {(!data.jev || !canAct) && (
        <div className="notice">
          {!data.jev && (
            <p>
              Configura <b>Jev</b> en Ajustes para que las comprobaciones tarden menos de un segundo. Sin Jev, cada paso visual se lo pregunta al modelo
              principal (unos segundos y usa tu plan).
            </p>
          )}
          {!canAct && (
            <p>
              {apple.input.detail ?? 'Las rutinas todavía no pueden hacer clics ni escribir en este equipo: solo mirar y señalar.'}{' '}
              {apple.helper === 'ready' && !apple.input.trusted && (
                <button type="button" className="link" onClick={() => void api.requestAccessibility()}>
                  Dar permiso de Accesibilidad
                </button>
              )}
            </p>
          )}
        </div>
      )}

      <div className="launcher">
        <textarea
          value={text}
          rows={3}
          placeholder="Describe la rutina: qué abrir, qué hacer y qué debe verse al final. Por ejemplo: «entra a localhost:3000, inicia sesión y comprueba que aparece el tablero»"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void create()
          }}
        />
        <div className="launcher-foot">
          <div className="ideas">
            {IDEAS.map((idea) => (
              <button key={idea} type="button" className="chip-btn" onClick={() => setText(idea)}>
                {idea}
              </button>
            ))}
          </div>
          <button type="button" className="btn primary" disabled={!text.trim() || creating} onClick={() => void create()}>
            <Icon name="bolt" size={14} /> {creating ? 'Claude la está definiendo…' : 'Crear con Claude'}
          </button>
        </div>
        {error && <p className="bad-text small-text">{error}</p>}
        <p className="muted small-text">
          También por voz: «crea una rutina que…» y luego «ejecuta la rutina …». Para tareas largas en tu pantalla di «hazlo tú: …» y Claude las orquesta con
          las herramientas de Buddy (y puede guardarlas como rutina).
        </p>
      </div>

      {routines.length === 0 ? (
        <div className="empty">
          <p>Todavía no hay rutinas.</p>
        </div>
      ) : (
        <ul className="tasks">
          {routines.map((r) => (
            <RoutineItem key={r.id} routine={r} runs={runs.filter((x) => x.routineId === r.id)} busy={running} />
          ))}
        </ul>
      )}
    </div>
  )
}
