import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

/**
 * Native networking for the vehicle connection (ios/App/App/BoostlineNetPlugin.swift).
 * Socket data crosses the bridge base64-encoded.
 */
export interface BoostlineNetPlugin {
  /** Opens a TCP connection; resolves once connected. */
  tcpConnect(opts: { host: string; port: number; timeoutMs: number }): Promise<{ id: string }>
  tcpWrite(opts: { id: string; data: string }): Promise<void>
  tcpClose(opts: { id: string }): Promise<void>
  /** IPv4 addresses of the device's interfaces (WiFi, USB Ethernet…). */
  interfaces(): Promise<{ interfaces: { name: string; address: string; netmask: string; internal: boolean }[] }>
  addListener(event: 'tcpData', listener: (e: { id: string; data: string }) => void): Promise<PluginListenerHandle>
  addListener(event: 'tcpClose', listener: (e: { id: string; error?: string; code?: string }) => void): Promise<PluginListenerHandle>
}

/** Downloads bmw-unified-db and runs SQL against it (ios/App/App/BoostlineDataPlugin.swift). */
export interface BoostlineDataPlugin {
  /**
   * Downloads a .sqlite.gz, checks its SHA-256 (when given), unpacks it to a temporary
   * database and keeps it open for query(). Progress arrives as 'progress' events.
   */
  openDownloaded(opts: { url: string; sha256?: string }): Promise<void>
  /** Opens a .sqlite or .sqlite.gz the user picked (document picker). False if cancelled. */
  openPicked(): Promise<{ opened: boolean; name?: string }>
  /** Runs a read-only query on the open database; rows as arrays of column values. */
  query(opts: { sql: string; params?: (string | number)[] }): Promise<{ columns: string[]; rows: (string | number | null)[][] }>
  /** Closes the database and deletes the temporary files. */
  close(): Promise<void>
  addListener(
    event: 'progress',
    listener: (e: { phase: 'download' | 'verify' | 'unpack'; received?: number; total?: number }) => void
  ): Promise<PluginListenerHandle>
}

const unavailable = (): Promise<never> => Promise.reject(new Error('Only available in the Boostline iOS app'))

export const BoostlineNet = registerPlugin<BoostlineNetPlugin>('BoostlineNet', {
  web: () => ({
    tcpConnect: unavailable,
    tcpWrite: unavailable,
    tcpClose: unavailable,
    interfaces: async () => ({ interfaces: [] }),
    addListener: async () => ({ remove: async () => undefined })
  })
})

export const BoostlineData = registerPlugin<BoostlineDataPlugin>('BoostlineData', {
  web: () => ({
    openDownloaded: unavailable,
    openPicked: unavailable,
    query: unavailable,
    close: async () => undefined,
    addListener: async () => ({ remove: async () => undefined })
  })
})
