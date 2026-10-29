import { api } from '../../common/api'
import type { AppData } from '../App'
import { Badge, Icon, timeAgo } from '../components'

export function Conversations({ data }: { data: AppData }) {
  const turns = [...data.history].reverse()
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Conversaciones</h1>
          <p className="muted">Lo que le has preguntado a Buddy. Las últimas respuestas se usan como contexto durante 10 minutos.</p>
        </div>
        {turns.length > 0 && (
          <button type="button" className="btn ghost small" onClick={() => void api.clearHistory()}>
            <Icon name="trash" size={14} /> Borrar
          </button>
        )}
      </header>

      {turns.length === 0 ? (
        <div className="empty">
          <p>Aún no hay conversaciones.</p>
          <p className="muted">Pulsa tu atajo de voz y pregúntale algo a Buddy sobre tu pantalla.</p>
        </div>
      ) : (
        <ul className="turns">
          {turns.map((t) => (
            <li key={t.id} className={`turn ${t.error ? 'is-error' : ''}`}>
              <div className="turn-q">{t.question}</div>
              <div className="turn-a">{t.answer}</div>
              <div className="turn-meta">
                <Badge tone={t.provider === 'claude' ? 'info' : 'neutral'}>{t.provider === 'claude' ? 'Claude' : 'ChatGPT'}</Badge>
                {t.pointed && <Badge tone="ok">Señaló: {t.pointed}</Badge>}
                {t.error && <Badge tone="bad">Error</Badge>}
                <span className="muted">{timeAgo(t.at)}</span>
                {t.ms > 0 && <span className="muted">{(t.ms / 1000).toFixed(1)} s</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
