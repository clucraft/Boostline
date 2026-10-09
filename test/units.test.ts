import { describe, expect, it } from 'vitest'
import {
  DEFAULT_UNITS,
  canConvert,
  convert,
  displayUnitFor,
  guessQuantity,
  normalizeUnit,
  powerFromKw,
  speedFromKmh,
  torqueFromNm
} from '@shared/units'

describe('convert', () => {
  it.each([
    ['bar', 'psi', 1.5],
    ['psi', 'kPa', 22],
    ['kPa', 'bar', 250],
    ['mbar', 'psi', 1013],
    ['hPa', 'bar', 990],
    ['°C', '°F', 25],
    ['°F', '°C', -40],
    ['km/h', 'mph', 100],
    ['Nm', 'lb-ft', 500],
    ['kW', 'hp', 300],
    ['kW', 'PS', 300],
    ['hp', 'PS', 450],
    ['kg/h', 'g/s', 800],
    ['g/s', 'lb/min', 250],
    ['λ', 'AFR', 0.82]
  ])('%s → %s → back is lossless', (from, to, v) => {
    expect(convert(convert(v, from, to), to, from)).toBeCloseTo(v, 10)
  })

  it('matches reference values', () => {
    expect(convert(1, 'bar', 'psi')).toBeCloseTo(14.5038, 4)
    expect(convert(1, 'bar', 'kPa')).toBe(100)
    expect(convert(1013, 'mbar', 'bar')).toBeCloseTo(1.013, 12)
    expect(convert(100, '°C', '°F')).toBeCloseTo(212, 10)
    expect(convert(32, '°F', '°C')).toBeCloseTo(0, 10)
    expect(convert(100, 'km/h', 'mph')).toBeCloseTo(62.1371, 4)
    expect(convert(100, 'Nm', 'lb-ft')).toBeCloseTo(73.7562, 4)
    expect(powerFromKw(100, 'hp')).toBeCloseTo(134.102, 3)
    expect(powerFromKw(100, 'PS')).toBeCloseTo(135.962, 3)
    expect(powerFromKw(100, 'kW')).toBe(100)
    expect(torqueFromNm(678, 'lb-ft')).toBeCloseTo(500.07, 2)
    expect(speedFromKmh(160.9344, 'mph')).toBeCloseTo(100, 10)
    expect(convert(3.6, 'kg/h', 'g/s')).toBeCloseTo(1, 12)
    expect(convert(1, 'λ', 'AFR')).toBeCloseTo(14.7, 12)
    expect(convert(0.85, 'lambda', 'afr')).toBeCloseTo(12.495, 12)
  })

  it('accepts sloppy spellings', () => {
    expect(convert(1, 'BAR', 'psig')).toBeCloseTo(14.5038, 4)
    expect(convert(20, 'degC', 'degF')).toBeCloseTo(68, 10)
    expect(convert(100, 'kph', 'MPH')).toBeCloseTo(62.1371, 4)
  })

  it('rejects incompatible units', () => {
    expect(() => convert(1, 'bar', '°C')).toThrow(RangeError)
    expect(() => convert(1, 'foo', 'bar')).toThrow(RangeError)
    expect(canConvert('rpm', 'km/h')).toBe(false)
    expect(canConvert('kPa', 'psi')).toBe(true)
    expect(convert(5, 'foo', 'foo')).toBe(5)
  })
})

describe('normalizeUnit / guessQuantity', () => {
  it.each([
    ['1/min', 'rpm', 'rpm'],
    ['RPM', 'rpm', 'rpm'],
    ['U/min', 'rpm', 'rpm'],
    ['kph', 'km/h', 'speed'],
    ['km/h', 'km/h', 'speed'],
    ['deg', '°', 'angle'],
    ['°CRK', '°CRK', 'angle'],
    ['degC', '°C', 'temperature'],
    ['°c', '°C', 'temperature'],
    ['ºC', '°C', 'temperature'],
    ['C', '°C', 'temperature'],
    ['F', '°F', 'temperature'],
    ['psig', 'psi', 'pressure'],
    ['mbar', 'mbar', 'pressure'],
    ['hpa', 'hPa', 'pressure'],
    ['kpa', 'kPa', 'pressure'],
    ['lambda', 'λ', 'lambda'],
    ['AFR', 'AFR', 'lambda'],
    ['%', '%', 'percent'],
    ['Nm', 'Nm', 'torque'],
    ['ft-lb', 'lb-ft', 'torque'],
    ['whp', 'hp', 'power'],
    ['g/s', 'g/s', 'massFlow'],
    ['ms', 'ms', 'time'],
    ['gear', 'gear', 'gear'],
    ['l/h', 'L/h', 'volumeFlow'],
    ['-', '', 'none'],
    ['widgets', 'widgets', 'none']
  ] as const)('%s → %s (%s)', (raw, canonical, quantity) => {
    expect(normalizeUnit(raw)).toBe(canonical)
    expect(guessQuantity(raw)).toBe(quantity)
  })
})

describe('displayUnitFor', () => {
  it('converts to the preferred unit and adjusts decimals', () => {
    const prefs = { ...DEFAULT_UNITS, pressure: 'psi' as const, temperature: 'F' as const, lambda: 'afr' as const }
    const boost = displayUnitFor({ unit: 'bar', quantity: 'pressure' }, prefs)
    expect(boost.label).toBe('psi')
    expect(boost.toDisplay(1)).toBeCloseTo(14.5038, 4)
    expect(boost.fromDisplay(boost.toDisplay(1.7))).toBeCloseTo(1.7, 12)
    expect(boost.decimals(2)).toBe(1)

    const kpa = displayUnitFor({ unit: 'bar', quantity: 'pressure' }, { ...DEFAULT_UNITS, pressure: 'kPa' })
    expect(kpa.decimals(2)).toBe(0)

    const iat = displayUnitFor({ unit: '°C', quantity: 'temperature' }, prefs)
    expect(iat.label).toBe('°F')
    expect(iat.toDisplay(0)).toBeCloseTo(32, 10)
    expect(iat.decimals(1)).toBe(1)

    const lambda = displayUnitFor({ unit: 'λ', quantity: 'lambda' }, prefs)
    expect(lambda.label).toBe('AFR')
    expect(lambda.toDisplay(1)).toBeCloseTo(14.7, 12)
    expect(lambda.decimals(3)).toBe(2)

    const maf = displayUnitFor({ unit: 'kg/h', quantity: 'massFlow' }, { ...DEFAULT_UNITS, massFlow: 'g/s' })
    expect(maf.decimals(1)).toBe(2)
  })

  it('is the identity for quantities without a preference or unknown units', () => {
    const rpm = displayUnitFor({ unit: 'rpm', quantity: 'rpm' }, DEFAULT_UNITS)
    expect(rpm.label).toBe('rpm')
    expect(rpm.toDisplay(6500)).toBe(6500)
    expect(rpm.decimals(0)).toBe(0)
    const odd = displayUnitFor({ unit: 'widgets', quantity: 'pressure' }, DEFAULT_UNITS)
    expect(odd.label).toBe('widgets')
    expect(odd.toDisplay(3)).toBe(3)
    const same = displayUnitFor({ unit: 'bar', quantity: 'pressure' }, DEFAULT_UNITS)
    expect(same.label).toBe('bar')
    expect(same.toDisplay(1.2)).toBe(1.2)
  })
})
