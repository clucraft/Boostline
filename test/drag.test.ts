import { describe, expect, it } from 'vitest'
import { CH, type DragInput, type DragMode, type LogData } from '@shared/types'
import { DragDetector, analyzeDrag, calibrateSpeed, dragInputFromLog, speedCalibrator } from '@shared/analysis/drag'
import { detectGearChanges } from '@shared/analysis/gear'

const HZ = 50
const LAUNCH = 1.013
/** 100 km/h in 4.0 s: a = 100 / 3.6 / 4.0 m/s². */
const A_KMH_S = 25
const MPH = 1.609344

/** Speed profile sampled at 50 Hz from t = 0 (seconds). */
function sampled(profile: (t: number) => number, durationSec: number): DragInput {
  const t = Float64Array.from({ length: Math.round(durationSec * HZ) + 1 }, (_, i) => i / HZ)
  return { t, speedKmh: t.map(profile) }
}

/** Constant acceleration from standstill at `launch`, capped at `capKmh`. */
const constantAccel =
  (a = A_KMH_S, capKmh = 120, launch = LAUNCH) =>
  (t: number): number =>
    Math.min(capKmh, Math.max(0, (t - launch) * a))

describe('analyzeDrag — standing starts', () => {
  it('times 0–100 km/h with splits every 10 km/h', () => {
    const input = sampled(constantAccel(), 10)
    const r = analyzeDrag(input, '0-100')
    expect(r.finished).toBe(true)
    expect(r.warnings).toEqual([])
    expect(Math.abs(r.finalTime! - 4.0)).toBeLessThan(0.03)
    expect(r.finalTime!).toBeCloseTo(4.0, 6)
    expect(r.startT).toBeCloseTo(LAUNCH, 6)
    expect(r.trapSpeedKmh).toBe(100)
    expect(r.distanceM).toBeCloseTo(0.5 * (100 / 3.6) * 4.0, 4)
    expect(r.splits.map((s) => s.speedKmh)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
    r.splits.forEach((s, i) => expect(s.time).toBeCloseTo(0.4 * (i + 1), 6))
    for (let i = 1; i < r.splits.length; i++) expect(r.splits[i].time).toBeGreaterThan(r.splits[i - 1].time)
    expect(r.splits[r.splits.length - 1].time).toBeCloseTo(r.finalTime!, 9)
    expect(r.curve.t[0]).toBe(0)
    expect(r.curve.calibrated[0]).toBe(0)
    expect(r.curve.t[r.curve.t.length - 1]).toBeGreaterThanOrEqual(4.0)
    expect(r.curve.raw).toEqual(r.curve.calibrated)
    expect(r.gearChanges).toEqual([])
  })

  it('times 0–60 mph with 10 mph splits', () => {
    const r = analyzeDrag(sampled(constantAccel(), 10), '0-60mph')
    expect(r.finished).toBe(true)
    expect(r.finalTime!).toBeCloseTo((60 * MPH) / A_KMH_S, 6)
    expect(r.splits).toHaveLength(6)
    r.splits.forEach((s, i) => expect(s.speedKmh).toBeCloseTo((i + 1) * 10 * MPH, 9))
  })

  it('times the 1/4 and 1/8 mile against the analytical solution', () => {
    const a = 5 // m/s²
    const input = sampled(constantAccel(a * 3.6, 400), 16)
    for (const [mode, d] of [
      ['402m', 402.336],
      ['201m', 201.168]
    ] as const) {
      const r = analyzeDrag(input, mode)
      const tExact = Math.sqrt((2 * d) / a)
      expect(r.finished).toBe(true)
      expect(Math.abs(r.finalTime! - tExact)).toBeLessThan(0.03)
      expect(Math.abs(r.trapSpeedKmh! - a * tExact * 3.6)).toBeLessThan(0.5)
      expect(r.distanceM).toBeCloseTo(d, 9)
      const lastSplit = r.splits[r.splits.length - 1]
      expect(lastSplit.speedKmh).toBe(Math.floor((a * tExact * 3.6) / 10) * 10)
      expect(lastSplit.time).toBeLessThanOrEqual(r.finalTime!)
    }
  })

  it('applies the speed calibration (+2 % GPS speed shortens the time)', () => {
    const input = sampled(constantAccel(), 10)
    const plain = analyzeDrag(input, '0-100')
    const calibration = [
      { ecu: 50, gps: 51 },
      { ecu: 150, gps: 153 }
    ]
    const r = analyzeDrag(input, '0-100', { calibration })
    expect(r.finished).toBe(true)
    expect(Math.abs(r.finalTime! - 4.0 / 1.02)).toBeLessThan(0.005)
    expect(r.finalTime!).toBeLessThan(plain.finalTime!)
    const i = r.curve.t.findIndex((t) => t > 2)
    expect(r.curve.calibrated[i]).toBeCloseTo(r.curve.raw[i] * 1.02, 9)
  })

  it('starts at the last moment the speed leaves standstill', () => {
    const creepThenLaunch = (t: number): number => (t >= 0.5 && t < 0.8 ? 1.5 : constantAccel(A_KMH_S, 120, 2.013)(t))
    const r = analyzeDrag(sampled(creepThenLaunch, 10), '0-100')
    expect(r.finished).toBe(true)
    expect(r.startT).toBeCloseTo(2.013, 6)
    expect(r.finalTime!).toBeCloseTo(4.0, 6)
  })

  it('reports runs that do not reach the target or lose speed', () => {
    const slow = analyzeDrag(sampled(constantAccel(A_KMH_S, 90), 10), '0-100')
    expect(slow.finished).toBe(false)
    expect(slow.finalTime).toBeNull()
    expect(slow.trapSpeedKmh).toBeNull()
    expect(slow.warnings[0]).toMatch(/not reached/)

    const short = analyzeDrag(sampled(constantAccel(A_KMH_S, 90), 10), '402m')
    expect(short.finished).toBe(false)
    expect(short.warnings[0]).toMatch(/not reached/)
    expect(short.distanceM).toBeGreaterThan(100)

    const lift = (t: number): number => {
      const v = constantAccel()(t)
      if (v < 60) return v
      const tLift = LAUNCH + 60 / A_KMH_S
      if (t < tLift + 1) return 60 - (t - tLift) * 10
      return 50 + (t - tLift - 1) * A_KMH_S
    }
    const dropped = analyzeDrag(sampled(lift, 10), '0-100')
    expect(dropped.finished).toBe(false)
    expect(dropped.warnings[0]).toMatch(/dropped/)

    const rolling = analyzeDrag(sampled(() => 120, 5), '0-100')
    expect(rolling.finished).toBe(false)
    expect(rolling.warnings[0]).toMatch(/No standing start/)
  })
})

describe('analyzeDrag — rolling starts', () => {
  it.each([
    ['100-200', 100, 200],
    ['200-300', 200, 300],
    ['60-130mph', 60 * MPH, 130 * MPH]
  ] as const)('times %s', (mode: DragMode, from: number, to: number) => {
    const r = analyzeDrag(sampled(constantAccel(A_KMH_S, 320), 16), mode)
    expect(r.finished).toBe(true)
    expect(r.finalTime!).toBeCloseTo((to - from) / A_KMH_S, 6)
    expect(r.startT).toBeCloseTo(LAUNCH + from / A_KMH_S, 6)
    expect(r.trapSpeedKmh).toBeCloseTo(to, 9)
    expect(r.curve.calibrated[0]).toBeCloseTo(from, 9)
    expect(r.splits[0].speedKmh).toBeCloseTo(from + (to - from) / r.splits.length, 9)
    expect(r.splits[r.splits.length - 1].speedKmh).toBeCloseTo(to, 9)
  })

  it('needs the speed to pass the lower bound from below', () => {
    const r = analyzeDrag(sampled((t) => 150 + t * 10, 10), '100-200')
    expect(r.finished).toBe(false)
    expect(r.warnings[0]).toMatch(/never rose through 100/)
  })
})

describe('gear changes', () => {
  it('detects shifts from the rpm/speed ratio', () => {
    const input = sampled(constantAccel(), 10)
    input.rpm = input.speedKmh.map((v) => v * (v < 50 ? 60 : v < 90 ? 40 : 30))
    const r = analyzeDrag(input, '0-100')
    expect(r.gearChanges.map((c) => [c.from, c.to])).toEqual([
      [1, 2],
      [2, 3]
    ])
    expect(r.gearChanges[0].time).toBeCloseTo(2.0, 1)
    expect(r.gearChanges[0].speedKmh).toBeCloseTo(50, 0)
    expect(r.gearChanges[1].time).toBeCloseTo(3.6, 1)
  })

  it('prefers a gear channel and ignores shift flicker', () => {
    const t = Float64Array.from({ length: 200 }, (_, i) => i / HZ)
    const gear = t.map((ti) => (ti < 2 || Math.abs(ti - 2.02) < 1e-9 ? 1 : 2))
    const changes = detectGearChanges(t, gear, t.map((ti) => ti * 10))
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ from: 1, to: 2 })
    expect(changes[0].time).toBeCloseTo(2.04, 9)
    expect(changes[0].speedKmh).toBeCloseTo(20.4, 9)

    const input = sampled(constantAccel(), 10)
    input.gear = input.t.map((ti) => (ti < LAUNCH + 2.5 ? 1 : 2))
    input.rpm = input.speedKmh.map((v) => v * 999) // ignored when a gear channel exists
    const r = analyzeDrag(input, '0-100')
    expect(r.gearChanges).toHaveLength(1)
    expect(r.gearChanges[0].time).toBeCloseTo(2.5, 1)
  })
})

describe('calibrateSpeed', () => {
  it('interpolates the gps/ecu ratio and extrapolates flat', () => {
    const points = [
      { ecu: 100, gps: 103 },
      { ecu: 50, gps: 50 }
    ]
    const out = calibrateSpeed(Float64Array.from([0, 25, 50, 75, 100, 200, NaN]), points)
    expect(out[0]).toBe(0)
    expect(out[1]).toBeCloseTo(25, 12)
    expect(out[2]).toBeCloseTo(50, 12)
    expect(out[3]).toBeCloseTo(75 * 1.015, 12)
    expect(out[4]).toBeCloseTo(103, 12)
    expect(out[5]).toBeCloseTo(206, 12)
    expect(out[6]).toBeNaN()
    expect([...calibrateSpeed(Float64Array.from([10, 20]), [])]).toEqual([10, 20])
    expect(speedCalibrator([{ ecu: 0, gps: 5 }])(42)).toBe(42)
  })
})

describe('DragDetector', () => {
  it('waits for a stop, runs and finishes a standing run', () => {
    const detector = new DragDetector('0-100')
    const profile = (t: number): number => (t < 3 ? 30 - 10 * t : constantAccel(A_KMH_S, 120, 4.013)(t))
    const states: string[] = [detector.state]
    for (let i = 0; i <= 12 * HZ; i++) {
      const t = i / HZ
      const s = detector.push(t, profile(t))
      if (states[states.length - 1] !== s) states.push(s)
    }
    expect(states).toEqual(['waiting-stop', 'ready', 'running', 'finished'])
    const r = analyzeDrag(detector.input(), '0-100')
    expect(r.finished).toBe(true)
    expect(r.finalTime!).toBeCloseTo(4.0, 6)
    expect(detector.input().t[0]).toBeGreaterThan(2) // pre-roll was trimmed
  })

  it('aborts when the speed drops and returns to waiting when creeping', () => {
    const detector = new DragDetector('0-100')
    let t = 0
    const push = (v: number): string => detector.push((t += 0.02), v)
    expect(push(0)).toBe('ready')
    expect(push(2)).toBe('running')
    expect(push(0.8)).toBe('waiting-stop')
    expect(push(0)).toBe('ready')
    for (let v = 2; v <= 50; v += 0.5) expect(push(v)).toBe('running')
    expect(push(45)).toBe('aborted')
    expect(push(0)).toBe('aborted')
    detector.reset()
    expect(detector.state).toBe('waiting-stop')
  })

  it('arms rolling runs below the start speed and finishes distance runs', () => {
    const rolling = new DragDetector('100-200', { calibration: [{ ecu: 100, gps: 100 }] })
    expect(rolling.push(0, 120)).toBe('waiting-stop')
    expect(rolling.push(0.1, 95)).toBe('ready')
    expect(rolling.push(0.2, 101)).toBe('running')
    expect(rolling.push(0.3, 199)).toBe('running')
    expect(rolling.push(0.4, 201, 4, 6000)).toBe('finished')
    const input = rolling.input()
    expect(input.gear).toBeDefined()
    expect(input.rpm).toBeDefined()

    const quarter = new DragDetector('402m')
    const states = new Set<string>()
    for (let i = 0; i <= 16 * HZ; i++) states.add(quarter.push(i / HZ, constantAccel(18, 400)(i / HZ)))
    expect(quarter.state).toBe('finished')
    expect([...states]).toEqual(['ready', 'running', 'finished'])
  })
})

describe('dragInputFromLog', () => {
  it('converts speed to km/h and picks up gear and rpm', () => {
    const time = Float64Array.from([0, 0.1, 0.2])
    const log: LogData = {
      name: 'log',
      meta: {},
      time,
      channels: [
        { id: CH.speed, name: 'Speed', unit: 'mph', quantity: 'speed', data: Float64Array.from([0, 10, 20]) },
        { id: CH.gear, name: 'Gear', unit: 'gear', quantity: 'gear', data: Float64Array.from([1, 1, 1]) }
      ]
    }
    const input = dragInputFromLog(log)!
    expect(input.speedKmh[2]).toBeCloseTo(20 * MPH, 12)
    expect(input.gear).toBeDefined()
    expect(input.rpm).toBeUndefined()
    expect(dragInputFromLog({ ...log, channels: [] })).toBeNull()
  })
})
