// Drag timing: 0–100 / 0–60 mph, rolling 100–200 / 200–300 / 60–130 mph and
// 1/8 / 1/4 mile, with speed splits, gear changes and ECU → GPS speed calibration.

import {
  CH,
  type DragEnvironment,
  type DragInput,
  type DragMode,
  type DragResult,
  type DragSplit,
  type GearChange,
  type LogData,
  type SpeedCalPoint
} from '@shared/types'
import { channelInUnit } from './channelLookup'
import { detectGearChanges, gearSeries } from './gear'
import { findCrossing, interpolateAt, upperBound } from './smoothing'

const KMH_PER_MPH = 1.609344

export interface DragModeSpec {
  /** Standing start from 0, or rolling start through fromKmh. */
  standing: boolean
  fromKmh: number
  /** Finish speed (speed modes). */
  toKmh?: number
  /** Finish distance in metres (distance modes). */
  distanceM?: number
  /** Split interval in km/h. */
  stepKmh: number
}

export const DRAG_MODES: Readonly<Record<DragMode, DragModeSpec>> = {
  '0-100': { standing: true, fromKmh: 0, toKmh: 100, stepKmh: 10 },
  '0-60mph': { standing: true, fromKmh: 0, toKmh: 60 * KMH_PER_MPH, stepKmh: 10 * KMH_PER_MPH },
  '100-200': { standing: false, fromKmh: 100, toKmh: 200, stepKmh: 10 },
  '200-300': { standing: false, fromKmh: 200, toKmh: 300, stepKmh: 10 },
  '60-130mph': { standing: false, fromKmh: 60 * KMH_PER_MPH, toKmh: 130 * KMH_PER_MPH, stepKmh: 10 * KMH_PER_MPH },
  '201m': { standing: true, fromKmh: 0, distanceM: 201.168, stepKmh: 10 },
  '402m': { standing: true, fromKmh: 0, distanceM: 402.336, stepKmh: 10 }
}

export interface DragOptions {
  /** ECU → GPS speed calibration points. */
  calibration?: SpeedCalPoint[]
  /** Recorded with the result for reference. */
  environment?: DragEnvironment
  /** Calibrated speed (km/h) above which a standing start counts as launched. Default 1. */
  launchThresholdKmh?: number
}

const DEFAULT_LAUNCH_THRESHOLD_KMH = 1.0
/** A fall of this much below the run's maximum speed ends the run unfinished. */
const DROP_TOLERANCE_KMH = 3
/** Samples at or below this speed are standing still (launch time cannot precede them). */
const STANDSTILL_KMH = 0.1
/** Data after the launch crossing used to estimate the initial acceleration. */
const LAUNCH_FIT_SEC = 0.5
const LAUNCH_FIT_KMH = 15
/** Back-extrapolation from the launch threshold to 0 km/h is limited to this. */
const MAX_LAUNCH_BACKTRACK_SEC = 1.0
/** Upper bound for speed splits of distance modes. */
const MAX_SPLIT_KMH = 500

// ------------------------------------------------------------------ calibration

/**
 * Calibration function: the GPS/ECU ratio is interpolated linearly between
 * the points (sorted by ECU speed) and held flat beyond the first/last point;
 * the result is ecu · ratio. Points with non-positive speeds are ignored.
 * Without points the speed is returned unchanged.
 */
export function speedCalibrator(points: SpeedCalPoint[]): (kmh: number) => number {
  const pts = points
    .filter((p) => p.ecu > 0 && p.gps > 0 && Number.isFinite(p.ecu) && Number.isFinite(p.gps))
    .sort((a, b) => a.ecu - b.ecu)
  if (pts.length === 0) return (kmh) => kmh
  const xs = pts.map((p) => p.ecu)
  const ratios = pts.map((p) => p.gps / p.ecu)
  const last = pts.length - 1
  return (kmh) => {
    if (kmh <= xs[0]) return kmh * ratios[0]
    if (kmh >= xs[last]) return kmh * ratios[last]
    let k = 0
    while (xs[k + 1] < kmh) k++
    const span = xs[k + 1] - xs[k]
    const ratio = span > 0 ? ratios[k] + ((ratios[k + 1] - ratios[k]) * (kmh - xs[k])) / span : ratios[k + 1]
    return kmh * ratio
  }
}

/** Applies a speed calibration (see speedCalibrator) to a whole series. */
export function calibrateSpeed(rawKmh: Float64Array, points: SpeedCalPoint[]): Float64Array {
  return rawKmh.map(speedCalibrator(points))
}

// ------------------------------------------------------------------ analysis

type RunStatus = 'finished' | 'dropped' | 'stopped' | 'ended'

interface RunMeasurement {
  status: RunStatus
  /** Finish time in the input time base. */
  finishT: number | null
  trapKmh: number | null
  distanceM: number
  maxKmh: number
  /** Last sample index belonging to the run (first sample at/after the finish when finished). */
  endIdx: number
  splits: DragSplit[]
  /** 0…1 towards the target; 1 when finished. */
  progress: number
}

interface RunStart {
  startT: number
  startKmh: number
  /** First sample after the start. */
  firstIdx: number
}

/** Split speeds: every stepKmh from fromKmh + step up to the target (its last value is the target). */
function splitSpeeds(spec: DragModeSpec): number[] {
  if (spec.toKmh === undefined) {
    const count = Math.floor((MAX_SPLIT_KMH - spec.fromKmh) / spec.stepKmh)
    return Array.from({ length: count }, (_, k) => spec.fromKmh + (k + 1) * spec.stepKmh)
  }
  const count = Math.max(1, Math.round((spec.toKmh - spec.fromKmh) / spec.stepKmh))
  const speeds = Array.from({ length: count }, (_, k) => spec.fromKmh + (k + 1) * spec.stepKmh)
  speeds[count - 1] = spec.toKmh
  return speeds
}

/**
 * Follows a run from its start point along the calibrated samples, assuming
 * speed varies linearly between samples: distance is the trapezoidal integral
 * (exact for constant acceleration); the finish time is interpolated within
 * the sample interval (for distance modes by solving the quadratic distance
 * equation of that interval).
 */
function measureRun(
  t: Float64Array,
  cal: Float64Array,
  spec: DragModeSpec,
  start: RunStart,
  splitAt: number[],
  launchThresholdKmh: number
): RunMeasurement {
  const { startT, startKmh } = start
  const n = Math.min(t.length, cal.length)
  const splits: DragSplit[] = []
  let prevT = startT
  let prevV = startKmh
  let distanceM = 0
  let maxKmh = startKmh
  let endIdx = start.firstIdx
  let status: RunStatus = 'ended'
  let finishT: number | null = null
  let trapKmh: number | null = null

  for (let i = start.firstIdx; i < n; i++) {
    const v = cal[i]
    if (!Number.isFinite(v)) continue
    const dt = t[i] - prevT
    const stepM = (((prevV + v) / 2) * dt) / 3.6
    endIdx = i
    if (spec.toKmh !== undefined && v >= spec.toKmh) {
      finishT = prevV < spec.toKmh ? prevT + ((spec.toKmh - prevV) / (v - prevV)) * dt : prevT
      distanceM += (((prevV + spec.toKmh) / 2) * (finishT - prevT)) / 3.6
      trapKmh = spec.toKmh
      status = 'finished'
    } else if (spec.distanceM !== undefined && distanceM + stepM >= spec.distanceM) {
      const tau = timeToCover(spec.distanceM - distanceM, prevV / 3.6, v / 3.6, dt)
      finishT = prevT + tau
      trapKmh = dt > 0 ? prevV + ((v - prevV) * tau) / dt : v
      distanceM = spec.distanceM
      status = 'finished'
    }
    // Splits crossed within this interval (and before the finish).
    while (splits.length < splitAt.length && v >= splitAt[splits.length]) {
      const s = splitAt[splits.length]
      const ts = prevV < s ? prevT + ((s - prevV) / (v - prevV)) * dt : prevT
      if (finishT !== null && ts > finishT + 1e-9) break
      splits.push({ speedKmh: s, time: ts - startT })
    }
    if (status === 'finished') break

    distanceM += stepM
    if (v < maxKmh - DROP_TOLERANCE_KMH) {
      status = 'dropped'
      break
    }
    if (spec.standing && maxKmh > launchThresholdKmh && v <= launchThresholdKmh) {
      status = 'stopped'
      break
    }
    if (v > maxKmh) maxKmh = v
    prevT = t[i]
    prevV = v
  }

  let progress = 1
  if (status !== 'finished') {
    progress =
      spec.toKmh !== undefined
        ? (maxKmh - spec.fromKmh) / (spec.toKmh - spec.fromKmh)
        : distanceM / (spec.distanceM ?? 1)
  }
  return { status, finishT, trapKmh, distanceM, maxKmh, endIdx, splits, progress }
}

/**
 * Time τ ∈ [0, dt] to cover `remaining` metres when speed goes linearly from
 * v0 to v1 (m/s) over dt: v0·τ + ½·k·τ² = remaining, k = (v1 − v0)/dt.
 */
function timeToCover(remaining: number, v0: number, v1: number, dt: number): number {
  if (!(dt > 0)) return 0
  const k = (v1 - v0) / dt
  if (Math.abs(k) < 1e-9) return v0 > 0 ? Math.min(dt, remaining / v0) : dt
  const disc = v0 * v0 + 2 * k * remaining
  const tau = (-v0 + Math.sqrt(Math.max(0, disc))) / k
  return Math.min(Math.max(tau, 0), dt)
}

/**
 * Launch time of a standing start. The launch-threshold crossing between
 * samples s (≤ threshold) and j (> threshold) is interpolated, then
 * extrapolated back to 0 km/h using the initial acceleration (least-squares
 * slope over ≤ 0.5 s / +15 km/h after the crossing). The result never
 * precedes the last standstill sample nor lies more than 1 s before the crossing.
 */
function launchTime(t: Float64Array, cal: Float64Array, s: number, j: number, threshold: number): number {
  const tc = t[s] + ((threshold - cal[s]) / (cal[j] - cal[s])) * (t[j] - t[s])
  let sw = 1 // the crossing point itself: x = 0, y = threshold
  let sx = 0
  let sy = threshold
  let sxx = 0
  let sxy = 0
  const n = Math.min(t.length, cal.length)
  for (let i = j; i < n; i++) {
    const v = cal[i]
    if (!Number.isFinite(v)) continue
    const x = t[i] - tc
    if (i > j && (x > LAUNCH_FIT_SEC || v > threshold + LAUNCH_FIT_KMH)) break
    sw++
    sx += x
    sy += v
    sxx += x * x
    sxy += x * v
  }
  const den = sw * sxx - sx * sx
  const slope = den > 0 ? (sw * sxy - sx * sy) / den : NaN
  let t0 = slope > 0 ? tc - threshold / slope : tc
  t0 = Math.max(t0, tc - MAX_LAUNCH_BACKTRACK_SEC)
  for (let k = s; k >= 0 && t[k] >= tc - MAX_LAUNCH_BACKTRACK_SEC; k--) {
    if (cal[k] <= STANDSTILL_KMH) {
      t0 = Math.max(t0, t[k])
      break
    }
  }
  return Math.min(t0, tc)
}

function nextFinite(y: Float64Array, from: number, n: number): number {
  for (let i = from; i < n; i++) if (Number.isFinite(y[i])) return i
  return -1
}

/** Candidate run starts in order of time. */
function runStarts(t: Float64Array, cal: Float64Array, spec: DragModeSpec, threshold: number): RunStart[] {
  const n = Math.min(t.length, cal.length)
  const starts: RunStart[] = []
  if (spec.standing) {
    // Every point where the speed leaves standstill (≤ threshold → > threshold).
    for (let s = 0; s < n; s++) {
      if (!(cal[s] <= threshold)) continue
      const j = nextFinite(cal, s + 1, n)
      if (j < 0) break
      if (cal[j] <= threshold) continue
      const startT = launchTime(t, cal, s, j, threshold)
      starts.push({ startT, startKmh: 0, firstIdx: upperBound(t, startT) })
    }
  } else {
    for (let c = findCrossing(t, cal, spec.fromKmh, 0); c; c = findCrossing(t, cal, spec.fromKmh, c.index)) {
      starts.push({ startT: c.time, startKmh: spec.fromKmh, firstIdx: c.index })
    }
  }
  return starts
}

const fmt1 = (v: number): string => (Math.round(v * 10) / 10).toString()

/**
 * Times a drag run. The first run that reaches the target is used; when none
 * does, the run that got closest is reported unfinished with a warning.
 *
 * Standing modes start where the calibrated speed last leaves standstill: the
 * launch-threshold crossing back-extrapolated to 0 km/h. Rolling modes start
 * at the upward crossing of the lower speed. Splits are taken every 10 km/h
 * (10 mph for mph modes) from the start speed; distance modes finish at
 * 201.168 / 402.336 m with the interpolated trap speed. A speed drop of more
 * than 3 km/h below the run's maximum ends the run unfinished.
 */
export function analyzeDrag(input: DragInput, mode: DragMode, opts: DragOptions = {}): DragResult {
  const spec = DRAG_MODES[mode]
  const threshold = opts.launchThresholdKmh ?? DEFAULT_LAUNCH_THRESHOLD_KMH
  const n = Math.min(input.t.length, input.speedKmh.length)
  const t = input.t.subarray(0, n)
  const raw = input.speedKmh.subarray(0, n)
  const cal = calibrateSpeed(raw, opts.calibration ?? [])
  const warnings: string[] = []
  const base = {
    mode,
    ...(opts.environment ? { environment: opts.environment } : {}),
    warnings
  }
  const unfinished = (message: string): DragResult => {
    warnings.push(message)
    return {
      ...base,
      finished: false,
      finalTime: null,
      distanceM: 0,
      trapSpeedKmh: null,
      startT: n > 0 ? t[0] : 0,
      splits: [],
      gearChanges: [],
      curve: { t: [], raw: [], calibrated: [] }
    }
  }
  if (n < 2) return unfinished('Not enough samples')

  const splitAt = splitSpeeds(spec)
  let chosen: { start: RunStart; run: RunMeasurement } | undefined
  for (const start of runStarts(t, cal, spec, threshold)) {
    const run = measureRun(t, cal, spec, start, splitAt, threshold)
    if (!chosen || run.status === 'finished' || run.progress > chosen.run.progress) chosen = { start, run }
    if (run.status === 'finished') break
  }
  if (!chosen) {
    return unfinished(
      spec.standing
        ? `No standing start found (speed never at or below ${fmt1(threshold)} km/h before accelerating)`
        : `Speed never rose through ${fmt1(spec.fromKmh)} km/h`
    )
  }
  const { start, run } = chosen
  if (run.status !== 'finished') {
    if (run.status === 'dropped') warnings.push(`Speed dropped during the run after reaching ${fmt1(run.maxKmh)} km/h`)
    else if (run.status === 'stopped') warnings.push('The vehicle came to a stop again before finishing')
    else if (spec.toKmh !== undefined) {
      warnings.push(`Target speed ${fmt1(spec.toKmh)} km/h not reached (max ${fmt1(run.maxKmh)} km/h)`)
    } else {
      warnings.push(`Finish distance ${fmt1(spec.distanceM ?? 0)} m not reached (${fmt1(run.distanceM)} m covered)`)
    }
  }

  const curve = {
    t: [0],
    raw: [spec.standing ? 0 : interpolateAt(t, raw, start.startT)],
    calibrated: [start.startKmh]
  }
  for (let i = start.firstIdx; i <= run.endIdx; i++) {
    if (!Number.isFinite(cal[i])) continue
    curve.t.push(t[i] - start.startT)
    curve.raw.push(raw[i])
    curve.calibrated.push(cal[i])
  }

  const endT = run.finishT ?? t[run.endIdx]
  let gearChanges: GearChange[] = []
  if (input.gear || input.rpm) {
    const rpm = input.rpm ? input.rpm.subarray(0, n) : new Float64Array(n).fill(NaN)
    const gear = gearSeries(rpm, raw, input.gear?.subarray(0, n))
    gearChanges = detectGearChanges(t, gear, cal)
      .filter((c) => c.time >= start.startT && c.time <= endT)
      .map((c) => ({ ...c, time: c.time - start.startT }))
  }

  return {
    ...base,
    finished: run.status === 'finished',
    finalTime: run.finishT !== null ? run.finishT - start.startT : null,
    distanceM: run.distanceM,
    trapSpeedKmh: run.trapKmh,
    startT: start.startT,
    splits: run.splits,
    gearChanges,
    curve
  }
}

// ------------------------------------------------------------------ live arming

export type DragDetectorState = 'waiting-stop' | 'ready' | 'running' | 'finished' | 'aborted'

/** Standing modes arm only after the speed has been at or below this. */
const STOP_KMH = 0.5
/** Samples kept from before the start. */
const PRE_ROLL_SEC = 2.0
const RUN_TIMEOUT_SEC = 120

/**
 * Live run detector. States:
 * - 'waiting-stop': standing modes wait for ≤ 0.5 km/h; rolling modes wait for
 *   the speed to be below the start speed.
 * - 'ready': armed; a standing run starts above the launch threshold, a
 *   rolling run when the start speed is crossed.
 * - 'running': until the target speed/distance is reached ('finished'), the
 *   speed drops more than 3 km/h below its maximum or the run exceeds 120 s
 *   ('aborted'). A standing run that falls back to the launch threshold
 *   (creeping) returns to waiting.
 * input() returns the buffered samples (≥ 2 s pre-roll + run) for analyzeDrag.
 */
export class DragDetector {
  readonly mode: DragMode
  private readonly spec: DragModeSpec
  private readonly calibrate: (kmh: number) => number
  private readonly threshold: number
  private status: DragDetectorState = 'waiting-stop'
  private t: number[] = []
  private speed: number[] = []
  private gear: number[] = []
  private rpm: number[] = []
  private hasGear = false
  private hasRpm = false
  private runStartT = NaN
  private maxKmh = 0
  private distanceM = 0
  private prevT = NaN
  private prevKmh = NaN

  constructor(mode: DragMode, opts: DragOptions = {}) {
    this.mode = mode
    this.spec = DRAG_MODES[mode]
    this.calibrate = speedCalibrator(opts.calibration ?? [])
    this.threshold = opts.launchThresholdKmh ?? DEFAULT_LAUNCH_THRESHOLD_KMH
  }

  get state(): DragDetectorState {
    return this.status
  }

  push(t: number, speedKmh: number, gear?: number, rpm?: number): DragDetectorState {
    if (this.status === 'finished' || this.status === 'aborted') return this.status
    this.t.push(t)
    this.speed.push(speedKmh)
    this.gear.push(gear ?? NaN)
    this.rpm.push(rpm ?? NaN)
    if (gear !== undefined && Number.isFinite(gear)) this.hasGear = true
    if (rpm !== undefined && Number.isFinite(rpm)) this.hasRpm = true
    const v = this.calibrate(speedKmh)
    if (!Number.isFinite(v)) return this.status
    const { standing, fromKmh, toKmh, distanceM } = this.spec

    switch (this.status) {
      case 'waiting-stop':
        this.trimPreRoll(t)
        if (standing ? v <= STOP_KMH : v < fromKmh) this.status = 'ready'
        break
      case 'ready':
        this.trimPreRoll(t)
        if (standing ? v > this.threshold : v >= fromKmh) {
          this.status = 'running'
          this.runStartT = t
          this.maxKmh = v
          this.distanceM = 0
          this.prevT = t
          this.prevKmh = v
        }
        break
      case 'running':
        this.distanceM += (((this.prevKmh + v) / 2) * (t - this.prevT)) / 3.6
        this.prevT = t
        this.prevKmh = v
        if ((toKmh !== undefined && v >= toKmh) || (distanceM !== undefined && this.distanceM >= distanceM)) {
          this.status = 'finished'
        } else if (v < this.maxKmh - DROP_TOLERANCE_KMH || t - this.runStartT > RUN_TIMEOUT_SEC) {
          this.status = 'aborted'
        } else if (standing && v <= this.threshold) {
          this.status = v <= STOP_KMH ? 'ready' : 'waiting-stop'
        }
        if (v > this.maxKmh) this.maxKmh = v
        break
    }
    return this.status
  }

  /** Buffered samples (raw ECU speed) for analyzeDrag. */
  input(): DragInput {
    const out: DragInput = { t: Float64Array.from(this.t), speedKmh: Float64Array.from(this.speed) }
    if (this.hasGear) out.gear = Float64Array.from(this.gear)
    if (this.hasRpm) out.rpm = Float64Array.from(this.rpm)
    return out
  }

  /** Discards everything and starts waiting again. */
  reset(): void {
    this.status = 'waiting-stop'
    this.t = []
    this.speed = []
    this.gear = []
    this.rpm = []
    this.hasGear = false
    this.hasRpm = false
  }

  private trimPreRoll(now: number): void {
    let k = 0
    while (k < this.t.length && this.t[k] < now - PRE_ROLL_SEC) k++
    if (k === 0) return
    for (const buf of [this.t, this.speed, this.gear, this.rpm]) buf.splice(0, k)
  }
}

/** Drag input from a log (speed converted to km/h). Null without a speed channel. */
export function dragInputFromLog(log: LogData): DragInput | null {
  const speedKmh = channelInUnit(log, CH.speed, 'km/h')
  if (!speedKmh) return null
  const input: DragInput = { t: log.time, speedKmh }
  const gear = channelInUnit(log, CH.gear, 'gear')
  const rpm = channelInUnit(log, CH.rpm, 'rpm')
  if (gear) input.gear = gear
  if (rpm) input.rpm = rpm
  return input
}
