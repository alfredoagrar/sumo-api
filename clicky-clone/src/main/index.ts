import { app, ipcMain, Notification, session, shell, systemPreferences, type IpcMainInvokeEvent } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import type {
  AgentTask,
  BuddyCommand,
  DeepPartial,
  HotkeyStatus,
  PermissionStatus,
  ProviderId,
  Settings,
  SttStatus
} from '../shared/types'
import { AgentManager } from './agents'
import { Assistant } from './assistant'
import { screenPermission } from './capture'
import { loadLoginShellPath } from './cli'
import { registerHotkeys } from './hotkeys'
import { APP_ORIGIN, handleAppProtocol, registerAppScheme } from './protocol'
import { openLogin, providers } from './providers'
import { SettingsStore } from './settings'
import { AppTray } from './tray'
import { OverlayManager, PanelWindow, PromptWindow, VoiceWindow } from './windows'

app.setName('Buddy')
registerAppScheme()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void main()
}

function isTrustedSender(e: IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  const url = e.senderFrame?.url ?? ''
  const dev = process.env.ELECTRON_RENDERER_URL
  return url.startsWith(`${APP_ORIGIN}/`) || Boolean(!app.isPackaged && dev && url.startsWith(dev))
}

/** ipcMain.handle que ignora mensajes de páginas que no son nuestras. */
function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!isTrustedSender(e)) throw new Error('Origen no permitido')
    return fn(...(args as A))
  })
}

function on<A extends unknown[]>(channel: string, fn: (...args: A) => void): void {
  ipcMain.on(channel, (e, ...args) => {
    if (isTrustedSender(e)) fn(...(args as A))
  })
}

async function main(): Promise<void> {
  // Cargamos el PATH del shell en paralelo con el arranque de Electron.
  const pathReady = loadLoginShellPath().catch(() => undefined)
  await app.whenReady()
  await pathReady

  handleAppProtocol(join(__dirname, '../renderer'))

  // Solo concedemos el micrófono (para el dictado local) a nuestras propias páginas.
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = details.requestingUrl ?? wc.getURL()
    const ours = origin.startsWith(APP_ORIGIN) || (!app.isPackaged && origin.startsWith(process.env.ELECTRON_RENDERER_URL ?? '\0'))
    callback(ours && (permission === 'media' || permission === 'speaker-selection'))
  })
  ses.setPermissionCheckHandler((_wc, permission, origin) => {
    const ours = origin.startsWith(APP_ORIGIN) || (!app.isPackaged && origin.startsWith(process.env.ELECTRON_RENDERER_URL ?? '\0'))
    return ours && (permission === 'media' || permission === 'speaker-selection')
  })

  if (process.platform === 'darwin') app.dock?.hide()

  const settings = new SettingsStore()
  mkdirSync(settings.get().agents.workspaceDir, { recursive: true })

  const overlays = new OverlayManager()
  const panel = new PanelWindow()
  const prompt = new PromptWindow()
  const voice = new VoiceWindow()
  const agents = new AgentManager(settings)
  const assistant = new Assistant({ settings, overlays, prompt, voice, agents })

  overlays.start()

  const talk = async (): Promise<void> => {
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      const ok = await systemPreferences.askForMediaAccess('microphone')
      if (!ok) {
        panel.show()
        return
      }
    }
    assistant.toggleTalk()
  }

  const handlers = {
    talk: () => void talk(),
    type: () => assistant.openTypedPrompt(),
    panel: () => panel.toggle()
  }

  let hotkeyStatus: HotkeyStatus = registerHotkeys(settings.get(), handlers)

  const tray = new AppTray({
    talk: handlers.talk,
    type: handlers.type,
    panel: () => panel.show(),
    setProvider: (id) => settings.update({ provider: id }),
    quit: () => {
      panel.quitting = true
      app.quit()
    }
  })
  tray.update(settings.get())

  settings.on('change', (next: Settings, prev: Settings) => {
    if (JSON.stringify(next.hotkeys) !== JSON.stringify(prev.hotkeys)) {
      hotkeyStatus = registerHotkeys(next, handlers)
      panel.send(IPC.hotkeysChanged, hotkeyStatus)
    }
    if (next.launchAtLogin !== prev.launchAtLogin && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: next.launchAtLogin })
    }
    if (next.agents.workspaceDir !== prev.agents.workspaceDir) {
      mkdirSync(next.agents.workspaceDir, { recursive: true })
    }
    tray.update(next)
    panel.send(IPC.settingsChanged, next)
    overlays.broadcast(IPC.settingsChanged, next)
    voice.send(IPC.settingsChanged, next)
  })

  assistant.on('history', (h) => panel.send(IPC.historyChanged, h))
  assistant.on('stt', (status) => panel.send(IPC.sttStatusChanged, status))
  // El buddy muestra un punto discreto mientras haya agentes trabajando.
  let runningAgents = 0
  agents.on('change', (tasks: AgentTask[]) => {
    panel.send(IPC.agentsChanged, tasks)
    const running = tasks.filter((t) => t.status === 'running').length
    if (running !== runningAgents) {
      runningAgents = running
      overlays.broadcast(IPC.buddy, { type: 'agents', running } satisfies BuddyCommand)
    }
  })
  agents.on('finished', (task) => {
    const s = settings.get()
    const es = s.language === 'es'
    const title = task.status === 'done' ? (es ? 'Tarea terminada' : 'Task finished') : es ? 'La tarea no terminó' : 'Task did not finish'
    if (Notification.isSupported()) {
      const n = new Notification({ title: `${title}: ${task.title}`, body: (task.result ?? '').slice(0, 240) })
      n.on('click', () => panel.show())
      n.show()
    }
    if (s.agents.announce && task.status !== 'cancelled') {
      const summary = (task.result ?? '').slice(0, 300)
      assistant.announce(
        task.status === 'done'
          ? `${es ? 'Terminé' : 'I finished'}: ${task.title}. ${summary}`
          : `${es ? 'No pude terminar' : "I couldn't finish"}: ${task.title}. ${summary}`
      )
    }
  })

  // ---- IPC ----------------------------------------------------------------------------------
  handle(IPC.settingsGet, () => settings.get())
  handle(IPC.settingsSet, (patch: DeepPartial<Settings>) => settings.update(patch))

  handle(IPC.providersStatus, () => Promise.all([providers.claude.status(settings.get()), providers.codex.status(settings.get())]))
  handle(IPC.providersTest, (id: ProviderId) => assistant.testProvider(id))
  handle(IPC.providersLogin, (id: ProviderId) => openLogin(id, settings.get()[id].binary))

  handle(IPC.historyGet, () => assistant.getHistory())
  handle(IPC.historyClear, () => assistant.clearHistory())

  handle(IPC.agentsList, () => agents.list())
  handle(IPC.agentsStart, (text: string) => agents.start(String(text).slice(0, 4000), null))
  handle(IPC.agentsCancel, (id: string) => agents.cancel(id))
  handle(IPC.agentsOpen, async (id: string) => {
    const task = agents.get(id)
    if (task && existsSync(task.workdir)) await shell.openPath(task.workdir)
  })

  handle(IPC.hotkeysStatus, () => hotkeyStatus)
  handle(IPC.permissionsGet, (): PermissionStatus => ({
    platform: process.platform,
    microphone: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'granted',
    screen: screenPermission()
  }))
  handle(IPC.permissionsOpen, async (kind: 'microphone' | 'screen') => {
    if (process.platform === 'darwin') {
      const pane = kind === 'microphone' ? 'Privacy_Microphone' : 'Privacy_ScreenCapture'
      await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`)
    } else if (process.platform === 'win32') {
      await shell.openExternal(kind === 'microphone' ? 'ms-settings:privacy-microphone' : 'ms-settings:privacy')
    }
  })
  handle(IPC.appInfo, () => ({ version: app.getVersion(), platform: process.platform, userData: app.getPath('userData') }))
  handle(IPC.openExternal, async (url: string) => {
    if (/^https:\/\//i.test(url)) await shell.openExternal(url)
  })

  handle(IPC.askText, (question: string) => assistant.askText(String(question).slice(0, 4000)))
  on(IPC.promptClose, () => prompt.hide())

  handle(IPC.sttStatusGet, () => assistant.getSttStatus())

  on(IPC.captureReady, () => assistant.onCaptureReady())
  on(IPC.transcript, (text: string) => assistant.onTranscript(String(text)))
  on(IPC.voiceError, (message: string) => assistant.onVoiceError(String(message)))
  on(IPC.voiceLevel, (level: number) => assistant.onVoiceLevel(Number(level) || 0))
  on(IPC.voiceStopped, () => assistant.onVoiceStopped())
  on(IPC.sttStatus, (status: SttStatus) => assistant.onSttStatus(status))
  on(IPC.speechDone, () => assistant.onSpeechDone())

  // ---- Ciclo de vida --------------------------------------------------------------------------
  app.on('second-instance', () => panel.show())
  app.on('activate', () => panel.show())
  app.on('window-all-closed', () => {
    // Buddy vive en la barra de menú / bandeja: no salimos al cerrar ventanas.
  })
  app.on('before-quit', () => {
    panel.quitting = true
    agents.cancelAll()
    overlays.stop()
    voice.destroy()
  })

  if (!settings.get().onboarded || process.argv.includes('--show-panel')) panel.show()
}
