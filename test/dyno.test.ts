import { describe, expect, it } from 'vitest'
import { CH, type DynoInput, type DynoSetup, type LogData } from '@shared/types'
import { airDensity, correctionFactor } from '@shared/analysis/air'
import { DEFAULT_DYNO_SETUP, DynoDetector, analyzeDyno, dynoInputFromLog } from '@shared/analysis/dyno'

const G = 9.80665

interface PullSpec {
  setup: DynoSetup
  /** Constant wheel power during the pull (W). */
  powerW: number
  hz?: number
  /** Engine rpm per m/s of road speed in the starting gear. */
  k?: number
  gear?: number
  /** Optional upshift: at this rpm switch to kAfterShift (gear + 1). */
  shiftAtRpm?: number
  kAfterShift?: number
  endRpm?: number
}

/**
 * Road pull with constant wheel power: m·dv/dt = P/v − ½ρ·CdA·v² − Crr·m·g,
 * integrated with RK4 (20 sub-steps per sample). 1 s of steady cruise with the
 * pedal released precedes the pull and 0.5 s follows it.
 */
function syntheticPull(spec: PullSpec): Required<DynoInput> {
  const { setup, powerW, hz = 50, gear = 3, shiftAtRpm, kAfterShift } = spec
  let k = spec.k ?? 100
  const endRpm = spec.endRpm ?? 7000
  const rho = airDensity(setup.ambientTempC, setup.baroHpa, setup.humidityPct)
  const accel = (v: number): number =>
    (powerW / v - 0.5 * rho * setup.cdA * v * v - setup.crr * setup.massKg * G) / setup.massKg
  const t: number[] = []
  const rpm: number[] = []
  const speed: number[] = []
  const pedal: number[] = []
  const gears: number[] = []
  let currentGear = gear
  let v = 1500 / k
  const dt = 1 / hz
  const push = (p: number): void => {
    t.push(t.length / hz)
    rpm.push(k * v)
    speed.push(v * 3.6)
    pedal.push(p)
    gears.push(currentGear)
  }
  for (let i = 0; i < hz; i++) push(0)
  while (k * v < endRpm) {
    push(100)
    const h = dt / 20
    for (let s = 0; s < 20; s++) {
      const k1 = accel(v)
      const k2 = accel(v + (h / 2) * k1)
      const k3 = accel(v + (h / 2) * k2)
      const k4 = accel(v + h * k3)
      v += (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4)
    }
    if (shiftAtRpm !== undefined && kAfterShift !== undefined && currentGear === gear && k * v >= shiftAtRpm) {
      k = kAfterShift
      currentGear = gear + 1
    }
  }
  for (let i = 0; i < hz / 2; i++) push(0)
  const f = (a: number[]): Float64Array => Float64Array.from(a)
  return { t: f(t), rpm: f(rpm), speedKmh: f(speed), pedalPct: f(pedal), gear: f(gears) }
}

const setup: DynoSetup = { ...DEFAULT_DYNO_SETUP }

function expectFlatPower(points: { rpm: number; wheelKw: number }[], kw: number, tolerance = 0.03): void {
  const mid = points.filter((p) => p.rpm >= 2500 && p.rpm <= 6000)
  expect(mid.length).toBeGreaterThan(50)
  for (const p of mid) expect(Math.abs(p.wheelKw - kw) / kw).toBeLessThan(tolerance)
}

describe('analyzeDyno', () => {
  const input = syntheticPull({ setup, powerW: 250_000 })

  it('recovers a constant 250 kW wheel power and consistent torque', () => {
    const result = analyzeDyno(input, setup)
    expect(result.warnings).toEqual([])
    expect(result.gear).toBe(3)
    expectFlatPower(result.points, 250)
    for (const p of result.points) {
      expect(p.engineKw).toBeCloseTo(p.wheelKw / 0.85, 9)
      expect(p.torqueNm).toBeCloseTo((p.engineKw * 1000) / ((2 * Math.PI * p.rpm) / 60), 6)
    }
    const rpms = result.points.map((p) => p.rpm)
    expect(rpms).toEqual([...rpms].sort((a, b) => a - b))
    expect(rpms[0]).toBe(2000)
    expect(rpms[rpms.length - 1]).toBe(6500)
    expect(Math.abs(result.peakWheel.kw - 250) / 250).toBeLessThan(0.03)
    expect(result.peakEngine.kw).toBeCloseTo(result.peakWheel.kw / 0.85, 6)
    // Constant power → torque falls with rpm, so peak torque sits at the low end.
    expect(result.peakTorque.rpm).toBeLessThan(2600)
    expect(result.airDensity).toBeCloseTo(airDensity(20, 1013, 50), 12)
    expect(result.correctionFactor).toBe(1)
    expect(result.segment.tStart).toBeCloseTo(1, 9)
  })

  it('applies the correction factor to wheel and engine power', () => {
    const hot: DynoSetup = { ...setup, ambientTempC: 32, baroHpa: 975, humidityPct: 60, correction: 'DIN' }
    const result = analyzeDyno(syntheticPull({ setup: hot, powerW: 250_000 }), hot)
    const cf = correctionFactor('DIN', 32, 975, 60)
    expect(cf).toBeGreaterThan(1.04)
    expect(result.correctionFactor).toBeCloseTo(cf, 12)
    expectFlatPower(result.points, 250 * cf)
  })

  it('estimates the gear from the rpm/speed ratio without a gear channel', () => {
    const result = analyzeDyno({ t: input.t, rpm: input.rpm, speedKmh: input.speedKmh, pedalPct: input.pedalPct }, setup)
    expect(result.gear).toBeNull()
    expectFlatPower(result.points, 250)
  })

  it('uses the whole input when there is no pedal channel', () => {
    const result = analyzeDyno({ t: input.t, rpm: input.rpm, speedKmh: input.speedKmh }, setup)
    expectFlatPower(result.points, 250)
  })

  it('analyses one gear when the pull contains a shift', () => {
    const shifted = syntheticPull({ setup, powerW: 250_000, k: 150, gear: 2, shiftAtRpm: 5000, kAfterShift: 100 })
    const result = analyzeDyno(shifted, setup)
    expect(result.gear).toBe(3)
    expect(result.warnings.some((w) => /Gear change/.test(w))).toBe(true)
    expect(result.warnings.some((w) => /Pull covers/.test(w))).toBe(true)
    const mid = result.points.filter((p) => p.rpm >= 4000 && p.rpm <= 6000)
    for (const p of mid) expect(Math.abs(p.wheelKw - 250) / 250).toBeLessThan(0.03)
  })

  it('reports missing WOT and missing speed', () => {
    const noWot = analyzeDyno({ ...input, pedalPct: input.pedalPct.map(() => 20) }, setup)
    expect(noWot.points).toEqual([])
    expect(noWot.warnings[0]).toMatch(/No wide-open throttle/)

    const noSpeed = analyzeDyno({ ...input, speedKmh: input.speedKmh.map(() => 0) }, setup)
    expect(noSpeed.points).toEqual([])
    expect(noSpeed.warnings[0]).toMatch(/speed is missing/)
  })

  it('warns when the pull does not cover the rpm range or has few samples', () => {
    const short = syntheticPull({ setup, powerW: 250_000, endRpm: 4000, hz: 3 })
    const result = analyzeDyno(short, setup)
    expect(result.warnings.some((w) => /Pull covers/.test(w))).toBe(true)
    expect(result.warnings.some((w) => /Only \d+ samples/.test(w))).toBe(true)
  })
})

describe('dynoInputFromLog', () => {
  it('reads channels in the required units and pads the segment', () => {
    const pull = syntheticPull({ setup, powerW: 250_000 })
    const log: LogData = {
      name: 'log',
      meta: {},
      time: pull.t,
      channels: [
        { id: CH.rpm, name: 'RPM', unit: 'rpm', quantity: 'rpm', data: pull.rpm },
        { id: CH.speed, name: 'Speed', unit: 'mph', quantity: 'speed', data: pull.speedKmh.map((v) => v / 1.609344) },
        { id: CH.pedal, name: 'Pedal', unit: '%', quantity: 'percent', data: pull.pedalPct }
      ]
    }
    const full = dynoInputFromLog(log)!
    expect(full.speedKmh[100]).toBeCloseTo(pull.speedKmh[100], 9)
    expect(full.gear).toBeUndefined()
    const seg = dynoInputFromLog(log, { start: 3, end: 4, startIdx: 150, endIdx: 200 })!
    expect(seg.t[0]).toBeCloseTo(2, 9)
    expect(seg.t[seg.t.length - 1]).toBeCloseTo(5, 9)
    expect(dynoInputFromLog({ ...log, channels: log.channels.slice(0, 1) })).toBeNull()
  })
})

describe('DynoDetector', () => {
  it('arms, records a pull with pre-roll and finishes after endRpm', () => {
    const pull = syntheticPull({ setup, powerW: 250_000 })
    const detector = new DynoDetector(setup)
    const states: string[] = []
    let recordingStart = NaN
    for (let i = 0; i < pull.t.length; i++) {
      const state = detector.push(pull.t[i], pull.rpm[i], pull.speedKmh[i], pull.pedalPct[i], pull.gear[i])
      if (state === 'recording' && Number.isNaN(recordingStart)) {
        recordingStart = pull.t[i]
        expect(pull.rpm[i]).toBeGreaterThanOrEqual(setup.startRpm - 300)
      }
      if (states[states.length - 1] !== state) states.push(state)
    }
    expect(states).toEqual(['armed', 'recording', 'done'])
    expect(detector.state).toBe('done')

    const recorded = detector.input()
    expect(recorded.t[0]).toBeLessThan(recordingStart - 0.9)
    expect(recorded.t[0]).toBeGreaterThan(recordingStart - 1.05)
    expect(recorded.rpm[recorded.rpm.length - 1]).toBeGreaterThanOrEqual(setup.endRpm)
    expect(recorded.gear).toBeDefined()
    expectFlatPower(analyzeDyno(recorded, setup).points, 250)
  })

  it('re-arms after a short stab of the pedal and finishes on a pedal lift', () => {
    const detector = new DynoDetector(setup)
    let t = 0
    const step = (rpm: number, pedal: number): string => detector.push((t += 0.02), rpm, rpm / 40, pedal, 3)
    expect(step(2000, 0)).toBe('armed')
    expect(step(2000, 100)).toBe('recording')
    for (let i = 0; i < 10; i++) step(2000 + i * 10, 100)
    expect(step(2100, 0)).toBe('armed')

    expect(step(2200, 100)).toBe('recording')
    for (let rpm = 2200; rpm < 4000; rpm += 20) expect(step(rpm, 100)).toBe('recording')
    expect(step(4000, 10)).toBe('done')
    expect(step(4000, 100)).toBe('done')

    detector.reset()
    expect(detector.state).toBe('armed')
    expect(detector.input().t.length).toBe(0)
  })

  it('ends the recording on a gear change', () => {
    const detector = new DynoDetector(setup)
    let t = 0
    detector.push(t, 2200, 55, 100, 3)
    for (let rpm = 2200; rpm < 4000; rpm += 25) expect(detector.push((t += 0.02), rpm, rpm / 40, 100, 3)).toBe('recording')
    expect(detector.push((t += 0.02), 3000, 100, 100, 4)).toBe('done')
  })

  it('ignores WOT that begins well above the start rpm (launches, post-shift)', () => {
    const detector = new DynoDetector(setup)
    let t = 0
    for (let rpm = 3000; rpm < 6800; rpm += 25) expect(detector.push((t += 0.02), rpm, rpm / 60, 100, 1)).toBe('armed')
    for (let rpm = 4400; rpm < 6800; rpm += 25) expect(detector.push((t += 0.02), rpm, rpm / 40, 100, 2)).toBe('armed')
  })
})
