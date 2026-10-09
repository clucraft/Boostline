import type { ChannelDef, UnitPrefs } from '@shared/types'
import { displayUnitFor, type DisplayUnit } from '@shared/units'

export interface ChannelView {
  def: ChannelDef
  unit: DisplayUnit
  decimals: number
}

/** Display unit + decimals for a channel under the user's unit preferences. */
export function channelView(def: ChannelDef, prefs: UnitPrefs): ChannelView {
  const unit = displayUnitFor(def, prefs)
  return { def, unit, decimals: unit.decimals(def.decimals) }
}

export function fmt(v: number | null | undefined, decimals: number): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(decimals)
}

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export const uid = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

export function stamp(date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`
}
