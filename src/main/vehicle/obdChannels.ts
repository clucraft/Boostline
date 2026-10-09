/**
 * Standard OBD-II (SAE J1979 mode 01) parameters read through UDS.
 *
 * ISO 14229-1 / ISO 27145 (WWH-OBD) map mode-01 PID `pp` to DID 0xF4pp, so
 * `22 F4 0C` answers `62 F4 0C A B` with the same data bytes and scaling as mode 01 PID 0C.
 * ASSUMPTION: BMW F/G DMEs answer these DIDs when addressed physically through the
 * gateway (0x12). Support is detected per car from the supported-PID bitmask DIDs
 * (0xF400, 0xF420, ...: 4 bytes, MSB of the first byte = PID base+1, the last bit flags
 * the next bitmask DID).
 *
 * Channel ids: the well-known ids from CH, or the catalog id (src/shared/catalog.ts) when
 * the OBD value means the same thing; `obd.*` otherwise. Pressures are converted to bar,
 * temperatures are °C.
 *
 * Range limits of the standard PIDs to keep in mind on tuned turbo engines: MAP (0B) and
 * baro (33) saturate at 2.55 bar absolute, vehicle speed (0D) at 255 km/h.
 */
import { CH, type ChannelDef } from '@shared/types'

export const OBD_DID_BASE = 0xf400

export const obdDid = (pid: number): number => OBD_DID_BASE + pid

/** Supported-PID bitmask DIDs; each covers the next 32 PIDs. */
export const SUPPORTED_PID_DIDS: readonly number[] = [0xf400, 0xf420, 0xf440, 0xf460, 0xf480, 0xf4a0]

export interface ObdPid {
  pid: number
  did: number
  /** Data bytes (without the DID echo). */
  length: number
  channel: ChannelDef
  /** Decodes the DID data; NaN when too short or flagged invalid. */
  decode(data: Buffer): number
}

/** A channel computed from other channels after every sampling pass. */
export interface DerivedChannel {
  channel: ChannelDef
  /** Channel ids the computation needs, in the order `compute` receives them. */
  inputs: readonly string[]
  compute(inputs: readonly number[]): number
}

function pid(code: number, length: number, channel: ChannelDef, decode: (d: Buffer) => number): ObdPid {
  return {
    pid: code,
    did: obdDid(code),
    length,
    channel: { ...channel, description: channel.description ?? `OBD-II PID ${code.toString(16).toUpperCase().padStart(2, '0')}` },
    decode: (data) => (data.length < length ? NaN : decode(data))
  }
}

const u16 = (d: Buffer): number => d.readUInt16BE(0)
const percent = (d: Buffer): number => (d[0] * 100) / 255
const celsius = (d: Buffer): number => d[0] - 40
const trim = (d: Buffer): number => ((d[0] - 128) * 100) / 128
const kpaToBar = (d: Buffer): number => d[0] / 100
const ratio = (d: Buffer): number => (u16(d) * 2) / 65536

/**
 * Supported decoders. When several PIDs feed the same channel id the first supported one
 * wins (wideband lambda 0x34 before 0x24).
 */
export const OBD_PIDS: readonly ObdPid[] = [
  pid(0x0c, 2, { id: CH.rpm, name: 'Engine RPM', group: 'Engine', unit: 'rpm', quantity: 'rpm', decimals: 0, min: 0, max: 7500 }, (d) => u16(d) / 4),
  pid(0x1f, 2, { id: 'obd.runtime', name: 'Run Time Since Start', group: 'Engine', unit: 's', quantity: 'time', decimals: 0, min: 0, max: 3600 }, u16),
  pid(0x49, 1, { id: CH.pedal, name: 'Accelerator Pedal', group: 'Throttle', unit: '%', quantity: 'percent', decimals: 1, min: 0, max: 100, description: 'OBD-II PID 49 (pedal position D, raw sensor %; rarely spans 0-100)' }, percent),
  pid(0x11, 1, { id: CH.throttle, name: 'Throttle Position · Actual', group: 'Throttle', unit: '%', quantity: 'percent', decimals: 1, min: 0, max: 100 }, percent),
  pid(0x45, 1, { id: 'obd.throttle_relative', name: 'Throttle Position · Relative', group: 'Throttle', unit: '%', quantity: 'percent', decimals: 1, min: 0, max: 100 }, percent),
  pid(0x4c, 1, { id: 'throttle.target', name: 'Throttle Position · Target', group: 'Throttle', unit: '%', quantity: 'percent', decimals: 1, min: 0, max: 100, description: 'OBD-II PID 4C (commanded throttle actuator)' }, percent),
  pid(0x04, 1, { id: 'load.calc', name: 'Calculated Engine Load', group: 'Load', unit: '%', quantity: 'percent', decimals: 1, min: 0, max: 100 }, percent),
  pid(0x43, 2, { id: 'obd.load_absolute', name: 'Absolute Load', group: 'Load', unit: '%', quantity: 'percent', decimals: 1, min: 0, max: 250 }, (d) => (u16(d) * 100) / 255),
  pid(0x10, 2, { id: 'obd.maf', name: 'Air Mass Flow', group: 'Load', unit: 'g/s', quantity: 'massFlow', decimals: 1, min: 0, max: 400 }, (d) => u16(d) / 100),
  pid(0x61, 1, { id: 'obd.torque_demand_pct', name: 'Driver Demand Torque', group: 'Load', unit: '%', quantity: 'percent', decimals: 0, min: -125, max: 130, description: 'OBD-II PID 61 (% of reference torque)' }, (d) => d[0] - 125),
  pid(0x62, 1, { id: 'obd.torque_actual_pct', name: 'Actual Torque', group: 'Load', unit: '%', quantity: 'percent', decimals: 0, min: -125, max: 130, description: 'OBD-II PID 62 (% of reference torque)' }, (d) => d[0] - 125),
  pid(0x63, 2, { id: 'obd.torque_reference', name: 'Reference Torque', group: 'Load', unit: 'Nm', quantity: 'torque', decimals: 0, min: 0, max: 1000 }, u16),
  pid(0x0b, 1, { id: 'boost.map', name: 'Manifold Pressure · Absolute', group: 'Boost', unit: 'bar', quantity: 'pressure', decimals: 2, min: 0, max: 2.6, description: 'OBD-II PID 0B (saturates at 2.55 bar absolute)' }, kpaToBar),
  pid(0x33, 1, { id: CH.baro, name: 'Ambient Pressure', group: 'Boost', unit: 'bar', quantity: 'pressure', decimals: 2, min: 0.7, max: 1.1, description: 'OBD-II PID 33 (barometric pressure, absolute)' }, kpaToBar),
  pid(0x23, 2, { id: 'fuel.rail.actual', name: 'Rail Pressure · Actual', group: 'Fuel', unit: 'bar', quantity: 'pressure', decimals: 1, min: 0, max: 400, description: 'OBD-II PID 23 (fuel rail gauge pressure)' }, (d) => u16(d) / 10),
  pid(0x34, 4, { id: CH.lambdaActual, name: 'Lambda · Actual', group: 'Fuel', unit: 'λ', quantity: 'lambda', decimals: 3, min: 0.7, max: 1.2, description: 'OBD-II PID 34 (O2 sensor 1, wideband equivalence ratio)' }, ratio),
  pid(0x24, 4, { id: CH.lambdaActual, name: 'Lambda · Actual', group: 'Fuel', unit: 'λ', quantity: 'lambda', decimals: 3, min: 0.7, max: 1.2, description: 'OBD-II PID 24 (O2 sensor 1 equivalence ratio)' }, ratio),
  pid(0x44, 2, { id: 'fuel.lambda.target', name: 'Lambda · Target', group: 'Fuel', unit: 'λ', quantity: 'lambda', decimals: 3, min: 0.7, max: 1.2, description: 'OBD-II PID 44 (commanded equivalence ratio)' }, ratio),
  pid(0x06, 1, { id: 'fuel.stft', name: 'Fuel Trim · Short Term', group: 'Fuel', unit: '%', quantity: 'percent', decimals: 1, min: -25, max: 25, description: 'OBD-II PID 06 (bank 1)' }, trim),
  pid(0x07, 1, { id: 'fuel.ltft', name: 'Fuel Trim · Long Term', group: 'Fuel', unit: '%', quantity: 'percent', decimals: 1, min: -25, max: 25, description: 'OBD-II PID 07 (bank 1)' }, trim),
  pid(0x5e, 2, { id: 'obd.fuel_rate', name: 'Fuel Rate', group: 'Fuel', unit: 'L/h', quantity: 'volumeFlow', decimals: 1, min: 0, max: 100 }, (d) => u16(d) / 20),
  pid(0x0e, 1, { id: 'obd.timing_advance', name: 'Timing Advance · Cyl 1', group: 'Ignition', unit: '°', quantity: 'angle', decimals: 1, min: -20, max: 50, description: 'OBD-II PID 0E (degrees before TDC)' }, (d) => d[0] / 2 - 64),
  pid(0x0f, 1, { id: CH.iat, name: 'Intake Air Temp', group: 'Temperatures', unit: '°C', quantity: 'temperature', decimals: 0, min: -20, max: 90 }, celsius),
  pid(0x05, 1, { id: 'temp.coolant', name: 'Coolant Temp', group: 'Temperatures', unit: '°C', quantity: 'temperature', decimals: 0, min: -20, max: 130 }, celsius),
  pid(0x5c, 1, { id: 'temp.oil', name: 'Oil Temp', group: 'Temperatures', unit: '°C', quantity: 'temperature', decimals: 0, min: -20, max: 150 }, celsius),
  pid(0x46, 1, { id: CH.ambientTemp, name: 'Ambient Temp', group: 'Temperatures', unit: '°C', quantity: 'temperature', decimals: 0, min: -30, max: 50 }, celsius),
  pid(0x3c, 2, { id: 'obd.cat_temp', name: 'Catalyst Temp · B1S1', group: 'Temperatures', unit: '°C', quantity: 'temperature', decimals: 0, min: 0, max: 1000 }, (d) => u16(d) / 10 - 40),
  pid(0x0d, 1, { id: CH.speed, name: 'Vehicle Speed', group: 'Vehicle', unit: 'km/h', quantity: 'speed', decimals: 0, min: 0, max: 255, description: 'OBD-II PID 0D (saturates at 255 km/h)' }, (d) => d[0]),
  // J1979-DA PID A4: A bit 1 = "actual gear" supported/valid, B bits 7..4 = actual gear
  // (C,D = gear ratio / 1000, unused). ASSUMPTION: 0 is neutral and reverse is not decoded.
  pid(0xa4, 4, { id: CH.gear, name: 'Gear', group: 'Vehicle', unit: 'gear', quantity: 'gear', decimals: 0, min: 0, max: 8, description: 'OBD-II PID A4 (transmission actual gear)' }, (d) => ((d[0] & 0x02) !== 0 ? d[1] >> 4 : NaN)),
  pid(0x42, 2, { id: 'elec.battery', name: 'Battery Voltage', group: 'Electrical', unit: 'V', quantity: 'voltage', decimals: 2, min: 10, max: 16, description: 'OBD-II PID 42 (control module voltage)' }, (d) => u16(d) / 1000)
]

export const OBD_DERIVED: readonly DerivedChannel[] = [
  {
    channel: { id: CH.boostActual, name: 'Boost Pressure · Actual', group: 'Boost', unit: 'bar', quantity: 'pressure', decimals: 2, min: -1, max: 1.6, description: 'Manifold absolute pressure minus ambient pressure (OBD-II PIDs 0B, 33)' },
    inputs: ['boost.map', CH.baro],
    compute: ([map, baro]) => map - baro
  },
  {
    channel: { id: CH.torqueActual, name: 'Engine Torque · Actual', group: 'Load', unit: 'Nm', quantity: 'torque', decimals: 0, min: -100, max: 900, description: 'Actual torque % × reference torque (OBD-II PIDs 62, 63)' },
    inputs: ['obd.torque_actual_pct', 'obd.torque_reference'],
    compute: ([pct, reference]) => (pct * reference) / 100
  }
]

/** PIDs flagged in a supported-PID bitmask read from `did` (0xF400, 0xF420, ...). */
export function parseSupportedPids(did: number, data: Uint8Array): number[] {
  const base = did - OBD_DID_BASE
  const pids: number[] = []
  for (let byte = 0; byte < Math.min(4, data.length); byte++) {
    for (let bit = 0; bit < 8; bit++) {
      if (data[byte] & (0x80 >> bit)) pids.push(base + byte * 8 + bit + 1)
    }
  }
  return pids
}

export interface ObdPlan {
  /** Channels available on this ECU: direct PIDs first, then derived channels. */
  channels: ChannelDef[]
  /** One DID per available direct channel (alternatives already resolved). */
  reads: ObdPid[]
  /** Derived channels whose inputs are all available. */
  derived: DerivedChannel[]
}

/** Resolves which OBD channels a car offers, given the PIDs it reports as supported. */
export function buildObdPlan(supported: ReadonlySet<number>): ObdPlan {
  const reads: ObdPid[] = []
  const ids = new Set<string>()
  for (const p of OBD_PIDS) {
    if (!supported.has(p.pid) || ids.has(p.channel.id)) continue
    reads.push(p)
    ids.add(p.channel.id)
  }
  const derived = OBD_DERIVED.filter((d) => !ids.has(d.channel.id) && d.inputs.every((input) => ids.has(input)))
  return { channels: [...reads.map((r) => r.channel), ...derived.map((d) => d.channel)], reads, derived }
}
