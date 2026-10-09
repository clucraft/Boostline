import { describe, expect, it } from 'vitest'
import {
  airDensity,
  correctionFactor,
  pressureAtAltitude,
  saturationVaporPressureHpa,
  vaporPressureHpa
} from '@shared/analysis/air'

describe('air density', () => {
  it('matches dry air at 20 °C and 1013.25 hPa', () => {
    expect(Math.abs(airDensity(20, 1013.25, 0) - 1.204)).toBeLessThan(0.01)
  })

  it('matches ISA sea level (15 °C, dry)', () => {
    expect(airDensity(15, 1013.25, 0)).toBeCloseTo(1.225, 3)
  })

  it('decreases with humidity, temperature and altitude', () => {
    expect(airDensity(25, 1013.25, 80)).toBeLessThan(airDensity(25, 1013.25, 0))
    expect(airDensity(35, 1013.25, 50)).toBeLessThan(airDensity(15, 1013.25, 50))
    expect(airDensity(20, pressureAtAltitude(1500), 50)).toBeLessThan(airDensity(20, 1013.25, 50))
  })

  it('uses a sensible saturation vapour pressure', () => {
    expect(saturationVaporPressureHpa(20)).toBeCloseTo(23.39, 1)
    expect(saturationVaporPressureHpa(0)).toBeCloseTo(6.11, 2)
    expect(vaporPressureHpa(20, 50)).toBeCloseTo(saturationVaporPressureHpa(20) / 2, 10)
  })
})

describe('pressureAtAltitude', () => {
  it('follows the ISA troposphere', () => {
    expect(pressureAtAltitude(0)).toBeCloseTo(1013.25, 10)
    expect(pressureAtAltitude(1000)).toBeCloseTo(898.75, 1)
    expect(pressureAtAltitude(1000, 1020)).toBeCloseTo((898.75 * 1020) / 1013.25, 1)
  })
})

describe('correctionFactor', () => {
  it('is 1 at the reference conditions', () => {
    // SAE J1349: 25 °C and 99 kPa dry-air pressure.
    expect(correctionFactor('SAE', 25, 990, 0)).toBeCloseTo(1, 10)
    expect(correctionFactor('SAE', 25, 990 + vaporPressureHpa(25, 40), 40)).toBeCloseTo(1, 10)
    // DIN 70020: 20 °C and 1013 hPa.
    expect(correctionFactor('DIN', 20, 1013, 50)).toBeCloseTo(1, 10)
    expect(correctionFactor('none', 40, 900, 90)).toBe(1)
  })

  it('stays close to 1 near reference conditions and raises power on hot / thin air', () => {
    expect(Math.abs(correctionFactor('SAE', 22, 1005, 30) - 1)).toBeLessThan(0.03)
    expect(Math.abs(correctionFactor('DIN', 22, 1005, 30) - 1)).toBeLessThan(0.03)
    expect(correctionFactor('SAE', 35, 950, 50)).toBeGreaterThan(1.05)
    expect(correctionFactor('DIN', 35, 950, 50)).toBeGreaterThan(1.05)
    expect(correctionFactor('DIN', 0, 1030, 50)).toBeLessThan(1)
  })
})
