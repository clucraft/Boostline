/**
 * Finding the HSFZ gateway on the local network.
 *
 * UDP vehicle identification (community documented, used by E-Sys / ISTA / EdiabasLib):
 * the tester sends the 6-byte HSFZ header `00 00 00 00 00 11` (LENGTH 0, control 0x0011)
 * to UDP port 6811 as a broadcast. Each gateway answers from its own IP with an HSFZ header
 * (control 0x0011) followed by ASCII such as
 *
 *   DIAGADR10BMWMAC001A37XXXXXXBMWVINWBA8E9C50XXXXXXXX
 *
 * i.e. diagnostic address, gateway MAC and VIN, each behind a fixed tag. Parsing is regex
 * based and tolerant of separators. ASSUMPTION: the DIAGADR value is hexadecimal (the ZGW is
 * 0x10 and replies "DIAGADR10").
 *
 * Windows sends 255.255.255.255 through a single "best" interface only, so the request also
 * goes to the directed broadcast address of every IPv4 interface. With an ENET cable the
 * car's gateway sits on a link-local 169.254.x.x address (APIPA) and answers discovery.
 *
 * WiFi adapters (MHD, bootmod3) may or may not forward discovery. As a fallback the
 * adapter's own IP is guessed (x.y.z.1 of each interface, plus common defaults) and
 * TCP-probed on 6801; see candidateHosts() and scanTcp().
 */
import { runtime, type NetworkInterfaceInfo, type SocketError, type UdpSocket } from '../runtime'
import { HSFZ_DIAG_PORT, HSFZ_HEADER_LENGTH, HSFZ_IDENT_PORT, HsfzControl, abortError, encodeFrame, type TrafficDirection } from './hsfz'

/** Default IPs of common WiFi OBD/ENET bridges (ESP32 soft-AP default, typical bridge default). */
export const DEFAULT_ADAPTER_HOSTS: readonly string[] = ['192.168.4.1', '192.168.0.10']

export interface Ipv4Interface {
  name: string
  address: string
  netmask: string
  internal: boolean
  /** 169.254.0.0/16 (APIPA): what an ENET cable connection usually gets. */
  linkLocal: boolean
  /** Directed broadcast address of the interface's subnet. */
  broadcast: string
}

export interface DiscoveredGateway {
  /** Source IP of the identification reply. */
  host: string
  /** HSFZ diagnostic port (always 6801; discovery does not announce it). */
  port: number
  vin?: string
  mac?: string
  diagAddress?: number
  /** The printable identification text as received. */
  ident: string
}

// ------------------------------------------------------------------ addressing

function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number)
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.')
}

export function directedBroadcast(address: string, netmask: string): string {
  return intToIp((ipToInt(address) | (~ipToInt(netmask) >>> 0)) >>> 0)
}

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host.startsWith('127.')
}

export function listIpv4Interfaces(
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined> = runtime().networkInterfaces()
): Ipv4Interface[] {
  const out: Ipv4Interface[] = []
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4') continue
      out.push({
        name,
        address: info.address,
        netmask: info.netmask,
        internal: info.internal,
        linkLocal: info.address.startsWith('169.254.'),
        broadcast: directedBroadcast(info.address, info.netmask)
      })
    }
  }
  return out
}

const unique = (items: string[]): string[] => [...new Set(items)]

/** 255.255.255.255 plus the directed broadcast of every external IPv4 interface. */
export function broadcastTargets(interfaces: Ipv4Interface[] = listIpv4Interfaces()): string[] {
  return unique([
    '255.255.255.255',
    ...interfaces.filter((i) => !i.internal && i.broadcast !== i.address).map((i) => i.broadcast)
  ])
}

/**
 * Hosts that might be a WiFi adapter: the first address (x.y.z.1, usually the access point)
 * of each external, non-link-local interface, then common adapter defaults.
 */
export function candidateHosts(interfaces: Ipv4Interface[] = listIpv4Interfaces()): string[] {
  const guesses: string[] = []
  for (const i of interfaces) {
    if (i.internal || i.linkLocal) continue
    const mask = ipToInt(i.netmask)
    if (mask === 0xffffffff || mask === 0xfffffffe) continue
    const first = intToIp(((ipToInt(i.address) & mask) >>> 0) + 1)
    if (first !== i.address) guesses.push(first)
  }
  return unique([...guesses, ...DEFAULT_ADAPTER_HOSTS])
}

/**
 * Every host address of the local networks (WiFi / Ethernet; not link-local), for a TCP scan
 * when neither discovery nor the likely addresses find the adapter. Larger networks are
 * scanned only in the /24 around this device's own address.
 */
export function subnetHosts(interfaces: Ipv4Interface[] = listIpv4Interfaces()): string[] {
  const out: string[] = []
  for (const i of interfaces) {
    if (i.internal || i.linkLocal) continue
    const address = ipToInt(i.address)
    let mask = ipToInt(i.netmask)
    if (mask === 0xffffffff || mask === 0xfffffffe) continue
    if (~mask >>> 0 > 0xff) mask = 0xffffff00
    const network = (address & mask) >>> 0
    const size = (~mask >>> 0) + 1
    for (let k = 1; k < size - 1; k++) {
      const host = (network + k) >>> 0
      if (host !== address) out.push(intToIp(host))
    }
  }
  return unique(out)
}

// ------------------------------------------------------------------ UDP identification

export function encodeDiscoveryRequest(): Buffer {
  return encodeFrame(HsfzControl.VehicleIdent)
}

/** Parses an identification reply; undefined when the datagram is not one. */
export function parseDiscoveryResponse(msg: Buffer, host: string): DiscoveredGateway | undefined {
  const framed = msg.length >= HSFZ_HEADER_LENGTH && msg.readUInt16BE(4) === HsfzControl.VehicleIdent
  const text = (framed ? msg.subarray(HSFZ_HEADER_LENGTH) : msg).toString('latin1')
  const vin = /BMWVIN[\s:=]*([A-HJ-NPR-Z0-9]{17})/i.exec(text)?.[1]?.toUpperCase()
  const mac = /BMWMAC[\s:=]*([0-9A-F]{12})/i.exec(text)?.[1]?.toUpperCase()
  const diag = /DIAGADR[\s:=]*([0-9A-F]{1,2})/i.exec(text)?.[1]
  if (!vin && !mac && diag === undefined) return undefined
  return {
    host,
    port: HSFZ_DIAG_PORT,
    vin,
    mac,
    diagAddress: diag === undefined ? undefined : parseInt(diag, 16),
    ident: text.replace(/[^\x20-\x7e]/g, '').trim()
  }
}

export interface DiscoveryOptions {
  /** UDP port gateways listen on (default 6811). */
  port?: number
  /** How long to collect replies (default 1500 ms). */
  timeoutMs?: number
  /** Destination addresses (default: broadcastTargets()). Loopback-only lists bind to 127.0.0.1. */
  targets?: string[]
  signal?: AbortSignal
  /** Every datagram sent / received, with "ip:port" of the peer. */
  onTraffic?: (direction: TrafficDirection, bytes: Buffer, peer: string) => void
  log?: (message: string) => void
}

/** Broadcasts an HSFZ identification request and collects replies, one per gateway host. */
export function discoverGateways(opts: DiscoveryOptions = {}): Promise<DiscoveredGateway[]> {
  const port = opts.port ?? HSFZ_IDENT_PORT
  const timeoutMs = opts.timeoutMs ?? 1500
  const targets = opts.targets ?? broadcastTargets()
  const loopbackOnly = targets.length > 0 && targets.every(isLoopback)
  const log = opts.log ?? (() => undefined)
  const { signal } = opts

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }
    let socket: UdpSocket
    try {
      socket = runtime().createUdpSocket()
    } catch (err) {
      // Platforms without UDP broadcast skip discovery; callers fall back to probing hosts.
      log(`Discovery unavailable: ${(err as Error).message}`)
      resolve([])
      return
    }
    const found = new Map<string, DiscoveredGateway>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (err?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      socket.close()
      if (err) reject(err)
      else resolve([...found.values()])
    }
    const onAbort = (): void => finish(abortError(signal as AbortSignal))
    signal?.addEventListener('abort', onAbort, { once: true })

    socket.on('error', (err) => finish(err))
    socket.on('message', (msg, rinfo) => {
      opts.onTraffic?.('rx', msg, `${rinfo.address}:${rinfo.port}`)
      const gw = parseDiscoveryResponse(msg, rinfo.address)
      if (!gw) return
      const known = found.get(gw.host)
      if (!known || (!known.vin && gw.vin)) found.set(gw.host, gw)
      log(`Gateway at ${gw.host}: ${gw.ident}`)
    })
    socket.bind({ port: 0, address: loopbackOnly ? '127.0.0.1' : undefined }, () => {
      if (!loopbackOnly) socket.setBroadcast(true)
      const request = encodeDiscoveryRequest()
      for (const target of targets) {
        opts.onTraffic?.('tx', request, `${target}:${port}`)
        socket.send(request, port, target, (err) => {
          if (err) log(`Discovery request to ${target}:${port} failed: ${err.message}`)
        })
      }
      timer = setTimeout(() => finish(), timeoutMs)
    })
  })
}

// ------------------------------------------------------------------ TCP probing

export interface TcpProbeResult {
  host: string
  port: number
  open: boolean
  /** Time until connect / failure. */
  ms: number
  /** Failure reason: errno code (ECONNREFUSED, EHOSTUNREACH, ...), "timeout" or "aborted". */
  error?: string
}

/** Tries a TCP connect without sending anything; the socket is closed immediately. */
export function probeTcpPort(host: string, port: number, timeoutMs = 800, signal?: AbortSignal): Promise<TcpProbeResult> {
  return new Promise((resolve) => {
    const start = performance.now()
    const socket = runtime().createTcpConnection(host, port)
    let settled = false
    const finish = (open: boolean, error?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      resolve({ host, port, open, ms: Math.round(performance.now() - start), error })
    }
    const onAbort = (): void => finish(false, 'aborted')
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs)
    socket.on('connect', () => finish(true))
    socket.on('error', (err: SocketError) => finish(false, err.code ?? err.message))
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface ScanOptions {
  timeoutMs?: number
  /** Parallel connection attempts (default 16). */
  concurrency?: number
  signal?: AbortSignal
}

/** probeTcpPort over many host/port pairs with bounded parallelism; results keep input order. */
export async function scanTcp(targets: ReadonlyArray<{ host: string; port: number }>, opts: ScanOptions = {}): Promise<TcpProbeResult[]> {
  const results: TcpProbeResult[] = new Array<TcpProbeResult>(targets.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < targets.length) {
      const index = next++
      const { host, port } = targets[index]
      results[index] = await probeTcpPort(host, port, opts.timeoutMs, opts.signal)
    }
  }
  const workers = Math.max(1, Math.min(opts.concurrency ?? 16, targets.length))
  await Promise.all(Array.from({ length: workers }, worker))
  return results
}
