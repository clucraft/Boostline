import type { ChannelDef, ChannelGroup, Quantity } from '@shared/types'
import { decodeMeasurement, VALUE_SIZE } from './sgbdRow'
import type { BmwDataPack, BmwDme, BmwMeasurement, DmeChannelRead, DmeChannelSet, DmeDerivedChannel } from './types'

// Turns a DME's imported measurements into Boostline channels.
//
// Curated rules map the measurements tuners log most (boost, wastegate, rail
// pressure, lambda, timing, VANOS, ...) onto Boostline's well-known channel ids with English
// names, so presets, the Dyno and Drag tools work on every DME family. The rules match the
// SGBD result name first, then the German description (INFO) — many MEVD17 / S55 entries
// only have generic result names like STAT_0x4206_WERT. Umlauts in INFO may have been lost
// (U+FFFD), so INFO patterns use "." where an umlaut would be.
// Every other numeric measurement is offered in the "DME" group under its SGBD name.

interface UnitMapping {
  unit: string
  quantity: Quantity
  factor: number
  offset?: number
}

/** SGBD unit → Boostline native unit (pressures to bar, millivolts to volts, ...). */
const UNIT_MAP: Readonly<Record<string, UnitMapping>> = {
  hPa: { unit: 'bar', quantity: 'pressure', factor: 0.001 },
  kPa: { unit: 'bar', quantity: 'pressure', factor: 0.01 },
  MPa: { unit: 'bar', quantity: 'pressure', factor: 10 },
  bar: { unit: 'bar', quantity: 'pressure', factor: 1 },
  rpm: { unit: 'rpm', quantity: 'rpm', factor: 1 },
  '°C': { unit: '°C', quantity: 'temperature', factor: 1 },
  '°CRK': { unit: '°CRK', quantity: 'angle', factor: 1 },
  '°': { unit: '°', quantity: 'angle', factor: 1 },
  '%': { unit: '%', quantity: 'percent', factor: 1 },
  '% DK': { unit: '%', quantity: 'percent', factor: 1 },
  'km/h': { unit: 'km/h', quantity: 'speed', factor: 1 },
  Nm: { unit: 'Nm', quantity: 'torque', factor: 1 },
  'kg/h': { unit: 'kg/h', quantity: 'massFlow', factor: 1 },
  V: { unit: 'V', quantity: 'voltage', factor: 1 },
  mV: { unit: 'V', quantity: 'voltage', factor: 0.001 },
  A: { unit: 'A', quantity: 'current', factor: 1 },
  mA: { unit: 'A', quantity: 'current', factor: 0.001 },
  ms: { unit: 'ms', quantity: 'time', factor: 1 },
  s: { unit: 's', quantity: 'time', factor: 1 },
  mm: { unit: 'mm', quantity: 'none', factor: 1 }
}

const unitOf = (m: BmwMeasurement): UnitMapping => UNIT_MAP[m.unit] ?? { unit: m.unit, quantity: 'none', factor: 1 }

interface Rule {
  id: string
  name: string
  group: ChannelGroup
  /** Matched against the SGBD result name. */
  result?: RegExp
  /** Matched against the German description when no result name matched. */
  info?: RegExp
  /** Rejects candidates whose result name or description matches. */
  exclude?: RegExp
  /** Acceptable SGBD units (normalised); any when omitted. */
  units?: string[]
  /** Overrides the native unit/quantity (e.g. unitless lambda → λ). */
  as?: { unit: string; quantity: Quantity }
  /** Applied after SGBD scaling and unit mapping. */
  transform?: (v: number) => number
  decimals: number
  min?: number
  max?: number
}

const EXCLUDE_RAW = /ROH|SPANNUNG|SPG_|_SPG|ADAPT|OFFS|DIAG|ZAEHLER|FEHLER|GRENZ|SCHWELLE|MAX_|MIN_|_MAX|_MIN|FREEZE|STATUS/i

const PER_CYLINDER = [1, 2, 3, 4, 5, 6, 7, 8]

const RULES: Rule[] = [
  { id: 'engine.rpm', name: 'Engine RPM', group: 'Engine', result: /^STAT_MOTORDREHZAHL_WERT$/, info: /^Motordrehzahl$/i, units: ['rpm'], decimals: 0, min: 0, max: 7500 },
  { id: 'engine.oil_pressure', name: 'Oil Pressure', group: 'Engine', result: /^STAT_OELDRUCK_WERT$/, info: /^.ldruck$/i, units: ['hPa', 'kPa', 'bar'], decimals: 2 },

  { id: 'throttle.pedal', name: 'Accelerator Pedal', group: 'Throttle', result: /FAHRERWUNSCH_PEDAL|^STAT_FAHRPEDAL(WERT)?_WERT$/, info: /Fahrpedal/i, exclude: /BUS_|ROH|SPANNUNG/i, units: ['%'], decimals: 1, min: 0, max: 100 },
  { id: 'throttle.position', name: 'Throttle Position · Actual', group: 'Throttle', result: /^STAT_DROSSELKLAPPENWINKEL_WERT$/, info: /^Drosselklappenwinkel$/i, units: ['%', '% DK'], decimals: 1, min: 0, max: 100 },
  { id: 'throttle.target', name: 'Throttle Position · Target', group: 'Throttle', result: /^STAT_DROSSELKLAPPENWINKEL_SOLL_WERT$/, info: /Drosselklappenwinkel.*soll|Sollwert Drosselklappe/i, units: ['%', '% DK'], decimals: 1, min: 0, max: 100 },

  { id: 'load.maf', name: 'Air Mass Flow · Actual', group: 'Load', result: /^STAT_LUFTMASSE_WERT$|^STAT_HFM_MASSENSTROM_MITTEL_IST_WERT$/, info: /^Luftmasse(nstrom)?( gefiltert)?$/i, units: ['kg/h'], decimals: 1, min: 0, max: 1400 },
  { id: 'load.maf_throttle', name: 'Air Mass Through Throttle', group: 'Load', result: /MASSENSTROM_DK(_BANK1)?_WERT$/, info: /Massenstrom .ber Drosselklappe/i, exclude: /BANK2|Bank 2/, units: ['kg/h'], decimals: 1, min: 0, max: 1400 },
  { id: 'load.engine', name: 'Engine Load · Actual', group: 'Load', result: /^STAT_(I_)?(REL_)?FUELLUNG_WERT$|RELATIVE_LUFTFUELLUNG/, info: /relative (Luft)?f.llung( ist)?$/i, exclude: /SOLL|_S_/, units: ['%'], decimals: 1 },
  { id: 'load.engine_target', name: 'Engine Load · Target', group: 'Load', result: /^STAT_S_FUELLUNG_WERT$|FUELLUNG_SOLL/, info: /f.llung.*soll|Sollf.llung|^Sollwert F.llung/i, units: ['%'], decimals: 1 },
  { id: 'load.torque.actual', name: 'Engine Torque · Actual', group: 'Load', result: /ISTMOMENT_OHNE|^STAT_(I_)?MOTORMOMENT(_IST)?_WERT$|MOMENT_IST_WERT$/, info: /^(Motor)?(ist)?moment( ist)?$/i, exclude: /KUPPL|RAD|RESERVE|EMASCHINE|ADAPT|MSR/i, units: ['Nm'], decimals: 0 },
  { id: 'load.torque.driver', name: 'Driver Wish Torque', group: 'Load', result: /FAHRERWUNSCHMOMENT/, info: /Fahrerwunsch(moment)?/i, exclude: /PEDAL/i, units: ['Nm'], decimals: 0 },
  { id: 'load.torque.reserve', name: 'Torque Reserve · Target', group: 'Load', result: /MOMENT_RESERVE_SOLL|MOMENTENRESERVE/, info: /Momentenreserve/i, units: ['Nm'], decimals: 0 },

  { id: 'boost.charge_abs', name: 'Boost Pressure · Actual (abs)', group: 'Boost', result: /^STAT_LADEDRUCK_WERT$|^STAT_I_LADEDRUCK_WERT$/, info: /^Ladedruck( ist)?$/i, units: ['hPa', 'kPa'], decimals: 3, min: 0.5, max: 3.5 },
  { id: 'boost.target_abs', name: 'Boost Pressure · Target (abs)', group: 'Boost', result: /^STAT_S_LADEDRUCK_WERT$|LADEDRUCK_SOLL_WERT$|SOLLLADEDRUCK/, info: /Ladedruck.*soll|Sollladedruck/i, exclude: /REGELDIFF|BEGRENZ/i, units: ['hPa', 'kPa'], decimals: 3, min: 0.5, max: 3.5 },
  { id: 'boost.map', name: 'Manifold Pressure · Absolute', group: 'Boost', result: /^STAT_SAUGROHRDRUCK_WERT$|^STAT_DRUCK_ABS_SAUGROHR_WERT$/, info: /^Saugrohrdruck$/i, units: ['hPa', 'kPa'], decimals: 3, min: 0, max: 3.5 },
  { id: 'boost.ambient', name: 'Ambient Pressure', group: 'Boost', result: /^STAT_UMGEBUNGSDRUCK_WERT$/, info: /^Umgebungsdruck$/i, units: ['hPa', 'kPa'], decimals: 3, min: 0.7, max: 1.1 },
  { id: 'boost.wg_actual', name: 'EWG Position · Actual', group: 'Boost', result: /^STAT_I_EWG_POS_WERT$|EWG_POS(ITION)?_IST/, info: /Wastegate.*(ist|Position)/i, exclude: /BANK2|_2_WERT|SOLL|ROH|SPANNUNG/i, units: ['%'], decimals: 1, min: 0, max: 100 },
  { id: 'boost.wg_target', name: 'EWG Position · Target', group: 'Boost', result: /^STAT_SOLL_POS_EWG_WERT$|EWG_POS(ITION)?_SOLL/, info: /Wastegate.*soll/i, exclude: /BANK2|EWG2/i, decimals: 2 },

  { id: 'fuel.rail.actual', name: 'Rail Pressure · Actual', group: 'Fuel', result: /^STAT_I_DRUCK_RAIL_ABS_FILT(_NEU)?_WERT$|^STAT_RAILDRUCK(_IST)?_WERT$|PRAIL_IST/, info: /Gefilterter Raildruck-?Istwert|^Raildruck-?Istwert|^Raildruck( ist| gefiltert)?$/i, exclude: /ROH|SOLL|OFFS|KORR|SPANNUNG|ungefiltert/i, units: ['MPa', 'hPa', 'kPa', 'bar'], decimals: 1, min: 0, max: 400 },
  { id: 'fuel.rail.target', name: 'Rail Pressure · Target', group: 'Fuel', result: /^STAT_S_RAILDRUCKREGELUNG(_NEU)?_WERT$|RAILDRUCK_SOLL|SOLL_RAILDRUCK/, info: /Raildruck.*soll|Sollwert Raildruck|Sollraildruck|Solldruck Hochdrucksystem/i, units: ['MPa', 'hPa', 'kPa', 'bar'], decimals: 1, min: 0, max: 400 },
  { id: 'fuel.lpfp', name: 'Low Pressure Fuel · Actual', group: 'Fuel', result: /NIEDERDRUCK.*WERT$|KRAFTSTOFFNIEDERDRUCK/, info: /Kraftstoffniederdruck|Niederdruck( ist)?$/i, exclude: /SPANNUNG|SPG|SOLL/i, units: ['kPa', 'hPa', 'bar', 'MPa'], decimals: 2 },
  { id: 'fuel.lambda.actual', name: 'Lambda · Actual', group: 'Fuel', result: /^STAT_LAMBDA_SONDE_IST_WERT$|^STAT_LAMBDA(_BANK1)?_IST(WERT)?_WERT$|LAMBDA_ISTWERT_SENSOR1_BANK1/, info: /^Lambda(wert)? ist|Lambda-?Istwert/i, exclude: /BANK2|Bank 2|OFFSET|ADAP|ABWEICH|WIDERSTAND|ZUSTAND/i, as: { unit: 'λ', quantity: 'lambda' }, decimals: 3, min: 0.7, max: 1.2 },
  { id: 'fuel.lambda.target', name: 'Lambda · Target', group: 'Fuel', result: /^STAT_LAMBDA_BANK1_SOLL_WERT$|^STAT_LAMBDA_SONDE_SOLL_WERT$|LAMBDA_SOLL_WERT$/, info: /Lambda.*soll|Lambdasollwert/i, exclude: /BANK2|Bank 2|KENNZAHL/i, as: { unit: 'λ', quantity: 'lambda' }, decimals: 3, min: 0.7, max: 1.2 },
  { id: 'fuel.ltft', name: 'Fuel Trim · Long Term', group: 'Fuel', result: /ADAPTION_MULTIPLIKATIV(_BANK1|_GRUPPE1)_WERT$/, info: /multiplikative (Gemisch)?adaption.*(Bank 1|Gruppe 1)/i, as: { unit: '%', quantity: 'percent' }, transform: (v) => (v - 1) * 100, decimals: 1, min: -25, max: 25 },
  { id: 'fuel.inj_time', name: 'Injection Time', group: 'Fuel', result: /EINSPRITZZEIT(_ZYL1)?_WERT$|^STAT_TI_WERT$/, info: /^Einspritzzeit/i, units: ['ms'], decimals: 2 },

  { id: 'ign.avg', name: 'Ignition Timing · Average', group: 'Ignition', result: /^STAT_I_ZUENDWINKEL_WERT$|^STAT_ZW_AUSGABE_BANK1_WERT$|^STAT_ZUENDWINKEL_WERT$/, info: /^Z.ndwinkel( ist)?$/i, units: ['°CRK', '°'], decimals: 1, min: -10, max: 50 },
  ...PER_CYLINDER.map<Rule>((n) => ({
    id: `ign.cyl${n}`,
    name: `Ignition Timing · Cyl ${n}`,
    group: 'Ignition',
    result: new RegExp(`^STAT_ZUENDWINKEL_ZYL${n}_WERT$`),
    info: new RegExp(`^Z.ndwinkel Zylinder ${n}$`, 'i'),
    units: ['°CRK', '°'],
    decimals: 1,
    min: -10,
    max: 50
  })),
  ...PER_CYLINDER.map<Rule>((n) => ({
    id: `knock.signal.cyl${n}`,
    name: `Knock Signal · Cyl ${n}`,
    group: 'Knock',
    result: new RegExp(`^STAT_KLOPFWERT_ZYL${n}(_SPANNUNG)?_WERT$`),
    info: new RegExp(`^Klopfwert Zylinder ${n}`, 'i'),
    decimals: 3
  })),

  { id: 'temp.intake', name: 'Intake Air Temp', group: 'Temperatures', result: /^STAT_TEMP_ANSLUFT1?(_FILT)?_WERT$|^STAT_ANSAUGLUFTTEMPERATUR(_1)?_WERT$/, info: /^Ansauglufttemperatur( 1)?$/i, exclude: EXCLUDE_RAW, units: ['°C'], decimals: 1, min: -20, max: 90 },
  { id: 'temp.charge', name: 'Charge Air Temp · Post IC', group: 'Temperatures', result: /LADELUFTTEMPERATUR|TEMP_LADELUFT|TEMP_NACH_LLK/, info: /Ladelufttemperatur/i, exclude: EXCLUDE_RAW, units: ['°C'], decimals: 1, min: -20, max: 90 },
  { id: 'temp.coolant', name: 'Coolant Temp', group: 'Temperatures', result: /^STAT_KUEHLMITTELTEMPERATUR_WERT$|^STAT_TEMP_KUEHLMITTEL_WERT$/, info: /^K.hlmitteltemperatur$/i, units: ['°C'], decimals: 1, min: -20, max: 130 },
  { id: 'temp.oil', name: 'Oil Temp', group: 'Temperatures', result: /^STAT_OELTEMPERATUR_WERT$|^STAT_TEMP_OEL_SUMPF_WERT$/, info: /^.ltemperatur$/i, units: ['°C'], decimals: 1, min: -20, max: 150 },
  { id: 'temp.ambient', name: 'Ambient Temp', group: 'Temperatures', result: /^STAT_UMGEBUNGSTEMPERATUR_WERT$|^STAT_TEMP_UMGEBUNG_WERT$|AUSSENTEMPERATUR/, info: /^(Umgebungs|Au.en)temperatur$/i, units: ['°C'], decimals: 1, min: -30, max: 50 },
  { id: 'temp.exhaust', name: 'Exhaust Gas Temp', group: 'Temperatures', result: /ABGASTEMPERATUR(_VORKAT|_BANK1)?_WERT$/, info: /^Abgastemperatur/i, exclude: /BANK2|Bank 2|SOLL/i, units: ['°C'], decimals: 0 },
  { id: 'temp.trans', name: 'Transmission Oil Temp', group: 'Temperatures', result: /^STAT_TEMP_GETRIEBE_WERT$|GETRIEBEOELTEMP/, info: /Getriebe(.l)?temperatur/i, units: ['°C'], decimals: 1 },

  { id: 'vanos.intake.actual', name: 'VANOS Intake · Actual', group: 'VANOS', result: /^STAT_I_NWSE_SPREIZUNG_WERT$|^STAT_NW_EINLASSSPREIZUNG_WERT$|^STAT_POSITION_NOCKENWELLE_EINLASS_WERT$/, info: /Einlassspreizung( ist)?$|Nockenwelle Einlass( ist)?$/i, exclude: /SOLL|ADAP/i, units: ['°CRK', '°'], decimals: 1 },
  { id: 'vanos.intake.target', name: 'VANOS Intake · Target', group: 'VANOS', result: /^STAT_S_NWSE_SPREIZUNG_WERT$|SOLLWINKEL_EINLASSVANOS|EINLASSSPREIZUNG_SOLL/, info: /Einlassspreizung soll|Sollwinkel Einlass/i, units: ['°CRK', '°'], decimals: 1 },
  { id: 'vanos.exhaust.actual', name: 'VANOS Exhaust · Actual', group: 'VANOS', result: /^STAT_I_NWSA_SPREIZUNG_WERT$|^STAT_NW_AUSLASSSPREIZUNG_WERT$|^STAT_POSITION_NOCKENWELLE_AUSLASS_WERT$/, info: /Auslassspreizung( ist)?$|Nockenwelle Auslass( ist)?$/i, exclude: /SOLL|ADAP/i, units: ['°CRK', '°'], decimals: 1 },
  { id: 'vanos.exhaust.target', name: 'VANOS Exhaust · Target', group: 'VANOS', result: /^STAT_S_NWSA_SPREIZUNG_WERT$|SOLLWINKEL_AUSLASSVANOS|AUSLASSSPREIZUNG_SOLL/, info: /Auslassspreizung soll|Sollwinkel Auslass/i, units: ['°CRK', '°'], decimals: 1 },
  { id: 'vanos.valvelift', name: 'Valvetronic Lift', group: 'VANOS', result: /^STAT_S_EINLASSVENTILHUB(_FILT)?_WERT$|^STAT_EINLASSVENTILHUB_WERT$/, info: /Einlassventilhub/i, exclude: /ADAP|PRAEDIK/i, units: ['mm'], decimals: 2 },

  { id: 'vehicle.speed', name: 'Vehicle Speed', group: 'Vehicle', result: /^STAT_GESCHWINDIGKEIT_WERT$|^STAT_FAHRZEUGGESCHWINDIGKEIT_WERT$/, info: /^(Fahrzeug)?geschwindigkeit$/i, units: ['km/h'], decimals: 1, min: 0, max: 300 },
  { id: 'vehicle.gear', name: 'Gear', group: 'Vehicle', result: /^STAT_BERECHNETER_GANG_WERT$|^STAT_ISTGANG_WERT$|^STAT_GANG_WERT$/, info: /^(berechneter |aktueller )?Gang$/i, as: { unit: 'gear', quantity: 'gear' }, decimals: 0, min: 0, max: 8 },
  { id: 'elec.battery', name: 'Battery Voltage', group: 'Electrical', result: /^STAT_UBATT(_AD_WANDLER)?_WERT$|^STAT_BATTERIESPANNUNG_WERT$|^STAT_SPG_ECU_BORDNETZ_WERT$/, info: /^Batteriespannung$|^Bordnetzspannung$/i, units: ['V', 'mV'], decimals: 2, min: 10, max: 16 }
]

/** Picks the measurement for a rule: result-name matches first, then description matches. */
function pick(rule: Rule, measurements: readonly BmwMeasurement[], taken: Set<number>): BmwMeasurement | undefined {
  const ok = (m: BmwMeasurement): boolean =>
    !taken.has(m.did) && (!rule.units || rule.units.includes(m.unit)) && !(rule.exclude && (rule.exclude.test(m.result) || rule.exclude.test(m.info)))
  return (
    (rule.result && measurements.find((m) => ok(m) && rule.result!.test(m.result))) ||
    (rule.info && measurements.find((m) => ok(m) && rule.info!.test(m.info))) ||
    undefined
  )
}

/** "STAT_LADEDRUCK_REGELDIFFERENZ_WERT" → "Ladedruck Regeldifferenz"; generic names fall back to INFO. */
export function measurementName(m: BmwMeasurement): string {
  const generic = /^STAT_0X[0-9A-F]+_WERT$/i.test(m.result) || !m.result
  if (generic && m.info) return m.info.replace(/�/g, '?')
  const words = m.result
    .replace(/^STAT_/, '')
    .replace(/_WERT$/, '')
    .split('_')
    .filter(Boolean)
  return words.map((w) => (w.length <= 3 && /^[A-Z0-9]+$/.test(w) ? w : w[0] + w.slice(1).toLowerCase())).join(' ') || `DID 0x${m.did.toString(16)}`
}

function decimalsFor(m: BmwMeasurement, factor: number): number {
  const step = Math.abs((m.mul / m.div) * factor)
  if (!Number.isFinite(step) || step === 0) return 2
  return Math.min(4, Math.max(0, Math.ceil(-Math.log10(step))))
}

function makeRead(m: BmwMeasurement, channel: ChannelDef, transform?: (v: number) => number): DmeChannelRead {
  const map = unitOf(m)
  return {
    channel,
    did: m.did,
    length: VALUE_SIZE[m.type],
    composable: m.composable,
    decode: (data) => {
      const v = decodeMeasurement(m, data) * map.factor + (map.offset ?? 0)
      return transform ? transform(v) : v
    }
  }
}

/** Builds the channel set for one DME: curated channels, derived boost, then all other measurements. */
export function buildDmeChannelSet(dme: BmwDme): DmeChannelSet {
  const reads: DmeChannelRead[] = []
  const taken = new Set<number>()
  const ids = new Set<string>()
  for (const rule of RULES) {
    const m = pick(rule, dme.measurements, taken)
    if (!m) continue
    const map = unitOf(m)
    taken.add(m.did)
    ids.add(rule.id)
    const unit = rule.as?.unit ?? map.unit
    const quantity = rule.as?.quantity ?? map.quantity
    const channel: ChannelDef = {
      id: rule.id,
      name: rule.name,
      group: rule.group,
      unit,
      quantity,
      decimals: rule.decimals,
      min: rule.min,
      max: rule.max,
      description: `${m.result}${m.info ? ` · ${m.info}` : ''}`
    }
    reads.push(makeRead(m, channel, rule.transform))
  }

  const derived: DmeDerivedChannel[] = []
  const relative = (id: string, name: string, abs: string): void => {
    if (!ids.has(abs) || !ids.has('boost.ambient')) return
    derived.push({
      channel: { id, name, group: 'Boost', unit: 'bar', quantity: 'pressure', decimals: 3, min: -1, max: 2.5 },
      inputs: [abs, 'boost.ambient'],
      compute: ([p, amb]) => p - amb
    })
  }
  relative('boost.actual', 'Boost Pressure · Actual', ids.has('boost.charge_abs') ? 'boost.charge_abs' : 'boost.map')
  relative('boost.target', 'Boost Pressure · Target', 'boost.target_abs')

  for (const m of dme.measurements) {
    if (taken.has(m.did)) continue
    const map = unitOf(m)
    // Unitless values are only useful when the SGBD scales them (ratios, factors).
    if (!map.unit && m.mul === 1 && m.div === 1 && m.add === 0) continue
    const id = `dme.${m.did.toString(16).padStart(4, '0')}`
    if (ids.has(id)) continue
    ids.add(id)
    taken.add(m.did)
    reads.push(
      makeRead(m, {
        id,
        name: measurementName(m),
        group: 'DME',
        unit: map.unit,
        quantity: map.quantity,
        decimals: decimalsFor(m, map.factor),
        description: `${m.result}${m.info ? ` · ${m.info}` : ''} (DID 0x${m.did.toString(16).toUpperCase()})`
      })
    )
  }
  return { name: `${dme.sgbd} · ${dme.name}`, sgbd: dme.sgbd, ecuAddress: dme.diagAddress, reads, derived }
}

/**
 * Chooses the DME data for a connection: an explicit SGBD name, 'off', or 'auto'
 * (the SGBD whose diagnostic indexes contain the index the DME reported via F150).
 */
export function resolveDme(pack: BmwDataPack | null, selection: string, sgbdIndex: number | undefined): BmwDme | undefined {
  if (!pack || selection === 'off') return undefined
  if (selection && selection !== 'auto') return pack.dmes.find((d) => d.sgbd === selection)
  if (sgbdIndex === undefined) return undefined
  return pack.dmes.find((d) => d.sgbdIndexes.includes(sgbdIndex))
}
