import { create } from 'zustand'
import type { AdapterOption, AppSettings, ChannelDef, ConnectionStatus, LogData, WotSegment } from '@shared/types'
import type { AppInfo, Presets } from '@shared/ipc'
import { BMW_CATALOG } from '@shared/catalog'

export const api = window.boostline

export type Page = 'logger' | 'dyno' | 'drag' | 'settings'

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'success' | 'error'
}

interface AppState {
  page: Page
  info: AppInfo | null
  settings: AppSettings | null
  presets: Presets
  status: ConnectionStatus
  /** Channels of the connected ECU, or the BMW catalog while offline. */
  channels: ChannelDef[]
  channelMap: Map<string, ChannelDef>
  adapters: AdapterOption[]
  /** Channels other features need streamed, keyed by requester. */
  streamRequests: Record<string, string[]>
  toasts: Toast[]
  /** A log (and optionally one WOT pull) handed from the Log Viewer to Dyno / Drag. */
  pendingDyno: { log: LogData; segment?: WotSegment } | null
  pendingDrag: { log: LogData; segment?: WotSegment } | null
  setPage(p: Page): void
  updateSettings(patch: Partial<AppSettings>): Promise<void>
  setPresets(p: Presets): Promise<void>
  setChannels(c: ChannelDef[]): void
  requestStream(key: string, ids: string[]): void
  toast(text: string, kind?: Toast['kind']): void
}

const mapOf = (c: ChannelDef[]): Map<string, ChannelDef> => new Map(c.map((d) => [d.id, d]))
let toastId = 0

export const useApp = create<AppState>((set, get) => ({
  page: 'logger',
  info: null,
  settings: null,
  presets: { channels: [], layouts: [], dragProfiles: [] },
  status: { state: 'disconnected' },
  channels: BMW_CATALOG,
  channelMap: mapOf(BMW_CATALOG),
  adapters: [],
  streamRequests: {},
  toasts: [],
  pendingDyno: null,
  pendingDrag: null,
  setPage: (page) => set({ page }),
  updateSettings: async (patch) => {
    const current = get().settings
    if (current) set({ settings: { ...current, ...patch } })
    set({ settings: await api.saveSettings(patch) })
  },
  setPresets: async (presets) => {
    set({ presets })
    await api.savePresets(presets)
  },
  setChannels: (c) => {
    const channels = c.length ? c : BMW_CATALOG
    set({ channels, channelMap: mapOf(channels) })
  },
  requestStream: (key, ids) => {
    const prev = get().streamRequests[key] ?? []
    if (prev.length === ids.length && prev.every((x, i) => x === ids[i])) return
    set({ streamRequests: { ...get().streamRequests, [key]: ids } })
  },
  toast: (text, kind = 'info') => {
    const id = ++toastId
    set({ toasts: [...get().toasts, { id, text, kind }] })
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 7000 : 3500)
  }
}))

export const isOnline = (s: ConnectionStatus): boolean => s.state === 'connected' || s.state === 'live'
