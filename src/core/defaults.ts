import type { AppSettings } from '@shared/types'
import type { Presets } from '@shared/ipc'
import { DEFAULT_LIVE_CHANNELS } from '@shared/catalog'
import { DEFAULT_UNITS } from '@shared/units'
import { DEFAULT_DYNO_SETUP } from '@shared/analysis/dyno'

/** Settings for a fresh install; `dataDir` is where logs and runs go on this platform. */
export function defaultSettings(dataDir: string): AppSettings {
  return {
    units: { ...DEFAULT_UNITS },
    logViewer: { cursorPopups: true, scaleLegends: true, lineSmoothing: false, liveWindowSec: 30 },
    connection: { kind: 'simulator' },
    dataDir,
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

export const DEFAULT_PRESETS: Presets = {
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

/** Stored settings merged over defaults (one level deep for nested groups). */
export function mergeSettings(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
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
