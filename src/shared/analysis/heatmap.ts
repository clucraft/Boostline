import { derivative } from './smoothing'

// RPM × load heatmaps ("histograms" in tuner speak): every sample is placed in the
// cell of its x (e.g. engine speed) and y (e.g. load) value, and the cell accumulates
// statistics of a value channel z (e.g. timing correction). Cells are time-weighted so
// logs recorded at different sample rates combine fairly, and each cell remembers the
// time spans that landed in it so the UI can jump to those moments.

/** A contiguous stretch of samples that stayed in one cell. */
export interface HeatmapSpan {
  /** Index of the source log (when several logs are accumulated). */
  log: number
  start: number
  end: number
}

export interface HeatmapCell {
  n: number
  /** Seconds spent in the cell. */
  time: number
  /** Σ z·dt and Σ z²·dt (time-weighted moments). */
  sumW: number
  sumW2: number
  min: number
  max: number
  /** The first spans (see MAX_SPANS_PER_CELL); spanCount has the total. */
  spans: HeatmapSpan[]
  spanCount: number
}

export interface HeatmapGrid {
  /** Bin edges, ascending: cell i covers [edges[i], edges[i+1]); the last edge is inclusive. */
  xEdges: number[]
  yEdges: number[]
  /** Row-major: index = row * columns + column (row 0 = lowest y). */
  cells: HeatmapCell[]
  samples: number
  time: number
  /** Included samples whose x or y fell outside the grid. */
  outside: number
}

export type HeatmapStat = 'mean' | 'min' | 'max' | 'std' | 'n' | 'time'

export const MAX_SPANS_PER_CELL = 40
/** Samples further apart than this are treated as a gap (no time credited across it). */
export const DEFAULT_MAX_DT = 0.5

const emptyCell = (): HeatmapCell => ({ n: 0, time: 0, sumW: 0, sumW2: 0, min: Infinity, max: -Infinity, spans: [], spanCount: 0 })

export function emptyGrid(xEdges: number[], yEdges: number[]): HeatmapGrid {
  if (xEdges.length < 2 || yEdges.length < 2) throw new RangeError('An axis needs at least two edges')
  const cells = Array.from({ length: (xEdges.length - 1) * (yEdges.length - 1) }, emptyCell)
  return { xEdges, yEdges, cells, samples: 0, time: 0, outside: 0 }
}

/** Bin index of v for ascending edges; -1 outside. The last edge belongs to the last bin. */
export function binIndex(edges: readonly number[], v: number): number {
  const last = edges.length - 1
  if (!(v >= edges[0]) || v > edges[last]) return -1
  if (v === edges[last]) return last - 1
  let lo = 0
  let hi = last
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (v >= edges[mid]) lo = mid
    else hi = mid
  }
  return lo
}

export interface HeatmapInput {
  t: ArrayLike<number>
  x: ArrayLike<number>
  y: ArrayLike<number>
  z: ArrayLike<number>
  /** 1 = include the sample. Omitted = include all. */
  mask?: ArrayLike<number>
}

/** Adds one log's samples to the grid (call repeatedly with different log indexes to combine logs). */
export function accumulate(grid: HeatmapGrid, input: HeatmapInput, logIndex = 0, maxDt = DEFAULT_MAX_DT): void {
  const { t, x, y, z, mask } = input
  const cols = grid.xEdges.length - 1
  const len = t.length
  let lastCell = -1
  let lastT = -Infinity
  let openSpan: HeatmapSpan | null = null
  for (let i = 0; i < len; i++) {
    const include = (!mask || mask[i] === 1) && Number.isFinite(z[i])
    if (!include) {
      lastCell = -1
      continue
    }
    const cx = binIndex(grid.xEdges, x[i])
    const cy = binIndex(grid.yEdges, y[i])
    if (cx < 0 || cy < 0) {
      grid.outside++
      lastCell = -1
      continue
    }
    // Time weight: half the distance to each neighbour, capped so gaps don't count.
    const prev = i > 0 ? Math.min(t[i] - t[i - 1], maxDt) : 0
    const next = i < len - 1 ? Math.min(t[i + 1] - t[i], maxDt) : 0
    const dt = Math.max(0, (prev + next) / 2) || maxDt / 10
    const index = cy * cols + cx
    const cell = grid.cells[index]
    const v = z[i]
    cell.n++
    cell.time += dt
    cell.sumW += v * dt
    cell.sumW2 += v * v * dt
    if (v < cell.min) cell.min = v
    if (v > cell.max) cell.max = v
    grid.samples++
    grid.time += dt
    if (index === lastCell && t[i] - lastT <= maxDt && openSpan) {
      openSpan.end = t[i]
    } else {
      cell.spanCount++
      openSpan = { log: logIndex, start: t[i], end: t[i] }
      if (cell.spans.length < MAX_SPANS_PER_CELL) cell.spans.push(openSpan)
    }
    lastCell = index
    lastT = t[i]
  }
}

export function cellValue(cell: HeatmapCell, stat: HeatmapStat): number {
  if (cell.n === 0) return NaN
  switch (stat) {
    case 'n':
      return cell.n
    case 'time':
      return cell.time
    case 'min':
      return cell.min
    case 'max':
      return cell.max
    case 'mean':
      return cell.time > 0 ? cell.sumW / cell.time : NaN
    case 'std': {
      if (cell.time <= 0) return NaN
      const mean = cell.sumW / cell.time
      return Math.sqrt(Math.max(0, cell.sumW2 / cell.time - mean * mean))
    }
  }
}

// ------------------------------------------------------------------ axes

/** Edges from start to end (inclusive) in steps. */
export function makeEdges(start: number, step: number, end: number): number[] {
  if (!(step > 0) || !(end > start)) throw new RangeError('Axis needs step > 0 and end > start')
  const n = Math.round((end - start) / step)
  return Array.from({ length: n + 1 }, (_, i) => +(start + i * step).toPrecision(12))
}

const NICE = [1, 2, 2.5, 5, 10]

/** Rounded "nice" step so that span / step is about `target`. */
export function niceStep(span: number, target: number): number {
  const raw = span / Math.max(1, target)
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  return NICE.map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag
}

/** Nice edges covering the 1st..99th percentile of the finite values. */
export function autoEdges(values: ArrayLike<number>, target = 10): number[] | null {
  const finite: number[] = []
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) finite.push(values[i])
  if (finite.length < 2) return null
  finite.sort((a, b) => a - b)
  const lo = finite[Math.floor(finite.length * 0.01)]
  const hi = finite[Math.min(finite.length - 1, Math.ceil(finite.length * 0.99))]
  if (!(hi > lo)) return null
  const step = niceStep(hi - lo, target)
  const start = Math.floor(lo / step) * step
  const end = Math.max(start + step, Math.ceil(hi / step) * step)
  return makeEdges(start, step, end)
}

// ------------------------------------------------------------------ filters

export type ThrottleFilter = 'all' | 'wot' | 'part'

export interface HeatmapFilters {
  /** Only samples with coolant at or above warmTempC. */
  warm: boolean
  /** Skip fast load or rpm changes: tip-in/out, shifts, spool spikes. */
  excludeTransients: boolean
  /** Skip overrun fuel cut (pedal released at speed). */
  excludeFuelCut: boolean
  throttle: ThrottleFilter
  /** Only this gear (null = all). */
  gear: number | null
  /** Only samples inside [start, end] seconds (null = whole log). */
  range: [number, number] | null
}

export const DEFAULT_FILTERS: HeatmapFilters = {
  warm: true,
  excludeTransients: true,
  excludeFuelCut: true,
  throttle: 'all',
  gear: null,
  range: null
}

export interface FilterChannels {
  t: Float64Array
  rpm?: Float64Array
  load?: Float64Array
  coolantC?: Float64Array
  pedalPct?: Float64Array
  gear?: Float64Array
}

export const FILTER_LIMITS = {
  warmTempC: 80,
  wotPedalPct: 85,
  /** |d load / dt| above this (%/s) is a transient (sharp tip-in/out; normal spool-up stays below). */
  maxLoadRate: 200,
  /** |d rpm / dt| above this (rpm/s) is a shift or clutch event, not a pull. */
  maxRpmRate: 2500,
  /** Pedal below this with rpm above fuelCutRpm = overrun fuel cut. */
  fuelCutPedalPct: 1,
  fuelCutRpm: 1300
}

export interface MaskResult {
  mask: Uint8Array
  /** Filters that were requested but could not be applied (missing channel). */
  unavailable: string[]
}

export function buildMask(ch: FilterChannels, f: HeatmapFilters): MaskResult {
  const n = ch.t.length
  const mask = new Uint8Array(n).fill(1)
  const unavailable: string[] = []
  const L = FILTER_LIMITS
  const drop = (test: (i: number) => boolean): void => {
    for (let i = 0; i < n; i++) if (mask[i] && test(i)) mask[i] = 0
  }
  if (f.range) {
    const [a, b] = f.range
    drop((i) => ch.t[i] < a || ch.t[i] > b)
  }
  if (f.warm) {
    if (ch.coolantC) drop((i) => !(ch.coolantC![i] >= L.warmTempC))
    else unavailable.push('Warm engine (no coolant temperature)')
  }
  if (f.throttle !== 'all') {
    if (ch.pedalPct) {
      const wot = (i: number): boolean => ch.pedalPct![i] >= L.wotPedalPct
      drop((i) => (f.throttle === 'wot' ? !wot(i) : wot(i)))
    } else unavailable.push('Throttle (no pedal channel)')
  }
  if (f.excludeFuelCut) {
    if (ch.pedalPct && ch.rpm) drop((i) => ch.pedalPct![i] < L.fuelCutPedalPct && ch.rpm![i] > L.fuelCutRpm)
    else unavailable.push('Exclude fuel cut (no pedal or rpm channel)')
  }
  if (f.gear !== null) {
    if (ch.gear) drop((i) => Math.round(ch.gear![i]) !== f.gear)
    else unavailable.push('Gear (no gear channel)')
  }
  if (f.excludeTransients) {
    if (ch.load || ch.rpm) {
      const loadRate = ch.load ? derivative(ch.t, ch.load, 0.3) : undefined
      const rpmRate = ch.rpm ? derivative(ch.t, ch.rpm, 0.3) : undefined
      drop((i) => Math.abs(loadRate?.[i] ?? 0) > L.maxLoadRate || Math.abs(rpmRate?.[i] ?? 0) > L.maxRpmRate)
    } else unavailable.push('Exclude transients (no load or rpm channel)')
  }
  return { mask, unavailable }
}
