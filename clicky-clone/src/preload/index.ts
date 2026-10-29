import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/ipc'
import type { BuddyApi } from '../shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: BuddyApi = {
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
  onSettings: (cb) => subscribe(IPC.settingsChanged, cb),

  getProviderStatus: () => ipcRenderer.invoke(IPC.providersStatus),
  testProvider: (id) => ipcRenderer.invoke(IPC.providersTest, id),
  openLogin: (id) => ipcRenderer.invoke(IPC.providersLogin, id),

  getHistory: () => ipcRenderer.invoke(IPC.historyGet),
  clearHistory: () => ipcRenderer.invoke(IPC.historyClear),
  onHistory: (cb) => subscribe(IPC.historyChanged, cb),

  listAgents: () => ipcRenderer.invoke(IPC.agentsList),
  startAgent: (prompt) => ipcRenderer.invoke(IPC.agentsStart, prompt),
  cancelAgent: (id) => ipcRenderer.invoke(IPC.agentsCancel, id),
  openAgentFolder: (id) => ipcRenderer.invoke(IPC.agentsOpen, id),
  onAgents: (cb) => subscribe(IPC.agentsChanged, cb),

  getHotkeyStatus: () => ipcRenderer.invoke(IPC.hotkeysStatus),
  onHotkeyStatus: (cb) => subscribe(IPC.hotkeysChanged, cb),
  getPermissions: () => ipcRenderer.invoke(IPC.permissionsGet),
  openPermissionSettings: (kind) => ipcRenderer.invoke(IPC.permissionsOpen, kind),
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),

  askText: (question) => ipcRenderer.invoke(IPC.askText, question),
  closePrompt: () => ipcRenderer.send(IPC.promptClose),
  onPromptShow: (cb) => subscribe(IPC.promptShow, cb),

  getSttStatus: () => ipcRenderer.invoke(IPC.sttStatusGet),
  onSttStatus: (cb) => subscribe(IPC.sttStatusChanged, cb),

  onCursor: (cb) => subscribe(IPC.cursor, cb),
  onBuddy: (cb) => subscribe(IPC.buddy, cb),
  sendCaptureReady: () => ipcRenderer.send(IPC.captureReady),

  onVoice: (cb) => subscribe(IPC.voice, cb),
  onSpeech: (cb) => subscribe(IPC.speech, cb),
  sendTranscript: (text) => ipcRenderer.send(IPC.transcript, text),
  sendVoiceError: (message) => ipcRenderer.send(IPC.voiceError, message),
  sendVoiceLevel: (level) => ipcRenderer.send(IPC.voiceLevel, level),
  sendVoiceStopped: () => ipcRenderer.send(IPC.voiceStopped),
  sendSttStatus: (status) => ipcRenderer.send(IPC.sttStatus, status),
  sendSpeechDone: () => ipcRenderer.send(IPC.speechDone)
}

contextBridge.exposeInMainWorld('buddy', api)
