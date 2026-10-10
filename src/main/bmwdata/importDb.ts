import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import type { BmwDataPack } from '@core/bmwdata/types'
import { readBmwDataPack } from '@core/bmwdata/importDb'

/** Reads the DME data from an (uncompressed) bmw-unified-db SQLite file. */
export async function importBmwUnifiedDb(path: string, source = 'bmw-unified-db'): Promise<BmwDataPack> {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return await readBmwDataPack({ all: async (sql, params = []) => db.prepare(sql).all(...params) as Record<string, unknown>[] }, source)
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
    return await importBmwUnifiedDb(tmp, source)
  } finally {
    await fs.rm(tmp, { force: true })
  }
}
