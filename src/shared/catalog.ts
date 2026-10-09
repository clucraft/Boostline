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
  [1, 2, 3, 4, 5, 6].map((n) => c(`${prefix}.cyl${n}`, `${name} · Cyl ${n}`, group, unit, quantity, decimals, min, max))

export const BMW_CATALOG: ChannelDef[] = [
  c('engine.rpm', 'Engine RPM', 'Engine', 'rpm', 'rpm', 0, 0, 7500),
  c('engine.idle_target', 'Idle Speed · Target', 'Engine', 'rpm', 'rpm', 0, 0, 1500),
  c('engine.oil_pressure', 'Oil Pressure', 'Engine', 'bar', 'pressure', 2, 0, 6),

  c('throttle.pedal', 'Accelerator Pedal', 'Throttle', '%', 'percent', 1, 0, 100),
  c('throttle.position', 'Throttle Position · Actual', 'Throttle', '%', 'percent', 1, 0, 100),
  c('throttle.target', 'Throttle Position · Target', 'Throttle', '%', 'percent', 1, 0, 100),

  c('load.maf', 'Air Mass Flow · Filtered', 'Load', 'kg/h', 'massFlow', 1, 0, 1400),
  c('load.maf_target', 'Air Mass Flow · Target', 'Load', 'kg/h', 'massFlow', 1, 0, 1400),
  c('load.calc', 'Calculated Engine Load', 'Load', '%', 'percent', 1, 0, 100),
  c('load.engine', 'Engine Load · Actual', 'Load', '%', 'percent', 1, 0, 250),
  c('load.engine_target', 'Engine Load · Target', 'Load', '%', 'percent', 1, 0, 250),
  c('load.torque.driver', 'Driver Wish Torque', 'Load', 'Nm', 'torque', 0, -100, 700),
  c('load.torque.actual', 'Engine Torque · Actual', 'Load', 'Nm', 'torque', 0, -100, 700),
  c('load.torque.target', 'Engine Torque · Target', 'Load', 'Nm', 'torque', 0, -100, 700),
  c('load.torque.limit', 'Torque Limit · Active', 'Load', 'Nm', 'torque', 0, 0, 800),

  c('boost.actual', 'Boost Pressure · Actual', 'Boost', 'bar', 'pressure', 3, -1, 2.5),
  c('boost.target', 'Boost Pressure · Target', 'Boost', 'bar', 'pressure', 3, -1, 2.5),
  c('boost.map', 'Manifold Pressure · Absolute', 'Boost', 'bar', 'pressure', 3, 0, 3.5),
  c('boost.ambient', 'Ambient Pressure', 'Boost', 'bar', 'pressure', 3, 0.7, 1.1),
  c('boost.wg_actual', 'EWG Position · Actual', 'Boost', '%', 'percent', 2, 0, 100),
  c('boost.wg_target', 'EWG Position · Target', 'Boost', '%', 'percent', 2, 0, 100),

  c('fuel.rail.actual', 'Rail Pressure · Actual', 'Fuel', 'bar', 'pressure', 1, 0, 400),
  c('fuel.rail.target', 'Rail Pressure · Target', 'Fuel', 'bar', 'pressure', 1, 0, 400),
  c('fuel.lpfp', 'Low Pressure Fuel · Actual', 'Fuel', 'bar', 'pressure', 2, 0, 8),
  c('fuel.lambda.actual', 'Lambda · Actual', 'Fuel', 'λ', 'lambda', 3, 0.7, 1.2),
  c('fuel.lambda.target', 'Lambda · Target', 'Fuel', 'λ', 'lambda', 3, 0.7, 1.2),
  c('fuel.stft', 'Fuel Trim · Short Term', 'Fuel', '%', 'percent', 1, -25, 25),
  c('fuel.ltft', 'Fuel Trim · Long Term', 'Fuel', '%', 'percent', 1, -25, 25),
  c('fuel.inj_time', 'Injection Time', 'Fuel', 'ms', 'time', 2, 0, 12),
  c('fuel.ethanol', 'Ethanol Content', 'Fuel', '%', 'percent', 0, 0, 100),

  c('ign.avg', 'Ignition Timing · Average', 'Ignition', '°CRK', 'angle', 1, -10, 50),
  ...perCylinder('ign', 'Ignition Timing', 'Ignition', '°CRK', 'angle', 1, -10, 50),

  ...perCylinder('knock', 'Knock Retard', 'Knock', '°CRK', 'angle', 2, -6, 0),

  c('temp.intake', 'Intake Air Temp', 'Temperatures', '°C', 'temperature', 1, -20, 90),
  c('temp.coolant', 'Coolant Temp', 'Temperatures', '°C', 'temperature', 1, -20, 130),
  c('temp.oil', 'Oil Temp', 'Temperatures', '°C', 'temperature', 1, -20, 150),
  c('temp.ambient', 'Ambient Temp', 'Temperatures', '°C', 'temperature', 1, -30, 50),
  c('temp.charge', 'Charge Air Temp · Post IC', 'Temperatures', '°C', 'temperature', 1, -20, 90),
  c('temp.exhaust', 'Exhaust Gas Temp · Model', 'Temperatures', '°C', 'temperature', 0, 0, 1050),
  c('temp.trans', 'Transmission Oil Temp', 'Temperatures', '°C', 'temperature', 1, -20, 140),

  c('vanos.intake.actual', 'VANOS Intake · Actual', 'VANOS', '°CRK', 'angle', 1, 60, 140),
  c('vanos.intake.target', 'VANOS Intake · Target', 'VANOS', '°CRK', 'angle', 1, 60, 140),
  c('vanos.exhaust.actual', 'VANOS Exhaust · Actual', 'VANOS', '°CRK', 'angle', 1, -130, -60),
  c('vanos.exhaust.target', 'VANOS Exhaust · Target', 'VANOS', '°CRK', 'angle', 1, -130, -60),
  c('vanos.valvelift', 'Valvetronic Lift', 'VANOS', 'mm', 'none', 2, 0, 10),

  c('vehicle.speed', 'Vehicle Speed', 'Vehicle', 'km/h', 'speed', 1, 0, 300),
  c('vehicle.gear', 'Gear', 'Vehicle', 'gear', 'gear', 0, 0, 8),
  c('vehicle.wheel_slip', 'Wheel Slip', 'Vehicle', '%', 'percent', 1, 0, 30),

  c('elec.battery', 'Battery Voltage', 'Electrical', 'V', 'voltage', 2, 10, 16)
]

/** Default Live Data selection: the boost, fuel and lambda essentials. */
export const DEFAULT_LIVE_CHANNELS = [
  'engine.rpm',
  'boost.actual',
  'boost.target',
  'boost.wg_actual',
  'fuel.rail.actual',
  'fuel.rail.target',
  'fuel.lambda.actual',
  'fuel.lambda.target'
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
