import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type BoostlineApi } from '@shared/ipc'

const invoke =
  <K extends keyof typeof IPC>(key: K) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(IPC[key], ...args)

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: BoostlineApi = {
  platform: process.platform,
  appInfo: invoke('appInfo'),
  getSettings: invoke('getSettings'),
  saveSettings: invoke('saveSettings'),
  getPresets: invoke('getPresets'),
  savePresets: invoke('savePresets'),
  adapterOptions: invoke('adapterOptions'),
  connect: invoke('connect'),
  disconnect: invoke('disconnect'),
  status: invoke('status'),
  channels: invoke('channels'),
  setStreamChannels: invoke('setStreamChannels'),
  startLive: invoke('startLive'),
  stopLive: invoke('stopLive'),
  startRecording: invoke('startRecording'),
  stopRecording: invoke('stopRecording'),
  runProbe: invoke('runProbe'),
  bmwDataStatus: invoke('bmwDataStatus'),
  bmwDataDownload: invoke('bmwDataDownload'),
  bmwDataImportFile: invoke('bmwDataImportFile'),
  bmwDataClear: invoke('bmwDataClear'),
  onBmwDataProgress: (cb) => subscribe(IPC.evBmwDataProgress, cb),
  onStatus: (cb) => subscribe(IPC.evStatus, cb),
  onChannels: (cb) => subscribe(IPC.evChannels, cb),
  onLiveBatch: (cb) => subscribe(IPC.evLiveBatch, cb),
  openLogDialog: invoke('openLogDialog'),
  openLogsDialog: invoke('openLogsDialog'),
  copyText: invoke('copyText'),
  readFile: invoke('readFile'),
  listLogs: invoke('listLogs'),
  saveTextDialog: invoke('saveTextDialog'),
  savePngDialog: invoke('savePngDialog'),
  openJsonDialog: invoke('openJsonDialog'),
  saveRun: invoke('saveRun'),
  listRuns: invoke('listRuns'),
  loadRun: invoke('loadRun'),
  deleteRun: invoke('deleteRun'),
  showInFolder: invoke('showInFolder'),
  openDataDir: invoke('openDataDir'),
  chooseDataDir: invoke('chooseDataDir'),
  windowControl: (action) => ipcRenderer.send(IPC.windowControl, action),
  onMaximized: (cb) => subscribe(IPC.evMaximized, cb)
} as BoostlineApi

contextBridge.exposeInMainWorld('boostline', api)
