import type { LiveBatch } from '@shared/types'

/**
 * Ring buffer of streamed samples, kept outside React state so 50 Hz data
 * never triggers re-renders. Consumers poll it from requestAnimationFrame.
 */
export class LiveBuffer {
  readonly capacity: number
  private t: Float64Array
  private cols = new Map<string, Float64Array>()
  private head = 0
  private count = 0
  /** Incremented on every push; lets pollers skip redundant redraws. */
  version = 0

  constructor(capacity = 50 * 60 * 10) {
    this.capacity = capacity
    this.t = new Float64Array(capacity)
  }

  clear(): void {
    this.head = 0
    this.count = 0
    this.cols.clear()
    this.version++
  }

  push(batch: LiveBatch): void {
    const idx = batch.channelIds.map((id) => {
      let col = this.cols.get(id)
      if (!col) {
        col = new Float64Array(this.capacity).fill(NaN)
        this.cols.set(id, col)
      }
      return col
    })
    const present = new Set(batch.channelIds)
    const absent = [...this.cols.entries()].filter(([id]) => !present.has(id)).map(([, col]) => col)
    for (let r = 0; r < batch.t.length; r++) {
      const row = batch.rows[r]
      const h = this.head
      this.t[h] = batch.t[r]
      for (let j = 0; j < idx.length; j++) idx[j][h] = row[j]
      for (const col of absent) col[h] = NaN
      this.head = (h + 1) % this.capacity
      if (this.count < this.capacity) this.count++
    }
    this.version++
  }

  get size(): number {
    return this.count
  }

  lastTime(): number {
    return this.count ? this.t[(this.head - 1 + this.capacity) % this.capacity] : 0
  }

  /** Most recent finite value of a channel. */
  latest(id: string): number {
    const col = this.cols.get(id)
    if (!col || !this.count) return NaN
    for (let k = 1; k <= Math.min(this.count, 10); k++) {
      const v = col[(this.head - k + this.capacity) % this.capacity]
      if (Number.isFinite(v)) return v
    }
    return NaN
  }

  /** Index range (oldest-first) of samples within the last `seconds`. */
  private windowStart(seconds: number): number {
    const tEnd = this.lastTime()
    let n = 0
    while (n < this.count) {
      const i = (this.head - 1 - n + this.capacity) % this.capacity
      if (tEnd - this.t[i] > seconds) break
      n++
    }
    return n
  }

  /** Time and channel arrays for the last `seconds`, oldest first; NaN → null. */
  window(seconds: number, ids: string[]): { t: number[]; series: (number | null)[][] } {
    const n = this.windowStart(seconds)
    const start = (this.head - n + this.capacity) % this.capacity
    const t = new Array<number>(n)
    const series = ids.map(() => new Array<number | null>(n))
    const cols = ids.map((id) => this.cols.get(id))
    for (let k = 0; k < n; k++) {
      const i = (start + k) % this.capacity
      t[k] = this.t[i]
      for (let j = 0; j < cols.length; j++) {
        const v = cols[j]?.[i]
        series[j][k] = v !== undefined && Number.isFinite(v) ? v : null
      }
    }
    return { t, series }
  }

  /** Raw arrays (oldest first) since a given time, for dyno/drag detectors. */
  since(tFrom: number, ids: string[]): { t: Float64Array; cols: Float64Array[] } {
    let n = 0
    while (n < this.count && this.t[(this.head - 1 - n + this.capacity) % this.capacity] > tFrom) n++
    const start = (this.head - n + this.capacity) % this.capacity
    const t = new Float64Array(n)
    const cols = ids.map(() => new Float64Array(n).fill(NaN))
    const src = ids.map((id) => this.cols.get(id))
    for (let k = 0; k < n; k++) {
      const i = (start + k) % this.capacity
      t[k] = this.t[i]
      for (let j = 0; j < src.length; j++) if (src[j]) cols[j][k] = src[j]![i]
    }
    return { t, cols }
  }
}

export const liveBuffer = new LiveBuffer()
