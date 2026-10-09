// Locating channels in a log by well-known id (with optional name fallbacks)
// and reading them in a required unit.

import type { LogChannel, LogData } from '@shared/types'
import { converter, normalizeUnit } from '@shared/units'

/**
 * Channel with the given id; otherwise the first channel whose name matches
 * one of `nameHints` (hints are tried in order of priority).
 */
export function findChannel(log: LogData, id: string, nameHints?: RegExp[]): LogChannel | undefined {
  const exact = log.channels.find((c) => c.id === id)
  if (exact || !nameHints) return exact
  for (const hint of nameHints) {
    const match = log.channels.find((c) => hint.test(c.name))
    if (match) return match
  }
  return undefined
}

/**
 * Channel data converted to `targetUnit`, or undefined when the channel is
 * missing or its unit cannot be converted.
 *
 * A channel without a unit is assumed to already be in the target unit, except
 * for a target of "%" where a signal that never exceeds 1.5 is taken to be a
 * 0…1 fraction and scaled by 100.
 *
 * The returned array may be the channel's own buffer: treat it as read-only.
 */
export function channelInUnit(
  log: LogData,
  id: string,
  targetUnit: string,
  nameHints?: RegExp[]
): Float64Array | undefined {
  const ch = findChannel(log, id, nameHints)
  if (!ch) return undefined
  const from = normalizeUnit(ch.unit)
  const to = normalizeUnit(targetUnit)
  if (from === '' && to !== '') return to === '%' && isFraction(ch.data) ? ch.data.map((v) => v * 100) : ch.data
  const f = converter(from, to)
  if (!f) return undefined
  return from === to ? ch.data : ch.data.map(f)
}

function isFraction(data: Float64Array): boolean {
  let max = -Infinity
  for (const v of data) if (v > max) max = v
  return max > -Infinity && max <= 1.5
}
