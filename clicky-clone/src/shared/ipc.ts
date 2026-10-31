// Nombres de los canales IPC. Un solo lugar para que main y preload no se desincronicen.

export const IPC = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsChanged: 'settings:changed',

  providersStatus: 'providers:status',
  providersTest: 'providers:test',
  providersLogin: 'providers:login',

  historyGet: 'history:get',
  historyClear: 'history:clear',
  historyChanged: 'history:changed',

  agentsList: 'agents:list',
  agentsStart: 'agents:start',
  agentsCancel: 'agents:cancel',
  agentsOpen: 'agents:open',
  agentsChanged: 'agents:changed',

  hotkeysStatus: 'hotkeys:status',
  hotkeysChanged: 'hotkeys:changed',
  permissionsGet: 'permissions:get',
  permissionsOpen: 'permissions:open',
  appInfo: 'app:info',
  openExternal: 'app:open-external',

  askText: 'ask:text',
  promptClose: 'prompt:close',
  promptShow: 'prompt:show',

  jevStatus: 'jev:status',
  jevSetKey: 'jev:set-key',
  jevTest: 'jev:test',

  sttStatusGet: 'stt:status:get',
  sttStatusChanged: 'stt:status:changed',

  cursor: 'overlay:cursor',
  buddy: 'overlay:buddy',
  captureReady: 'overlay:capture-ready',

  voice: 'voice:command',
  speech: 'voice:speech',
  transcript: 'voice:transcript',
  voiceError: 'voice:error',
  voiceLevel: 'voice:level',
  voiceStopped: 'voice:stopped',
  sttStatus: 'voice:stt-status',
  speechDone: 'voice:speech-done'
} as const
