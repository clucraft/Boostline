/**
 * Connection diagnostics for real hardware (ENET cable, MHD / bootmod3 WiFi adapters).
 *
 * Whether the WiFi adapters expose a transparent HSFZ gateway is an assumption; this probe
 * collects the evidence to confirm or refute it without changing anything in the car:
 *
 *   1. lists the PC's IPv4 interfaces (is it on the adapter's WiFi / a 169.254 link?),
 *   2. sends HSFZ UDP discovery and records every reply,
 *   3. TCP-connect-scans candidate hosts on ports used by HSFZ and common OBD bridges
 *      (connect only, nothing is sent),
 *   4. on every host with the HSFZ port open: reads the VIN (DME, then gateway), the DME's
 *      diagnostic index (DID F150, which selects the BMW DME data; the raw bytes are kept
 *      because its layout is an assumption), the DME software id, the supported OBD PID
 *      bitmasks and tries one multi-DID read, i.e. exactly the requests the logger relies
 *      on (read-only UDS through UdsClient),
 *   5. writes every byte exchanged as a timestamped hex dump to `capturePath`.
 *
 * The returned report is plain JSON; `summary` is one plain-English line.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import type { AdapterKind } from '@shared/types'
import {
  broadcastTargets,
  candidateHosts,
  discoverGateways,
  listIpv4Interfaces,
  scanTcp,
  type DiscoveredGateway,
  type Ipv4Interface,
  type TcpProbeResult
} from './discovery'
import { detectSupportedPids, readSgbdIndex, readSoftwareIdentification } from './enet'
import { ECU_ADDRESS, HSFZ_DIAG_PORT, HSFZ_IDENT_PORT, HsfzConnection, HsfzGatewayError, HsfzTimeoutError, toHex, type TrafficDirection } from './hsfz'
import { OBD_PIDS } from './obdChannels'
import { UdsClient } from './uds'

/** HSFZ, HSFZ control, telnet / ELM327 WiFi, web UIs, Vgate-style ELM327 WiFi, misc bridges. */
export const PROBE_PORTS: readonly number[] = [6801, 6811, 23, 80, 443, 3000, 8080, 35000, 50000]

const SCAN_TIMEOUT_MS = 700
const SCAN_CONCURRENCY = 24
const HSFZ_CONNECT_TIMEOUT_MS = 2000
const HSFZ_REQUEST_TIMEOUT_MS = 1500

export interface ProbeOptions {
  kind: AdapterKind
  /** Only probe this host (plus whatever answers discovery). */
  host?: string
  /** Where to write the hex dump of all traffic. */
  capturePath?: string
  log?: (message: string) => void
  /** Ports to scan (default PROBE_PORTS; the HSFZ port is always added). */
  ports?: readonly number[]
  /** HSFZ diagnostic port (default 6801). */
  hsfzPort?: number
  discovery?: { port?: number; targets?: string[]; timeoutMs?: number }
  signal?: AbortSignal
}

export interface ProbeHsfzResult {
  host: string
  port: number
  connected: boolean
  vin?: string
  vinSource?: 'DME' | 'ZGW'
  /** The DME answered at all (positive or negative response). */
  dmeResponding: boolean
  /** DME diagnostic (SGBD) index from DID F150, e.g. "0x0F2426". */
  sgbdIndex?: string
  /** Raw F150 data bytes, e.g. "0f 24 26". */
  sgbdIndexRaw?: string
  softwareVersion?: string
  hardwareNumber?: string
  /** OBD PIDs reported as supported (hex strings). */
  obdPids?: string[]
  /** Outcome of a two-DID ReadDataByIdentifier request. */
  multiDidRead?: string
  /** Protocol notes from the connection (ACK oddities, alive checks, stray frames). */
  notes: string[]
  error?: string
}

export interface ProbeReport {
  startedAt: string
  durationMs: number
  kind: AdapterKind
  platform: string
  interfaces: Ipv4Interface[]
  discovery: { port: number; targets: string[]; replies: DiscoveredGateway[]; error?: string }
  candidates: string[]
  portScan: TcpProbeResult[]
  hsfz: ProbeHsfzResult[]
  capturePath?: string
  captureError?: string
  summary: string
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// ------------------------------------------------------------------ capture

/** Timestamped hex dump of everything exchanged during the probe. */
class Capture {
  private readonly lines: string[] = []
  private readonly t0 = performance.now()

  private stamp(): string {
    return `[+${(performance.now() - this.t0).toFixed(1).padStart(9)} ms]`
  }

  note(text: string): void {
    this.lines.push(`${this.stamp()} # ${text}`)
  }

  record(channel: string, direction: TrafficDirection, bytes: Buffer): void {
    this.lines.push(`${this.stamp()} ${channel} ${direction === 'tx' ? 'TX' : 'RX'} ${bytes.length} bytes`)
    for (let offset = 0; offset < bytes.length; offset += 16) {
      const row = bytes.subarray(offset, offset + 16)
      const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0')).join(' ')
      const ascii = Array.from(row, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')
      this.lines.push(`    ${offset.toString(16).padStart(4, '0')}  ${hex.padEnd(47)}  |${ascii}|`)
    }
  }

  async write(path: string, header: string): Promise<void> {
    await fs.writeFile(path, `${header}\n\n${this.lines.join('\n')}\n`, 'utf8')
  }
}

// ------------------------------------------------------------------ HSFZ checks

async function probeHsfz(host: string, port: number, capture: Capture, log: (m: string) => void, signal?: AbortSignal): Promise<ProbeHsfzResult> {
  const result: ProbeHsfzResult = { host, port, connected: false, dmeResponding: false, notes: [] }
  const note = (m: string): void => {
    result.notes.push(m)
    capture.note(`${host}:${port} ${m}`)
    log(`[${host}] ${m}`)
  }
  let conn: HsfzConnection
  try {
    conn = await HsfzConnection.connect(host, port, {
      timeoutMs: HSFZ_CONNECT_TIMEOUT_MS,
      signal,
      onTraffic: (direction, bytes) => capture.record(`TCP ${host}:${port}`, direction, bytes),
      log: note
    })
  } catch (err) {
    result.error = describe(err)
    note(`connect failed: ${result.error}`)
    return result
  }
  result.connected = true
  const uds = new UdsClient(conn, { timeoutMs: HSFZ_REQUEST_TIMEOUT_MS })
  const dme = ECU_ADDRESS.DME
  try {
    try {
      result.vin = await uds.readVin(dme)
      result.vinSource = 'DME'
      result.dmeResponding = true
    } catch (err) {
      result.dmeResponding = !(err instanceof HsfzTimeoutError || err instanceof HsfzGatewayError)
      note(`VIN from DME ${dme.toString(16)}: ${describe(err)}`)
    }
    if (!result.vin) {
      try {
        result.vin = await uds.readVin(ECU_ADDRESS.ZGW)
        result.vinSource = 'ZGW'
      } catch (err) {
        note(`VIN from gateway: ${describe(err)}`)
      }
    }
    if (result.dmeResponding) {
      // Only once HSFZ demonstrably works (a VIN came back); a silent DME is skipped above.
      if (result.vin) {
        const index = await readSgbdIndex(uds, dme, note)
        result.sgbdIndex = index?.hex
        result.sgbdIndexRaw = index && toHex(index.raw)
      }
      const ident = await readSoftwareIdentification(uds, dme, note)
      result.softwareVersion = ident.softwareVersion
      result.hardwareNumber = ident.hardwareNumber
      const pids = await detectSupportedPids(uds, dme, note)
      result.obdPids = [...pids].map((p) => p.toString(16).padStart(2, '0'))
      const pair = OBD_PIDS.filter((p) => pids.has(p.pid)).slice(0, 2)
      if (pair.length === 2) {
        try {
          const values = await uds.readDataByIdentifier(dme, pair.map((p) => p.did), new Map(pair.map((p) => [p.did, p.length])))
          result.multiDidRead = `ok (${pair.map((p) => `${p.did.toString(16)}=${values.has(p.did) ? 'present' : 'omitted'}`).join(', ')})`
        } catch (err) {
          result.multiDidRead = `failed: ${describe(err)}`
        }
      }
    }
  } catch (err) {
    result.error = describe(err)
    note(`aborted: ${result.error}`)
  } finally {
    await conn.close()
  }
  return result
}

// ------------------------------------------------------------------ summary

function hint(kind: AdapterKind): string {
  switch (kind) {
    case 'mhd-wifi':
      return "connect this PC to the MHD adapter's WiFi (MHD_xxxx / MHD ENET xxxx) with the ignition on"
    case 'bm3-wifi':
      return "connect this PC to the bootmod3 adapter's WiFi (BM3-NET...) with the ignition on"
    default:
      return 'check the ENET cable, the ignition, and that the Ethernet adapter has a 169.254.x.x address'
  }
}

function summarize(report: Omit<ProbeReport, 'summary'>, hsfzPort: number): string {
  const found = report.hsfz.find((h) => h.vin || h.dmeResponding)
  if (found) {
    const parts = [`HSFZ gateway found at ${found.host}:${found.port}`]
    if (found.vin) parts.push(`VIN ${found.vin}`)
    parts.push(found.dmeResponding ? 'DME responding' : 'DME not responding (ignition off?)')
    if (found.sgbdIndex) parts.push(`SGBD index ${found.sgbdIndex} [${found.sgbdIndexRaw}]`)
    if (found.obdPids) parts.push(`${found.obdPids.length} OBD PIDs`)
    if (found.multiDidRead) parts.push(`multi-DID read ${found.multiDidRead.startsWith('ok') ? 'ok' : 'rejected'}`)
    return parts.join(', ')
  }
  const connected = report.hsfz.find((h) => h.connected)
  if (connected) {
    return `${connected.host}:${connected.port} accepts TCP connections but did not answer HSFZ diagnostics (${connected.notes.at(-1) ?? connected.error ?? 'no response'})`
  }
  const open = report.portScan.filter((r) => r.open).map((r) => `${r.host}:${r.port}`)
  if (report.discovery.replies.length > 0) {
    return `Gateway answered discovery (${report.discovery.replies.map((r) => r.host).join(', ')}) but TCP ${hsfzPort} is not reachable`
  }
  if (open.length > 0) return `No HSFZ gateway found; open ports: ${open.join(', ')}`
  return `No HSFZ gateway found on ${report.candidates.length} candidate host(s); ${hint(report.kind)}`
}

// ------------------------------------------------------------------ probe

export async function runProbe(opts: ProbeOptions): Promise<ProbeReport> {
  const log = opts.log ?? (() => undefined)
  const capture = new Capture()
  const started = performance.now()
  const startedAt = new Date().toISOString()
  const hsfzPort = opts.hsfzPort ?? HSFZ_DIAG_PORT
  const ports = [...new Set([...(opts.ports ?? PROBE_PORTS), hsfzPort])]

  const interfaces = listIpv4Interfaces()
  for (const i of interfaces.filter((i) => !i.internal)) {
    capture.note(`interface ${i.name}: ${i.address}/${i.netmask}${i.linkLocal ? ' (link-local)' : ''}`)
  }
  log(`Interfaces: ${interfaces.filter((i) => !i.internal).map((i) => `${i.name} ${i.address}`).join(', ') || 'none'}`)

  const discoveryPort = opts.discovery?.port ?? HSFZ_IDENT_PORT
  const discoveryTargets = opts.discovery?.targets ?? broadcastTargets(interfaces)
  let replies: DiscoveredGateway[] = []
  let discoveryError: string | undefined
  try {
    replies = await discoverGateways({
      port: discoveryPort,
      targets: discoveryTargets,
      timeoutMs: opts.discovery?.timeoutMs,
      signal: opts.signal,
      onTraffic: (direction, bytes, peer) => capture.record(`UDP ${peer}`, direction, bytes),
      log
    })
  } catch (err) {
    discoveryError = describe(err)
    capture.note(`discovery failed: ${discoveryError}`)
  }
  log(`Discovery: ${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}${discoveryError ? ` (${discoveryError})` : ''}`)

  const candidates = [
    ...new Set([...(opts.host ? [opts.host] : []), ...replies.map((r) => r.host), ...(opts.host ? [] : candidateHosts(interfaces))])
  ]
  capture.note(`scanning ${candidates.join(', ')} on ports ${ports.join(', ')}`)
  const portScan = await scanTcp(
    candidates.flatMap((host) => ports.map((port) => ({ host, port }))),
    { timeoutMs: SCAN_TIMEOUT_MS, concurrency: SCAN_CONCURRENCY, signal: opts.signal }
  )
  for (const r of portScan.filter((r) => r.open)) capture.note(`open: ${r.host}:${r.port} (${r.ms} ms)`)
  log(`Open ports: ${portScan.filter((r) => r.open).map((r) => `${r.host}:${r.port}`).join(', ') || 'none'}`)

  const hsfz: ProbeHsfzResult[] = []
  for (const host of candidates) {
    if (!portScan.some((r) => r.host === host && r.port === hsfzPort && r.open)) continue
    hsfz.push(await probeHsfz(host, hsfzPort, capture, log, opts.signal))
  }

  const partial = {
    startedAt,
    durationMs: Math.round(performance.now() - started),
    kind: opts.kind,
    platform: `${os.platform()} ${os.release()}`,
    interfaces,
    discovery: { port: discoveryPort, targets: discoveryTargets, replies, error: discoveryError },
    candidates,
    portScan,
    hsfz
  }
  const report: ProbeReport = { ...partial, summary: summarize(partial, hsfzPort) }
  log(report.summary)

  if (opts.capturePath) {
    try {
      await capture.write(opts.capturePath, `Boostline connection probe (${opts.kind}), ${startedAt}\n${report.summary}`)
      report.capturePath = opts.capturePath
    } catch (err) {
      report.captureError = describe(err)
      log(`Could not write capture: ${report.captureError}`)
    }
  }
  return report
}
