import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import type { BmwDataPack, BmwDme } from '@core/bmwdata/types'
import { parseSgfunktionenRow } from '@core/bmwdata/sgbdRow'

// Imports DME measurement tables from a bmw-unified-db SQLite file
// (https://github.com/gediz/bmw-unified-db, tables ecu_variant / ecu_table / table_row /
// routing / ecu_engine). Only UDS petrol engine ECUs (ecu_family 'DME') are taken, and
// only their SG_FUNKTIONEN rows that are plain numeric values readable with 0x22.

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

/** Reads the DME data from an (uncompressed) bmw-unified-db SQLite file. */
export function importBmwUnifiedDb(path: string, source = 'bmw-unified-db'): BmwDataPack {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const tables = new Set(
      (db.prepare("select name from sqlite_master where type in ('table','view')").all() as { name: string }[]).map((r) => r.name)
    )
    const missing = REQUIRED_TABLES.filter((t) => !tables.has(t))
    if (missing.length) throw new Error(`Not a bmw-unified-db database (missing tables: ${missing.join(', ')})`)

    const variants = db
      .prepare(
        `select v.sgbd as sgbd, v.ecu_name as name, v.comment as comment, v.chassis as chassis
           from ecu_variant v join ecu_table t on t.sgbd = v.sgbd and t.name = 'SG_FUNKTIONEN'
          where v.is_uds = 1 and v.ecu_family = 'DME' order by v.sgbd`
      )
      .all() as { sgbd: string; name: string | null; comment: string | null; chassis: string | null }[]

    const columnsOf = db.prepare(`select columns from ecu_table where sgbd = ? and name = 'SG_FUNKTIONEN'`)
    const rowsOf = db.prepare(`select cells from table_row where sgbd = ? and "table" = 'SG_FUNKTIONEN' order by idx`)
    const routingOf = db.prepare(`select sgbd_index, diag_address from routing where sgbd = ?`)
    const enginesOf = db.prepare(`select distinct engine from ecu_engine where sgbd = ? order by engine`)

    const dmes: BmwDme[] = []
    for (const v of variants) {
      const cols = parseJsonArray((columnsOf.get(v.sgbd) as { columns: string } | undefined)?.columns)
      if (!cols.length) continue
      const measurements = []
      for (const { cells } of rowsOf.all(v.sgbd) as { cells: string }[]) {
        const values = parseJsonArray(cells)
        const row: Record<string, string> = {}
        cols.forEach((c, i) => (row[c] = values[i] ?? ''))
        const m = parseSgfunktionenRow(row)
        if (m) measurements.push(m)
      }
      if (!measurements.length) continue
      const routes = routingOf.all(v.sgbd) as { sgbd_index: string | null; diag_address: string | null }[]
      const indexes = [...new Set(routes.map((r) => parseHex(r.sgbd_index)).filter((n): n is number => n !== undefined))]
      const address = routes.map((r) => parseHex(r.diag_address)).find((n) => n !== undefined)
      dmes.push({
        sgbd: v.sgbd.toLowerCase(),
        name: v.name ?? v.sgbd,
        comment: v.comment ?? '',
        chassis: parseJsonArray(v.chassis),
        engines: (enginesOf.all(v.sgbd) as { engine: string }[]).map((r) => r.engine),
        diagAddress: address ?? 0x12,
        sgbdIndexes: indexes.sort((a, b) => a - b),
        measurements
      })
    }
    if (!dmes.length) throw new Error('The database contains no engine ECU (DME) measurement tables')
    return { format: 1, source, importedAt: new Date().toISOString(), dmes }
  } finally {
    db.close()
  }
}

/** Imports a .sqlite or .sqlite.gz file (gzip is unpacked to a temp file first). */
export async function importBmwUnifiedDbFile(path: string, source?: string): Promise<BmwDataPack> {
  if (!/\.gz$/i.test(path)) return importBmwUnifiedDb(path, source)
  const tmp = join(tmpdir(), `boostline-bmwdb-${process.pid}-${Date.now()}.sqlite`)
  try {
    await pipeline(createReadStream(path), createGunzip(), createWriteStream(tmp))
    return importBmwUnifiedDb(tmp, source)
  } finally {
    await fs.rm(tmp, { force: true })
  }
}
