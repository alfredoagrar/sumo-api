import { useEffect, useRef, useState } from 'react'
import { prettyAccelerator } from '../../../shared/accelerator'
import type { BuddyCommand, BuddyState, Settings } from '../../../shared/types'
import { api } from '../common/api'
import {
  FOLLOW_OFFSET,
  arcControl,
  bezier,
  bezierTangent,
  easeInOut,
  flightDuration,
  headingFor,
  lerpAngle,
  type MotionMode,
  type Vec
} from './motion'

interface Flight {
  from: Vec
  control: Vec
  to: Vec
  start: number
  duration: number
}

const RETURN_DELAY_MS = 1800
const ERROR_MS = 6500
const CAPTION_LINGER_MS = 1400

export function Overlay() {
  const buddyRef = useRef<HTMLDivElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLDivElement>(null)

  const cursor = useRef<Vec>({ x: -200, y: -200 })
  const pos = useRef<Vec>({ x: -200, y: -200 })
  const angle = useRef(0)
  const mode = useRef<MotionMode>('follow')
  const flight = useRef<Flight | null>(null)
  const target = useRef<Vec | null>(null)
  const level = useRef(0)
  const returnTimer = useRef<number | null>(null)
  const errorTimer = useRef<number | null>(null)
  const lingerTimer = useRef<number | null>(null)
  const stateRef = useRef<BuddyState>('idle')

  const [active, setActive] = useState(false)
  const [state, setState] = useState<BuddyState>('idle')
  const [text, setText] = useState<string | undefined>()
  const [label, setLabel] = useState<string | null>(null)
  const [pointing, setPointing] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [platform, setPlatform] = useState('darwin')

  useEffect(() => {
    void api.getSettings().then(setSettings)
    void api.getAppInfo().then((info) => setPlatform(info.platform))
    return api.onSettings(setSettings)
  }, [])

  useEffect(
    () =>
      api.onCursor((c) => {
        cursor.current = { x: c.x, y: c.y }
        setActive(c.active)
      }),
    []
  )

  useEffect(() => {
    const clearTimers = (): void => {
      if (returnTimer.current !== null) window.clearTimeout(returnTimer.current)
      returnTimer.current = null
    }
    const flyTo = (to: Vec): void => {
      clearTimers()
      const from = { ...pos.current }
      flight.current = { from, control: arcControl(from, to), to, start: performance.now(), duration: flightDuration(from, to) }
      mode.current = 'flying'
    }
    const goHome = (): void => {
      clearTimers()
      target.current = null
      setLabel(null)
      setPointing(false)
      if (mode.current === 'follow') return
      const from = { ...pos.current }
      const to = { x: cursor.current.x + FOLLOW_OFFSET.x, y: cursor.current.y + FOLLOW_OFFSET.y }
      flight.current = { from, control: arcControl(from, to), to, start: performance.now(), duration: flightDuration(from, to) }
      mode.current = 'returning'
    }

    return api.onBuddy((cmd: BuddyCommand) => {
      switch (cmd.type) {
        case 'state':
          if (errorTimer.current !== null) window.clearTimeout(errorTimer.current)
          if (lingerTimer.current !== null) window.clearTimeout(lingerTimer.current)
          errorTimer.current = null
          lingerTimer.current = null
          if (cmd.state === 'idle' && stateRef.current === 'speaking') {
            // Dejamos el subtítulo visible un instante después de hablar.
            lingerTimer.current = window.setTimeout(() => {
              stateRef.current = 'idle'
              setState('idle')
              setText(undefined)
            }, CAPTION_LINGER_MS)
          } else {
            stateRef.current = cmd.state
            setState(cmd.state)
            setText(cmd.text)
          }
          if (cmd.state === 'listening') level.current = 0
          if (cmd.state === 'idle' && target.current) {
            returnTimer.current = window.setTimeout(goHome, RETURN_DELAY_MS)
          }
          if (cmd.state === 'error') {
            errorTimer.current = window.setTimeout(() => {
              stateRef.current = 'idle'
              setState('idle')
              setText(undefined)
              if (target.current) goHome()
            }, ERROR_MS)
          }
          break
        case 'point':
          target.current = { x: cmd.x, y: cmd.y }
          setLabel(cmd.label || null)
          setPointing(true)
          flyTo({ x: cmd.x, y: cmd.y })
          break
        case 'level':
          level.current = cmd.value
          break
        case 'stop':
          if (lingerTimer.current !== null) window.clearTimeout(lingerTimer.current)
          lingerTimer.current = null
          stateRef.current = 'idle'
          setState('idle')
          setText(undefined)
          goHome()
          break
        case 'hide-for-capture':
          // Ocultamos todo y esperamos dos frames para que no salga en la captura.
          document.body.style.opacity = '0'
          requestAnimationFrame(() => requestAnimationFrame(() => api.sendCaptureReady()))
          break
        case 'show-after-capture':
          document.body.style.opacity = '1'
          break
      }
    })
  }, [])

  // Bucle de animación: posición, rotación y colocación de los globos.
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const tick = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const home = { x: cursor.current.x + FOLLOW_OFFSET.x, y: cursor.current.y + FOLLOW_OFFSET.y }

      if (mode.current === 'follow') {
        const k = 1 - Math.exp(-dt * 22)
        pos.current = { x: pos.current.x + (home.x - pos.current.x) * k, y: pos.current.y + (home.y - pos.current.y) * k }
        if (Math.abs(pos.current.x - home.x) > 600 || Math.abs(pos.current.y - home.y) > 600) pos.current = home
        angle.current = lerpAngle(angle.current, 0, 1 - Math.exp(-dt * 10))
      } else if (flight.current) {
        const f = flight.current
        if (mode.current === 'returning') f.to = home
        const t = Math.min(1, (now - f.start) / f.duration)
        const e = easeInOut(t)
        pos.current = bezier(f.from, f.control, f.to, e)
        // Durante el vuelo mira hacia donde va; al final recupera su forma de cursor.
        const heading = t > 0.7 ? 0 : headingFor(bezierTangent(f.from, f.control, f.to, Math.max(0.02, e)))
        angle.current = lerpAngle(angle.current, heading, 1 - Math.exp(-dt * 14))
        if (t >= 1) {
          flight.current = null
          mode.current = mode.current === 'returning' ? 'follow' : 'pointing'
        }
      } else if (mode.current === 'pointing' && target.current) {
        // Pequeño "toque" sobre el objetivo.
        const bob = Math.sin(now / 260) * 2.2
        pos.current = { x: target.current.x - bob * 0.7, y: target.current.y - bob * 0.7 }
        angle.current = lerpAngle(angle.current, 0, 1 - Math.exp(-dt * 10))
      }

      const buddy = buddyRef.current
      if (buddy) {
        const lv = level.current
        buddy.style.transform = `translate3d(${pos.current.x}px, ${pos.current.y}px, 0) rotate(${angle.current}deg)`
        buddy.style.setProperty('--level', String(lv))
      }

      const vw = window.innerWidth
      const vh = window.innerHeight
      const bubble = bubbleRef.current
      if (bubble) {
        const w = bubble.offsetWidth
        const h = bubble.offsetHeight
        let x = pos.current.x + 30
        let y = pos.current.y + 26
        if (x + w > vw - 12) x = pos.current.x - w - 18
        if (y + h > vh - 12) y = pos.current.y - h - 14
        bubble.style.transform = `translate3d(${Math.max(12, x)}px, ${Math.max(12, y)}px, 0)`
      }
      const lbl = labelRef.current
      if (lbl && target.current) {
        const w = lbl.offsetWidth
        let x = target.current.x + 22
        const y = target.current.y - 38
        if (x + w > vw - 12) x = target.current.x - w - 22
        lbl.style.transform = `translate3d(${Math.max(12, x)}px, ${Math.max(12, y)}px, 0)`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const es = (settings?.language ?? 'es') === 'es'
  const talkKey = settings ? prettyAccelerator(settings.hotkeys.talk, platform) : ''
  const visible = active || pointing

  let bubbleText: string | undefined
  let bubbleKind: 'listening' | 'thinking' | 'speaking' | 'error' | null = null
  if (state === 'listening') {
    bubbleKind = 'listening'
    bubbleText = es ? `Te escucho… (${talkKey} para terminar)` : `Listening… (${talkKey} to finish)`
  } else if (state === 'transcribing') {
    bubbleKind = 'thinking'
    bubbleText = text ?? (es ? 'Transcribiendo…' : 'Transcribing…')
  } else if (state === 'thinking') {
    bubbleKind = 'thinking'
    bubbleText = text ? `“${text}”` : es ? 'Pensando…' : 'Thinking…'
  } else if (state === 'speaking' && text && settings?.showCaptions !== false) {
    bubbleKind = 'speaking'
    bubbleText = text
  } else if (state === 'error' && text) {
    bubbleKind = 'error'
    bubbleText = text
  }

  return (
    <div className={`stage ${visible ? 'is-visible' : ''}`}>
      <div ref={buddyRef} className={`buddy state-${state}`}>
        <div className="buddy-ring" />
        <svg className="buddy-arrow" width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
          <defs>
            <linearGradient id="buddy-fill" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#5AA9FF" />
              <stop offset="100%" stopColor="#4F46E5" />
            </linearGradient>
          </defs>
          <path d="M3 3 L25 11 L14.5 14.5 L11 25 Z" fill="url(#buddy-fill)" stroke="white" strokeWidth="2" strokeLinejoin="round" />
        </svg>
        {(state === 'thinking' || state === 'transcribing') && (
          <div className="buddy-dots">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>

      {bubbleKind && bubbleText && (
        <div ref={bubbleRef} className={`bubble bubble-${bubbleKind}`}>
          {bubbleKind === 'listening' && (
            <span className="meter" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </span>
          )}
          <span className="bubble-text">{bubbleText}</span>
        </div>
      )}

      {pointing && label && (
        <div ref={labelRef} className="target-label">
          {label}
        </div>
      )}
    </div>
  )
}
