import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { prettyAccelerator } from '../../../shared/accelerator'

export function BuddyMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 30 30" aria-hidden="true" className="buddy-mark">
      <defs>
        <linearGradient id={`bm-${size}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#5AA9FF" />
          <stop offset="100%" stopColor="#4F46E5" />
        </linearGradient>
      </defs>
      <path d="M3 3 L25 11 L14.5 14.5 L11 25 Z" fill={`url(#bm-${size})`} stroke="white" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  )
}

export function Card({ title, subtitle, children, actions }: { title?: ReactNode; subtitle?: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h3>{title}</h3>}
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral'

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="row toggle-row">
      <span className="row-text">
        <span>{label}</span>
        {hint && <small className="muted">{hint}</small>}
      </span>
      <button type="button" role="switch" aria-checked={checked} className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
        <span />
      </button>
    </label>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="row">
      <span className="row-text">
        <span>{label}</span>
        {hint && <small className="muted">{hint}</small>}
      </span>
      <div className="row-control">{children}</div>
    </div>
  )
}

/** Input de texto que guarda al salir del campo o al pulsar Enter. */
export function TextSetting({ value, onSave, placeholder, mono }: { value: string; onSave: (v: string) => void; placeholder?: string; mono?: boolean }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = (): void => {
    if (draft.trim() !== value) onSave(draft.trim())
  }
  return (
    <input
      className={`input ${mono ? 'mono' : ''}`}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

const CODE_KEYS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Period: '.',
  Comma: ',',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right'
}

/** Convierte una pulsación en un acelerador de Electron, o null si no es válida. */
export function acceleratorFromEvent(e: KeyboardEvent, platform: string): string | null {
  const mac = platform === 'darwin'
  let key: string | undefined
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5)
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) key = e.code
  else key = CODE_KEYS[e.code]
  if (!key) return null
  const mods: string[] = []
  if (mac ? e.metaKey : e.ctrlKey) mods.push('CommandOrControl')
  if (mac && e.ctrlKey) mods.push('Control')
  if (!mac && e.metaKey) mods.push('Super')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  const isFn = /^F\d+$/.test(key)
  if (!isFn && mods.length === 0) return null
  if (!isFn && mods.length === 1 && mods[0] === 'Shift') return null
  return [...mods, key].join('+')
}

export function HotkeyInput({ value, platform, ok, onSave }: { value: string; platform: string; ok: boolean; onSave: (v: string) => void }) {
  const [recording, setRecording] = useState(false)
  return (
    <div className="hotkey">
      <button
        type="button"
        className={`kbd-button ${recording ? 'recording' : ''} ${!ok && !recording ? 'invalid' : ''}`}
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          if (!recording) return
          e.preventDefault()
          if (e.key === 'Escape') {
            setRecording(false)
            return
          }
          const acc = acceleratorFromEvent(e, platform)
          if (acc) {
            onSave(acc)
            setRecording(false)
          }
        }}
      >
        {recording ? 'Pulsa la combinación…' : value ? prettyAccelerator(value, platform) : 'Sin atajo'}
      </button>
      {!ok && !recording && <small className="bad-text">No se pudo registrar (¿lo usa otra app?)</small>}
    </div>
  )
}

export function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 45) return 'hace un momento'
  const m = Math.round(s / 60)
  if (m < 60) return `hace ${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `hace ${h} h`
  return new Date(ts).toLocaleDateString()
}

const ICONS: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  chat: 'M4 5h16v11H8l-4 4z',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
  gear: 'M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.5 7.5 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 1.7-1l2.4 1 2-3.4z',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  folder: 'M3 6h6l2 2h10v11H3z',
  play: 'M7 5v14l11-7z',
  stop: 'M6 6h12v12H6z',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13'
}

export function Icon({ name, size = 16 }: { name: keyof typeof ICONS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name] ?? ''} />
    </svg>
  )
}
