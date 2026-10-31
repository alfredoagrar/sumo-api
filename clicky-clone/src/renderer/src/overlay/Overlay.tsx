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
  const hintRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLDivElement>(null)
  const edgeRef = useRef<HTMLDivElement>(null)

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
  const [agents, setAgents] = useState(0)
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
        case 'label':
          if (target.current) setLabel(cmd.label || null)
          break
        case 'unpoint':
          goHome()
          break
        case 'level':
          level.current = cmd.value
          break
        case 'agents':
          setAgents(cmd.running)
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
          // Ocultamos todo (también el brillo del borde) y esperamos dos frames para que no salga en la captura.
          document.body.style.opacity = '0'
          requestAnimationFrame(() => requestAnimationFrame(() => api.sendCaptureReady()))
          break
        case 'show-after-capture':
          document.body.style.opacity = '1'
          break
      }
    })
  }, [])

  // Bucle de animación: posición, rotación y colocación del hint.
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
        const bob = Math.sin(now / 260) * 1.6
        pos.current = { x: target.current.x - bob * 0.7, y: target.current.y - bob * 0.7 }
        angle.current = lerpAngle(angle.current, 0, 1 - Math.exp(-dt * 10))
      }

      const lv = level.current
      const buddy = buddyRef.current
      if (buddy) {
        buddy.style.transform = `translate3d(${pos.current.x}px, ${pos.current.y}px, 0) rotate(${angle.current}deg)`
        buddy.style.setProperty('--level', String(lv))
      }
      edgeRef.current?.style.setProperty('--level', String(lv))

      const vw = window.innerWidth
      const vh = window.innerHeight
      const hint = hintRef.current
      if (hint) {
        const w = hint.offsetWidth
        const h = hint.offsetHeight
        let x = pos.current.x + 18
        let y = pos.current.y + 16
        if (x + w > vw - 10) x = pos.current.x - w - 10
        if (y + h > vh - 10) y = pos.current.y - h - 8
        hint.style.transform = `translate3d(${Math.max(10, x)}px, ${Math.max(10, y)}px, 0)`
      }
      const lbl = labelRef.current
      if (lbl && target.current) {
        const w = lbl.offsetWidth
        let x = target.current.x + 14
        const y = target.current.y - 26
        if (x + w > vw - 10) x = target.current.x - w - 14
        lbl.style.transform = `translate3d(${Math.max(10, x)}px, ${Math.max(10, y)}px, 0)`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const es = (settings?.language ?? 'es') === 'es'
  const talkKey = settings ? prettyAccelerator(settings.hotkeys.talk, platform) : ''
  const visible = active || pointing

  // Hint compacto junto al buddy.
  let hint: { kind: 'listening' | 'working' | 'speaking' | 'error'; text: string } | null = null
  if (state === 'listening') hint = { kind: 'listening', text: es ? 'Escuchando' : 'Listening' }
  else if (state === 'transcribing') hint = { kind: 'working', text: text ?? (es ? 'Transcribiendo…' : 'Transcribing…') }
  else if (state === 'thinking') hint = { kind: 'working', text: text ?? (es ? 'Pensando…' : 'Thinking…') }
  else if (state === 'speaking' && text && settings?.showCaptions !== false) hint = { kind: 'speaking', text }
  else if (state === 'error' && text) hint = { kind: 'error', text }

  // Brillo en el borde: mientras escucha (sigue la voz) y mientras trabaja o habla.
  const glowOn = settings?.screenGlow !== false
  const edge =
    !glowOn ? 'off' : state === 'listening' ? 'listening' : state === 'transcribing' || state === 'thinking' || state === 'speaking' || pointing ? 'working' : 'off'

  return (
    <>
      <div ref={edgeRef} className={`edge edge-${edge}`} aria-hidden="true" />
      <div className={`stage ${visible ? 'is-visible' : ''}`}>
        <div ref={buddyRef} className={`buddy state-${state}`}>
          <div className="buddy-ring" />
          <svg className="buddy-arrow" width="18" height="18" viewBox="0 0 30 30" aria-hidden="true">
            <path d="M3 3 L25 11 L14.5 14.5 L11 25 Z" strokeWidth="2.6" strokeLinejoin="round" />
          </svg>
          {agents > 0 && <span className="agents-dot" title={es ? `${agents} agente(s) trabajando` : `${agents} agent(s) working`} />}
        </div>

        {hint && (
          <div ref={hintRef} className={`hint hint-${hint.kind}`}>
            {hint.kind === 'listening' && (
              <span className="meter" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            )}
            {hint.kind === 'working' && (
              <span className="dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            )}
            <span className="hint-text">{hint.text}</span>
            {hint.kind === 'listening' && talkKey && <kbd>{talkKey}</kbd>}
          </div>
        )}

        {pointing && label && (
          <div ref={labelRef} className="target-label">
            {label}
          </div>
        )}
      </div>
    </>
  )
}
