import type { BmwDataPack, BmwDme } from './types'
import { parseSgfunktionenRow } from './sgbdRow'

// Imports DME measurement tables from a bmw-unified-db SQLite database
// (https://github.com/gediz/bmw-unified-db, tables ecu_variant / ecu_table / table_row /
// routing / ecu_engine). Only UDS petrol engine ECUs (ecu_family 'DME') are taken, and
// only their SG_FUNKTIONEN rows that are plain numeric values readable with 0x22.
//
// The database is reached through a SqlReader: node:sqlite on the desktop, the native
// SQLite plugin on mobile.

export interface SqlReader {
  all(sql: string, params?: (string | number)[]): Promise<Record<string, unknown>[]>
}

const REQUIRED_TABLES = ['ecu_variant', 'ecu_table', 'table_row', 'routing', 'ecu_engine']

const parseHex = (s: unknown): number | undefined => {
  if (typeof s !== 'string') return undefined
  const m = /^0x([0-9a-f]+)$/i.exec(s.trim())
  return m ? parseInt(m[1], 16) : undefined
}

const parseJsonArray = (s: unknown): string[] => {
  if (typeof s !== 'string' || !s.startsWith('[')) return []
  try {
    const v = JSON.parse(s) as unknown
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** Reads the DME data from an open bmw-unified-db database. */
export async function readBmwDataPack(db: SqlReader, source = 'bmw-unified-db'): Promise<BmwDataPack> {
  const tables = new Set((await db.all("select name from sqlite_master where type in ('table','view')")).map((r) => String(r.name)))
  const missing = REQUIRED_TABLES.filter((t) => !tables.has(t))
  if (missing.length) throw new Error(`Not a bmw-unified-db database (missing tables: ${missing.join(', ')})`)

  const variants = await db.all(
    `select v.sgbd as sgbd, v.ecu_name as name, v.comment as comment, v.chassis as chassis
       from ecu_variant v join ecu_table t on t.sgbd = v.sgbd and t.name = 'SG_FUNKTIONEN'
      where v.is_uds = 1 and v.ecu_family = 'DME' order by v.sgbd`
  )

  const dmes: BmwDme[] = []
  for (const v of variants) {
    const sgbd = String(v.sgbd)
    const cols = parseJsonArray((await db.all(`select columns from ecu_table where sgbd = ? and name = 'SG_FUNKTIONEN'`, [sgbd]))[0]?.columns)
    if (!cols.length) continue
    const measurements = []
    for (const { cells } of await db.all(`select cells from table_row where sgbd = ? and "table" = 'SG_FUNKTIONEN' order by idx`, [sgbd])) {
      const values = parseJsonArray(cells)
      const row: Record<string, string> = {}
      cols.forEach((c, i) => (row[c] = values[i] ?? ''))
      const m = parseSgfunktionenRow(row)
      if (m) measurements.push(m)
    }
    if (!measurements.length) continue
    const routes = await db.all(`select sgbd_index, diag_address from routing where sgbd = ?`, [sgbd])
    const indexes = [...new Set(routes.map((r) => parseHex(r.sgbd_index)).filter((n): n is number => n !== undefined))]
    const address = routes.map((r) => parseHex(r.diag_address)).find((n) => n !== undefined)
    const engines = await db.all(`select distinct engine from ecu_engine where sgbd = ? order by engine`, [sgbd])
    dmes.push({
      sgbd: sgbd.toLowerCase(),
      name: str(v.name) ?? sgbd,
      comment: str(v.comment) ?? '',
      chassis: parseJsonArray(v.chassis),
      engines: engines.map((r) => String(r.engine)),
      diagAddress: address ?? 0x12,
      sgbdIndexes: indexes.sort((a, b) => a - b),
      measurements
    })
  }
  if (!dmes.length) throw new Error('The database contains no engine ECU (DME) measurement tables')
  return { format: 1, source, importedAt: new Date().toISOString(), dmes }
}
