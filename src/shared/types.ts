// Shared contracts between the main process (vehicle I/O, recording), the
// renderer (UI) and the pure analysis modules. Keep this file dependency-free.

/** Physical quantity of a channel; drives unit conversion (see units.ts). */
export type Quantity =
  | 'none'
  | 'rpm'
  | 'speed'
  | 'pressure'
  | 'temperature'
  | 'percent'
  | 'torque'
  | 'power'
  | 'massFlow'
  | 'lambda'
  | 'angle'
  | 'voltage'
  | 'current'
  | 'time'
  | 'distance'
  | 'gear'
  | 'volumeFlow'

export type ChannelGroup =
  | 'Engine'
  | 'Throttle'
  | 'Load'
  | 'Boost'
  | 'Fuel'
  | 'Ignition'
  | 'Knock'
  | 'Temperatures'
  | 'VANOS'
  | 'Vehicle'
  | 'Electrical'
  | 'OBD-II'
  | 'DME'
  | 'Custom'

export interface ChannelDef {
  /** Stable key, e.g. "engine.rpm". Used in presets, logs and analysis lookups. */
  id: string
  /** Display name, e.g. "Boost Pressure · Actual". */
  name: string
  group: ChannelGroup
  /** Native unit as produced by the adapter, e.g. "rpm", "bar", "°C", "%", "km/h". */
  unit: string
  quantity: Quantity
  /** Display decimals in the native unit. */
  decimals: number
  /** Expected display range in native units (graph scale hint). */
  min?: number
  max?: number
  description?: string
}

/**
 * Well-known channel ids that the Dyno, Drag and WOT tools look for.
 * Adapters should map their equivalents to these ids where possible.
 */
export const CH = {
  rpm: 'engine.rpm',
  speed: 'vehicle.speed',
  pedal: 'throttle.pedal',
  throttle: 'throttle.position',
  gear: 'vehicle.gear',
  boostActual: 'boost.actual',
  boostTarget: 'boost.target',
  iat: 'temp.intake',
  ambientTemp: 'temp.ambient',
  baro: 'boost.ambient',
  torqueActual: 'load.torque.actual',
  lambdaActual: 'fuel.lambda.actual'
} as const

export type AdapterKind = 'simulator' | 'enet' | 'mhd-wifi' | 'bm3-wifi'

export interface AdapterOption {
  kind: AdapterKind
  label: string
  description: string
}

export interface EcuInfo {
  /** Diagnostic address of the engine ECU (DME), e.g. 0x12. */
  address?: number
  /** ECU software identifier as reported by the car (SVK / F101 / F189). */
  softwareVersion?: string
  hardwareNumber?: string
  /** Name of the channel definition set chosen for this ECU. */
  definitionSet?: string
  /** Diagnostic (SGBD) index reported by the DME (DID F150), hex, e.g. "0x0F2426". */
  sgbdIndex?: string
  /** BMW diagnostic data used for this DME, e.g. "dme8ff_r · MDG1 DME8.x". */
  dmeData?: string
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'live' | 'error'

export interface RecordingInfo {
  file: string
  startedAt: number
  samples: number
}

export interface ConnectionStatus {
  state: ConnectionState
  adapterKind?: AdapterKind
  adapterLabel?: string
  /** Host:port the adapter talks to (ENET / WiFi adapters). */
  endpoint?: string
  vin?: string
  ecu?: EcuInfo
  /** Measured effective sample rate while streaming. */
  sampleRateHz?: number
  recording?: RecordingInfo
  error?: string
}

export interface ConnectOptions {
  kind: AdapterKind
  /** Optional manual host (IP) override for ENET/WiFi adapters. */
  host?: string
  port?: number
}

/** A batch of samples streamed from main to renderer. */
export interface LiveBatch {
  /** Order of the values in every row. */
  channelIds: string[]
  /** Timestamps in seconds since the stream started. */
  t: number[]
  /** rows[i][j] = value of channelIds[j] at t[i] (NaN when not sampled). */
  rows: number[][]
}

// ---------------------------------------------------------------- Logs

export interface LogChannel {
  id: string
  name: string
  unit: string
  quantity: Quantity
  data: Float64Array
}

/** Columnar in-memory log, as recorded or as parsed from CSV. */
export interface LogData {
  name: string
  path?: string
  meta: Record<string, string>
  /** Seconds. Monotonic, not necessarily starting at 0. */
  time: Float64Array
  channels: LogChannel[]
}

export interface WotSegment {
  /** Seconds (log time). */
  start: number
  end: number
  startIdx: number
  endIdx: number
  peakRpm?: number
  gear?: number
}

// ---------------------------------------------------------------- Dyno

export type CorrectionStandard = 'none' | 'SAE' | 'DIN'

export interface DynoSetup {
  massKg: number
  drivetrainLossPct: number
  startRpm: number
  endRpm: number
  minPedalPct: number
  /** Smoothing window in seconds applied to speed before differentiation. */
  smoothingSec: number
  ambientTempC: number
  humidityPct: number
  /** Barometric pressure; hPa. */
  baroHpa: number
  /** Drag area Cd·A in m². */
  cdA: number
  /** Rolling resistance coefficient. */
  crr: number
  correction: CorrectionStandard
}

export interface DynoInput {
  t: Float64Array
  rpm: Float64Array
  speedKmh: Float64Array
  pedalPct?: Float64Array
  gear?: Float64Array
}

export interface DynoPoint {
  rpm: number
  engineKw: number
  wheelKw: number
  torqueNm: number
}

export interface DynoResult {
  gear: number | null
  points: DynoPoint[]
  peakEngine: { kw: number; rpm: number }
  peakWheel: { kw: number; rpm: number }
  peakTorque: { nm: number; rpm: number }
  /** Seconds (input time base) of the analysed WOT window. */
  segment: { tStart: number; tEnd: number }
  airDensity: number
  correctionFactor: number
  setup: DynoSetup
  warnings: string[]
}

export interface SavedDynoRun {
  id: string
  name: string
  createdAt: string
  vin?: string
  result: DynoResult
  /** Raw input samples so a run can be re-analysed with other setup values. */
  input: { t: number[]; rpm: number[]; speedKmh: number[]; pedalPct?: number[]; gear?: number[] }
}

// ---------------------------------------------------------------- Drag

export type DragMode = '0-100' | '100-200' | '200-300' | '0-60mph' | '60-130mph' | '201m' | '402m'

export interface SpeedCalPoint {
  /** Speed reported by the ECU, km/h. */
  ecu: number
  /** Reference (GPS) speed, km/h. */
  gps: number
}

export interface DragEnvironment {
  altitudeM: number
  ambientTempC: number
  humidityPct: number
}

export interface DragInput {
  t: Float64Array
  speedKmh: Float64Array
  gear?: Float64Array
  rpm?: Float64Array
}

export interface DragSplit {
  /** Speed threshold for speed splits (km/h). */
  speedKmh: number
  /** Seconds from run start. */
  time: number
}

export interface GearChange {
  from: number
  to: number
  time: number
  speedKmh: number
}

export interface DragResult {
  mode: DragMode
  finished: boolean
  /** Seconds from run start to finish. */
  finalTime: number | null
  distanceM: number
  /** Speed at the finish (km/h). */
  trapSpeedKmh: number | null
  /** Input time (s) where the run started. */
  startT: number
  splits: DragSplit[]
  gearChanges: GearChange[]
  /** Curve relative to run start. */
  curve: { t: number[]; raw: number[]; calibrated: number[] }
  environment?: DragEnvironment
  warnings: string[]
}

export interface SavedDragRun {
  id: string
  name: string
  createdAt: string
  vin?: string
  result: DragResult
}

export interface DragProfile {
  name: string
  calibration: SpeedCalPoint[]
  environment: DragEnvironment
}

// ---------------------------------------------------------------- Settings

export type PressureUnit = 'bar' | 'psi' | 'kPa'
export type TemperatureUnit = 'C' | 'F'
export type SpeedUnit = 'km/h' | 'mph'
export type TorqueUnit = 'Nm' | 'lb-ft'
export type PowerUnit = 'hp' | 'PS' | 'kW'
export type MassFlowUnit = 'kg/h' | 'g/s' | 'lb/min'
export type LambdaUnit = 'lambda' | 'afr'

export interface UnitPrefs {
  pressure: PressureUnit
  temperature: TemperatureUnit
  speed: SpeedUnit
  torque: TorqueUnit
  power: PowerUnit
  massFlow: MassFlowUnit
  lambda: LambdaUnit
}

export interface LogViewerPrefs {
  cursorPopups: boolean
  scaleLegends: boolean
  lineSmoothing: boolean
  liveWindowSec: number
}

export interface ChannelPreset {
  name: string
  channelIds: string[]
}

export interface GraphLayout {
  title: string
  channelIds: string[]
  pinned?: boolean
}

export interface LayoutPreset {
  name: string
  graphs: GraphLayout[]
}

export type HeatmapStatPref = 'mean' | 'worst' | 'min' | 'max' | 'std' | 'n' | 'time'

export interface HeatmapAxisPrefs {
  channelId: string
  start: number
  step: number
  end: number
}

/** Log Viewer heatmap configuration (persisted). */
export interface HeatmapPrefs {
  preset: string
  valueId: string
  stat: HeatmapStatPref
  x: HeatmapAxisPrefs
  y: HeatmapAxisPrefs
  filters: {
    warm: boolean
    excludeTransients: boolean
    excludeFuelCut: boolean
    throttle: 'all' | 'wot' | 'part'
    gear: number | null
    visibleOnly: boolean
  }
  minSamples: number
}

export interface AppSettings {
  units: UnitPrefs
  logViewer: LogViewerPrefs
  connection: { kind: AdapterKind; host?: string; port?: number }
  /** Folder where logs, dyno and drag runs are written. */
  dataDir: string
  /** Channels shown in the Live Data panel. */
  liveChannels: string[]
  dyno: DynoSetup
  drag: { mode: DragMode; profile?: string; environment: DragEnvironment; calibration: SpeedCalPoint[] }
  /** Automatically start recording when a WOT pull is detected. */
  autoRecordWot: boolean
  /** BMW DME data selection: 'auto' (by the DME's diagnostic index), 'off', or an SGBD name. */
  bmwDme: string
  /** Log Viewer heatmap configuration; defaults apply when absent. */
  heatmap?: HeatmapPrefs
}
