import { describe, expect, it } from 'vitest'
import {
  accumulate,
  autoEdges,
  binIndex,
  buildMask,
  cellValue,
  DEFAULT_FILTERS,
  emptyGrid,
  makeEdges,
  MAX_SPANS_PER_CELL,
  niceStep
} from '../src/shared/analysis/heatmap'
import { timingCorrections, withDerivedChannels } from '../src/shared/analysis/derived'
import type { LogData } from '../src/shared/types'

const f64 = (a: number[]): Float64Array => Float64Array.from(a)

describe('binIndex / edges', () => {
  const edges = [0, 10, 20, 30]
  it('assigns half-open bins with an inclusive last edge', () => {
    expect(binIndex(edges, 0)).toBe(0)
    expect(binIndex(edges, 9.99)).toBe(0)
    expect(binIndex(edges, 10)).toBe(1)
    expect(binIndex(edges, 30)).toBe(2)
    expect(binIndex(edges, -0.01)).toBe(-1)
    expect(binIndex(edges, 30.01)).toBe(-1)
    expect(binIndex(edges, NaN)).toBe(-1)
  })

  it('builds even edges and nice automatic axes', () => {
    expect(makeEdges(1000, 500, 3000)).toEqual([1000, 1500, 2000, 2500, 3000])
    expect(niceStep(6000, 12)).toBe(500)
    expect(niceStep(2.3, 10)).toBe(0.25)
    const auto = autoEdges(Array.from({ length: 1000 }, (_, i) => 800 + i * 6.2), 14)!
    expect(auto[0]).toBeLessThanOrEqual(850)
    expect(auto[auto.length - 1]).toBeGreaterThanOrEqual(6900)
    expect(auto[1] - auto[0]).toBe(500)
    expect(autoEdges([1, 1, 1])).toBeNull()
  })
})

describe('accumulate', () => {
  it('bins samples, weights by time and tracks spans', () => {
    const grid = emptyGrid([0, 1000, 2000], [0, 50, 100])
    // 0.0–0.2 s in cell (x0,y0), then 0.3–0.5 s in cell (x1,y1); 20 Hz → 0.05 s steps.
    const t = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.35, 0.4, 0.45, 0.5]
    const x = [500, 500, 500, 500, 500, 1500, 1500, 1500, 1500, 1500]
    const y = [20, 20, 20, 20, 20, 70, 70, 70, 70, 70]
    const z = [1, 2, 3, 4, 5, -1, -2, -3, -4, -5]
    accumulate(grid, { t, x, y, z })
    const a = grid.cells[0]
    const b = grid.cells[1 * 2 + 1]
    expect(a.n).toBe(5)
    expect(b.n).toBe(5)
    expect(cellValue(a, 'min')).toBe(1)
    expect(cellValue(a, 'max')).toBe(5)
    expect(cellValue(a, 'mean')).toBeGreaterThan(2.5)
    expect(cellValue(a, 'mean')).toBeLessThan(3.5)
    expect(cellValue(b, 'mean')).toBeLessThan(-2.5)
    expect(a.spans).toEqual([{ log: 0, start: 0, end: 0.2 }])
    expect(b.spans).toEqual([{ log: 0, start: 0.3, end: 0.5 }])
    expect(grid.samples).toBe(10)
    expect(cellValue(grid.cells[1], 'n')).toBeNaN()
  })

  it('caps time across gaps and splits spans at gaps', () => {
    const grid = emptyGrid([0, 10], [0, 10])
    accumulate(grid, { t: [0, 0.1, 10, 10.1], x: [5, 5, 5, 5], y: [5, 5, 5, 5], z: [1, 1, 1, 1] }, 0, 0.5)
    const c = grid.cells[0]
    expect(c.time).toBeLessThan(1)
    expect(c.spanCount).toBe(2)
  })

  it('respects the mask, NaN values and out-of-grid samples', () => {
    const grid = emptyGrid([0, 10], [0, 10])
    accumulate(grid, { t: [0, 1, 2, 3], x: [5, 5, 50, 5], y: [5, 5, 5, 5], z: [1, NaN, 1, 1], mask: [1, 1, 1, 0] })
    expect(grid.cells[0].n).toBe(1)
    expect(grid.outside).toBe(1)
  })

  it('combines several logs and keeps the source log of each span', () => {
    const grid = emptyGrid([0, 10], [0, 10])
    accumulate(grid, { t: [0, 0.1], x: [5, 5], y: [5, 5], z: [1, 1] }, 0)
    accumulate(grid, { t: [0, 0.1], x: [5, 5], y: [5, 5], z: [3, 3] }, 1)
    expect(grid.cells[0].n).toBe(4)
    expect(cellValue(grid.cells[0], 'mean')).toBeCloseTo(2, 6)
    expect(grid.cells[0].spans.map((s) => s.log)).toEqual([0, 1])
  })

  it('keeps at most MAX_SPANS_PER_CELL spans but counts all', () => {
    const grid = emptyGrid([0, 10], [0, 10])
    const n = (MAX_SPANS_PER_CELL + 10) * 2
    // Alternate in and out of the grid so every in-grid sample starts a new span.
    const x = Array.from({ length: n }, (_, i) => (i % 2 ? 50 : 5))
    accumulate(grid, { t: x.map((_, i) => i * 0.1), x, y: x.map(() => 5), z: x.map(() => 1) })
    expect(grid.cells[0].spans).toHaveLength(MAX_SPANS_PER_CELL)
    expect(grid.cells[0].spanCount).toBe(MAX_SPANS_PER_CELL + 10)
  })
})

describe('buildMask', () => {
  const t = f64([0, 0.1, 0.2, 0.3, 0.4, 0.5])
  it('applies throttle, warm-up, fuel cut, gear and range filters', () => {
    const { mask, unavailable } = buildMask(
      {
        t,
        rpm: f64([2000, 2000, 2000, 2000, 2000, 2000]),
        coolantC: f64([60, 90, 90, 90, 90, 90]),
        pedalPct: f64([100, 100, 0, 30, 100, 100]),
        gear: f64([3, 3, 3, 3, 4, 3])
      },
      { ...DEFAULT_FILTERS, excludeTransients: false, throttle: 'wot', gear: 3, range: [0, 0.45] }
    )
    expect(Array.from(mask)).toEqual([0, 1, 0, 0, 0, 0])
    expect(unavailable).toEqual([])
  })

  it('reports filters it cannot apply', () => {
    const { mask, unavailable } = buildMask({ t }, { ...DEFAULT_FILTERS, gear: 3 })
    expect(Array.from(mask)).toEqual([1, 1, 1, 1, 1, 1])
    expect(unavailable.length).toBe(4)
  })

  it('drops fast load changes as transients', () => {
    const tt = f64(Array.from({ length: 50 }, (_, i) => i * 0.02))
    const load = f64(Array.from({ length: 50 }, (_, i) => (i < 20 ? 40 : i < 25 ? 40 + (i - 20) * 30 : 190)))
    const { mask } = buildMask({ t: tt, load }, { ...DEFAULT_FILTERS, warm: false, excludeFuelCut: false })
    expect(mask[5]).toBe(1)
    expect(mask[22]).toBe(0)
    expect(mask[45]).toBe(1)
  })
})

describe('timing corrections (beta)', () => {
  it('removes static cylinder offsets and isolates a pulled cylinder', () => {
    const n = 200
    const offsets = [0.4, -0.3, 0.1, 0, -0.2, 0]
    const partLoadUntil = 120
    const timing = offsets.map((off, c) =>
      Float64Array.from({ length: n }, (_, i) => 20 + off - (c === 2 && i >= 150 && i < 160 ? 3 : 0))
    )
    const { avg, worst, perCylinder } = timingCorrections(timing, (i) => i < partLoadUntil)
    expect(Math.abs(worst[50])).toBeLessThan(1e-9)
    expect(perCylinder[2][155]).toBeCloseTo(-3, 9)
    expect(worst[155]).toBeCloseTo(-3, 9)
    expect(avg[155]).toBeCloseTo(-0.5, 9)
  })

  it('adds derived channels to a log when their inputs exist', () => {
    const t = f64([0, 1, 2])
    const ch = (id: string, unit: string, v: number[]) => ({ id, name: id, unit, quantity: 'none' as const, data: f64(v) })
    const log: LogData = {
      name: 'x',
      meta: {},
      time: t,
      channels: [
        ch('fuel.lambda.actual', 'λ', [0.85, 0.82, 1]),
        ch('fuel.lambda.target', 'λ', [0.82, 0.82, 1]),
        ch('boost.actual', 'bar', [1.2, 1.5, 0]),
        ch('boost.target', 'bar', [1.5, 1.5, 0]),
        ch('ign.cyl1', '°CRK', [10, 10, 10]),
        ch('ign.cyl2', '°CRK', [10, 8, 10])
      ]
    }
    const { log: out, derived } = withDerivedChannels(log)
    const ids = derived.map((d) => d.id)
    expect(ids).toEqual(expect.arrayContaining(['derived.lambda_error', 'derived.boost_error', 'derived.timing_corr.avg', 'derived.timing_corr.worst']))
    expect(ids).not.toContain('derived.rail_drop')
    const lam = out.channels.find((c) => c.id === 'derived.lambda_error')!.data
    expect(lam[0]).toBeCloseTo(0.03, 9)
    expect(out.channels.find((c) => c.id === 'derived.timing_corr.worst')!.data[1]).toBeCloseTo(-2, 9)
  })
})
