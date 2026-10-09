// Time-aware signal helpers for irregularly sampled logs. All functions take a
// monotonic (non-decreasing) time base in seconds and tolerate NaN samples.

/** Small tolerance so window edges that land exactly on a sample include it on both sides. */
const EDGE_EPS = 1e-9

/** First index i with t[i] ≥ tq (t.length when none). */
export function lowerBound(t: ArrayLike<number>, tq: number): number {
  let lo = 0
  let hi = t.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (t[mid] < tq) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** First index i with t[i] > tq (t.length when none). */
export function upperBound(t: ArrayLike<number>, tq: number): number {
  let lo = 0
  let hi = t.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (t[mid] <= tq) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Centered moving average over a time window of `windowSec` seconds
 * (samples with |t_j − t_i| ≤ windowSec/2). NaN samples are skipped; the
 * output is NaN only where the whole window is NaN. windowSec ≤ 0 copies.
 * O(n) sliding sums.
 */
export function movingAverage(t: Float64Array, y: Float64Array, windowSec: number): Float64Array {
  const n = Math.min(t.length, y.length)
  const out = new Float64Array(n)
  if (!(windowSec > 0)) {
    out.set(y.subarray(0, n))
    return out
  }
  const half = windowSec / 2 + EDGE_EPS
  let lo = 0
  let hi = 0 // window is [lo, hi)
  let sum = 0
  let count = 0
  for (let i = 0; i < n; i++) {
    while (hi < n && t[hi] <= t[i] + half) {
      const v = y[hi++]
      if (Number.isFinite(v)) {
        sum += v
        count++
      }
    }
    while (t[lo] < t[i] - half) {
      const v = y[lo++]
      if (Number.isFinite(v)) {
        sum -= v
        if (--count === 0) sum = 0 // drop accumulated rounding error
      }
    }
    out[i] = count > 0 ? sum / count : NaN
  }
  return out
}

/**
 * First derivative dy/dt by local linear least squares over a centered window
 * of `windowSec` seconds (a first-order Savitzky–Golay filter generalised to
 * irregular sampling):
 *
 *   slope_i = (N·Σxy − Σx·Σy) / (N·Σx² − (Σx)²),  x = t_j − t_i
 *
 * The window always contains at least one neighbour on each side (where one
 * exists), so windowSec = 0 degrades to a central difference. Windows are
 * truncated at the ends of the signal. NaN samples are skipped.
 */
export function derivative(t: Float64Array, y: Float64Array, windowSec: number): Float64Array {
  const n = Math.min(t.length, y.length)
  const out = new Float64Array(n).fill(NaN)
  const half = Math.max(0, windowSec) / 2 + EDGE_EPS
  let lo = 0
  let hi = 0
  for (let i = 0; i < n; i++) {
    while (lo < i - 1 && t[lo] < t[i] - half) lo++
    if (hi < Math.min(i + 1, n - 1)) hi = Math.min(i + 1, n - 1)
    while (hi + 1 < n && t[hi + 1] <= t[i] + half) hi++
    let sw = 0
    let sx = 0
    let sy = 0
    let sxx = 0
    let sxy = 0
    for (let j = lo; j <= hi; j++) {
      const v = y[j]
      if (!Number.isFinite(v)) continue
      const x = t[j] - t[i]
      sw++
      sx += x
      sy += v
      sxx += x * x
      sxy += x * v
    }
    const den = sw * sxx - sx * sx
    if (sw >= 2 && den > 0) out[i] = (sw * sxy - sx * sy) / den
  }
  return out
}

/** Linear interpolation of y at time tq; NaN outside [t0, tn] or for empty input. */
export function interpolateAt(t: Float64Array, y: Float64Array, tq: number): number {
  const n = Math.min(t.length, y.length)
  if (n === 0 || !(tq >= t[0]) || !(tq <= t[n - 1])) return NaN
  const hi = lowerBound(t, tq) // ≤ n − 1 because tq ≤ t[n − 1]
  if (t[hi] === tq) return y[hi]
  const lo = hi - 1
  return y[lo] + ((y[hi] - y[lo]) * (tq - t[lo])) / (t[hi] - t[lo])
}

/**
 * First upward crossing of `threshold` at or after `fromIdx`: the first finite
 * sample `index` with y ≥ threshold whose previous finite sample is below it.
 * `time` is linearly interpolated between the two samples. A signal that is
 * already above the threshold at `fromIdx` must first drop below it.
 */
export function findCrossing(
  t: Float64Array,
  y: Float64Array,
  threshold: number,
  fromIdx = 0
): { index: number; time: number } | null {
  const n = Math.min(t.length, y.length)
  let prev = -1
  for (let i = Math.max(0, fromIdx); i < n; i++) {
    const v = y[i]
    if (!Number.isFinite(v)) continue
    if (prev >= 0 && y[prev] < threshold && v >= threshold) {
      const time = t[prev] + ((threshold - y[prev]) / (v - y[prev])) * (t[i] - t[prev])
      return { index: i, time }
    }
    prev = i
  }
  return null
}

/** Time of the first upward crossing (see findCrossing), or null. */
export function crossingTime(t: Float64Array, y: Float64Array, threshold: number, fromIdx = 0): number | null {
  return findCrossing(t, y, threshold, fromIdx)?.time ?? null
}

/** Resamples y onto a uniform grid at `hz` from t[0] to t[n−1] by linear interpolation. */
export function resampleUniform(
  t: Float64Array,
  y: Float64Array,
  hz: number
): { t: Float64Array; y: Float64Array } {
  const n = Math.min(t.length, y.length)
  if (n === 0 || !(hz > 0)) return { t: new Float64Array(0), y: new Float64Array(0) }
  const t0 = t[0]
  const m = Math.floor((t[n - 1] - t0) * hz + EDGE_EPS) + 1
  const tu = new Float64Array(m)
  const yu = new Float64Array(m)
  let k = 0
  for (let j = 0; j < m; j++) {
    const tq = t0 + j / hz
    while (k < n - 2 && t[k + 1] <= tq) k++
    tu[j] = tq
    const dt = t[k + 1] - t[k]
    if (n === 1 || tq <= t[k]) yu[j] = y[k]
    else if (!(dt > 0) || tq >= t[k + 1]) yu[j] = y[k + 1]
    else yu[j] = y[k] + ((y[k + 1] - y[k]) * (tq - t[k])) / dt
  }
  return { t: tu, y: yu }
}
