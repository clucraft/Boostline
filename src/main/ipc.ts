import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import type { AdapterOption, AppSettings, ConnectOptions, SavedDragRun, SavedDynoRun } from '@shared/types'
import { IPC, type FileEntry, type OpenedFile, type Presets, type ProbeResult, type RunEntry, type RunKind } from '@shared/ipc'
import { Session } from './session'
import { dataPath, loadPresets, loadSettings, savePresets, saveSettings } from './storage'
import { runProbe } from './vehicle/probe'
import { downloadAndImportBmwDb } from './bmwdata/download'
import { importBmwUnifiedDbFile } from './bmwdata/importDb'
import { clearBmwData, loadBmwData, saveBmwData, summarizeBmwData } from './bmwdata/store'

const ADAPTERS: AdapterOption[] = [
  { kind: 'simulator', label: 'Simulator', description: 'Simulated B58 drive cycle. No car needed.' },
  { kind: 'enet', label: 'ENET cable', description: 'Ethernet (HSFZ) cable on the OBD port, F/G-series.' },
  { kind: 'mhd-wifi', label: 'MHD WiFi adapter', description: 'Join the adapter’s “MHD ENET” WiFi first (not “MHD ECA”).' },
  { kind: 'bm3-wifi', label: 'bootmod3 WiFi adapter', description: 'Join the adapter WiFi (BM3-NET…) first.' }
]

const runFolder = (kind: RunKind): Promise<string> => dataPath(kind === 'dyno' ? 'Dyno' : 'Drag')
const safeId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '')

async function readOpened(path: string): Promise<OpenedFile> {
  return { name: basename(path), path, text: await fs.readFile(path, 'utf8') }
}

export function registerIpc(session: Session, getWindow: () => BrowserWindow | null): void {
  const send = (channel: string, payload: unknown): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
  session.on('status', (s) => send(IPC.evStatus, s))
  session.on('channels', (c) => send(IPC.evChannels, c))
  session.on('batch', (b) => send(IPC.evLiveBatch, b))
  session.on('log', (msg) => console.log(`[session] ${msg}`))

  ipcMain.handle(IPC.appInfo, async () => ({
    version: app.getVersion(),
    platform: process.platform,
    dataDir: (await loadSettings()).dataDir
  }))
  ipcMain.handle(IPC.getSettings, () => loadSettings())
  ipcMain.handle(IPC.saveSettings, (_e, patch: Partial<AppSettings>) => saveSettings(patch))
  ipcMain.handle(IPC.getPresets, () => loadPresets())
  ipcMain.handle(IPC.savePresets, (_e, presets: Presets) => savePresets(presets))

  ipcMain.handle(IPC.adapterOptions, () => ADAPTERS)
  ipcMain.handle(IPC.connect, (_e, opts: ConnectOptions) => session.connect(opts))
  ipcMain.handle(IPC.disconnect, () => session.disconnect())
  ipcMain.handle(IPC.status, () => session.status())
  ipcMain.handle(IPC.channels, () => session.channels())
  ipcMain.handle(IPC.setStreamChannels, (_e, ids: string[]) => session.setStreamChannels(ids))
  ipcMain.handle(IPC.startLive, () => session.startLive())
  ipcMain.handle(IPC.stopLive, () => session.stopLive())
  ipcMain.handle(IPC.startRecording, () => session.startRecording())
  ipcMain.handle(IPC.stopRecording, () => session.stopRecording())
  ipcMain.handle(IPC.runProbe, async (_e, opts: ConnectOptions): Promise<ProbeResult> => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const capturePath = join(await dataPath('Diagnostics'), `probe_${opts.kind}_${stamp}.txt`)
    const report = await runProbe({ kind: opts.kind, host: opts.host, capturePath, log: (m: string) => console.log(`[probe] ${m}`) })
    await fs.writeFile(capturePath.replace(/\.txt$/, '.json'), JSON.stringify(report, null, 2), 'utf8')
    return { summary: report.summary, report, capturePath }
  })

  ipcMain.handle(IPC.bmwDataStatus, async () => summarizeBmwData(await loadBmwData()))
  ipcMain.handle(IPC.bmwDataDownload, async () => {
    const pack = await downloadAndImportBmwDb((p) => send(IPC.evBmwDataProgress, p))
    await saveBmwData(pack)
    return summarizeBmwData(pack)
  })
  ipcMain.handle(IPC.bmwDataImportFile, async () => {
    const res = await dialog.showOpenDialog({
      title: 'Import BMW diagnostic data (bmw-unified-db)',
      filters: [{ name: 'bmw-unified-db SQLite', extensions: ['sqlite', 'gz', 'db'] }],
      properties: ['openFile']
    })
    if (res.canceled || !res.filePaths[0]) return null
    send(IPC.evBmwDataProgress, { phase: 'import' })
    const pack = await importBmwUnifiedDbFile(res.filePaths[0], `bmw-unified-db (${basename(res.filePaths[0])})`)
    await saveBmwData(pack)
    send(IPC.evBmwDataProgress, { phase: 'done' })
    return summarizeBmwData(pack)
  })
  ipcMain.handle(IPC.bmwDataClear, () => clearBmwData())

  ipcMain.handle(IPC.openLogDialog, async () => {
    const res = await dialog.showOpenDialog({
      title: 'Open log',
      defaultPath: await dataPath('Logs'),
      filters: [{ name: 'Logs', extensions: ['csv', 'txt'] }],
      properties: ['openFile']
    })
    return res.canceled || !res.filePaths[0] ? null : readOpened(res.filePaths[0])
  })
  ipcMain.handle(IPC.openLogsDialog, async () => {
    const res = await dialog.showOpenDialog({
      title: 'Add logs',
      defaultPath: await dataPath('Logs'),
      filters: [{ name: 'Logs', extensions: ['csv', 'txt'] }],
      properties: ['openFile', 'multiSelections']
    })
    return res.canceled ? [] : Promise.all(res.filePaths.map(readOpened))
  })
  ipcMain.handle(IPC.copyText, (_e, text: string) => clipboard.writeText(text))
  ipcMain.handle(IPC.readFile, (_e, path: string) => readOpened(path))
  ipcMain.handle(IPC.listLogs, async (): Promise<FileEntry[]> => {
    const dir = await dataPath('Logs')
    const names = (await fs.readdir(dir)).filter((n) => n.toLowerCase().endsWith('.csv'))
    const entries = await Promise.all(
      names.map(async (name) => {
        const path = join(dir, name)
        const st = await fs.stat(path)
        return { name, path, size: st.size, mtime: st.mtimeMs }
      })
    )
    return entries.sort((a, b) => b.mtime - a.mtime)
  })
  ipcMain.handle(IPC.saveTextDialog, async (_e, defaultName: string, text: string, ext: 'csv' | 'json') => {
    const res = await dialog.showSaveDialog({
      defaultPath: join(await dataPath('Logs'), defaultName),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
    })
    if (res.canceled || !res.filePath) return null
    await fs.writeFile(res.filePath, text, 'utf8')
    return res.filePath
  })
  ipcMain.handle(IPC.savePngDialog, async (_e, defaultName: string, dataUrl: string) => {
    const res = await dialog.showSaveDialog({
      defaultPath: join(app.getPath('pictures'), defaultName),
      filters: [{ name: 'PNG image', extensions: ['png'] }]
    })
    if (res.canceled || !res.filePath) return null
    await fs.writeFile(res.filePath, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'))
    return res.filePath
  })
  ipcMain.handle(IPC.openJsonDialog, async (_e, title: string) => {
    const res = await dialog.showOpenDialog({ title, filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] })
    return res.canceled || !res.filePaths[0] ? null : readOpened(res.filePaths[0])
  })

  ipcMain.handle(IPC.saveRun, async (_e, kind: RunKind, run: SavedDynoRun | SavedDragRun) => {
    const path = join(await runFolder(kind), `${safeId(run.id)}.json`)
    await fs.writeFile(path, JSON.stringify(run), 'utf8')
    return path
  })
  ipcMain.handle(IPC.listRuns, async (_e, kind: RunKind): Promise<RunEntry[]> => {
    const dir = await runFolder(kind)
    const entries: RunEntry[] = []
    for (const name of await fs.readdir(dir)) {
      if (!name.endsWith('.json')) continue
      const path = join(dir, name)
      try {
        const run = JSON.parse(await fs.readFile(path, 'utf8')) as SavedDynoRun | SavedDragRun
        entries.push({ id: run.id, name: run.name, createdAt: run.createdAt, path })
      } catch {
        // Ignore files that are not runs.
      }
    }
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  })
  ipcMain.handle(IPC.loadRun, async (_e, kind: RunKind, id: string) => {
    try {
      return JSON.parse(await fs.readFile(join(await runFolder(kind), `${safeId(id)}.json`), 'utf8'))
    } catch {
      return null
    }
  })
  ipcMain.handle(IPC.deleteRun, async (_e, kind: RunKind, id: string) => {
    await fs.rm(join(await runFolder(kind), `${safeId(id)}.json`), { force: true })
  })

  ipcMain.handle(IPC.showInFolder, (_e, path: string) => shell.showItemInFolder(path))
  ipcMain.handle(IPC.openDataDir, async () => {
    await shell.openPath((await loadSettings()).dataDir)
  })
  ipcMain.handle(IPC.chooseDataDir, async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || !res.filePaths[0]) return null
    await saveSettings({ dataDir: res.filePaths[0] })
    return res.filePaths[0]
  })

  ipcMain.on(IPC.windowControl, (_e, action: 'minimize' | 'maximize' | 'close') => {
    const win = getWindow()
    if (!win) return
    if (action === 'minimize') win.minimize()
    else if (action === 'maximize') {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    } else win.close()
  })
}
