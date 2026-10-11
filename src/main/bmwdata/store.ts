import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { BmwDataPack } from '@core/bmwdata/types'

// The imported DME data lives in the app's userData folder (never in the repo or the
// installer): it is derived from BMW diagnostic data the user downloaded themselves.

const file = (): string => join(app.getPath('userData'), 'bmw-dme-data.json')

let cache: BmwDataPack | null | undefined

export async function loadBmwData(): Promise<BmwDataPack | null> {
  if (cache !== undefined) return cache
  try {
    const pack = JSON.parse(await fs.readFile(file(), 'utf8')) as BmwDataPack
    cache = pack.format === 1 && Array.isArray(pack.dmes) ? pack : null
  } catch {
    cache = null
  }
  return cache
}

export async function saveBmwData(pack: BmwDataPack): Promise<void> {
  const tmp = `${file()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(pack), 'utf8')
  await fs.rename(tmp, file())
  cache = pack
}

export async function clearBmwData(): Promise<void> {
  await fs.rm(file(), { force: true })
  cache = null
}

export { summarizeBmwData } from '@core/bmwdata/summary'
