import { describe, expect, it } from 'vitest'
import { CH, type LogChannel, type LogData } from '@shared/types'
import { detectWotSegments, findWotRuns } from '@shared/analysis/wot'

const HZ = 20

function makeLog(pedalAt: (t: number) => number, opts: { pedalUnit?: string; pedalId?: string } = {}): LogData {
  const n = 20 * HZ
  const time = Float64Array.from({ length: n }, (_, i) => i / HZ)
  const pedal = time.map(pedalAt)
  const rpm = time.map((t) => {
    if (t >= 2 && t < 6) return 2000 + (t - 2) * 1000
    if (t >= 10 && t < 14) return 2500 + (t - 10) * 900
    return 1500
  })
  const gear = time.map((t) => (t < 8 ? 2 : 3))
  const channels: LogChannel[] = [
    { id: opts.pedalId ?? CH.pedal, name: 'Accelerator Pedal', unit: opts.pedalUnit ?? '%', quantity: 'percent', data: pedal },
    { id: CH.rpm, name: 'Engine RPM', unit: 'rpm', quantity: 'rpm', data: rpm },
    { id: CH.gear, name: 'Gear', unit: 'gear', quantity: 'gear', data: gear }
  ]
  return { name: 'wot', meta: {}, time, channels }
}

/** Two pulls (2–6 s with a 0.1 s dropout at 3 s, and 10–14 s) plus a 0.5 s blip at 17 s. */
const twoPulls = (t: number): number => {
  if (t >= 2 && t < 6 && !(t >= 3 && t < 3.1)) return 100
  if (t >= 10 && t < 14) return 98
  if (t >= 17 && t < 17.5) return 100
  return 5
}

describe('detectWotSegments', () => {
  it('finds two pulls, merges the short dropout and ignores the blip', () => {
    const segments = detectWotSegments(makeLog(twoPulls))
    expect(segments).toHaveLength(2)
    const [a, b] = segments
    expect(a.start).toBeCloseTo(2, 9)
    expect(a.end).toBeCloseTo(5.95, 9)
    expect(a.startIdx).toBe(40)
    expect(a.endIdx).toBe(119)
    expect(a.peakRpm).toBeCloseTo(2000 + 3.95 * 1000, 6)
    expect(a.gear).toBe(2)
    expect(b.start).toBeCloseTo(10, 9)
    expect(b.end).toBeCloseTo(13.95, 9)
    expect(b.gear).toBe(3)
  })

  it('splits at a dropout longer than mergeGapSec', () => {
    const segments = detectWotSegments(makeLog(twoPulls), { mergeGapSec: 0.1, minDurationSec: 0.5 })
    expect(segments.map((s) => [s.start, s.end])).toEqual([
      [2, 2.95],
      [3.1, 5.95],
      [10, 13.95]
    ])
  })

  it('honours minPedalPct and minDurationSec', () => {
    expect(detectWotSegments(makeLog(twoPulls), { minPedalPct: 99 })).toHaveLength(1)
    expect(detectWotSegments(makeLog(twoPulls), { minDurationSec: 0.4 })).toHaveLength(3)
  })

  it('falls back to throttle position and reads 0…1 pedal fractions', () => {
    expect(detectWotSegments(makeLog(twoPulls, { pedalId: CH.throttle }))).toHaveLength(2)
    const fraction = makeLog((t) => twoPulls(t) / 100, { pedalUnit: '' })
    expect(detectWotSegments(fraction)).toHaveLength(2)
  })

  it('returns nothing without a pedal or throttle channel', () => {
    const log = makeLog(twoPulls, { pedalId: 'something.else' })
    expect(detectWotSegments(log)).toEqual([])
    expect(detectWotSegments(log, { pedalChannelId: 'something.else' })).toHaveLength(2)
  })
})

describe('findWotRuns', () => {
  it('works on raw arrays', () => {
    const t = Float64Array.from({ length: 10 }, (_, i) => i)
    const p = Float64Array.from([0, 90, 90, 0, 90, 90, 90, NaN, 0, 90])
    expect(findWotRuns(t, p, { minPedalPct: 85, mergeGapSec: 2, minDurationSec: 0 })).toEqual([
      [1, 6],
      [9, 9]
    ])
  })
})
