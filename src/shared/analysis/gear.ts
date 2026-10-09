// Gear detection: from a gear channel when the log has one, otherwise from the
// engine-speed / road-speed ratio, which is constant within a gear.

import type { GearChange } from '@shared/types'

/** Below this road speed the ratio is unreliable (clutch / converter slip, speed quantisation). */
const RATIO_MIN_SPEED_KMH = 15
/** Samples slower than this are not assigned an estimated gear. */
const GEAR_MIN_SPEED_KMH = 10
const RATIO_MIN_RPM = 600
/** Max |Δ ln(ratio)| to both neighbours for a sample to count as "in gear". */
const STABLE_LOG_DELTA = 0.02
/** Half-width (ln units, ≈ ±2 %) of the density window used for mode seeking. */
const DENSITY_BAND = 0.02
/** Half-width (ln units, ≈ ±8 %) cleared around a found gear; gear steps are ≥ ~12 %. */
const EXCLUSION_BAND = 0.08
/** Max distance (ln units, ≈ ±6 %) from a gear's ratio for a sample to be assigned to it. */
const MATCH_BAND = 0.06
const MIN_CLUSTER_POINTS = 8
/** A new gear must be held this long to count as a gear change. */
const DEFAULT_MIN_HOLD_SEC = 0.3

/** True when a gear channel carries at least one engaged gear (≥ 1). */
export function isGearChannelUsable(gear?: Float64Array): gear is Float64Array {
  return gear !== undefined && gear.some((g) => g >= 0.5)
}

function logRatio(rpm: Float64Array, speedKmh: Float64Array, i: number): number {
  const r = rpm[i]
  const s = speedKmh[i]
  return s > RATIO_MIN_SPEED_KMH && r > RATIO_MIN_RPM ? Math.log(r / s) : NaN
}

/**
 * Estimates the overall gear ratios present in a log as engine rpm per km/h,
 * sorted from the lowest gear (highest rpm/km/h) to the highest.
 *
 * Only "stable" samples are used: speed above ~15 km/h and a ratio that agrees
 * within 2 % with both neighbours (rejects shifts and slip). Ratios are
 * clustered in log space by greedy mode seeking: the densest ±2 % band becomes
 * a gear (its median), ±8 % around it is cleared, and this repeats while a band
 * holds at least max(8, 3 % of the stable samples).
 */
export function estimateGearRatios(rpm: Float64Array, speedKmh: Float64Array): number[] {
  const n = Math.min(rpm.length, speedKmh.length)
  const values: number[] = []
  for (let i = 1; i < n - 1; i++) {
    const x = logRatio(rpm, speedKmh, i)
    if (!Number.isFinite(x)) continue
    const before = logRatio(rpm, speedKmh, i - 1)
    const after = logRatio(rpm, speedKmh, i + 1)
    if (Math.abs(x - before) <= STABLE_LOG_DELTA && Math.abs(x - after) <= STABLE_LOG_DELTA) values.push(x)
  }
  const minCount = Math.max(MIN_CLUSTER_POINTS, Math.round(0.03 * values.length))
  if (values.length < minCount) return []
  values.sort((a, b) => a - b)

  const alive = new Uint8Array(values.length).fill(1)
  const centers: number[] = []
  for (;;) {
    // Densest band among remaining values (two pointers over the sorted array).
    let best = -1
    let bestCount = 0
    let lo = 0
    let hi = 0
    let inBand = 0
    for (let i = 0; i < values.length; i++) {
      while (hi < values.length && values[hi] <= values[i] + DENSITY_BAND) inBand += alive[hi++]
      while (values[lo] < values[i] - DENSITY_BAND) inBand -= alive[lo++]
      if (alive[i] && inBand > bestCount) {
        bestCount = inBand
        best = i
      }
    }
    if (best < 0 || bestCount < minCount) break
    const members: number[] = []
    for (let i = 0; i < values.length; i++) {
      if (alive[i] && Math.abs(values[i] - values[best]) <= DENSITY_BAND) members.push(values[i])
    }
    const center = members[members.length >> 1] // members are sorted: this is the median
    centers.push(center)
    for (let i = 0; i < values.length; i++) if (Math.abs(values[i] - center) <= EXCLUSION_BAND) alive[i] = 0
  }
  return centers.map(Math.exp).sort((a, b) => b - a)
}

/**
 * Per-sample gear. A usable gear channel is preferred (rounded; values below
 * 1 such as neutral/park become NaN). Otherwise each sample above 10 km/h is
 * assigned to the nearest estimated ratio within ±6 % and numbered 1…k in
 * order of decreasing ratio — an ordinal among the gears seen in the data,
 * which equals the real gear number only when the lowest gear appears.
 * Samples that match no gear are NaN.
 */
export function gearSeries(rpm: Float64Array, speedKmh: Float64Array, gearChannel?: Float64Array): Float64Array {
  if (isGearChannelUsable(gearChannel)) return gearChannel.map((g) => (g >= 0.5 ? Math.round(g) : NaN))
  const n = Math.min(rpm.length, speedKmh.length)
  const out = new Float64Array(n).fill(NaN)
  const centers = estimateGearRatios(rpm, speedKmh).map(Math.log)
  if (centers.length === 0) return out
  for (let i = 0; i < n; i++) {
    const s = speedKmh[i]
    const r = rpm[i]
    if (!(s > GEAR_MIN_SPEED_KMH && r > 0)) continue
    const x = Math.log(r / s)
    let bestGear = NaN
    let bestDist = MATCH_BAND
    centers.forEach((c, k) => {
      const d = Math.abs(x - c)
      if (d <= bestDist) {
        bestDist = d
        bestGear = k + 1
      }
    })
    out[i] = bestGear
  }
  return out
}

/**
 * Gear changes in a per-sample gear series. A new gear only counts once it has
 * been observed for at least `minHoldSec` without the previous gear
 * reappearing, which suppresses flicker while shifting. NaN samples neither
 * confirm nor cancel a pending change. The change is stamped with the time and
 * speed of the first sample in the new gear.
 */
export function detectGearChanges(
  t: Float64Array,
  gear: Float64Array,
  speedKmh: Float64Array,
  minHoldSec = DEFAULT_MIN_HOLD_SEC
): GearChange[] {
  const n = Math.min(t.length, gear.length)
  const changes: GearChange[] = []
  let confirmed = NaN
  let candidate = NaN
  let candidateIdx = -1
  for (let i = 0; i < n; i++) {
    const g = gear[i]
    if (!Number.isFinite(g)) continue
    if (g === confirmed) {
      candidate = NaN
      continue
    }
    if (g !== candidate) {
      candidate = g
      candidateIdx = i
    }
    if (t[i] - t[candidateIdx] >= minHoldSec) {
      if (Number.isFinite(confirmed)) {
        changes.push({ from: confirmed, to: candidate, time: t[candidateIdx], speedKmh: speedKmh[candidateIdx] })
      }
      confirmed = candidate
      candidate = NaN
    }
  }
  return changes
}
