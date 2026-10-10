import type { LogChannel, LogData, Quantity } from '../types'
import { CH } from '../types'
import { channelInUnit, findChannel } from './channelLookup'

// Channels computed from others, appended to a log so every tool (graphs, heatmaps)
// can use them like recorded channels. Ids start with "derived.".

export interface DerivedInfo {
  id: string
  name: string
  unit: string
  quantity: Quantity
  decimals: number
  /** +1: positive values are the bad direction (lean, overboost); -1: negative is bad (timing pulled). */
  badSign: 1 | -1
  /** Experimental: the derivation still needs validating against real logs. */
  beta?: boolean
  description: string
}

export const DERIVED: Readonly<Record<string, DerivedInfo>> = {
  'derived.lambda_error': {
    id: 'derived.lambda_error', name: 'Lambda error (actual − target)', unit: 'λ', quantity: 'lambda', decimals: 3, badSign: 1,
    description: 'Positive = leaner than requested, negative = richer.'
  },
  'derived.boost_error': {
    id: 'derived.boost_error', name: 'Boost error (actual − target)', unit: 'bar', quantity: 'pressure', decimals: 3, badSign: 1,
    description: 'Positive = overboost, negative = under target (normal while spooling).'
  },
  'derived.rail_drop': {
    id: 'derived.rail_drop', name: 'Rail pressure drop', unit: '%', quantity: 'percent', decimals: 1, badSign: 1,
    description: 'How far rail pressure falls below its target, in % of the target. Large drops mean the high-pressure pump is at its limit.'
  },
  'derived.timing_corr.avg': {
    id: 'derived.timing_corr.avg', name: 'Timing correction, cylinder average (beta)', unit: '°CRK', quantity: 'angle', decimals: 2, badSign: -1, beta: true,
    description: 'How far cylinders run below the most-advanced cylinder, after removing each cylinder’s normal offset. Detects cylinder-specific pulls; a uniform retard on all cylinders is not visible.'
  },
  'derived.timing_corr.worst': {
    id: 'derived.timing_corr.worst', name: 'Timing correction, worst cylinder (beta)', unit: '°CRK', quantity: 'angle', decimals: 2, badSign: -1, beta: true,
    description: 'The largest correction of any cylinder at that moment (see cylinder average).'
  }
}

const CYLINDERS = [1, 2, 3, 4, 5, 6, 7, 8]
/** Part-load limit (relative load %) for measuring each cylinder's normal timing offset. */
const BASELINE_MAX_LOAD = 80
const BASELINE_MIN_SAMPLES = 50

const channel = (info: DerivedInfo, data: Float64Array): LogChannel => ({ id: info.id, name: info.name, unit: info.unit, quantity: info.quantity, data })

function difference(a: Float64Array, b: Float64Array): Float64Array {
  return a.map((v, i) => v - b[i])
}

function median(values: number[]): number {
  if (!values.length) return 0
  const s = [...values].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * Per-cylinder timing corrections from per-cylinder ignition timing.
 * corr_n = (timing_n − offset_n) − max_k (timing_k − offset_k) ≤ 0, where offset_n is the
 * cylinder's median deviation from the all-cylinder mean at part load.
 */
export function timingCorrections(timing: Float64Array[], partLoad?: (i: number) => boolean): { perCylinder: Float64Array[]; avg: Float64Array; worst: Float64Array } {
  const n = timing[0].length
  const k = timing.length
  const offsets = new Array<number>(k).fill(0)
  if (partLoad) {
    const deviations: number[][] = timing.map(() => [])
    for (let i = 0; i < n; i++) {
      if (!partLoad(i)) continue
      let sum = 0
      let ok = true
      for (const t of timing) {
        if (!Number.isFinite(t[i])) ok = false
        sum += t[i]
      }
      if (!ok) continue
      const mean = sum / k
      timing.forEach((t, c) => deviations[c].push(t[i] - mean))
    }
    if (deviations[0].length >= BASELINE_MIN_SAMPLES) deviations.forEach((d, c) => (offsets[c] = median(d)))
  }
  const perCylinder = timing.map(() => new Float64Array(n))
  const avg = new Float64Array(n)
  const worst = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let max = -Infinity
    let valid = true
    for (let c = 0; c < k; c++) {
      const adj = timing[c][i] - offsets[c]
      if (!Number.isFinite(adj)) valid = false
      if (adj > max) max = adj
    }
    if (!valid) {
      perCylinder.forEach((p) => (p[i] = NaN))
      avg[i] = NaN
      worst[i] = NaN
      continue
    }
    let sum = 0
    let low = 0
    for (let c = 0; c < k; c++) {
      const corr = timing[c][i] - offsets[c] - max
      perCylinder[c][i] = corr
      sum += corr
      if (corr < low) low = corr
    }
    avg[i] = sum / k
    worst[i] = low
  }
  return { perCylinder, avg, worst }
}

/** Returns the log with every derivable channel appended, and the infos of those channels. */
export function withDerivedChannels(log: LogData): { log: LogData; derived: DerivedInfo[] } {
  const extra: LogChannel[] = []
  const infos: DerivedInfo[] = []
  const add = (info: DerivedInfo, data: Float64Array): void => {
    extra.push(channel(info, data))
    infos.push(info)
  }

  const lamA = channelInUnit(log, CH.lambdaActual, 'λ')
  const lamT = channelInUnit(log, 'fuel.lambda.target', 'λ')
  if (lamA && lamT) add(DERIVED['derived.lambda_error'], difference(lamA, lamT))

  const boostA = channelInUnit(log, CH.boostActual, 'bar')
  const boostT = channelInUnit(log, CH.boostTarget, 'bar')
  if (boostA && boostT) add(DERIVED['derived.boost_error'], difference(boostA, boostT))

  const railA = channelInUnit(log, 'fuel.rail.actual', 'bar')
  const railT = channelInUnit(log, 'fuel.rail.target', 'bar')
  if (railA && railT) add(DERIVED['derived.rail_drop'], railT.map((target, i) => (target > 10 ? ((target - railA[i]) / target) * 100 : NaN)))

  const timing = CYLINDERS.map((c) => findChannel(log, `ign.cyl${c}`)?.data).filter((d): d is Float64Array => !!d)
  if (timing.length >= 2) {
    const load = findChannel(log, 'load.engine')?.data ?? findChannel(log, 'load.calc')?.data
    const pedal = channelInUnit(log, CH.pedal, '%')
    const partLoad = load ? (i: number) => load[i] > 10 && load[i] < BASELINE_MAX_LOAD : pedal ? (i: number) => pedal[i] > 1 && pedal[i] < 40 : undefined
    const { perCylinder, avg, worst } = timingCorrections(timing, partLoad)
    add(DERIVED['derived.timing_corr.avg'], avg)
    add(DERIVED['derived.timing_corr.worst'], worst)
    perCylinder.forEach((data, c) => {
      const info: DerivedInfo = {
        ...DERIVED['derived.timing_corr.avg'],
        id: `derived.timing_corr.cyl${c + 1}`,
        name: `Timing correction cyl ${c + 1} (beta)`
      }
      add(info, data)
    })
  }

  return { log: extra.length ? { ...log, channels: [...log.channels, ...extra] } : log, derived: infos }
}
