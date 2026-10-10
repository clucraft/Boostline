import type { ChannelDef, ChannelGroup, Quantity } from './types'

// BMW DME-style channel catalog. The simulator produces all of these; real
// adapters report their own (usually smaller) list for the connected ECU.

const c = (
  id: string,
  name: string,
  group: ChannelGroup,
  unit: string,
  quantity: Quantity,
  decimals: number,
  min?: number,
  max?: number
): ChannelDef => ({ id, name, group, unit, quantity, decimals, min, max })

const perCylinder = (
  prefix: string,
  name: string,
  group: ChannelGroup,
  unit: string,
  quantity: Quantity,
  decimals: number,
  min: number,
  max: number
): ChannelDef[] =>
  [1, 2, 3, 4, 5, 6].map((n) => c(`${prefix}.cyl${n}`, `${name} cyl ${n}`, group, unit, quantity, decimals, min, max))

export const BMW_CATALOG: ChannelDef[] = [
  c('engine.rpm', 'Engine speed', 'Engine', 'rpm', 'rpm', 0, 0, 7500),
  c('engine.idle_target', 'Idle speed target', 'Engine', 'rpm', 'rpm', 0, 0, 1500),
  c('engine.oil_pressure', 'Oil pressure', 'Engine', 'bar', 'pressure', 2, 0, 6),

  c('throttle.pedal', 'Accelerator pedal', 'Throttle', '%', 'percent', 1, 0, 100),
  c('throttle.position', 'Throttle angle', 'Throttle', '%', 'percent', 1, 0, 100),
  c('throttle.target', 'Throttle angle target', 'Throttle', '%', 'percent', 1, 0, 100),

  c('load.maf', 'Air mass flow', 'Load', 'kg/h', 'massFlow', 1, 0, 1400),
  c('load.maf_target', 'Air mass flow target', 'Load', 'kg/h', 'massFlow', 1, 0, 1400),
  c('load.calc', 'Calculated load', 'Load', '%', 'percent', 1, 0, 100),
  c('load.engine', 'Engine load', 'Load', '%', 'percent', 1, 0, 250),
  c('load.engine_target', 'Engine load target', 'Load', '%', 'percent', 1, 0, 250),
  c('load.torque.driver', 'Driver torque request', 'Load', 'Nm', 'torque', 0, -100, 700),
  c('load.torque.actual', 'Engine torque', 'Load', 'Nm', 'torque', 0, -100, 700),
  c('load.torque.target', 'Engine torque target', 'Load', 'Nm', 'torque', 0, -100, 700),
  c('load.torque.limit', 'Active torque limit', 'Load', 'Nm', 'torque', 0, 0, 800),

  c('boost.actual', 'Boost pressure', 'Boost', 'bar', 'pressure', 3, -1, 2.5),
  c('boost.target', 'Boost target', 'Boost', 'bar', 'pressure', 3, -1, 2.5),
  c('boost.map', 'Manifold pressure (absolute)', 'Boost', 'bar', 'pressure', 3, 0, 3.5),
  c('boost.ambient', 'Barometric pressure', 'Boost', 'bar', 'pressure', 3, 0.7, 1.1),
  c('boost.wg_actual', 'Wastegate position', 'Boost', '%', 'percent', 2, 0, 100),
  c('boost.wg_target', 'Wastegate target', 'Boost', '%', 'percent', 2, 0, 100),

  c('fuel.rail.actual', 'Rail pressure', 'Fuel', 'bar', 'pressure', 1, 0, 400),
  c('fuel.rail.target', 'Rail pressure target', 'Fuel', 'bar', 'pressure', 1, 0, 400),
  c('fuel.lpfp', 'Low-side fuel pressure', 'Fuel', 'bar', 'pressure', 2, 0, 8),
  c('fuel.lambda.actual', 'Lambda', 'Fuel', 'λ', 'lambda', 3, 0.7, 1.2),
  c('fuel.lambda.target', 'Lambda target', 'Fuel', 'λ', 'lambda', 3, 0.7, 1.2),
  c('fuel.stft', 'Short-term fuel trim', 'Fuel', '%', 'percent', 1, -25, 25),
  c('fuel.ltft', 'Long-term fuel trim', 'Fuel', '%', 'percent', 1, -25, 25),
  c('fuel.inj_time', 'Injection time', 'Fuel', 'ms', 'time', 2, 0, 12),
  c('fuel.ethanol', 'Ethanol content', 'Fuel', '%', 'percent', 0, 0, 100),

  c('ign.avg', 'Ignition timing (average)', 'Ignition', '°CRK', 'angle', 1, -10, 50),
  ...perCylinder('ign', 'Ignition timing', 'Ignition', '°CRK', 'angle', 1, -10, 50),

  ...perCylinder('knock', 'Knock retard', 'Knock', '°CRK', 'angle', 2, -6, 0),

  c('temp.intake', 'Intake air temp', 'Temperatures', '°C', 'temperature', 1, -20, 90),
  c('temp.coolant', 'Coolant temp', 'Temperatures', '°C', 'temperature', 1, -20, 130),
  c('temp.oil', 'Oil temp', 'Temperatures', '°C', 'temperature', 1, -20, 150),
  c('temp.ambient', 'Ambient temp', 'Temperatures', '°C', 'temperature', 1, -30, 50),
  c('temp.charge', 'Charge air temp', 'Temperatures', '°C', 'temperature', 1, -20, 90),
  c('temp.exhaust', 'Exhaust temp (model)', 'Temperatures', '°C', 'temperature', 0, 0, 1050),
  c('temp.trans', 'Transmission oil temp', 'Temperatures', '°C', 'temperature', 1, -20, 140),

  c('vanos.intake.actual', 'Intake cam (VANOS)', 'VANOS', '°CRK', 'angle', 1, 60, 140),
  c('vanos.intake.target', 'Intake cam target', 'VANOS', '°CRK', 'angle', 1, 60, 140),
  c('vanos.exhaust.actual', 'Exhaust cam (VANOS)', 'VANOS', '°CRK', 'angle', 1, -130, -60),
  c('vanos.exhaust.target', 'Exhaust cam target', 'VANOS', '°CRK', 'angle', 1, -130, -60),
  c('vanos.valvelift', 'Valvetronic lift', 'VANOS', 'mm', 'none', 2, 0, 10),

  c('vehicle.speed', 'Vehicle speed', 'Vehicle', 'km/h', 'speed', 1, 0, 300),
  c('vehicle.gear', 'Gear', 'Vehicle', 'gear', 'gear', 0, 0, 8),
  c('vehicle.wheel_slip', 'Wheel slip', 'Vehicle', '%', 'percent', 1, 0, 30),

  c('elec.battery', 'Battery voltage', 'Electrical', 'V', 'voltage', 2, 10, 16)
]

/** Default live dashboard: the boost, fuel and lambda essentials (actual/target pairs share a tile). */
export const DEFAULT_LIVE_CHANNELS = [
  'engine.rpm',
  'throttle.pedal',
  'boost.actual',
  'boost.target',
  'fuel.lambda.actual',
  'fuel.lambda.target',
  'fuel.rail.actual',
  'fuel.rail.target',
  'boost.wg_actual',
  'temp.intake'
]

export const GROUP_ORDER: ChannelGroup[] = [
  'Engine',
  'Throttle',
  'Load',
  'Boost',
  'Fuel',
  'Ignition',
  'Knock',
  'Temperatures',
  'VANOS',
  'Vehicle',
  'Electrical',
  'OBD-II',
  'DME',
  'Custom'
]

export const MAX_LIVE_CHANNELS = 40
export const MAX_GRAPHS = 5
export const MAX_GRAPH_CHANNELS = 5
