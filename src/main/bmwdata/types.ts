import type { ChannelDef } from '@shared/types'

// BMW DME measurement data imported from the user's own copy of BMW diagnostic data
// (decoded EDIABAS SGBD "SG_FUNKTIONEN" tables, e.g. via github.com/gediz/bmw-unified-db).
// That data is BMW-copyrighted: it is downloaded/imported on the user's machine and stored
// in the app's userData folder; it is never bundled with Boostline.

export type BmwValueType = 'u8' | 's8' | 'u16' | 's16' | 'u32' | 's32' | 'f32'

/** One readable measurement of a DME (one SG_FUNKTIONEN row, service 22). */
export interface BmwMeasurement {
  /** UDS DataIdentifier read with ReadDataByIdentifier (0x22). */
  did: number
  /** SGBD argument name (ARG). */
  arg: string
  /** SGBD result name (RESULTNAME), e.g. "STAT_..._WERT". */
  result: string
  /** German description (INFO). */
  info: string
  /** Unit as given by the SGBD, normalised (°C, °KW, hPa, MPa, kg/h, 1/min, %, ...). */
  unit: string
  type: BmwValueType
  littleEndian: boolean
  /** physical = raw * mul / div + add */
  mul: number
  div: number
  add: number
  /** The DID may be composed into a dynamically defined DID (2C 01) for fast block reads. */
  composable: boolean
}

/** Measurements of one DME variant (one SGBD). */
export interface BmwDme {
  /** SGBD name, lower case, e.g. "dme8ff_r". */
  sgbd: string
  /** SGBD title, e.g. "Motorelektronik DME8xx". */
  name: string
  comment: string
  chassis: string[]
  engines: string[]
  diagAddress: number
  /** Diagnostic indexes (DID F150 values) that select this SGBD. */
  sgbdIndexes: number[]
  measurements: BmwMeasurement[]
}

export interface BmwDataPack {
  format: 1
  /** Where the data came from, e.g. "bmw-unified-db v1.2.0". */
  source: string
  importedAt: string
  dmes: BmwDme[]
}

export interface DmeChannelRead {
  channel: ChannelDef
  did: number
  /** Record length in bytes (the value's size). */
  length: number
  composable: boolean
  decode: (data: Buffer) => number
}

export interface DmeDerivedChannel {
  channel: ChannelDef
  inputs: string[]
  compute: (inputs: readonly number[]) => number
}

/** Ready-to-poll channel set for the connected DME (built from a BmwDme). */
export interface DmeChannelSet {
  /** e.g. "dme8ff_r · Motorelektronik DME8xx". */
  name: string
  sgbd: string
  ecuAddress: number
  reads: DmeChannelRead[]
  derived: DmeDerivedChannel[]
}

/** Picks the DME channel set for a diagnostic index read from the car (F150), if any. */
export type DmeDataResolver = (sgbdIndex: number | undefined) => DmeChannelSet | undefined
