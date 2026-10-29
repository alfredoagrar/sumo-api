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
        <svg className="logo" width="15" height="15" viewBox="0 0 30 30" aria-hidden="true">
          <path d="M3 3 L25 11 L14.5 14.5 L11 25 Z" fill="#4F8DFF" stroke="white" strokeWidth="2.6" strokeLinejoin="round" />
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
            <kbd>↩</kbd> preguntar · <kbd>Esc</kbd> cerrar · <b>agente:</b> tarea en segundo plano
          </>
        ) : (
          <>
            <kbd>↩</kbd> ask · <kbd>Esc</kbd> close · <b>agent:</b> background task
          </>
        )}
      </div>
    </div>
  )
}
