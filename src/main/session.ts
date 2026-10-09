import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'
import type { ChannelDef, ConnectionStatus, ConnectOptions, LiveBatch, RecordingInfo } from '@shared/types'
import { CH } from '@shared/types'
import { MAX_LIVE_CHANNELS } from '@shared/catalog'
import type { SampleFrame, StreamHandle, VehicleAdapter } from './vehicle/adapter'
import { SimulatorAdapter } from './vehicle/simulator'
import { EnetAdapter } from './vehicle/enet'
import { Recorder } from './recorder'
import { dataPath, loadSettings } from './storage'
import { loadBmwData } from './bmwdata/store'
import { buildDmeChannelSet, resolveDme } from './bmwdata/channels'
import type { DmeDataResolver } from './bmwdata/types'

/** Always sampled when available: the Dyno, Drag and WOT tools depend on them. */
const REQUIRED = [CH.rpm, CH.speed, CH.pedal, CH.gear]
/** Hard cap on streamed channels: live tiles (40) + required + graph extras. */
const MAX_STREAM = MAX_LIVE_CHANNELS + 30
const FLUSH_MS = 50
const AUTO_RECORD_PEDAL = 85
const AUTO_RECORD_TAIL_S = 3

export interface SessionEvents {
  status: [ConnectionStatus]
  channels: [ChannelDef[]]
  batch: [LiveBatch]
  log: [string]
}

/**
 * Owns the vehicle connection: adapter lifecycle, streaming, batching samples
 * for the renderer and writing recordings. One instance per app.
 */
export class Session extends EventEmitter<SessionEvents> {
  private adapter: VehicleAdapter | null = null
  private abort: AbortController | null = null
  private stream: StreamHandle | null = null
  private channelList: ChannelDef[] = []
  private wanted: string[] = []
  private active: string[] = []
  private pendingRestart = false
  private recorder: Recorder | null = null
  private epoch = 0
  private streamOffset = 0
  private batchT: number[] = []
  private batchRows: number[][] = []
  private flushTimer: NodeJS.Timeout | null = null
  private rateWindow: number[] = []
  private autoRecord = false
  private wotLastSeen = -Infinity
  private autoRecording = false
  private current: ConnectionStatus = { state: 'disconnected' }

  status(): ConnectionStatus {
    return this.current
  }

  channels(): ChannelDef[] {
    return this.channelList
  }

  private setStatus(patch: Partial<ConnectionStatus>, replace = false): void {
    this.current = replace ? (patch as ConnectionStatus) : { ...this.current, ...patch }
    this.emit('status', this.current)
  }

  async connect(opts: ConnectOptions): Promise<ConnectionStatus> {
    await this.disconnect()
    const settings = await loadSettings()
    this.autoRecord = settings.autoRecordWot
    const bmwData = await loadBmwData()
    const dmeData: DmeDataResolver = (index) => {
      const dme = resolveDme(bmwData, settings.bmwDme, index)
      return dme ? buildDmeChannelSet(dme) : undefined
    }
    const adapter: VehicleAdapter =
      opts.kind === 'simulator'
        ? new SimulatorAdapter()
        : new EnetAdapter({
            kind: opts.kind,
            host: opts.host,
            port: opts.port,
            definitionsDir: await dataPath('Definitions'),
            dmeData,
            log: (msg: string) => this.emit('log', msg)
          })
    this.adapter = adapter
    this.abort = new AbortController()
    this.setStatus({ state: 'connecting', adapterKind: opts.kind }, true)
    try {
      const info = await adapter.connect(this.abort.signal)
      this.channelList = adapter.channels()
      this.emit('channels', this.channelList)
      this.epoch = performance.now()
      this.setStatus({
        state: 'connected',
        adapterKind: opts.kind,
        adapterLabel: info.label,
        endpoint: info.endpoint,
        vin: info.vin,
        ecu: info.ecu
      })
      await this.startLive()
    } catch (err) {
      this.adapter = null
      await adapter.disconnect().catch(() => undefined)
      this.setStatus({ state: 'error', adapterKind: opts.kind, error: errorMessage(err) }, true)
    }
    return this.current
  }

  async disconnect(): Promise<void> {
    this.abort?.abort()
    this.abort = null
    await this.stopRecording()
    await this.stopLive()
    if (this.adapter) {
      await this.adapter.disconnect().catch(() => undefined)
      this.adapter = null
    }
    if (this.channelList.length) {
      this.channelList = []
      this.emit('channels', [])
    }
    this.setStatus({ state: 'disconnected' }, true)
  }

  async setStreamChannels(ids: string[]): Promise<void> {
    this.wanted = ids
    if (!this.stream) return
    if (sameSet(this.resolveIds(), this.active)) return
    // The channel set of an open CSV cannot change; apply after recording.
    if (this.recorder) this.pendingRestart = true
    else await this.restartStream()
  }

  private resolveIds(): string[] {
    const available = new Set(this.channelList.map((c) => c.id))
    const ids = [...new Set([...REQUIRED, ...this.wanted])].filter((id) => available.has(id))
    return ids.slice(0, MAX_STREAM)
  }

  async startLive(): Promise<void> {
    if (!this.adapter || this.stream) return
    this.active = this.resolveIds()
    this.streamOffset = (performance.now() - this.epoch) / 1000
    this.rateWindow = []
    this.stream = await this.adapter.startStreaming(this.active, (f) => this.onFrame(f), {
      maxRateHz: 50,
      onError: (err) => this.emit('log', `Stream error: ${err.message}`)
    })
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS)
    this.setStatus({ state: 'live' })
  }

  async stopLive(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flushTimer = null
    const stream = this.stream
    this.stream = null
    await stream?.stop()
    this.flush()
    if (this.adapter && this.current.state === 'live') this.setStatus({ state: 'connected', sampleRateHz: undefined })
  }

  private async restartStream(): Promise<void> {
    this.pendingRestart = false
    await this.stopLive()
    await this.startLive()
  }

  private onFrame(frame: SampleFrame): void {
    const t = this.streamOffset + frame.t
    this.batchT.push(t)
    this.batchRows.push(frame.values)
    this.recorder?.write(t, frame.values)
    this.rateWindow.push(t)
    if (this.autoRecord) this.checkAutoRecord(t, frame.values)
  }

  private checkAutoRecord(t: number, values: number[]): void {
    const pedal = values[this.active.indexOf(CH.pedal)]
    if (pedal >= AUTO_RECORD_PEDAL) {
      this.wotLastSeen = t
      if (!this.recorder) {
        this.autoRecording = true
        void this.startRecording()
      }
    } else if (this.autoRecording && this.recorder && t - this.wotLastSeen > AUTO_RECORD_TAIL_S) {
      this.autoRecording = false
      void this.stopRecording()
    }
  }

  private flush(): void {
    if (!this.batchT.length) return
    this.emit('batch', { channelIds: this.active, t: this.batchT, rows: this.batchRows })
    this.batchT = []
    this.batchRows = []
    const last = this.rateWindow[this.rateWindow.length - 1]
    while (this.rateWindow.length && last - this.rateWindow[0] > 2) this.rateWindow.shift()
    const span = last - this.rateWindow[0]
    const rate = span > 0.5 ? (this.rateWindow.length - 1) / span : undefined
    const patch: Partial<ConnectionStatus> = { sampleRateHz: rate }
    if (this.recorder) patch.recording = this.recordingInfo()
    this.setStatus(patch)
  }

  private recordingInfo(): RecordingInfo | undefined {
    const r = this.recorder
    return r ? { file: r.file, startedAt: r.startedAt, samples: r.samples } : undefined
  }

  async startRecording(): Promise<RecordingInfo> {
    if (!this.stream) await this.startLive()
    if (!this.stream) throw new Error('Not connected')
    if (!this.recorder) {
      const byId = new Map(this.channelList.map((c) => [c.id, c]))
      const channels = this.active.map((id) => byId.get(id)!)
      const meta: Record<string, string> = { adapter: this.current.adapterLabel ?? '' }
      if (this.current.vin) meta.vin = this.current.vin
      if (this.current.ecu?.softwareVersion) meta.ecu = this.current.ecu.softwareVersion
      this.recorder = new Recorder(await dataPath('Logs'), channels, meta)
      this.setStatus({ recording: this.recordingInfo() })
    }
    return this.recordingInfo()!
  }

  async stopRecording(): Promise<string | null> {
    const r = this.recorder
    if (!r) return null
    this.recorder = null
    this.autoRecording = false
    const file = await r.close()
    this.setStatus({ recording: undefined })
    if (this.pendingRestart && this.stream) await this.restartStream()
    return file
  }
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
