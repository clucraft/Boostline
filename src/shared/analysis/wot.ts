// Wide-open-throttle (WOT) pull detection.

import { CH, type LogData, type WotSegment } from '@shared/types'
import { channelInUnit } from './channelLookup'

export interface WotRunOptions {
  /** Pedal (or throttle) threshold in %. */
  minPedalPct: number
  /** Dropouts below the threshold up to this long are bridged. */
  mergeGapSec: number
  /** Runs shorter than this (after merging) are discarded. */
  minDurationSec: number
}

export interface WotOptions extends Partial<WotRunOptions> {
  /** Channel to use instead of the accelerator pedal (falls back to pedal, then throttle). */
  pedalChannelId?: string
}

export const DEFAULT_WOT_OPTIONS: WotRunOptions = { minPedalPct: 85, mergeGapSec: 0.25, minDurationSec: 1.0 }

/**
 * Index ranges [startIdx, endIdx] (inclusive) where pedalPct ≥ minPedalPct.
 * Runs separated by a dropout of at most mergeGapSec (time from the last WOT
 * sample to the next WOT sample) are merged; runs shorter than minDurationSec
 * are dropped. NaN pedal samples count as "not WOT".
 */
export function findWotRuns(t: Float64Array, pedalPct: Float64Array, opts: WotRunOptions): Array<[number, number]> {
  const n = Math.min(t.length, pedalPct.length)
  const merged: Array<[number, number]> = []
  let start = -1
  for (let i = 0; i <= n; i++) {
    const wot = i < n && pedalPct[i] >= opts.minPedalPct
    if (wot && start < 0) start = i
    if (!wot && start >= 0) {
      const last = merged[merged.length - 1]
      if (last && t[start] - t[last[1]] <= opts.mergeGapSec) last[1] = i - 1
      else merged.push([start, i - 1])
      start = -1
    }
  }
  return merged.filter(([s, e]) => t[e] - t[s] >= opts.minDurationSec)
}

/**
 * WOT segments of a log, using the accelerator pedal (or the channel given in
 * pedalChannelId) and falling back to throttle position. Each segment gets the
 * peak engine speed and the dominant gear when those channels exist.
 */
export function detectWotSegments(log: LogData, opts: WotOptions = {}): WotSegment[] {
  const runOpts: WotRunOptions = {
    minPedalPct: opts.minPedalPct ?? DEFAULT_WOT_OPTIONS.minPedalPct,
    mergeGapSec: opts.mergeGapSec ?? DEFAULT_WOT_OPTIONS.mergeGapSec,
    minDurationSec: opts.minDurationSec ?? DEFAULT_WOT_OPTIONS.minDurationSec
  }
  const pedal =
    (opts.pedalChannelId !== undefined ? channelInUnit(log, opts.pedalChannelId, '%') : undefined) ??
    channelInUnit(log, CH.pedal, '%') ??
    channelInUnit(log, CH.throttle, '%')
  if (!pedal) return []
  const rpm = channelInUnit(log, CH.rpm, 'rpm')
  const gear = channelInUnit(log, CH.gear, 'gear')
  return findWotRuns(log.time, pedal, runOpts).map(([s, e]) => {
    const seg: WotSegment = { start: log.time[s], end: log.time[e], startIdx: s, endIdx: e }
    const peakRpm = rpm ? maxIn(rpm, s, e) : NaN
    if (Number.isFinite(peakRpm)) seg.peakRpm = peakRpm
    const g = gear ? dominantGear(gear, s, e) : NaN
    if (Number.isFinite(g)) seg.gear = g
    return seg
  })
}

function maxIn(y: Float64Array, s: number, e: number): number {
  let max = -Infinity
  for (let i = s; i <= e; i++) if (y[i] > max) max = y[i]
  return max === -Infinity ? NaN : max
}

/** Most frequent engaged gear (rounded, ≥ 1) in [s, e]; NaN when none. */
function dominantGear(gear: Float64Array, s: number, e: number): number {
  const counts = new Map<number, number>()
  for (let i = s; i <= e; i++) {
    const g = Math.round(gear[i])
    if (g >= 1) counts.set(g, (counts.get(g) ?? 0) + 1)
  }
  let best = NaN
  let bestCount = 0
  for (const [g, c] of counts) {
    if (c > bestCount) {
      best = g
      bestCount = c
    }
  }
  return best
}
