// Road dyno: estimates wheel power, engine power and torque versus engine
// speed from a wide-open-throttle pull in a single gear.
//
// Physics (per sample, SI units):
//   v  = smoothed road speed (m/s), a = dv/dt
//   F  = m·a + ½·ρ·CdA·v² + Crr·m·g            tractive force at the wheels
//   P_wheel  = F·v
//   P_engine = P_wheel / (1 − drivetrain loss)
//   both multiplied by the selected SAE/DIN correction factor
//   T_engine = P_engine / ω,  ω = 2π·rpm/60
// Rotating inertia is not modelled separately; it shows up as part of the
// drivetrain loss (or can be accounted for by raising the mass).

import { CH, type DynoInput, type DynoPoint, type DynoResult, type DynoSetup, type LogData, type WotSegment } from '@shared/types'
import { airDensity, correctionFactor } from './air'
import { channelInUnit } from './channelLookup'
import { gearSeries, isGearChannelUsable } from './gear'
import { derivative, lowerBound, movingAverage, upperBound } from './smoothing'
import { findWotRuns } from './wot'

export const DEFAULT_DYNO_SETUP: DynoSetup = {
  massKg: 1835,
  drivetrainLossPct: 15,
  startRpm: 2000,
  endRpm: 6500,
  minPedalPct: 85,
  smoothingSec: 0.5,
  ambientTempC: 20,
  humidityPct: 50,
  baroHpa: 1013,
  cdA: 0.65,
  crr: 0.012,
  correction: 'none'
}

const G = 9.80665
/** Width of the rpm bins of the output curve. */
const RPM_BIN = 50
/** Fewer samples than this in the analysed range triggers a warning. */
const MIN_SAMPLES = 20
/** An rpm fall of this much below the running maximum ends the pull (shift / traction loss). */
const SHIFT_RPM_DROP = 250
/** Slack when checking whether the pull covers the requested rpm range. */
const RANGE_TOLERANCE_RPM = 100
const WOT_MERGE_GAP_SEC = 0.25
const MAX_LOSS_PCT = 80

interface PullWindow {
  /** Inclusive sample range of the single-gear WOT window used for smoothing. */
  start: number
  end: number
  gear: number
  /** Inclusive sample range rising from startRpm up to endRpm (or the rpm peak). */
  iStart: number
  iEnd: number
  rpmLo: number
  rpmHi: number
  coveredRpm: number
  /** The WOT run held more than one gear, or rpm fell back mid-pull. */
  gearChange: boolean
}

/** Analyses the best single-gear WOT pull in `input`. Never throws; problems go to `warnings`. */
export function analyzeDyno(input: DynoInput, setup: DynoSetup): DynoResult {
  const warnings: string[] = []
  const rho = airDensity(setup.ambientTempC, setup.baroHpa, setup.humidityPct)
  const cf = correctionFactor(setup.correction, setup.ambientTempC, setup.baroHpa, setup.humidityPct)
  const n = Math.min(input.t.length, input.rpm.length, input.speedKmh.length)
  const t = input.t.subarray(0, n)
  const rpm = input.rpm.subarray(0, n)
  const speed = input.speedKmh.subarray(0, n)

  const finish = (gear: number | null, points: DynoPoint[], tStart: number, tEnd: number): DynoResult => {
    const engine = maxPoint(points, (p) => p.engineKw)
    const wheel = maxPoint(points, (p) => p.wheelKw)
    const torque = maxPoint(points, (p) => p.torqueNm)
    return {
      gear,
      points,
      peakEngine: { kw: engine?.engineKw ?? 0, rpm: engine?.rpm ?? 0 },
      peakWheel: { kw: wheel?.wheelKw ?? 0, rpm: wheel?.rpm ?? 0 },
      peakTorque: { nm: torque?.torqueNm ?? 0, rpm: torque?.rpm ?? 0 },
      segment: { tStart, tEnd },
      airDensity: rho,
      correctionFactor: cf,
      setup,
      warnings
    }
  }
  const fail = (message: string): DynoResult => {
    warnings.push(message)
    return finish(null, [], n > 0 ? t[0] : 0, n > 0 ? t[n - 1] : 0)
  }

  if (!(setup.massKg > 0)) return fail('Vehicle mass must be greater than zero')
  if (!(setup.endRpm > setup.startRpm)) return fail('End rpm must be above start rpm')
  if (n < 3) return fail('Not enough samples to analyse')
  if (!speed.some((v) => v > 0)) return fail('Vehicle speed is missing; power cannot be calculated')
  if (!rpm.some((v) => v > 0)) return fail('Engine speed is missing')

  const pedal = input.pedalPct
  const runs: Array<[number, number]> =
    pedal && pedal.some(Number.isFinite)
      ? findWotRuns(t, pedal, { minPedalPct: setup.minPedalPct, mergeGapSec: WOT_MERGE_GAP_SEC, minDurationSec: 0 })
      : [[0, n - 1]]
  if (runs.length === 0) return fail(`No wide-open throttle found (pedal never reached ${setup.minPedalPct} %)`)

  const gear = gearSeries(rpm, speed, input.gear)
  let best: PullWindow | undefined
  for (const [s, e] of runs) {
    const windows = splitByGear(gear, s, e)
    for (const w of windows) {
      const pull = risingPull(rpm, w.start, w.end, w.gear, setup, windows.length > 1)
      if (!pull) continue
      const better =
        !best ||
        pull.coveredRpm > best.coveredRpm ||
        (pull.coveredRpm === best.coveredRpm && t[pull.end] - t[pull.start] > t[best.end] - t[best.start])
      if (better) best = pull
    }
  }
  if (!best) return fail(`No wide-open-throttle pull rises through ${setup.startRpm}–${setup.endRpm} rpm`)

  const gearNumber = isGearChannelUsable(input.gear) && Number.isFinite(best.gear) ? best.gear : null
  if (best.gearChange) {
    warnings.push(
      `Gear change inside the WOT window; only ${gearNumber !== null ? `gear ${gearNumber}` : 'one gear'} ` +
        `(${Math.round(best.rpmLo)}–${Math.round(best.rpmHi)} rpm) was analysed`
    )
  }
  if (best.rpmLo > setup.startRpm + RANGE_TOLERANCE_RPM || best.rpmHi < setup.endRpm - RANGE_TOLERANCE_RPM) {
    warnings.push(
      `Pull covers ${Math.round(best.rpmLo)}–${Math.round(best.rpmHi)} rpm of the requested ` +
        `${setup.startRpm}–${setup.endRpm} rpm`
    )
  }
  let lossPct = setup.drivetrainLossPct
  if (!(lossPct >= 0 && lossPct <= MAX_LOSS_PCT)) {
    lossPct = Math.min(Math.max(Number.isFinite(lossPct) ? lossPct : 0, 0), MAX_LOSS_PCT)
    warnings.push(`Drivetrain loss limited to ${lossPct} %`)
  }

  // Smooth and differentiate over the whole single-gear window so the
  // reported range is not affected by window-edge effects where avoidable.
  const ws = best.start
  const tw = t.subarray(ws, best.end + 1)
  const vRaw = speed.subarray(ws, best.end + 1).map((kmh) => kmh / 3.6)
  const v = movingAverage(tw, vRaw, setup.smoothingSec)
  const a = derivative(tw, v, setup.smoothingSec)
  const rpmS = movingAverage(tw, rpm.subarray(ws, best.end + 1), setup.smoothingSec)

  const m = setup.massKg
  const aero = 0.5 * rho * setup.cdA
  const rolling = setup.crr * m * G
  const binCount = Math.floor((setup.endRpm - setup.startRpm) / RPM_BIN) + 1
  const binSum = new Float64Array(binCount)
  const binN = new Uint32Array(binCount)
  let samples = 0
  for (let i = best.iStart; i <= best.iEnd; i++) {
    const j = i - ws
    const r = rpmS[j]
    const vj = v[j]
    const aj = a[j]
    if (!Number.isFinite(r) || !Number.isFinite(vj) || !Number.isFinite(aj)) continue
    const k = Math.round((r - setup.startRpm) / RPM_BIN)
    if (k < 0 || k >= binCount) continue
    binSum[k] += (m * aj + aero * vj * vj + rolling) * vj
    binN[k]++
    samples++
  }
  if (samples < MIN_SAMPLES) {
    warnings.push(`Only ${samples} samples in the analysed range; increase the logging rate or use a higher gear`)
  }

  const binned: Array<{ rpm: number; wheelW: number }> = []
  for (let k = 0; k < binCount; k++) {
    if (binN[k] > 0) binned.push({ rpm: setup.startRpm + k * RPM_BIN, wheelW: binSum[k] / binN[k] })
  }
  const lossFactor = 1 - lossPct / 100
  // Light [1 2 1] smoothing between neighbouring bins.
  const points: DynoPoint[] = binned.map((p, idx) => {
    let sum = 2 * p.wheelW
    let weight = 2
    for (const q of [binned[idx - 1], binned[idx + 1]]) {
      if (q) {
        sum += q.wheelW
        weight++
      }
    }
    const wheelKw = ((sum / weight) * cf) / 1000
    const engineKw = wheelKw / lossFactor
    const torqueNm = (engineKw * 1000) / ((2 * Math.PI * p.rpm) / 60)
    return { rpm: p.rpm, engineKw, wheelKw, torqueNm }
  })
  return finish(gearNumber, points, t[best.start], t[best.end])
}

/**
 * Splits [s, e] at gear changes. Samples with unknown gear stay in the window
 * they fall in, except between two different gears where they are dropped.
 */
function splitByGear(gear: Float64Array, s: number, e: number): Array<{ start: number; end: number; gear: number }> {
  const out: Array<{ start: number; end: number; gear: number }> = []
  let current = NaN
  let start = s
  let lastKnown = s
  for (let i = s; i <= e; i++) {
    const g = gear[i]
    if (!Number.isFinite(g)) continue
    if (Number.isFinite(current) && g !== current) {
      out.push({ start, end: lastKnown, gear: current })
      start = i
    }
    current = g
    lastKnown = i
  }
  out.push({ start, end: e, gear: current })
  return out
}

/**
 * The part of a single-gear window that rises from startRpm (or the window
 * start, if already above) to endRpm, stopping early where rpm falls more than
 * SHIFT_RPM_DROP below its running maximum. Null when the window does not
 * overlap the requested range.
 */
function risingPull(
  rpm: Float64Array,
  start: number,
  end: number,
  gear: number,
  setup: DynoSetup,
  splitRun: boolean
): PullWindow | null {
  let iStart = start
  while (iStart <= end && !(rpm[iStart] >= setup.startRpm)) iStart++
  if (iStart > end || rpm[iStart] >= setup.endRpm) return null
  let maxRpm = rpm[iStart]
  let iEnd = iStart
  let contextEnd = end
  let dropped = false
  for (let i = iStart + 1; i <= end; i++) {
    const r = rpm[i]
    if (!Number.isFinite(r)) continue
    if (r < maxRpm - SHIFT_RPM_DROP) {
      dropped = true
      contextEnd = i - 1
      break
    }
    if (r > maxRpm) maxRpm = r
    iEnd = i
    if (r >= setup.endRpm) break
  }
  const rpmLo = rpm[iStart]
  const coveredRpm = Math.min(maxRpm, setup.endRpm) - Math.max(rpmLo, setup.startRpm)
  if (!(coveredRpm > 0)) return null
  return {
    start,
    end: contextEnd,
    gear,
    iStart,
    iEnd,
    rpmLo,
    rpmHi: maxRpm,
    coveredRpm,
    gearChange: splitRun || dropped
  }
}

function maxPoint(points: DynoPoint[], key: (p: DynoPoint) => number): DynoPoint | undefined {
  let best: DynoPoint | undefined
  for (const p of points) if (!best || key(p) > key(best)) best = p
  return best
}

// ------------------------------------------------------------------ live arming

export type DynoDetectorState = 'armed' | 'recording' | 'done'

/** Samples kept from before the pull starts (smoothing context). */
const PRE_ROLL_SEC = 1.0
/** A pull may start this far below startRpm. */
const START_MARGIN_RPM = 300
/**
 * ...and at most this far above it. Flooring it at higher rpm (a launch, or
 * right after a shift) would not cover the requested range, so it is ignored.
 */
const START_WINDOW_RPM = 400
/** The pedal must fall this far below minPedalPct to end a pull. */
const PEDAL_LIFT_HYSTERESIS = 5
/** A pull that ends after rising less than this is discarded and the detector re-arms. */
const MIN_PULL_RPM = 500
const MIN_POST_ROLL_SEC = 0.3

/**
 * Live "Arm run" detector. Feed samples with push(); it starts recording when
 * the pedal is at least minPedalPct with rpm within [startRpm − 300,
 * startRpm + 400], and finishes once rpm has been at/above endRpm for a short post-roll
 * (max(0.3 s, smoothingSec)), or when the pedal lifts or the gear changes
 * (gear value or an rpm drop of 250 rpm). A pull that rose less than 500 rpm
 * is discarded and the detector re-arms. input() returns the recorded
 * samples including ~1 s of pre-roll, ready for analyzeDyno.
 */
export class DynoDetector {
  private readonly setup: DynoSetup
  private status: DynoDetectorState = 'armed'
  private t: number[] = []
  private rpm: number[] = []
  private speed: number[] = []
  private pedal: number[] = []
  private gear: number[] = []
  private hasGear = false
  private rpmAtStart = NaN
  private maxRpm = NaN
  private startGear = NaN
  private endReachedAt = NaN

  constructor(setup: DynoSetup) {
    this.setup = setup
  }

  get state(): DynoDetectorState {
    return this.status
  }

  push(t: number, rpm: number, speedKmh: number, pedalPct: number, gear?: number): DynoDetectorState {
    if (this.status === 'done') return this.status
    const g = gear ?? NaN
    this.t.push(t)
    this.rpm.push(rpm)
    this.speed.push(speedKmh)
    this.pedal.push(pedalPct)
    this.gear.push(g)
    if (Number.isFinite(g)) this.hasGear = true
    const { minPedalPct, startRpm, endRpm } = this.setup

    if (this.status === 'armed') {
      this.trimPreRoll(t)
      if (pedalPct >= minPedalPct && rpm >= startRpm - START_MARGIN_RPM && rpm <= Math.min(startRpm + START_WINDOW_RPM, endRpm)) {
        this.status = 'recording'
        this.rpmAtStart = rpm
        this.maxRpm = rpm
        this.startGear = g
        this.endReachedAt = NaN
      }
      return this.status
    }

    const lifted = pedalPct < minPedalPct - PEDAL_LIFT_HYSTERESIS
    const shifted =
      (Number.isFinite(g) && Number.isFinite(this.startGear) && g !== this.startGear) ||
      rpm < this.maxRpm - SHIFT_RPM_DROP
    if (rpm > this.maxRpm) this.maxRpm = rpm
    if (lifted || shifted) {
      // A short stab of the pedal is not a pull: keep waiting for a real one.
      this.status = this.maxRpm - this.rpmAtStart >= MIN_PULL_RPM ? 'done' : 'armed'
    } else if (rpm >= endRpm) {
      if (Number.isNaN(this.endReachedAt)) this.endReachedAt = t
      if (t - this.endReachedAt >= Math.max(MIN_POST_ROLL_SEC, this.setup.smoothingSec)) this.status = 'done'
    }
    return this.status
  }

  /** Recorded samples (pre-roll + pull). */
  input(): DynoInput {
    const out: DynoInput = {
      t: Float64Array.from(this.t),
      rpm: Float64Array.from(this.rpm),
      speedKmh: Float64Array.from(this.speed),
      pedalPct: Float64Array.from(this.pedal)
    }
    if (this.hasGear) out.gear = Float64Array.from(this.gear)
    return out
  }

  /** Discards everything and re-arms. */
  reset(): void {
    this.status = 'armed'
    this.t = []
    this.rpm = []
    this.speed = []
    this.pedal = []
    this.gear = []
    this.hasGear = false
  }

  private trimPreRoll(now: number): void {
    let k = 0
    while (k < this.t.length && this.t[k] < now - PRE_ROLL_SEC) k++
    if (k === 0) return
    for (const buf of [this.t, this.rpm, this.speed, this.pedal, this.gear]) buf.splice(0, k)
  }
}

/** Extra context taken around a WOT segment for smoothing. */
const INPUT_PAD_SEC = 1.0

/**
 * Dyno input from a log (speed converted to km/h, pedal to %; throttle is used
 * when there is no pedal channel). With a segment, only its samples plus 1 s
 * on either side are used. Null when rpm or speed is missing.
 */
export function dynoInputFromLog(log: LogData, segment?: WotSegment): DynoInput | null {
  const rpm = channelInUnit(log, CH.rpm, 'rpm')
  const speedKmh = channelInUnit(log, CH.speed, 'km/h')
  if (!rpm || !speedKmh) return null
  const pedalPct = channelInUnit(log, CH.pedal, '%') ?? channelInUnit(log, CH.throttle, '%')
  const gear = channelInUnit(log, CH.gear, 'gear')
  const { time } = log
  const s = segment ? lowerBound(time, segment.start - INPUT_PAD_SEC) : 0
  const e = segment ? upperBound(time, segment.end + INPUT_PAD_SEC) : time.length
  const input: DynoInput = { t: time.slice(s, e), rpm: rpm.slice(s, e), speedKmh: speedKmh.slice(s, e) }
  if (pedalPct) input.pedalPct = pedalPct.slice(s, e)
  if (gear) input.gear = gear.slice(s, e)
  return input
}
