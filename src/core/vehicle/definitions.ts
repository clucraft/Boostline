/**
 * User-supplied channel definition files.
 *
 * Tuners add BMW-specific measurements (DME DIDs or RAM addresses, which differ per DME
 * software version) as JSON files in the Definitions folder. Every *.json file holds one
 * definition set:
 *
 *   {
 *     "name": "B58 TU MG1 · boost & knock",          // required, shown in the UI
 *     "description": "optional free text",
 *     "match": {                                      // optional; omit for "any ECU"
 *       "softwareVersions": ["SWFL_00002A6F_", "^BTLD_00001F2E"]   // regexes, case-insensitive,
 *     },                                              // tested against the ECU software string
 *     "ecuAddress": "0x12",                           // optional, default 0x12 (DME); 0x13 = 2nd DME
 *     "channels": [
 *       {
 *         "id": "boost.target",                       // [A-Za-z0-9_.-]+; may reuse a built-in id to replace it
 *         "name": "Boost target",
 *         "group": "Boost",                           // a ChannelGroup
 *         "unit": "bar",
 *         "quantity": "pressure",                     // a Quantity
 *         "decimals": 3,
 *         "min": -1, "max": 2.5,                      // optional graph range
 *         "description": "optional",
 *         "source": {
 *           "type": "did",                            // UDS ReadDataByIdentifier
 *           "did": "0x4205",
 *           "offset": 0,                              // byte offset inside the DID record
 *           "length": 2,                              // 1..4 (integers) or 4/8 (float)
 *           "didLength": 6,                           // optional total record length; lets the DID
 *                                                     //   share multi-DID requests (else read alone)
 *           "signed": false, "float": false,          // optional, default false
 *           "endian": "big",                          // optional, default "big"
 *           "scale": 0.001, "add": -1.013             // value = raw * scale + add (defaults 1, 0)
 *         }
 *       },
 *       {
 *         "id": "knock.cyl1", "name": "Knock retard cyl 1", "group": "Knock", "unit": "°CRK",
 *         "quantity": "angle", "decimals": 2,
 *         "source": {
 *           "type": "memory",                         // ECU RAM, logged through a dynamically defined
 *           "address": "0xD0012345",                  //   DID (2C 02) or ReadMemoryByAddress (23)
 *           "size": 2,                                // 1..4 (integers) or 4/8 (float)
 *           "signed": true, "float": false,
 *           "endian": "little",                       // optional, default "little" (TriCore RAM)
 *           "scale": 0.0234375, "add": 0
 *         }
 *       }
 *     ]
 *   }
 *
 * Integers may be JSON numbers or strings ("0x4205", "18"). Invalid files are reported via
 * the callback and skipped; they never abort loading.
 */
import { runtime } from '../runtime'
import type { ChannelDef, ChannelGroup, Quantity } from '@shared/types'

export interface ValueEncoding {
  signed: boolean
  float: boolean
  endian: 'big' | 'little'
  scale: number
  add: number
}

export interface DidSource extends ValueEncoding {
  type: 'did'
  did: number
  offset: number
  length: number
  /** Total DID record length, when known. */
  didLength?: number
}

export interface MemorySource extends ValueEncoding {
  type: 'memory'
  address: number
  size: number
}

export type ChannelSource = DidSource | MemorySource

export interface DefinedChannel {
  channel: ChannelDef
  source: ChannelSource
}

export interface DefinitionSet {
  name: string
  description?: string
  /** File the set was loaded from. */
  file: string
  /** Software-version patterns; empty means the set applies to every ECU. */
  softwareVersions: RegExp[]
  ecuAddress: number
  channels: DefinedChannel[]
}

export const DEFAULT_ECU_ADDRESS = 0x12

const GROUPS: Record<ChannelGroup, true> = {
  Engine: true, Throttle: true, Load: true, Boost: true, Fuel: true, Ignition: true, Knock: true,
  Temperatures: true, VANOS: true, Vehicle: true, Electrical: true, 'OBD-II': true, DME: true, Custom: true
}

const QUANTITIES: Record<Quantity, true> = {
  none: true, rpm: true, speed: true, pressure: true, temperature: true, percent: true, torque: true,
  power: true, massFlow: true, lambda: true, angle: true, voltage: true, current: true, time: true,
  distance: true, gear: true, volumeFlow: true
}

// ------------------------------------------------------------------ decoding

/** Decodes `length` bytes at `offset` as described by `enc`; NaN when out of range. */
export function decodeValue(bytes: Buffer, offset: number, length: number, enc: ValueEncoding): number {
  if (offset < 0 || offset + length > bytes.length) return NaN
  const le = enc.endian === 'little'
  let raw: number
  if (enc.float) {
    if (length === 4) raw = le ? bytes.readFloatLE(offset) : bytes.readFloatBE(offset)
    else if (length === 8) raw = le ? bytes.readDoubleLE(offset) : bytes.readDoubleBE(offset)
    else return NaN
  } else if (enc.signed) {
    raw = le ? bytes.readIntLE(offset, length) : bytes.readIntBE(offset, length)
  } else {
    raw = le ? bytes.readUIntLE(offset, length) : bytes.readUIntBE(offset, length)
  }
  return raw * enc.scale + enc.add
}

/**
 * Decodes a channel value: for a DID source from the whole DID record, for a memory source
 * from exactly the `size` bytes read at its address.
 */
export function decodeChannelSource(source: ChannelSource, data: Buffer): number {
  return source.type === 'did'
    ? decodeValue(data, source.offset, source.length, source)
    : decodeValue(data, 0, source.size, source)
}

// ------------------------------------------------------------------ validation

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

class Validator {
  readonly errors: string[] = []

  integer(value: unknown, path: string, min: number, max: number): number | undefined {
    let n: number | undefined
    if (typeof value === 'number') n = value
    else if (typeof value === 'string' && /^\s*(0x[0-9a-f]+|-?\d+)\s*$/i.test(value)) n = Number(value.trim())
    if (n === undefined || !Number.isInteger(n) || n < min || n > max) {
      this.errors.push(`${path}: expected an integer ${min}..${max} (number or "0x.." string), got ${JSON.stringify(value)}`)
      return undefined
    }
    return n
  }

  number(value: unknown, path: string, fallback?: number): number | undefined {
    if (value === undefined && fallback !== undefined) return fallback
    if (typeof value === 'number' && Number.isFinite(value)) return value
    this.errors.push(`${path}: expected a finite number, got ${JSON.stringify(value)}`)
    return undefined
  }

  string(value: unknown, path: string): string | undefined {
    if (typeof value === 'string' && value.trim() !== '') return value
    this.errors.push(`${path}: expected a non-empty string`)
    return undefined
  }

  boolean(value: unknown, path: string): boolean {
    if (value === undefined) return false
    if (typeof value === 'boolean') return value
    this.errors.push(`${path}: expected true or false`)
    return false
  }

  oneOf<T extends string>(value: unknown, allowed: Record<T, true>, path: string): T | undefined {
    if (typeof value === 'string' && Object.hasOwn(allowed, value)) return value as T
    this.errors.push(`${path}: expected one of ${Object.keys(allowed).join(', ')}`)
    return undefined
  }

  encoding(src: Json, path: string, length: number, defaultEndian: 'big' | 'little'): ValueEncoding {
    const float = this.boolean(src.float, `${path}.float`)
    const signed = this.boolean(src.signed, `${path}.signed`)
    if (float && length !== 4 && length !== 8) this.errors.push(`${path}: float values need 4 or 8 bytes`)
    if (!float && (length < 1 || length > 4)) this.errors.push(`${path}: integer values need 1..4 bytes`)
    let endian = defaultEndian
    if (src.endian !== undefined) {
      if (src.endian === 'big' || src.endian === 'little') endian = src.endian
      else this.errors.push(`${path}.endian: expected "big" or "little"`)
    }
    return {
      float,
      signed,
      endian,
      scale: this.number(src.scale, `${path}.scale`, 1) ?? 1,
      add: this.number(src.add, `${path}.add`, 0) ?? 0
    }
  }

  source(value: unknown, path: string): ChannelSource | undefined {
    if (!isObject(value)) {
      this.errors.push(`${path}: missing source object`)
      return undefined
    }
    if (value.type === 'did') {
      const did = this.integer(value.did, `${path}.did`, 0, 0xffff)
      const offset = this.integer(value.offset ?? 0, `${path}.offset`, 0, 4095)
      const length = this.integer(value.length, `${path}.length`, 1, 8)
      const didLength = value.didLength === undefined ? undefined : this.integer(value.didLength, `${path}.didLength`, 1, 4096)
      if (did === undefined || offset === undefined || length === undefined) return undefined
      if (didLength !== undefined && offset + length > didLength) this.errors.push(`${path}: offset + length exceeds didLength`)
      return { type: 'did', did, offset, length, didLength, ...this.encoding(value, path, length, 'big') }
    }
    if (value.type === 'memory') {
      const address = this.integer(value.address, `${path}.address`, 0, 0xffffffff)
      const size = this.integer(value.size, `${path}.size`, 1, 8)
      if (address === undefined || size === undefined) return undefined
      return { type: 'memory', address, size, ...this.encoding(value, path, size, 'little') }
    }
    this.errors.push(`${path}.type: expected "did" or "memory"`)
    return undefined
  }

  channel(value: unknown, path: string): DefinedChannel | undefined {
    if (!isObject(value)) {
      this.errors.push(`${path}: expected an object`)
      return undefined
    }
    const before = this.errors.length
    const id = this.string(value.id, `${path}.id`)
    if (id !== undefined && !/^[A-Za-z0-9_.-]+$/.test(id)) this.errors.push(`${path}.id: only letters, digits, "_", "." and "-" allowed`)
    const name = this.string(value.name, `${path}.name`)
    const group = this.oneOf(value.group, GROUPS, `${path}.group`)
    const unit = typeof value.unit === 'string' ? value.unit : undefined
    if (unit === undefined) this.errors.push(`${path}.unit: expected a string`)
    const quantity = this.oneOf(value.quantity, QUANTITIES, `${path}.quantity`)
    const decimals = this.integer(value.decimals ?? 2, `${path}.decimals`, 0, 6)
    const min = value.min === undefined ? undefined : this.number(value.min, `${path}.min`)
    const max = value.max === undefined ? undefined : this.number(value.max, `${path}.max`)
    const description = typeof value.description === 'string' ? value.description : undefined
    const source = this.source(value.source, `${path}.source`)
    if (
      this.errors.length > before ||
      id === undefined || name === undefined || group === undefined || unit === undefined ||
      quantity === undefined || decimals === undefined || source === undefined
    ) {
      return undefined
    }
    return { channel: { id, name, group, unit, quantity, decimals, min, max, description }, source }
  }
}

/** Validates one parsed definition file. Returns the set, or the list of problems. */
export function parseDefinitionSet(json: unknown, file: string): { set?: DefinitionSet; errors: string[] } {
  const v = new Validator()
  if (!isObject(json)) return { errors: ['top level must be a JSON object'] }
  const name = v.string(json.name, 'name')
  const description = typeof json.description === 'string' ? json.description : undefined
  const ecuAddress = json.ecuAddress === undefined ? DEFAULT_ECU_ADDRESS : v.integer(json.ecuAddress, 'ecuAddress', 0, 0xff)

  const softwareVersions: RegExp[] = []
  if (json.match !== undefined) {
    const patterns: unknown = isObject(json.match) ? json.match.softwareVersions : null
    if (Array.isArray(patterns) && patterns.every((p): p is string => typeof p === 'string')) {
      patterns.forEach((pattern, i) => {
        try {
          softwareVersions.push(new RegExp(pattern, 'i'))
        } catch (err) {
          v.errors.push(`match.softwareVersions[${i}]: ${(err as Error).message}`)
        }
      })
    } else if (patterns !== undefined) {
      v.errors.push('match: expected { "softwareVersions": [regular expression strings] }')
    }
  }

  const channels: DefinedChannel[] = []
  if (!Array.isArray(json.channels) || json.channels.length === 0) {
    v.errors.push('channels: expected a non-empty array')
  } else {
    const seen = new Set<string>()
    json.channels.forEach((raw, i) => {
      const ch = v.channel(raw, `channels[${i}]`)
      if (!ch) return
      if (seen.has(ch.channel.id)) v.errors.push(`channels[${i}].id: duplicate id "${ch.channel.id}"`)
      seen.add(ch.channel.id)
      channels.push(ch)
    })
    const didLengths = new Map<number, number>()
    for (const { source } of channels) {
      if (source.type !== 'did' || source.didLength === undefined) continue
      const known = didLengths.get(source.did)
      if (known !== undefined && known !== source.didLength) {
        v.errors.push(`DID 0x${source.did.toString(16)}: conflicting didLength ${known} / ${source.didLength}`)
      }
      didLengths.set(source.did, source.didLength)
    }
  }

  if (v.errors.length > 0 || name === undefined || ecuAddress === undefined) return { errors: v.errors }
  return { set: { name, description, file, softwareVersions, ecuAddress, channels }, errors: [] }
}

/**
 * Loads every *.json file in `dir` (not recursive, sorted by name). A missing folder yields
 * no sets. Invalid files are passed to `onInvalid` and skipped.
 */
export async function loadDefinitionFiles(
  dir: string,
  onInvalid?: (file: string, errors: string[]) => void
): Promise<DefinitionSet[]> {
  let names: string[]
  try {
    names = (await runtime().readDir(dir)).filter((n) => n.toLowerCase().endsWith('.json')).sort()
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return []
    onInvalid?.(dir, [`cannot read folder: ${(err as Error).message}`])
    return []
  }
  const sets: DefinitionSet[] = []
  for (const name of names) {
    const file = runtime().joinPath(dir, name)
    let json: unknown
    try {
      json = JSON.parse(await runtime().readTextFile(file))
    } catch (err) {
      onInvalid?.(file, [`not valid JSON: ${(err as Error).message}`])
      continue
    }
    const { set, errors } = parseDefinitionSet(json, file)
    if (set) sets.push(set)
    else onInvalid?.(file, errors)
  }
  return sets
}

/**
 * Sets applying to an ECU: generic sets (no software patterns) always, version-specific
 * sets when one of their patterns matches `softwareVersion`.
 */
export function selectDefinitionSets(sets: readonly DefinitionSet[], softwareVersion?: string): DefinitionSet[] {
  return sets.filter(
    (s) => s.softwareVersions.length === 0 || (softwareVersion !== undefined && s.softwareVersions.some((r) => r.test(softwareVersion)))
  )
}
