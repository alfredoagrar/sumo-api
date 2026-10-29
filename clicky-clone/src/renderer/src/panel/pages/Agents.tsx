import { useState } from 'react'
import type { AgentTask } from '../../../../shared/types'
import { api } from '../../common/api'
import type { AppData } from '../App'
import { Badge, Icon, timeAgo, type Tone } from '../components'

const STATUS: Record<AgentTask['status'], { label: string; tone: Tone }> = {
  running: { label: 'Trabajando', tone: 'info' },
  done: { label: 'Terminada', tone: 'ok' },
  error: { label: 'Falló', tone: 'bad' },
  cancelled: { label: 'Cancelada', tone: 'neutral' }
}

const IDEAS = [
  'Investiga los 5 mejores editores de video gratuitos y haz una tabla comparativa',
  'Escribe un borrador de correo para pedir un aumento, tono profesional',
  'Crea una página HTML de una sola pantalla con un temporizador Pomodoro'
]

function TaskItem({ task }: { task: AgentTask }) {
  const [open, setOpen] = useState(task.status === 'running')
  const st = STATUS[task.status]
  const elapsed = Math.round(((task.finishedAt ?? Date.now()) - task.startedAt) / 1000)
  return (
    <li className={`task task-${task.status}`}>
      <button type="button" className="task-head" onClick={() => setOpen(!open)}>
        <span className={`dot dot-${st.tone} ${task.status === 'running' ? 'pulse' : ''}`} />
        <span className="task-title">{task.title}</span>
        <Badge tone={st.tone}>{st.label}</Badge>
        <span className="muted small-text">
          {task.provider === 'claude' ? 'Claude' : 'ChatGPT'} · {timeAgo(task.startedAt)} · {elapsed < 60 ? `${elapsed} s` : `${Math.round(elapsed / 60)} min`}
        </span>
      </button>
      {task.result && task.status !== 'running' && <p className="task-result">{task.result}</p>}
      {open && (
        <ol className="task-log">
          {task.events.map((e, i) => (
            <li key={i} className={`log-${e.kind}`}>
              {e.text}
            </li>
          ))}
        </ol>
      )}
      <div className="task-actions">
        {task.status === 'running' && (
          <button type="button" className="btn small ghost" onClick={() => void api.cancelAgent(task.id)}>
            <Icon name="stop" size={14} /> Detener
          </button>
        )}
        <button type="button" className="btn small ghost" onClick={() => void api.openAgentFolder(task.id)}>
          <Icon name="folder" size={14} /> Abrir carpeta
        </button>
      </div>
    </li>
  )
}

export function Agents({ data }: { data: AppData }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const launch = async (): Promise<void> => {
    const prompt = text.trim()
    if (!prompt) return
    setBusy(true)
    try {
      await api.startAgent(prompt)
      setText('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Agentes</h1>
          <p className="muted">
            Tareas largas que Buddy hace en segundo plano con tu suscripción mientras sigues trabajando. Cada tarea tiene su carpeta en{' '}
            <code className="code inline">{data.settings.agents.workspaceDir}</code>.
          </p>
        </div>
      </header>

      <div className="launcher">
        <textarea
          value={text}
          rows={3}
          placeholder="¿Qué quieres que haga? Por ejemplo: «investiga vuelos baratos a Madrid en marzo y resúmelos en un documento»"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void launch()
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
          <button type="button" className="btn primary" disabled={!text.trim() || busy} onClick={() => void launch()}>
            <Icon name="bolt" size={14} /> Lanzar agente
          </button>
        </div>
        <p className="muted small-text">
          También puedes decirlo en voz alta: «agente, investiga…». Con Claude, el agente puede leer, escribir y buscar en la web
          {data.settings.agents.allowShell ? ' y ejecutar comandos' : ''}; con ChatGPT, Codex trabaja en un entorno aislado dentro de la carpeta.
        </p>
      </div>

      {data.agents.length === 0 ? (
        <div className="empty">
          <p>Todavía no hay tareas.</p>
        </div>
      ) : (
        <ul className="tasks">
          {data.agents.map((t) => (
            <TaskItem key={t.id} task={t} />
          ))}
        </ul>
      )}
    </div>
  )
}
