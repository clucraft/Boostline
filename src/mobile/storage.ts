import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import type { AppSettings } from '@shared/types'
import type { Presets } from '@shared/ipc'
import { DEFAULT_PRESETS, defaultSettings, mergeSettings } from '@core/defaults'
import type { BmwDataPack } from '@core/bmwdata/types'

// App-private JSON (settings, presets, imported DME data) lives in Library/; logs and
// runs live in Documents/ so they show up in the Files app.

/** Shown in Settings → Logging; files are in the app's Documents folder. */
export const DATA_DIR_LABEL = 'Files › On My iPhone › Boostline'

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const { data } = await Filesystem.readFile({ path, directory: Directory.Library, encoding: Encoding.UTF8 })
    return JSON.parse(data as string) as T
  } catch {
    return null
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Filesystem.writeFile({ path, data: JSON.stringify(value), directory: Directory.Library, encoding: Encoding.UTF8, recursive: true })
}

let settingsCache: AppSettings | null = null

export async function loadSettings(): Promise<AppSettings> {
  if (!settingsCache) {
    const stored = await readJson<Partial<AppSettings>>('settings.json')
    const defaults = defaultSettings(DATA_DIR_LABEL)
    // One Y axis per graph by default: a phone screen has no room for five.
    defaults.logViewer.scaleLegends = false
    // The data folder is fixed on mobile.
    settingsCache = { ...mergeSettings(defaults, stored ?? {}), dataDir: DATA_DIR_LABEL }
  }
  return settingsCache
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...mergeSettings(await loadSettings(), patch), dataDir: DATA_DIR_LABEL }
  settingsCache = next
  await writeJson('settings.json', next)
  return next
}

export async function loadPresets(): Promise<Presets> {
  return { ...DEFAULT_PRESETS, ...(await readJson<Partial<Presets>>('presets.json')) }
}

export async function savePresets(presets: Presets): Promise<void> {
  await writeJson('presets.json', presets)
}

let bmwCache: BmwDataPack | null | undefined

export async function loadBmwData(): Promise<BmwDataPack | null> {
  if (bmwCache === undefined) {
    const pack = await readJson<BmwDataPack>('bmw-dme-data.json')
    bmwCache = pack && pack.format === 1 && Array.isArray(pack.dmes) ? pack : null
  }
  return bmwCache
}

export async function saveBmwData(pack: BmwDataPack): Promise<void> {
  await writeJson('bmw-dme-data.json', pack)
  bmwCache = pack
}

export async function clearBmwData(): Promise<void> {
  await Filesystem.deleteFile({ path: 'bmw-dme-data.json', directory: Directory.Library }).catch(() => undefined)
  bmwCache = null
}

export type DataFolder = 'Logs' | 'Dyno' | 'Drag' | 'Definitions' | 'Diagnostics' | 'Exports'

/** Folder under Documents (created if missing); paths are Documents-relative. */
export async function dataPath(folder: DataFolder): Promise<string> {
  await Filesystem.mkdir({ path: folder, directory: Directory.Documents, recursive: true }).catch(() => undefined)
  return folder
}
