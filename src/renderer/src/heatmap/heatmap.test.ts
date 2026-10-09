import { describe, expect, it } from 'vitest'
import type { HeatmapPrefs, LogData } from '@shared/types'
import { DEFAULT_UNITS } from '@shared/units'
import { buildModel, DEFAULT_HEATMAP, fmtVal, prepareSource, resolveStat } from './model'
import { heatmapTable } from './exportHeatmap'

const f64 = (a: number[]): Float64Array => Float64Array.from(a)
const ch = (id: string, unit: string, data: number[]) => ({ id, name: id, unit, quantity: 'none' as const, data: f64(data) })

/** 2 s at 10 Hz: first second at 1000 rpm / 50 % load, second at 2000 rpm / 150 % load. */
function makeLog(): LogData {
  const n = 20
  const t = Array.from({ length: n }, (_, i) => i * 0.1)
  const first = (i: number): boolean => i < 10
  return {
    name: 'test.csv',
    meta: {},
    time: f64(t),
    channels: [
      ch('engine.rpm', 'rpm', t.map((_, i) => (first(i) ? 1000 : 2000))),
      ch('load.engine', '%', t.map((_, i) => (first(i) ? 50 : 150))),
      ch('fuel.lambda.actual', 'λ', t.map((_, i) => (first(i) ? 1.0 : 0.86))),
      ch('fuel.lambda.target', 'λ', t.map((_, i) => (first(i) ? 1.0 : 0.82))),
      ch('temp.coolant', '°C', t.map(() => 90))
    ]
  }
}

const prefs = (patch: Partial<HeatmapPrefs> = {}): HeatmapPrefs => ({
  ...DEFAULT_HEATMAP,
  valueId: 'derived.lambda_error',
  stat: 'mean',
  preset: 'lambda',
  x: { channelId: 'engine.rpm', start: 500, step: 1000, end: 2500 },
  y: { channelId: 'load.engine', start: 0, step: 100, end: 200 },
  filters: { ...DEFAULT_HEATMAP.filters, excludeTransients: false },
  minSamples: 5,
  ...patch
})

describe('heatmap model', () => {
  const source = prepareSource(makeLog(), new Map())

  it('bins derived lambda error into the right cells', () => {
    const model = buildModel([source], { prefs: prefs(), units: DEFAULT_UNITS, range: null })
    if ('error' in model) throw new Error(model.error)
    // Columns: 500–1500, 1500–2500. Rows: 0–100, 100–200.
    expect(model.values[0]).toBeCloseTo(0, 9)
    expect(model.values[3]).toBeCloseTo(0.04, 9)
    expect(Number.isNaN(model.values[1])).toBe(true)
    expect(model.scale.kind).toBe('diverging')
  })

  it('hides cells below the minimum sample count', () => {
    const model = buildModel([source], { prefs: prefs({ minSamples: 11 }), units: DEFAULT_UNITS, range: null })
    if ('error' in model) throw new Error(model.error)
    expect(model.values.every((v) => Number.isNaN(v))).toBe(true)
  })

  it('resolves "worst" to the bad direction of the value', () => {
    expect(resolveStat('worst', 'derived.timing_corr.worst')).toBe('min')
    expect(resolveStat('worst', 'derived.lambda_error')).toBe('max')
    expect(resolveStat('mean', 'derived.lambda_error')).toBe('mean')
  })

  it('reports a missing value channel instead of drawing an empty grid', () => {
    const model = buildModel([source], { prefs: prefs({ valueId: 'derived.timing_corr.worst' }), units: DEFAULT_UNITS, range: null })
    expect('error' in model && model.error).toMatch(/per-cylinder ignition timing/)
  })

  it('exports a table with the highest load row first', () => {
    const model = buildModel([source], { prefs: prefs(), units: DEFAULT_UNITS, range: null })
    if ('error' in model) throw new Error(model.error)
    const rows = heatmapTable(model, ',').trim().split('\n')
    expect(rows[0].split(',').slice(1)).toEqual(['500-1500', '1500-2500'])
    expect(rows[1]).toBe('100-200,,0.040')
    expect(rows[2]).toBe('0-100,0.000,')
  })

  it('never shows negative zero', () => {
    expect(fmtVal(-0.0004, 3)).toBe('0.000')
    expect(fmtVal(-0.0006, 3)).toBe('-0.001')
  })
})
