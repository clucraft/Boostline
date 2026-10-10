/**
 * Platform services the core (vehicle protocols, session, recorder) needs from its host.
 *
 * The core runs in Electron's main process on the desktop and inside the WebView on
 * mobile. Everything platform-specific (sockets, files, network interfaces) goes through
 * the Runtime registered at startup: src/main/nodeRuntime.ts on the desktop and in tests,
 * src/mobile/runtime.ts in the mobile app.
 *
 * The socket interfaces are the subset of Node's net.Socket / dgram.Socket the core uses,
 * so Node sockets satisfy them as they are.
 */
import type { Buffer } from 'buffer'

export type SocketError = Error & { code?: string }

export interface TcpSocket {
  on(event: 'connect' | 'close', listener: () => void): unknown
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'error', listener: (err: SocketError) => void): unknown
  once(event: 'connect' | 'close', listener: () => void): unknown
  once(event: 'error', listener: (err: SocketError) => void): unknown
  off(event: 'connect' | 'close', listener: () => void): unknown
  off(event: 'error', listener: (err: SocketError) => void): unknown
  write(data: Uint8Array): unknown
  destroy(): unknown
  setNoDelay(noDelay: boolean): unknown
  setKeepAlive(enable: boolean, initialDelayMs: number): unknown
}

export interface UdpRemoteInfo {
  address: string
  port: number
}

export interface UdpSocket {
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'message', listener: (msg: Buffer, rinfo: UdpRemoteInfo) => void): unknown
  bind(opts: { port: number; address?: string }, callback: () => void): unknown
  setBroadcast(flag: boolean): void
  send(msg: Uint8Array, port: number, address: string, callback: (err: Error | null) => void): void
  close(): unknown
}

/** One address of a network interface (the fields of Node's os.NetworkInterfaceInfo the core reads). */
export interface NetworkInterfaceInfo {
  address: string
  netmask: string
  family: string
  internal: boolean
  mac?: string
  cidr?: string | null
}

/** Appends text to a file; end() flushes and closes it. */
export interface FileWriter {
  write(text: string): void
  end(): Promise<void>
}

export interface Runtime {
  /** e.g. "win32 10.0.26200", "ios 18.0" (diagnostics reports). */
  describePlatform(): string
  createTcpConnection(host: string, port: number): TcpSocket
  /** Throws when the platform cannot do UDP (discovery is then skipped). */
  createUdpSocket(): UdpSocket
  networkInterfaces(): Record<string, NetworkInterfaceInfo[] | undefined>
  joinPath(...parts: string[]): string
  /** Rejects with an error whose code is 'ENOENT' when the folder doesn't exist. */
  readDir(dir: string): Promise<string[]>
  readTextFile(path: string): Promise<string>
  writeTextFile(path: string, text: string): Promise<void>
  createFileWriter(path: string): FileWriter
}

let current: Runtime | null = null

export function setRuntime(runtime: Runtime): void {
  current = runtime
}

export function runtime(): Runtime {
  if (!current) throw new Error('Boostline runtime not initialised (setRuntime was not called)')
  return current
}
