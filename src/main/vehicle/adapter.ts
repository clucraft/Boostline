import type { AdapterKind, ChannelDef, EcuInfo } from '@shared/types'

export interface VehicleInfo {
  vin?: string
  ecu?: EcuInfo
  /** "host:port" the adapter is talking to, if network based. */
  endpoint?: string
  /** Human readable adapter description, e.g. "ENET · 169.254.3.12". */
  label: string
}

/** One sampling pass: values aligned with the channel ids passed to startStreaming. */
export interface SampleFrame {
  /** Seconds since streaming started (monotonic). */
  t: number
  values: number[]
}

export interface StreamHandle {
  stop(): Promise<void>
}

/**
 * A connection to the vehicle. Implementations: SimulatorAdapter, EnetAdapter
 * (HSFZ over TCP; also used for MHD / bootmod3 WiFi adapters which bridge ENET).
 */
export interface VehicleAdapter {
  readonly kind: AdapterKind
  connect(signal?: AbortSignal): Promise<VehicleInfo>
  /** Channels available for the connected ECU. Valid after connect(). */
  channels(): ChannelDef[]
  /**
   * Start polling the given channels as fast as possible (capped by maxRateHz).
   * onFrame is called once per completed pass over all channels.
   */
  startStreaming(
    channelIds: string[],
    onFrame: (frame: SampleFrame) => void,
    opts?: { maxRateHz?: number; onError?: (err: Error) => void }
  ): Promise<StreamHandle>
  disconnect(): Promise<void>
}
