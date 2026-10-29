import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Settings } from '../../../shared/types'
import { api } from '../common/api'

export function Prompt() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    void api.getSettings().then(setSettings)
    const offSettings = api.onSettings(setSettings)
    const offShow = api.onPromptShow(() => {
      setValue('')
      requestAnimationFrame(() => inputRef.current?.focus())
    })
    return () => {
      offSettings()
      offShow()
    }
  }, [])

  const es = (settings?.language ?? 'es') === 'es'
  const provider = settings?.provider === 'codex' ? 'ChatGPT' : 'Claude'

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      api.closePrompt()
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      const q = value.trim()
      if (q) void api.askText(q)
      else api.closePrompt()
    }
  }

  return (
    <div className="prompt">
      <div className="bar">
        <svg className="logo" width="22" height="22" viewBox="0 0 30 30" aria-hidden="true">
          <defs>
            <linearGradient id="p-fill" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#5AA9FF" />
              <stop offset="100%" stopColor="#4F46E5" />
            </linearGradient>
          </defs>
          <path d="M3 3 L25 11 L14.5 14.5 L11 25 Z" fill="url(#p-fill)" stroke="white" strokeWidth="2" strokeLinejoin="round" />
        </svg>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={es ? 'Pregúntale algo sobre tu pantalla…' : 'Ask something about your screen…'}
          spellCheck={false}
          autoFocus
        />
        <span className="chip">{provider}</span>
      </div>
      <div className="hint">
        {es ? (
          <>
            <kbd>Enter</kbd> preguntar · <kbd>Esc</kbd> cerrar · empieza con <b>agente:</b> para una tarea en segundo plano
          </>
        ) : (
          <>
            <kbd>Enter</kbd> ask · <kbd>Esc</kbd> close · start with <b>agent:</b> for a background task
          </>
        )}
      </div>
    </div>
  )
}
