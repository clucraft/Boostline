import type {
  AdapterOption,
  AppSettings,
  ChannelDef,
  ChannelPreset,
  ConnectionStatus,
  ConnectOptions,
  DragProfile,
  LayoutPreset,
  LiveBatch,
  RecordingInfo,
  SavedDragRun,
  SavedDynoRun
} from './types'

export interface AppInfo {
  version: string
  platform: string
  dataDir: string
}

export interface Presets {
  channels: ChannelPreset[]
  layouts: LayoutPreset[]
  dragProfiles: DragProfile[]
}

export interface FileEntry {
  name: string
  path: string
  size: number
  mtime: number
}

export interface OpenedFile {
  name: string
  path: string
  text: string
}

export type RunKind = 'dyno' | 'drag'

export interface RunEntry {
  id: string
  name: string
  createdAt: string
  path: string
}

/** Connection diagnostics result (see src/main/vehicle/probe.ts). */
export interface ProbeResult {
  summary: string
  report: unknown
  capturePath?: string
}

/** Imported BMW DME measurement data (see src/main/bmwdata). */
export interface BmwDataSummary {
  source: string
  importedAt: string
  dmes: { sgbd: string; name: string; engines: string[]; chassis: string[]; measurements: number; autoDetect: boolean }[]
}

export interface BmwDataProgress {
  phase: 'release' | 'download' | 'verify' | 'unpack' | 'import' | 'done'
  received?: number
  total?: number
}

/** API exposed to the renderer as `window.boostline` by the preload script. */
export interface BoostlineApi {
  /** process.platform of the app ('win32', 'darwin', ...). */
  readonly platform: string
  appInfo(): Promise<AppInfo>

  getSettings(): Promise<AppSettings>
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  getPresets(): Promise<Presets>
  savePresets(presets: Presets): Promise<void>

  adapterOptions(): Promise<AdapterOption[]>
  connect(opts: ConnectOptions): Promise<ConnectionStatus>
  disconnect(): Promise<void>
  status(): Promise<ConnectionStatus>
  channels(): Promise<ChannelDef[]>
  /** Channels the renderer wants sampled (live tiles ∪ live graphs ∪ dyno/drag needs). */
  setStreamChannels(ids: string[]): Promise<void>
  startLive(): Promise<void>
  stopLive(): Promise<void>
  startRecording(): Promise<RecordingInfo>
  stopRecording(): Promise<string | null>
  runProbe(opts: ConnectOptions): Promise<ProbeResult>

  bmwDataStatus(): Promise<BmwDataSummary | null>
  /** Downloads the latest bmw-unified-db release and imports its DME tables. */
  bmwDataDownload(): Promise<BmwDataSummary>
  /** Imports from a local bmw.sqlite / bmw.sqlite.gz chosen in a file dialog. */
  bmwDataImportFile(): Promise<BmwDataSummary | null>
  bmwDataClear(): Promise<void>
  onBmwDataProgress(cb: (p: BmwDataProgress) => void): () => void

  onStatus(cb: (s: ConnectionStatus) => void): () => void
  onChannels(cb: (c: ChannelDef[]) => void): () => void
  onLiveBatch(cb: (b: LiveBatch) => void): () => void

  openLogDialog(): Promise<OpenedFile | null>
  /** Multi-select log picker (heatmap sources). */
  openLogsDialog(): Promise<OpenedFile[]>
  copyText(text: string): Promise<void>
  readFile(path: string): Promise<OpenedFile>
  listLogs(): Promise<FileEntry[]>
  saveTextDialog(defaultName: string, text: string, ext: 'csv' | 'json'): Promise<string | null>
  savePngDialog(defaultName: string, dataUrl: string): Promise<string | null>
  openJsonDialog(title: string): Promise<OpenedFile | null>

  saveRun(kind: RunKind, run: SavedDynoRun | SavedDragRun): Promise<string>
  listRuns(kind: RunKind): Promise<RunEntry[]>
  loadRun(kind: RunKind, id: string): Promise<SavedDynoRun | SavedDragRun | null>
  deleteRun(kind: RunKind, id: string): Promise<void>

  showInFolder(path: string): Promise<void>
  openDataDir(): Promise<void>
  chooseDataDir(): Promise<string | null>

  windowControl(action: 'minimize' | 'maximize' | 'close'): void
  onMaximized(cb: (maximized: boolean) => void): () => void
}

export const IPC = {
  appInfo: 'app:info',
  getSettings: 'settings:get',
  saveSettings: 'settings:save',
  getPresets: 'presets:get',
  savePresets: 'presets:save',
  adapterOptions: 'conn:adapters',
  connect: 'conn:connect',
  disconnect: 'conn:disconnect',
  status: 'conn:status',
  channels: 'conn:channels',
  setStreamChannels: 'live:set-channels',
  startLive: 'live:start',
  stopLive: 'live:stop',
  startRecording: 'rec:start',
  stopRecording: 'rec:stop',
  runProbe: 'conn:probe',
  bmwDataStatus: 'bmw:status',
  bmwDataDownload: 'bmw:download',
  bmwDataImportFile: 'bmw:import-file',
  bmwDataClear: 'bmw:clear',
  evBmwDataProgress: 'ev:bmw-progress',
  evStatus: 'ev:status',
  evChannels: 'ev:channels',
  evLiveBatch: 'ev:live',
  evMaximized: 'ev:maximized',
  openLogDialog: 'file:open-log',
  openLogsDialog: 'file:open-logs',
  copyText: 'clip:write',
  readFile: 'file:read',
  listLogs: 'file:list-logs',
  saveTextDialog: 'file:save-text',
  savePngDialog: 'file:save-png',
  openJsonDialog: 'file:open-json',
  saveRun: 'run:save',
  listRuns: 'run:list',
  loadRun: 'run:load',
  deleteRun: 'run:delete',
  showInFolder: 'shell:show',
  openDataDir: 'shell:data-dir',
  chooseDataDir: 'shell:choose-data-dir',
  windowControl: 'win:control'
} as const
