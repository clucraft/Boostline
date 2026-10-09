// Unit handling: canonical unit strings, conversion between compatible units,
// and the mapping from a channel's native unit to the user's display preference.
//
// Canonical native unit strings used across the app:
//   "rpm", "km/h", "mph", "bar", "kPa", "hPa", "mbar", "psi", "°C", "°F", "%",
//   "Nm", "lb-ft", "kW", "hp", "PS", "kg/h", "g/s", "lb/min", "λ", "AFR", "°",
//   "°CRK", "V", "A", "s", "ms", "m", "gear", "L/h" and "" (dimensionless / none).
// A few extra units are understood for foreign logs (m/s, Pa, K, mV, km, ft, mi).
// This module is pure and runs in both the main process and the renderer.

import type {
  LambdaUnit,
  PowerUnit,
  Quantity,
  SpeedUnit,
  TemperatureUnit,
  TorqueUnit,
  UnitPrefs
} from '@shared/types'

/** Stoichiometric air/fuel ratio of gasoline; used for λ ↔ AFR. */
export const STOICH_AFR_GASOLINE = 14.7

export const DEFAULT_UNITS: UnitPrefs = {
  pressure: 'bar',
  temperature: 'C',
  speed: 'km/h',
  torque: 'Nm',
  power: 'hp',
  massFlow: 'kg/h',
  lambda: 'lambda'
}

/**
 * Affine definition of a unit relative to the base unit of its quantity:
 * base = value · scale + offset.
 * Bases: rpm, km/h, kPa, °C, %, Nm, kW, kg/h, λ, °, V, A, s, m, gear, L/h.
 */
interface UnitDef {
  quantity: Quantity
  scale: number
  offset: number
}

const def = (quantity: Quantity, scale = 1, offset = 0): UnitDef => ({ quantity, scale, offset })

const UNIT_DEFS: Readonly<Record<string, UnitDef>> = {
  '': def('none'),
  rpm: def('rpm'),
  'km/h': def('speed'),
  mph: def('speed', 1.609344),
  'm/s': def('speed', 3.6),
  kPa: def('pressure'),
  bar: def('pressure', 100),
  hPa: def('pressure', 0.1),
  mbar: def('pressure', 0.1),
  Pa: def('pressure', 0.001),
  psi: def('pressure', 6.894757293168361),
  '°C': def('temperature'),
  '°F': def('temperature', 5 / 9, -160 / 9), // °C = (°F − 32)·5/9
  K: def('temperature', 1, -273.15),
  '%': def('percent'),
  Nm: def('torque'),
  'lb-ft': def('torque', 1.3558179483314004),
  kW: def('power'),
  hp: def('power', 0.7456998715822702), // mechanical horsepower (550 ft·lbf/s)
  PS: def('power', 0.73549875), // metric horsepower (75 kgf·m/s)
  'kg/h': def('massFlow'),
  'g/s': def('massFlow', 3.6),
  'lb/min': def('massFlow', 0.45359237 * 60),
  'λ': def('lambda'),
  AFR: def('lambda', 1 / STOICH_AFR_GASOLINE),
  '°': def('angle'),
  '°CRK': def('angle'),
  V: def('voltage'),
  mV: def('voltage', 0.001),
  A: def('current'),
  s: def('time'),
  ms: def('time', 0.001),
  m: def('distance'),
  km: def('distance', 1000),
  ft: def('distance', 0.3048),
  mi: def('distance', 1609.344),
  gear: def('gear'),
  'L/h': def('volumeFlow')
}

/** Spellings found in foreign logs (lower-cased, whitespace removed) → canonical unit. */
const ALIASES: Readonly<Record<string, string>> = (() => {
  const groups: Record<string, string[]> = {
    '': ['', '-', '--', 'none', 'n/a', 'unitless'],
    rpm: ['rpm', '1/min', 'u/min', 'min-1', 'min^-1', 'min⁻¹', 'rev/min', 'r/min', '/min'],
    'km/h': ['km/h', 'kmh', 'kph', 'km/hr', 'kmph', 'kmhr'],
    mph: ['mph', 'mi/h', 'mi/hr'],
    'm/s': ['m/s', 'mps'],
    kPa: ['kpa', 'kpaa', 'kpag'],
    bar: ['bar', 'bara', 'barg'],
    hPa: ['hpa'],
    mbar: ['mbar', 'mbara', 'mbarg'],
    Pa: ['pa'],
    psi: ['psi', 'psig', 'psia', 'lb/in2', 'lbf/in2'],
    '°C': ['°c', 'degc', 'deg.c', 'c', 'celsius', '℃', 'grad c', 'gradc'],
    '°F': ['°f', 'degf', 'deg.f', 'f', 'fahrenheit', '℉'],
    K: ['k', 'kelvin'],
    '%': ['%', 'pct', 'percent', 'prozent'],
    Nm: ['nm', 'n·m', 'n.m', 'n-m', 'n*m'],
    'lb-ft': ['lb-ft', 'lbft', 'lb·ft', 'lb.ft', 'lb*ft', 'ft-lb', 'ftlb', 'ft·lb', 'ft.lb', 'ft-lbs', 'lbs-ft', 'lbf-ft', 'lbf·ft'],
    kW: ['kw'],
    hp: ['hp', 'bhp', 'whp'],
    PS: ['ps', 'cv'],
    'kg/h': ['kg/h', 'kg/hr', 'kgh'],
    'g/s': ['g/s', 'g/sec'],
    'lb/min': ['lb/min', 'lbs/min', 'lbm/min'],
    'λ': ['λ', 'lambda', 'lam'],
    AFR: ['afr', 'a/f', 'a:f'],
    '°': ['°', 'deg', 'degree', 'degrees', 'grad'],
    '°CRK': ['°crk', 'degcrk', '°crank', 'degcrank', '°ca', 'degca', '°kw', '°kwg'],
    V: ['v', 'volt', 'volts'],
    mV: ['mv'],
    A: ['a', 'amp', 'amps', 'ampere'],
    s: ['s', 'sec', 'secs', 'second', 'seconds'],
    ms: ['ms', 'msec', 'millisec', 'milliseconds'],
    m: ['m', 'meter', 'meters', 'metre', 'metres'],
    km: ['km'],
    ft: ['ft', 'feet'],
    mi: ['mi', 'mile', 'miles'],
    gear: ['gear', 'gang'],
    'L/h': ['l/h', 'l/hr', 'lph']
  }
  const out: Record<string, string> = {}
  for (const [canonical, spellings] of Object.entries(groups)) for (const s of spellings) out[s] = canonical
  return out
})()

/**
 * Maps a unit as written in a (possibly foreign) log to its canonical string,
 * e.g. "1/min" → "rpm", "degC" → "°C", "psig" → "psi", "kph" → "km/h".
 * Unknown units are returned trimmed but otherwise unchanged.
 */
export function normalizeUnit(unit: string): string {
  const trimmed = unit.trim()
  if (trimmed in UNIT_DEFS) return trimmed
  const key = trimmed
    .toLowerCase()
    .replace(/[º˚]/g, '°') // masculine ordinal / ring above used in place of the degree sign
    .replace(/â°/g, '°') // UTF-8 "°" decoded as Latin-1
    .replace(/\s+/g, '')
  return ALIASES[key] ?? trimmed
}

/** True when the unit (after normalisation) is one this module can convert. */
export function isKnownUnit(unit: string): boolean {
  return normalizeUnit(unit) in UNIT_DEFS
}

/** Physical quantity of a unit; "none" for dimensionless or unknown units. */
export function guessQuantity(unit: string): Quantity {
  return UNIT_DEFS[normalizeUnit(unit)]?.quantity ?? 'none'
}

/**
 * Returns a conversion function between two units, or null when the units are
 * unknown or measure different quantities. Identical units (after
 * normalisation, including unknown ones) convert by identity.
 */
export function converter(fromUnit: string, toUnit: string): ((v: number) => number) | null {
  const from = normalizeUnit(fromUnit)
  const to = normalizeUnit(toUnit)
  if (from === to) return (v) => v
  const a = UNIT_DEFS[from]
  const b = UNIT_DEFS[to]
  if (!a || !b || a.quantity !== b.quantity) return null
  const scale = a.scale / b.scale
  const offset = (a.offset - b.offset) / b.scale
  return (v) => v * scale + offset
}

export function canConvert(fromUnit: string, toUnit: string): boolean {
  return converter(fromUnit, toUnit) !== null
}

/**
 * Converts a value between compatible units.
 * @throws RangeError when the units are unknown or incompatible (use canConvert to check).
 */
export function convert(value: number, fromUnit: string, toUnit: string): number {
  const f = converter(fromUnit, toUnit)
  if (!f) throw new RangeError(`Cannot convert "${fromUnit}" to "${toUnit}"`)
  return f(value)
}

/**
 * The canonical unit the user prefers for a quantity, or undefined for
 * quantities without a preference. The canonical string doubles as label.
 */
export function preferredUnit(quantity: Quantity, prefs: UnitPrefs): string | undefined {
  switch (quantity) {
    case 'pressure':
      return prefs.pressure
    case 'temperature':
      return temperatureLabel(prefs.temperature)
    case 'speed':
      return prefs.speed
    case 'torque':
      return prefs.torque
    case 'power':
      return prefs.power
    case 'massFlow':
      return prefs.massFlow
    case 'lambda':
      return lambdaLabel(prefs.lambda)
    default:
      return undefined
  }
}

export function temperatureLabel(unit: TemperatureUnit): string {
  return unit === 'F' ? '°F' : '°C'
}

export function lambdaLabel(unit: LambdaUnit): string {
  return unit === 'afr' ? 'AFR' : 'λ'
}

export function powerFromKw(kw: number, unit: PowerUnit): number {
  return convert(kw, 'kW', unit)
}

export function torqueFromNm(nm: number, unit: TorqueUnit): number {
  return convert(nm, 'Nm', unit)
}

export function speedFromKmh(kmh: number, unit: SpeedUnit): number {
  return convert(kmh, 'km/h', unit)
}

/** How a channel is presented: label, value mapping and decimals in display units. */
export interface DisplayUnit {
  label: string
  toDisplay(v: number): number
  fromDisplay(v: number): number
  /** Display decimals given the channel's decimals in its native unit. */
  decimals(nativeDecimals: number): number
}

const identity = (v: number): number => v

/**
 * Display unit for a channel under the user's preferences. Quantities without
 * a preference, unknown native units and incompatible units are shown as-is.
 * Decimals shift by the order of magnitude of the conversion factor
 * (e.g. bar → kPa drops two decimals, λ → AFR drops one).
 */
export function displayUnitFor(ch: { unit: string; quantity: Quantity }, prefs: UnitPrefs): DisplayUnit {
  const native = normalizeUnit(ch.unit)
  const target = preferredUnit(ch.quantity, prefs)
  if (target !== undefined && target !== native) {
    const to = converter(native, target)
    const from = converter(target, native)
    if (to && from) {
      const shift = Math.round(Math.log10(Math.abs(to(1) - to(0))))
      return {
        label: target,
        toDisplay: to,
        fromDisplay: from,
        decimals: (nativeDecimals) => Math.max(0, nativeDecimals - shift)
      }
    }
  }
  return { label: native, toDisplay: identity, fromDisplay: identity, decimals: (d) => d }
}
