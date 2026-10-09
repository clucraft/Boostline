// Air properties and engine power correction factors.

import type { CorrectionStandard } from '@shared/types'

/** Specific gas constant of dry air, J/(kg·K). */
const R_DRY = 287.058
/** Specific gas constant of water vapour, J/(kg·K). */
const R_VAPOUR = 461.495
const KELVIN = 273.15
export const STANDARD_SEA_LEVEL_HPA = 1013.25

/**
 * Saturation vapour pressure over water in hPa (Buck 1996, an improved
 * Tetens-type fit, accurate to ~0.05 % between −40 and +50 °C):
 *
 *   e_s = 6.1121 · exp((18.678 − T/234.5) · T / (257.14 + T)),  T in °C
 */
export function saturationVaporPressureHpa(tempC: number): number {
  return 6.1121 * Math.exp((18.678 - tempC / 234.5) * (tempC / (257.14 + tempC)))
}

/** Partial pressure of water vapour in hPa for a relative humidity in %. */
export function vaporPressureHpa(tempC: number, humidityPct: number): number {
  const rh = Math.min(Math.max(humidityPct, 0), 100) / 100
  return rh * saturationVaporPressureHpa(tempC)
}

/**
 * Density of moist air in kg/m³ as the sum of the dry-air and vapour partial
 * densities (ideal gas): ρ = p_d / (R_d·T) + p_v / (R_v·T).
 */
export function airDensity(tempC: number, pressureHpa: number, humidityPct: number): number {
  const tK = tempC + KELVIN
  const pv = vaporPressureHpa(tempC, humidityPct) * 100
  const pd = pressureHpa * 100 - pv
  return pd / (R_DRY * tK) + pv / (R_VAPOUR * tK)
}

/**
 * Static pressure at an altitude in the ISA troposphere (hPa):
 * p = p0 · (1 − L·h / T0)^(g·M / (R·L)), L = 0.0065 K/m, T0 = 288.15 K,
 * exponent ≈ 5.25588.
 */
export function pressureAtAltitude(altM: number, seaLevelHpa = STANDARD_SEA_LEVEL_HPA): number {
  return seaLevelHpa * Math.pow(1 - (0.0065 * altM) / 288.15, 5.25588)
}

/**
 * Factor that converts power measured at the given ambient conditions to the
 * standard's reference conditions (multiply measured power by it).
 *
 * - SAE J1349: reference 25 °C and 99 kPa dry-air pressure,
 *     CF = 1.18 · (99 / P_d) · √((T + 273) / 298) − 0.18,  P_d in kPa.
 * - DIN 70020: reference 20 °C and 1013 hPa total pressure,
 *     CF = (1013 / p) · √((T + 273) / 293).
 * - none: 1.
 */
export function correctionFactor(
  standard: CorrectionStandard,
  tempC: number,
  pressureHpa: number,
  humidityPct: number
): number {
  switch (standard) {
    case 'SAE': {
      const dryKpa = (pressureHpa - vaporPressureHpa(tempC, humidityPct)) / 10
      return 1.18 * (99 / dryKpa) * Math.sqrt((tempC + 273) / 298) - 0.18
    }
    case 'DIN':
      return (1013 / pressureHpa) * Math.sqrt((tempC + 273) / 293)
    case 'none':
      return 1
  }
}
