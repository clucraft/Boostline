import { EventEmitter } from 'events'
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { KeepAwake } from '@capacitor-community/keep-awake'
import type { AdapterOption, AppSettings, ConnectOptions, SavedDragRun, SavedDynoRun } from '@shared/types'
import type { BmwDataProgress, BmwDataSummary, BoostlineApi, FileEntry, OpenedFile, Presets, RunEntry, RunKind } from '@shared/ipc'
import { Session } from '@core/session'
import { runProbe } from '@core/vehicle/probe'
import { readBmwDataPack, type SqlReader } from '@core/bmwdata/importDb'
import { summarizeBmwData } from '@core/bmwdata/summary'
import type { BmwDataPack } from '@core/bmwdata/types'
import { refreshInterfaces } from './runtime'
import { BoostlineData } from './plugins'
import { clearBmwData, dataPath, loadBmwData, loadPresets, loadSettings, saveBmwData, savePresets, saveSettings } from './storage'

declare const __APP_VERSION__: string

const ADAPTERS: AdapterOption[] = [
  { kind: 'simulator', label: 'Simulator', description: 'Simulated B58 drive cycle. No car needed.' },
  { kind: 'mhd-wifi', label: 'MHD WiFi adapter', description: 'Join the adapter’s “MHD ENET” WiFi in iOS Settings first (not “MHD ECA”).' },
  { kind: 'bm3-wifi', label: 'bootmod3 WiFi adapter', description: 'Join the adapter WiFi (BM3-NET…) in iOS Settings first.' },
  { kind: 'enet', label: 'ENET cable', description: 'Needs a USB-C Ethernet adapter. Untested on phones.' }
]

const BMW_DB_REPO = 'gediz/bmw-unified-db'
const BMW_DB_ASSET = 'bmw.sqlite.gz'

const clone = <T>(v: T): T => structuredClone(v)
const safeId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '')
const runFolder = (kind: RunKind): Promise<string> => dataPath(kind === 'dyno' ? 'Dyno' : 'Drag')
const DOCS = Directory.Documents

/** Opens the system file picker. Must be called synchronously from a tap handler. */
function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.style.display = 'none'
    const done = (files: File[]): void => {
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => done([...(input.files ?? [])]))
    input.addEventListener('cancel', () => done([]))
    document.body.appendChild(input)
    input.click()
  })
}

const readPicked = async (f: File): Promise<OpenedFile> => ({ name: f.name, path: f.name, text: await f.text() })

async function readDocument(path: string): Promise<OpenedFile> {
  const { data } = await Filesystem.readFile({ path, directory: DOCS, encoding: Encoding.UTF8 })
  return { name: path.split('/').pop() ?? path, path, text: data as string }
}

/** Rows from the native SQLite plugin as objects keyed by column name. */
const nativeSql: SqlReader = {
  all: async (sql, params = []) => {
    const { columns, rows } = await BoostlineData.query({ sql, params })
    return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])))
  }
}

/** The app's API (the same one the desktop preload exposes), backed by the in-app session. */
export function createMobileApi(): BoostlineApi {
  const session = new Session({ loadSettings, loadBmwData, dataPath })
  const bmwProgress = new EventEmitter()
  session.on('log', (msg) => console.log(`[session] ${msg}`))

  // Keep the screen on while connected: iOS suspends apps in the background.
  let awake = false
  session.on('status', (s) => {
    const want = s.state === 'connected' || s.state === 'live'
    if (want === awake) return
    awake = want
    void (want ? KeepAwake.keepAwake() : KeepAwake.allowSleep()).catch(() => undefined)
  })

  const importWith = async (open: () => Promise<boolean>, source: () => string): Promise<BmwDataSummary | null> => {
    try {
      if (!(await open())) return null
      bmwProgress.emit('progress', { phase: 'import' } satisfies BmwDataProgress)
      const pack: BmwDataPack = await readBmwDataPack(nativeSql, source())
      await saveBmwData(pack)
      bmwProgress.emit('progress', { phase: 'done' } satisfies BmwDataProgress)
      return summarizeBmwData(pack)
    } finally {
      await BoostlineData.close().catch(() => undefined)
    }
  }


  return {
    platform: Capacitor.getPlatform(),
    appInfo: async () => ({ version: __APP_VERSION__, platform: Capacitor.getPlatform(), dataDir: (await loadSettings()).dataDir }),

    getSettings: async () => clone(await loadSettings()),
    saveSettings: async (patch: Partial<AppSettings>) => clone(await saveSettings(patch)),
    getPresets: async () => clone(await loadPresets()),
    savePresets: (presets: Presets) => savePresets(clone(presets)),

    adapterOptions: async () => ADAPTERS,
    connect: async (opts: ConnectOptions) => {
      await refreshInterfaces().catch(() => undefined)
      return session.connect(opts)
    },
    disconnect: () => session.disconnect(),
    status: async () => session.status(),
    channels: async () => session.channels(),
    setStreamChannels: (ids) => session.setStreamChannels(ids),
    startLive: () => session.startLive(),
    stopLive: () => session.stopLive(),
    startRecording: () => session.startRecording(),
    stopRecording: () => session.stopRecording(),
    runProbe: async (opts: ConnectOptions) => {
      await refreshInterfaces().catch(() => undefined)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const capturePath = `${await dataPath('Diagnostics')}/probe_${opts.kind}_${stamp}.txt`
      const report = await runProbe({ kind: opts.kind, host: opts.host, capturePath, log: (m: string) => console.log(`[probe] ${m}`) })
      await Filesystem.writeFile({
        path: capturePath.replace(/\.txt$/, '.json'),
        data: JSON.stringify(report, null, 2),
        directory: DOCS,
        encoding: Encoding.UTF8
      })
      return { summary: report.summary, report, capturePath }
    },

    bmwDataStatus: async () => summarizeBmwData(await loadBmwData()),
    bmwDataDownload: async () => {
      bmwProgress.emit('progress', { phase: 'release' } satisfies BmwDataProgress)
      const res = await CapacitorHttp.get({
        url: `https://api.github.com/repos/${BMW_DB_REPO}/releases/latest`,
        headers: { Accept: 'application/vnd.github+json' }
      })
      if (res.status !== 200) throw new Error(`GitHub release lookup failed (${res.status})`)
      const release = (typeof res.data === 'string' ? JSON.parse(res.data) : res.data) as {
        tag_name: string
        assets: { name: string; browser_download_url: string }[]
      }
      const asset = release.assets.find((a) => a.name === BMW_DB_ASSET)
      if (!asset) throw new Error(`Release ${release.tag_name} has no ${BMW_DB_ASSET}`)
      const sums = release.assets.find((a) => a.name === 'SHA256SUMS')
      let sha256: string | undefined
      if (sums) {
        const text = (await CapacitorHttp.get({ url: sums.browser_download_url, responseType: 'text' })).data as string
        sha256 = text.split('\n').find((l) => l.trim().endsWith(BMW_DB_ASSET))?.split(/\s+/)[0]?.toLowerCase()
      }
      const handle = await BoostlineData.addListener('progress', (p) => bmwProgress.emit('progress', p))
      try {
        const summary = await importWith(
          async () => {
            await BoostlineData.openDownloaded({ url: asset.browser_download_url, sha256 })
            return true
          },
          () => `bmw-unified-db ${release.tag_name}`
        )
        return summary!
      } finally {
        await handle.remove()
      }
    },
    bmwDataImportFile: async () => {
      let name = 'file'
      return importWith(
        async () => {
          const r = await BoostlineData.openPicked()
          name = r.name ?? name
          return r.opened
        },
        () => `bmw-unified-db (${name})`
      )
    },
    bmwDataClear: () => clearBmwData(),
    onBmwDataProgress: (cb) => {
      bmwProgress.on('progress', cb)
      return () => void bmwProgress.off('progress', cb)
    },

    onStatus: (cb) => {
      session.on('status', cb)
      return () => void session.off('status', cb)
    },
    onChannels: (cb) => {
      session.on('channels', cb)
      return () => void session.off('channels', cb)
    },
    onLiveBatch: (cb) => {
      session.on('batch', cb)
      return () => void session.off('batch', cb)
    },

    openLogDialog: async () => {
      const [f] = await pickFiles('.csv,.txt,text/csv,text/plain', false)
      return f ? readPicked(f) : null
    },
    openLogsDialog: async () => Promise.all((await pickFiles('.csv,.txt,text/csv,text/plain', true)).map(readPicked)),
    copyText: (text) => navigator.clipboard.writeText(text),
    readFile: (path) => readDocument(path),
    listLogs: async (): Promise<FileEntry[]> => {
      const dir = await dataPath('Logs')
      const { files } = await Filesystem.readdir({ path: dir, directory: DOCS })
      return files
        .filter((f) => f.type === 'file' && /\.csv$/i.test(f.name))
        .map((f) => ({ name: f.name, path: `${dir}/${f.name}`, size: f.size, mtime: f.mtime }))
        .sort((a, b) => b.mtime - a.mtime)
    },
    saveTextDialog: async (defaultName, text, ext) => {
      const path = `${await dataPath(ext === 'csv' ? 'Logs' : 'Exports')}/${defaultName}`
      await Filesystem.writeFile({ path, data: text, directory: DOCS, encoding: Encoding.UTF8, recursive: true })
      return path
    },
    savePngDialog: async (defaultName, dataUrl) => {
      const path = `${await dataPath('Exports')}/${defaultName}`
      await Filesystem.writeFile({ path, data: dataUrl.replace(/^data:image\/png;base64,/, ''), directory: DOCS, recursive: true })
      return path
    },
    openJsonDialog: async () => {
      const [f] = await pickFiles('.json,application/json', false)
      return f ? readPicked(f) : null
    },

    saveRun: async (kind: RunKind, run: SavedDynoRun | SavedDragRun) => {
      const path = `${await runFolder(kind)}/${safeId(run.id)}.json`
      await Filesystem.writeFile({ path, data: JSON.stringify(run), directory: DOCS, encoding: Encoding.UTF8, recursive: true })
      return path
    },
    listRuns: async (kind: RunKind): Promise<RunEntry[]> => {
      const dir = await runFolder(kind)
      const entries: RunEntry[] = []
      for (const f of (await Filesystem.readdir({ path: dir, directory: DOCS })).files) {
        if (!f.name.endsWith('.json')) continue
        const path = `${dir}/${f.name}`
        try {
          const run = JSON.parse((await readDocument(path)).text) as SavedDynoRun | SavedDragRun
          entries.push({ id: run.id, name: run.name, createdAt: run.createdAt, path })
        } catch {
          // Ignore files that are not runs.
        }
      }
      return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },
    loadRun: async (kind: RunKind, id: string) => {
      try {
        return JSON.parse((await readDocument(`${await runFolder(kind)}/${safeId(id)}.json`)).text)
      } catch {
        return null
      }
    },
    deleteRun: async (kind: RunKind, id: string) => {
      await Filesystem.deleteFile({ path: `${await runFolder(kind)}/${safeId(id)}.json`, directory: DOCS }).catch(() => undefined)
    },

    // No folders to reveal or choose on a phone: files are in the Files app.
    showInFolder: async () => undefined,
    openDataDir: async () => undefined,
    chooseDataDir: async () => null,
    windowControl: () => undefined,
    onMaximized: () => () => undefined
  }
}
