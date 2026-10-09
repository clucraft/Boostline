import type { ChannelDef, LogChannel, LogData } from '@shared/types'

export interface GraphConfig {
  key: string
  title: string
  channelIds: string[]
  pinned: boolean
  /** Manual y ranges in display units, keyed by channel id. */
  ranges: Record<string, [number, number]>
}

/** Data behind the graphs: a shared x axis plus per-channel arrays (native units). */
export interface SeriesSource {
  x: number[]
  a: (id: string) => (number | null)[] | undefined
  /** Compared log, aligned to the same x axis. */
  b?: (id: string) => (number | null)[] | undefined
  defs: Map<string, ChannelDef>
}

let graphCounter = 0
export const newGraph = (title: string, channelIds: string[] = []): GraphConfig => ({
  key: `g${++graphCounter}`,
  title,
  channelIds,
  pinned: false,
  ranges: {}
})

export function defOfLogChannel(ch: LogChannel, known?: ChannelDef): ChannelDef {
  return known ?? { id: ch.id, name: ch.name, group: 'Custom', unit: ch.unit, quantity: ch.quantity, decimals: 2 }
}

const toArray = (data: Float64Array): (number | null)[] => Array.from(data, (v) => (Number.isFinite(v) ? v : null))

/** Builds the series source for a loaded log, optionally merged with a compared log. */
export function logSource(log: LogData, known: Map<string, ChannelDef>, compare?: { log: LogData; offset: number }): SeriesSource {
  const defs = new Map<string, ChannelDef>()
  for (const ch of log.channels) defs.set(ch.id, defOfLogChannel(ch, known.get(ch.id)))
  if (compare) for (const ch of compare.log.channels) if (!defs.has(ch.id)) defs.set(ch.id, defOfLogChannel(ch, known.get(ch.id)))

  const cacheA = new Map<string, (number | null)[]>()
  const cacheB = new Map<string, (number | null)[]>()

  if (!compare) {
    const x = Array.from(log.time)
    return {
      x,
      defs,
      a: (id) => {
        if (!cacheA.has(id)) {
          const ch = log.channels.find((c) => c.id === id)
          if (!ch) return undefined
          cacheA.set(id, toArray(ch.data))
        }
        return cacheA.get(id)
      }
    }
  }

  // Merge both time axes; each log contributes values only at its own samples.
  const ta = log.time
  const tb = compare.log.time
  const x: number[] = []
  const ia: number[] = []
  const ib: number[] = []
  let i = 0
  let j = 0
  while (i < ta.length || j < tb.length) {
    const va = i < ta.length ? ta[i] : Infinity
    const vb = j < tb.length ? tb[j] + compare.offset : Infinity
    if (va <= vb) {
      x.push(va)
      ia.push(i++)
      ib.push(va === vb ? j++ : -1)
    } else {
      x.push(vb)
      ia.push(-1)
      ib.push(j++)
    }
  }
  const pick = (data: Float64Array, idx: number[]): (number | null)[] =>
    idx.map((k) => (k >= 0 && Number.isFinite(data[k]) ? data[k] : null))
  return {
    x,
    defs,
    a: (id) => {
      if (!cacheA.has(id)) {
        const ch = log.channels.find((c) => c.id === id)
        if (!ch) return undefined
        cacheA.set(id, pick(ch.data, ia))
      }
      return cacheA.get(id)
    },
    b: (id) => {
      if (!cacheB.has(id)) {
        const ch = compare.log.channels.find((c) => c.id === id)
        if (!ch) return undefined
        cacheB.set(id, pick(ch.data, ib))
      }
      return cacheB.get(id)
    }
  }
}
