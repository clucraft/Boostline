import type { BmwMeasurement, BmwValueType } from './types'

// Parses rows of an EDIABAS SGBD "SG_FUNKTIONEN" table (one row per DME function:
// ARG, ID, RESULTNAME, INFO, EINHEIT, L/H, DATENTYP, MUL, DIV, ADD, SERVICE, RES_TABELLE, ...)
// into readable numeric measurements. Rows that are not plain numeric values readable with
// ReadDataByIdentifier (routines, actuator tests, enums, bitfields, raw data) are dropped.

/** EDIABAS data types: char = 8 bit, int = 16 bit, long = 32 bit; plain types are signed. */
const TYPES: Readonly<Record<string, { type: BmwValueType; littleEndian?: boolean }>> = {
  'unsigned char': { type: 'u8' },
  'signed char': { type: 's8' },
  char: { type: 's8' },
  'unsigned int': { type: 'u16' },
  'signed int': { type: 's16' },
  int: { type: 's16' },
  'unsigned long': { type: 'u32' },
  'signed long': { type: 's32' },
  long: { type: 's32' },
  'motorola float': { type: 'f32' },
  float: { type: 'f32' },
  'intel float': { type: 'f32', littleEndian: true }
}

export const VALUE_SIZE: Readonly<Record<BmwValueType, number>> = { u8: 1, s8: 1, u16: 2, s16: 2, u32: 4, s32: 4, f32: 4 }

/** Units that mark flags, enums or raw data rather than a physical value. */
const NON_NUMERIC_UNITS = new Set(['0/1', '0-n', 'HEX', 'DATA', 'BIT', 'TEXT'])

/**
 * Restores unit symbols lost to an encoding round trip (U+FFFD where the SGBD had
 * °, µ or ²) and unifies spelling.
 */
export function normalizeSgbdUnit(raw: string): string {
  const u = raw.trim()
  if (u === '' || u === '-') return ''
  const fixed = u
    .replace(/^�\s*(KW|CRK)$/i, '°CRK')
    .replace(/^°\s*(KW|CRK)$/i, '°CRK')
    .replace(/^�\s*C$/i, '°C')
    .replace(/^°\s+C$/i, '°C')
    .replace(/^�TPS$/i, '°TPS')
    .replace(/^�$/, '°')
    .replace(/^�s$/, 'µs')
    .replace(/�$/, '²')
  return fixed === '1/min' ? 'rpm' : fixed
}

/** Parses SGBD numbers: "-" / "" mean "not set"; decimal commas are accepted. */
export function parseSgbdNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === '' || s === '-') return undefined
  const v = Number(s.replace(',', '.'))
  return Number.isFinite(v) ? v : undefined
}

export function parseSgfunktionenRow(row: Readonly<Record<string, string | undefined>>): BmwMeasurement | null {
  const services = (row.SERVICE ?? '').split(/[;,]/).map((s) => s.trim().toUpperCase())
  if (!services.includes('22')) return null
  const resTable = (row.RES_TABELLE ?? '-').trim()
  if (resTable !== '' && resTable !== '-') return null
  const typeInfo = TYPES[(row.DATENTYP ?? '').trim().toLowerCase().replace(/\s+/g, ' ')]
  if (!typeInfo) return null
  const id = (row.ID ?? '').trim()
  if (!/^0x[0-9a-f]{1,4}$/i.test(id)) return null
  const unit = normalizeSgbdUnit(row.EINHEIT ?? '')
  if (NON_NUMERIC_UNITS.has(unit.toUpperCase())) return null
  const mul = parseSgbdNumber(row.MUL) ?? 1
  const div = parseSgbdNumber(row.DIV) ?? 1
  const add = parseSgbdNumber(row.ADD) ?? 0
  if (div === 0) return null
  const order = (row['L/H'] ?? '-').trim().toLowerCase()
  return {
    did: parseInt(id, 16),
    arg: (row.ARG ?? '').trim(),
    result: (row.RESULTNAME ?? '').trim(),
    info: (row.INFO ?? '').trim(),
    unit,
    type: typeInfo.type,
    littleEndian: typeInfo.littleEndian ?? (order === 'low' || order === 'l'),
    mul,
    div,
    add,
    composable: services.includes('2C')
  }
}

/** Decodes one measurement record (the DID's data bytes) to its SGBD physical value. */
export function decodeMeasurement(m: Pick<BmwMeasurement, 'type' | 'littleEndian' | 'mul' | 'div' | 'add'>, data: Buffer): number {
  if (data.length < VALUE_SIZE[m.type]) return NaN
  const le = m.littleEndian
  let raw: number
  switch (m.type) {
    case 'u8':
      raw = data.readUInt8(0)
      break
    case 's8':
      raw = data.readInt8(0)
      break
    case 'u16':
      raw = le ? data.readUInt16LE(0) : data.readUInt16BE(0)
      break
    case 's16':
      raw = le ? data.readInt16LE(0) : data.readInt16BE(0)
      break
    case 'u32':
      raw = le ? data.readUInt32LE(0) : data.readUInt32BE(0)
      break
    case 's32':
      raw = le ? data.readInt32LE(0) : data.readInt32BE(0)
      break
    case 'f32':
      raw = le ? data.readFloatLE(0) : data.readFloatBE(0)
      break
  }
  return (raw * m.mul) / m.div + m.add
}
