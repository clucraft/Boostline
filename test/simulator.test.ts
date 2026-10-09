import { describe, expect, it } from 'vitest'
import { SimEngine } from '../src/main/vehicle/simulator'
import { BMW_CATALOG } from '../src/shared/catalog'

/** Runs the simulator for `seconds` at 50 Hz and returns every snapshot. */
function run(seconds: number): Record<string, number>[] {
  const sim = new SimEngine()
  const out: Record<string, number>[] = []
  for (let i = 0; i < seconds * 50; i++) {
    sim.step(0.02)
    out.push(sim.snapshot())
  }
  return out
}

describe('SimEngine', () => {
  const frames = run(70)
  const t = (i: number): number => (i + 1) * 0.02

  it('produces a finite value for every catalog channel', () => {
    for (const ch of BMW_CATALOG) expect(Number.isFinite(frames[100][ch.id]), ch.id).toBe(true)
  })

  it('launches from a stop and reaches 100 km/h in a plausible time', () => {
    const launch = frames.findIndex((f) => f['vehicle.speed'] > 1)
    const hundred = frames.findIndex((f) => f['vehicle.speed'] >= 100)
    expect(launch).toBeGreaterThan(0)
    const time = t(hundred) - t(launch)
    expect(time).toBeGreaterThan(3.5)
    expect(time).toBeLessThan(6)
  })

  it('shifts up through the gears during the launch', () => {
    const gears = new Set(frames.slice(0, 50 * 20).map((f) => f['vehicle.gear']))
    expect([...gears]).toEqual(expect.arrayContaining([1, 2, 3, 4]))
  })

  it('does a 4th-gear WOT pull to the limiter later in the cycle', () => {
    const pull = frames.filter((f) => f['vehicle.gear'] === 4 && f['throttle.pedal'] === 100 && f['engine.rpm'] > 6500)
    expect(pull.length).toBeGreaterThan(5)
  })

  it('builds boost under load and keeps lambda rich at WOT', () => {
    const wot = frames.filter((f) => f['throttle.pedal'] === 100 && f['engine.rpm'] > 4500)
    const maxBoost = Math.max(...wot.map((f) => f['boost.actual']))
    expect(maxBoost).toBeGreaterThan(1.1)
    expect(maxBoost).toBeLessThan(1.8)
    expect(Math.min(...wot.map((f) => f['fuel.lambda.target']))).toBeLessThan(0.9)
  })
})
