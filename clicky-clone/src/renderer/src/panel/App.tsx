import { useCallback, useEffect, useState } from 'react'
import type { AgentTask, AppInfo, ChatTurn, DeepPartial, HotkeyStatus, PermissionStatus, ProviderStatus, Settings, SttStatus } from '../../../shared/types'
import { api } from '../common/api'
import { BuddyMark, Icon } from './components'
import { Agents } from './pages/Agents'
import { Conversations } from './pages/Conversations'
import { Home } from './pages/Home'
import { SettingsPage } from './pages/SettingsPage'

export type PageId = 'home' | 'chats' | 'agents' | 'settings'

export interface AppData {
  settings: Settings
  save: (patch: DeepPartial<Settings>) => Promise<void>
  info: AppInfo
  statuses: ProviderStatus[] | null
  refreshStatuses: () => void
  hotkeys: HotkeyStatus
  permissions: PermissionStatus | null
  refreshPermissions: () => void
  stt: SttStatus
  history: ChatTurn[]
  agents: AgentTask[]
  go: (page: PageId) => void
}

const NAV: { id: PageId; label: string; icon: string }[] = [
  { id: 'home', label: 'Inicio', icon: 'home' },
  { id: 'chats', label: 'Conversaciones', icon: 'chat' },
  { id: 'agents', label: 'Agentes', icon: 'bolt' },
  { id: 'settings', label: 'Ajustes', icon: 'gear' }
]

export function App() {
  const [page, setPage] = useState<PageId>('home')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [statuses, setStatuses] = useState<ProviderStatus[] | null>(null)
  const [hotkeys, setHotkeys] = useState<HotkeyStatus>({ talk: true, type: true, panel: true })
  const [permissions, setPermissions] = useState<PermissionStatus | null>(null)
  const [stt, setStt] = useState<SttStatus>({ state: 'idle' })
  const [history, setHistory] = useState<ChatTurn[]>([])
  const [agents, setAgents] = useState<AgentTask[]>([])

  const refreshStatuses = useCallback(() => {
    setStatuses(null)
    void api.getProviderStatus().then(setStatuses)
  }, [])
  const refreshPermissions = useCallback(() => void api.getPermissions().then(setPermissions), [])

  useEffect(() => {
    void api.getSettings().then(setSettings)
    void api.getAppInfo().then(setInfo)
    void api.getHotkeyStatus().then(setHotkeys)
    void api.getSttStatus().then(setStt)
    void api.getHistory().then(setHistory)
    void api.listAgents().then(setAgents)
    refreshStatuses()
    refreshPermissions()
    const offs = [
      api.onSettings(setSettings),
      api.onHotkeyStatus(setHotkeys),
      api.onSttStatus(setStt),
      api.onHistory(setHistory),
      api.onAgents(setAgents)
    ]
    const onFocus = (): void => refreshPermissions()
    window.addEventListener('focus', onFocus)
    return () => {
      offs.forEach((off) => off())
      window.removeEventListener('focus', onFocus)
    }
  }, [refreshStatuses, refreshPermissions])

  if (!settings || !info) return <div className="loading">Cargando…</div>

  const data: AppData = {
    settings,
    save: async (patch) => {
      setSettings(await api.setSettings(patch))
    },
    info,
    statuses,
    refreshStatuses,
    hotkeys,
    permissions,
    refreshPermissions,
    stt,
    history,
    agents,
    go: setPage
  }

  const running = agents.filter((a) => a.status === 'running').length

  return (
    <div className={`app platform-${info.platform}`}>
      <aside className="sidebar">
        <div className="brand">
          <BuddyMark size={26} />
          <div>
            <strong>Buddy</strong>
            <small className="muted">tu compañero junto al cursor</small>
          </div>
        </div>
        <nav>
          {NAV.map((n) => (
            <button key={n.id} type="button" className={`nav-item ${page === n.id ? 'active' : ''}`} onClick={() => setPage(n.id)}>
              <Icon name={n.icon} />
              {n.label}
              {n.id === 'agents' && running > 0 && <span className="nav-count">{running}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot muted">
          <span>v{info.version}</span>
          <span>{settings.provider === 'claude' ? 'Claude' : 'ChatGPT'}</span>
        </div>
      </aside>
      <main className="content">
        {page === 'home' && <Home data={data} />}
        {page === 'chats' && <Conversations data={data} />}
        {page === 'agents' && <Agents data={data} />}
        {page === 'settings' && <SettingsPage data={data} />}
      </main>
    </div>
  )
}
