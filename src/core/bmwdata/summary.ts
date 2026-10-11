import type { BmwDataSummary } from '@shared/ipc'
import type { BmwDataPack } from './types'

export function summarizeBmwData(pack: BmwDataPack | null): BmwDataSummary | null {
  if (!pack) return null
  return {
    source: pack.source,
    importedAt: pack.importedAt,
    dmes: pack.dmes.map((d) => ({
      sgbd: d.sgbd,
      name: d.name,
      engines: d.engines,
      chassis: d.chassis,
      measurements: d.measurements.length,
      autoDetect: d.sgbdIndexes.length > 0
    }))
  }
}
