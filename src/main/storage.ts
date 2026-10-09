import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings } from '@shared/types'
import type { Presets } from '@shared/ipc'
import { DEFAULT_LIVE_CHANNELS } from '@shared/catalog'
import { DEFAULT_UNITS } from '@shared/units'
import { DEFAULT_DYNO_SETUP } from '@shared/analysis/dyno'

// Settings and presets live as JSON in Electron's userData folder; logs and
// runs are written to the user-visible data folder (Documents/Boostline).

const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')
const presetsFile = (): string => join(app.getPath('userData'), 'presets.json')

export function defaultSettings(): AppSettings {
  return {
    units: { ...DEFAULT_UNITS },
    logViewer: { cursorPopups: true, scaleLegends: true, lineSmoothing: false, liveWindowSec: 30 },
    connection: { kind: 'simulator' },
    dataDir: join(app.getPath('documents'), 'Boostline'),
    liveChannels: [...DEFAULT_LIVE_CHANNELS],
    dyno: { ...DEFAULT_DYNO_SETUP },
    drag: {
      mode: '0-100',
      environment: { altitudeM: 0, ambientTempC: 20, humidityPct: 50 },
      calibration: []
    },
    autoRecordWot: false,
    bmwDme: 'auto'
  }
}

const DEFAULT_PRESETS: Presets = {
  channels: [
    { name: 'Boost & Fuel', channelIds: [...DEFAULT_LIVE_CHANNELS] },
    {
      name: 'Timing & Knock',
      channelIds: ['engine.rpm', 'ign.avg', 'knock.cyl1', 'knock.cyl2', 'knock.cyl3', 'knock.cyl4', 'knock.cyl5', 'knock.cyl6']
    },
    {
      name: 'Temperatures',
      channelIds: ['temp.intake', 'temp.coolant', 'temp.oil', 'temp.ambient', 'temp.charge', 'temp.trans']
    }
  ],
  layouts: [
    {
      name: 'Boost control',
      graphs: [
        { title: 'Boost control', channelIds: ['boost.actual', 'boost.target', 'boost.wg_actual'] },
        { title: 'Rail pressure', channelIds: ['fuel.rail.actual', 'fuel.rail.target'] }
      ]
    },
    {
      name: 'WOT overview',
      graphs: [
        { title: 'Engine', channelIds: ['engine.rpm', 'throttle.pedal', 'vehicle.gear'] },
        { title: 'Boost', channelIds: ['boost.actual', 'boost.target'] },
        { title: 'Fuelling', channelIds: ['fuel.lambda.actual', 'fuel.lambda.target'] },
        { title: 'Knock', channelIds: ['knock.cyl1', 'knock.cyl2', 'knock.cyl3', 'knock.cyl4', 'knock.cyl5'] }
      ]
    }
  ],
  dragProfiles: []
}

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

/** Stored settings merged over defaults (one level deep for nested groups). */
function mergeSettings(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
  const out = { ...base } as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key]
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)
        ? { ...current, ...value }
        : value
  }
  return out as unknown as AppSettings
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
