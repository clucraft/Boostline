import type { ChannelDef, HeatmapPrefs, HeatmapStatPref, LogData, UnitPrefs } from '@shared/types'
import { CH } from '@shared/types'
import { channelInUnit, findChannel } from '@shared/analysis/channelLookup'
import { DERIVED, withDerivedChannels, type DerivedInfo } from '@shared/analysis/derived'
import {
  accumulate,
  autoEdges,
  buildMask,
  cellValue,
  emptyGrid,
  makeEdges,
  type HeatmapCell,
  type HeatmapGrid,
  type HeatmapStat
} from '@shared/analysis/heatmap'
import { displayUnitFor, type DisplayUnit } from '@shared/units'
import { defOfLogChannel } from '../logviewer/types'

export interface HeatmapPreset {
  id: string
  name: string
  valueId: string
  stat: HeatmapStatPref
  beta?: boolean
}

export const PRESETS: HeatmapPreset[] = [
  { id: 'knock', name: 'Knock map (beta)', valueId: 'derived.timing_corr.worst', stat: 'worst', beta: true },
  { id: 'lambda', name: 'Lambda map', valueId: 'derived.lambda_error', stat: 'mean' },
  { id: 'boost', name: 'Boost map', valueId: 'derived.boost_error', stat: 'mean' },
  { id: 'rail', name: 'Rail pressure map', valueId: 'derived.rail_drop', stat: 'worst' },
  { id: 'coverage', name: 'Coverage', valueId: 'engine.rpm', stat: 'time' }
]

/** Load axis candidates, best first (relative load % is how BMW maps are laid out). */
export const LOAD_AXIS_CANDIDATES = ['load.engine', 'load.calc', 'boost.map', 'boost.actual', 'load.maf', 'obd.maf']

export const DEFAULT_HEATMAP: HeatmapPrefs = {
  preset: 'knock',
  valueId: 'derived.timing_corr.worst',
  stat: 'worst',
  x: { channelId: CH.rpm, start: 500, step: 500, end: 7500 },
  y: { channelId: 'load.engine', start: 0, step: 20, end: 260 },
  filters: { warm: true, excludeTransients: true, excludeFuelCut: true, throttle: 'all', gear: null, visibleOnly: false },
  minSamples: 5
}

export const MAX_CELLS_PER_AXIS = 40

/** A log prepared for heatmaps: with derived channels and defs for every channel. */
export interface HeatmapSource {
  log: LogData
  defs: Map<string, ChannelDef>
  derived: DerivedInfo[]
}

const prepared = new WeakMap<LogData, HeatmapSource>()

export function prepareSource(log: LogData, known: Map<string, ChannelDef>): HeatmapSource {
  const hit = prepared.get(log)
  if (hit) return hit
  const { log: withDerived, derived } = withDerivedChannels(log)
  const defs = new Map<string, ChannelDef>()
  for (const ch of withDerived.channels) {
    const info = DERIVED[ch.id] ?? derived.find((d) => d.id === ch.id)
    defs.set(
      ch.id,
      info
        ? { id: ch.id, name: ch.name, group: 'Custom', unit: info.unit, quantity: info.quantity, decimals: info.decimals, description: info.description }
        : defOfLogChannel(ch, known.get(ch.id))
    )
  }
  const source = { log: withDerived, defs, derived }
  prepared.set(log, source)
  return source
}

export function derivedInfo(id: string): DerivedInfo | undefined {
  return DERIVED[id] ?? (id.startsWith('derived.timing_corr.cyl') ? DERIVED['derived.timing_corr.avg'] : undefined)
}

/** The y channel to use for a source: the configured one, else the first available load channel. */
export function resolveAxisChannel(source: HeatmapSource, wanted: string, candidates: string[]): string | undefined {
  if (source.defs.has(wanted)) return wanted
  return candidates.find((id) => source.defs.has(id))
}

function displayArray(source: HeatmapSource, id: string, unit: DisplayUnit): Float64Array | undefined {
  const ch = findChannel(source.log, id)
  return ch ? ch.data.map((v) => unit.toDisplay(v)) : undefined
}

export interface HeatmapModel {
  grid: HeatmapGrid
  stat: HeatmapStat
  /** Value per cell (NaN = hidden: no data or below min samples). */
  values: number[]
  valueDef: ChannelDef
  valueUnit: DisplayUnit
  xDef: ChannelDef
  yDef: ChannelDef
  xUnit: DisplayUnit
  yUnit: DisplayUnit
  /** Logs that took part (index into the sources array) and why others didn't. */
  used: number[]
  skipped: { index: number; reason: string }[]
  unavailableFilters: string[]
  scale: { kind: 'diverging'; limit: number; badSign: 1 | -1 } | { kind: 'sequential'; min: number; max: number }
  decimals: number
}

export interface BuildOptions {
  prefs: HeatmapPrefs
  units: UnitPrefs
  /** Visible range of source 0 (the Log Viewer's log), for the "visible range only" filter. */
  range: [number, number] | null
}

const STAT_DECIMALS: Partial<Record<HeatmapStat, number>> = { n: 0, time: 1 }
const DIVERGING_FLOOR: Record<string, number> = {
  'derived.lambda_error': 0.02,
  'derived.boost_error': 0.1,
  'derived.rail_drop': 5,
  'derived.timing_corr.avg': 1,
  'derived.timing_corr.worst': 1
}

export function resolveStat(stat: HeatmapStatPref, valueId: string): HeatmapStat {
  if (stat !== 'worst') return stat
  return (derivedInfo(valueId)?.badSign ?? 1) < 0 ? 'min' : 'max'
}

export function buildModel(sources: HeatmapSource[], opts: BuildOptions): HeatmapModel | { error: string } {
  const { prefs, units } = opts
  const primary = sources[0]
  if (!primary) return { error: 'Open a log to build a heatmap.' }
  const valueDef = primary.defs.get(prefs.valueId) ?? sources.find((s) => s.defs.has(prefs.valueId))?.defs.get(prefs.valueId)
  if (!valueDef) {
    const info = derivedInfo(prefs.valueId)
    return {
      error: info
        ? `${info.name} needs channels these logs don't have${prefs.valueId.startsWith('derived.timing') ? ' (per-cylinder ignition timing)' : ''}.`
        : 'The selected value channel is not in these logs.'
    }
  }
  const xId = resolveAxisChannel(primary, prefs.x.channelId, [CH.rpm])
  const yId = resolveAxisChannel(primary, prefs.y.channelId, LOAD_AXIS_CANDIDATES)
  if (!xId || !yId) return { error: 'These logs have no engine speed or load channel for the axes.' }
  const xDef = primary.defs.get(xId)!
  const yDef = primary.defs.get(yId)!
  const xUnit = displayUnitFor(xDef, units)
  const yUnit = displayUnitFor(yDef, units)
  const valueUnit = displayUnitFor(valueDef, units)

  // Axes: configured edges, or automatic ones when the y channel had to fall back.
  let xEdges: number[]
  let yEdges: number[]
  try {
    xEdges = xId === prefs.x.channelId ? makeEdges(prefs.x.start, prefs.x.step, prefs.x.end) : autoEdges(displayArray(primary, xId, xUnit) ?? [], 13) ?? makeEdges(500, 500, 7500)
    yEdges = yId === prefs.y.channelId ? makeEdges(prefs.y.start, prefs.y.step, prefs.y.end) : autoEdges(displayArray(primary, yId, yUnit) ?? [], 11) ?? makeEdges(0, 20, 260)
  } catch (err) {
    return { error: `Invalid axis: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (xEdges.length - 1 > MAX_CELLS_PER_AXIS || yEdges.length - 1 > MAX_CELLS_PER_AXIS) return { error: `Use at most ${MAX_CELLS_PER_AXIS} cells per axis.` }

  const grid = emptyGrid(xEdges, yEdges)
  const used: number[] = []
  const skipped: { index: number; reason: string }[] = []
  const unavailable = new Set<string>()
  sources.forEach((src, index) => {
    const x = displayArray(src, xId, xUnit)
    const y = displayArray(src, yId, yUnit)
    const z = displayArray(src, prefs.valueId, valueUnit)
    if (!x || !y || !z) {
      skipped.push({ index, reason: !z ? `no ${valueDef.name}` : `no ${!x ? xDef.name : yDef.name}` })
      return
    }
    const f = prefs.filters
    const { mask, unavailable: missing } = buildMask(
      {
        t: src.log.time,
        rpm: channelInUnit(src.log, CH.rpm, 'rpm'),
        load: findChannel(src.log, 'load.engine')?.data ?? findChannel(src.log, 'load.calc')?.data,
        coolantC: channelInUnit(src.log, 'temp.coolant', '°C'),
        pedalPct: channelInUnit(src.log, CH.pedal, '%'),
        gear: findChannel(src.log, CH.gear)?.data
      },
      { ...f, range: f.visibleOnly && index === 0 ? opts.range : null }
    )
    missing.forEach((m) => unavailable.add(m))
    accumulate(grid, { t: src.log.time, x, y, z, mask }, index)
    used.push(index)
  })

  const stat = resolveStat(prefs.stat, prefs.valueId)
  const values = grid.cells.map((c: HeatmapCell) => (c.n >= prefs.minSamples ? cellValue(c, stat) : NaN))
  const finite = values.filter(Number.isFinite)
  const info = derivedInfo(prefs.valueId)
  const valueStat = stat === 'mean' || stat === 'min' || stat === 'max'
  let scale: HeatmapModel['scale']
  if (info && valueStat) {
    const maxAbs = finite.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
    const floor = (DIVERGING_FLOOR[prefs.valueId] ?? 0) * (valueUnit.toDisplay(1) - valueUnit.toDisplay(0) || 1)
    scale = { kind: 'diverging', limit: Math.max(maxAbs, floor, 1e-9), badSign: info.badSign }
  } else {
    scale = { kind: 'sequential', min: finite.length ? Math.min(...finite) : 0, max: finite.length ? Math.max(...finite) : 1 }
  }
  const decimals = STAT_DECIMALS[stat] ?? (stat === 'std' ? valueUnit.decimals(valueDef.decimals) + 1 : valueUnit.decimals(valueDef.decimals))
  return { grid, stat, values, valueDef, valueUnit, xDef, yDef, xUnit, yUnit, used, skipped, unavailableFilters: [...unavailable], scale, decimals }
}

// ------------------------------------------------------------------ colors

type RGB = [number, number, number]
const MID: RGB = [38, 38, 43]
const BAD: RGB = [248, 92, 92]
const GOOD: RGB = [56, 189, 248]
const SEQ_LO: RGB = [52, 34, 10]
const SEQ_HI: RGB = [255, 173, 51]

const mix = (a: RGB, b: RGB, t: number): RGB => a.map((v, i) => Math.round(v + (b[i] - v) * t)) as RGB

export function cellColor(model: HeatmapModel, v: number): { bg: string; fg: string } {
  let c: RGB
  if (model.scale.kind === 'diverging') {
    const t = Math.max(-1, Math.min(1, (v * model.scale.badSign) / model.scale.limit))
    c = t >= 0 ? mix(MID, BAD, t) : mix(MID, GOOD, -t)
  } else {
    const { min, max } = model.scale
    const t = max > min ? (v - min) / (max - min) : 1
    c = mix(SEQ_LO, SEQ_HI, Math.max(0, Math.min(1, t)))
  }
  const lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
  return { bg: `rgb(${c[0]},${c[1]},${c[2]})`, fg: lum > 150 ? '#140c00' : '#f4f4f5' }
}

export function legendGradient(model: HeatmapModel): string {
  const css = (c: RGB): string => `rgb(${c[0]},${c[1]},${c[2]})`
  if (model.scale.kind === 'sequential') return `linear-gradient(90deg, ${css(SEQ_LO)}, ${css(SEQ_HI)})`
  // Left = negative values, right = positive values.
  const neg = model.scale.badSign < 0 ? BAD : GOOD
  const pos = model.scale.badSign < 0 ? GOOD : BAD
  return `linear-gradient(90deg, ${css(neg)}, ${css(MID)}, ${css(pos)})`
}

/** Fixed decimals without a misleading "-0.00" for values that round to zero. */
export function fmtVal(v: number, decimals: number): string {
  const s = v.toFixed(decimals)
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s
}

export const fmtEdge = (v: number): string => (Math.abs(v) >= 100 || Number.isInteger(v) ? String(Math.round(v * 100) / 100) : v.toFixed(2))
