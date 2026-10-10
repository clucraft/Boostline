import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings } from '@shared/types'
import type { Presets } from '@shared/ipc'
import { DEFAULT_PRESETS, defaultSettings as coreDefaults, mergeSettings } from '@core/defaults'

// Settings and presets live as JSON in Electron's userData folder; logs and
// runs are written to the user-visible data folder (Documents/Boostline).

const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')
const presetsFile = (): string => join(app.getPath('userData'), 'presets.json')

export const defaultSettings = (): AppSettings => coreDefaults(join(app.getPath('documents'), 'Boostline'))

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** Write atomically so a crash mid-write never corrupts the file. */
async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

let settingsCache: AppSettings | null = null

export async function loadSettings(): Promise<AppSettings> {
  if (!settingsCache) {
    const stored = await readJson<Partial<AppSettings>>(settingsFile())
    settingsCache = mergeSettings(defaultSettings(), stored ?? {})
  }
  return settingsCache
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = mergeSettings(await loadSettings(), patch)
  settingsCache = next
  await writeJson(settingsFile(), next)
  return next
}

export async function loadPresets(): Promise<Presets> {
  const stored = await readJson<Partial<Presets>>(presetsFile())
  return { ...DEFAULT_PRESETS, ...stored }
}

export async function savePresets(presets: Presets): Promise<void> {
  await writeJson(presetsFile(), presets)
}

export type DataFolder = 'Logs' | 'Dyno' | 'Drag' | 'Definitions' | 'Diagnostics'

export async function dataPath(folder: DataFolder): Promise<string> {
  const dir = join((await loadSettings()).dataDir, folder)
  await fs.mkdir(dir, { recursive: true })
  return dir
}
