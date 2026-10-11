import { Buffer } from 'buffer'
import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import type { FileWriter, NetworkInterfaceInfo, Runtime, SocketError, TcpSocket, UdpSocket } from '@core/runtime'
import { BoostlineNet } from './plugins'

// Mobile runtime: TCP through the native BoostlineNet plugin, files in the app's
// Documents folder (visible in the Files app under "On My iPhone › Boostline").

const CONNECT_TIMEOUT_MS = 5000
/** The recorder writes small chunks; batch them into fewer native file appends. */
const WRITE_FLUSH_MS = 1000
const WRITE_FLUSH_BYTES = 64 * 1024

type Listener = (...args: never[]) => void

/** Traffic counters (diagnostics and the CI launch test). */
export const netStats = { connects: 0, writes: 0, bytesOut: 0, dataEvents: 0, bytesIn: 0, closes: 0 }

/** A TCP socket backed by the native plugin, with the events of Node's net.Socket. */
class NativeTcpSocket implements TcpSocket {
  private readonly listeners = new Map<string, { fn: Listener; once: boolean }[]>()
  private id: string | null = null
  private closed = false
  private pendingWrites: Uint8Array[] = []

  constructor(host: string, port: number) {
    BoostlineNet.tcpConnect({ host, port, timeoutMs: CONNECT_TIMEOUT_MS }).then(
      ({ id }) => {
        if (this.closed) {
          void BoostlineNet.tcpClose({ id })
          return
        }
        this.id = id
        netStats.connects++
        sockets.set(id, this)
        for (const data of this.pendingWrites) this.write(data)
        this.pendingWrites = []
        this.emit('connect')
      },
      (err: Error & { code?: string }) => this.fail(err.message, err.code)
    )
  }

  on(event: string, fn: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), { fn, once: false }])
    return this
  }

  once(event: string, fn: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), { fn, once: true }])
    return this
  }

  off(event: string, fn: Listener): this {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((l) => l.fn !== fn))
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    const list = this.listeners.get(event) ?? []
    this.listeners.set(event, list.filter((l) => !l.once))
    for (const l of list) (l.fn as (...a: unknown[]) => void)(...args)
  }

  write(data: Uint8Array): boolean {
    if (this.closed) return false
    if (!this.id) {
      this.pendingWrites.push(data)
      return true
    }
    netStats.writes++
    netStats.bytesOut += data.length
    void BoostlineNet.tcpWrite({ id: this.id, data: Buffer.from(data).toString('base64') }).catch((err: Error) => this.fail(err.message))
    return true
  }

  destroy(): void {
    if (this.closed) return
    if (this.id) void BoostlineNet.tcpClose({ id: this.id }).catch(() => undefined)
    this.finish()
  }

  setNoDelay(): void {
    // TCP_NODELAY is always set natively.
  }

  setKeepAlive(): void {
    // Keep-alive is configured natively.
  }

  /** Data from the native side. */
  receive(base64: string): void {
    if (this.closed) return
    const chunk = Buffer.from(base64, 'base64')
    netStats.dataEvents++
    netStats.bytesIn += chunk.length
    this.emit('data', chunk)
  }

  /** The native side closed the connection (error = it failed). */
  fail(message?: string, code?: string): void {
    if (this.closed) return
    if (message) {
      const err: SocketError = new Error(message)
      if (code) err.code = code
      this.emit('error', err)
    }
    this.finish()
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    if (this.id) sockets.delete(this.id)
    // Node emits 'close' asynchronously, after any 'error'.
    setTimeout(() => this.emit('close'), 0)
  }
}

const sockets = new Map<string, NativeTcpSocket>()
let listening = false

function listen(): void {
  if (listening || !Capacitor.isNativePlatform()) return
  listening = true
  void BoostlineNet.addListener('tcpData', (e) => sockets.get(e.id)?.receive(e.data))
  void BoostlineNet.addListener('tcpClose', (e) => {
    netStats.closes++
    sockets.get(e.id)?.fail(e.error, e.code)
  })
}

let interfaces: Record<string, NetworkInterfaceInfo[]> = {}

/** Reads the device's network interfaces (call before connecting; the runtime API is synchronous). */
export async function refreshInterfaces(): Promise<void> {
  const { interfaces: list } = await BoostlineNet.interfaces()
  const next: Record<string, NetworkInterfaceInfo[]> = {}
  // WiFi and wired (en*) only: not cellular (pdp_ip*), VPN (utun*) or peer-to-peer links.
  for (const i of list.filter((x) => /^(en|lo)\d/.test(x.name))) next[i.name] = [...(next[i.name] ?? []), { address: i.address, netmask: i.netmask, family: 'IPv4', internal: i.internal }]
  interfaces = next
}

/** Paths are relative to the app's Documents folder. */
const DOCS = Directory.Documents

function notFound(err: unknown): Error {
  const e = err instanceof Error ? err : new Error(String(err))
  if (/does not exist|no such file|not found/i.test(e.message)) (e as SocketError).code = 'ENOENT'
  return e
}

class DocumentWriter implements FileWriter {
  private chunks: string[] = []
  private size = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private chain: Promise<void>

  constructor(private readonly path: string) {
    this.chain = Filesystem.writeFile({ path, data: '', directory: DOCS, encoding: Encoding.UTF8, recursive: true }).then(() => undefined)
  }

  write(text: string): void {
    this.chunks.push(text)
    this.size += text.length
    if (this.size >= WRITE_FLUSH_BYTES) this.flush()
    else this.timer ??= setTimeout(() => this.flush(), WRITE_FLUSH_MS)
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.chunks.length) return
    const data = this.chunks.join('')
    this.chunks = []
    this.size = 0
    this.chain = this.chain.then(() =>
      Filesystem.appendFile({ path: this.path, data, directory: DOCS, encoding: Encoding.UTF8 }).then(() => undefined)
    )
  }

  async end(): Promise<void> {
    this.flush()
    await this.chain
  }
}

export const mobileRuntime: Runtime = {
  describePlatform: () => `${Capacitor.getPlatform()} (Boostline mobile)`,
  createTcpConnection: (host, port) => {
    listen()
    return new NativeTcpSocket(host, port)
  },
  createUdpSocket: (): UdpSocket => {
    // iOS only allows UDP broadcast with an Apple-granted entitlement; the adapter is
    // found by probing likely addresses over TCP instead.
    throw new Error('UDP broadcast is not available on this device')
  },
  networkInterfaces: () => interfaces,
  joinPath: (...parts) => parts.filter(Boolean).join('/').replace(/\/+/g, '/'),
  readDir: async (dir) => {
    try {
      return (await Filesystem.readdir({ path: dir, directory: DOCS })).files.map((f) => f.name)
    } catch (err) {
      throw notFound(err)
    }
  },
  readTextFile: async (path) => {
    try {
      return (await Filesystem.readFile({ path, directory: DOCS, encoding: Encoding.UTF8 })).data as string
    } catch (err) {
      throw notFound(err)
    }
  },
  writeTextFile: async (path, text) => {
    await Filesystem.writeFile({ path, data: text, directory: DOCS, encoding: Encoding.UTF8, recursive: true })
  },
  createFileWriter: (path) => new DocumentWriter(path)
}
