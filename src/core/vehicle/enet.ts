/**
 * EnetAdapter: live data from the engine DME over HSFZ (ENET cable, or a WiFi adapter that
 * bridges HSFZ such as MHD / bootmod3; the WiFi bridging is an assumption, see probe.ts).
 *
 * connect():
 *   1. Gateway host: explicit host, else UDP discovery (~1.5 s), else (WiFi kinds only) a
 *      TCP probe of likely adapter IPs on port 6801.
 *   2. VIN from the DME (0x12, DID F190), falling back to the gateway (0x10). A DME that
 *      does not answer at all fails the connect with an "ignition on?" hint.
 *   3. Diagnostic (SGBD) index from the DME (DID F150, BMW job IDENT / ID_SGBD_INDEX;
 *      never fatal). ASSUMPTION: the record is the index as a big-endian unsigned integer;
 *      the first (up to) 4 data bytes are used and the raw bytes are logged. The index is
 *      handed to the `dmeData` resolver, which picks the BMW DME data (SG_FUNKTIONEN
 *      measurements, src/main/bmwdata) for this DME variant, if the user imported any.
 *   4. Software identification (SVK F101, else F189 / F1A0; never fatal) selects the
 *      user definition sets that apply (definitions.ts).
 *   5. Supported OBD PIDs from the bitmask DIDs F400, F420, ... (obdChannels.ts).
 *
 * Channel registry, later layers replacing channels with the same id: OBD channels, OBD
 * derived channels, BMW DME measurements (+ their derived channels), user definition sets.
 * Derived channels whose inputs end up unavailable are dropped.
 *
 * startStreaming() polls in passes; one pass over all requests yields one SampleFrame:
 *   - DIDs are grouped into multi-DID ReadDataByIdentifier requests (8 per request at
 *     first). NRC 0x13 / 0x14 / 0x31 or an unparsable response splits the batch in halves;
 *     when the halves succeed the smaller size is remembered per ECU. A DID the ECU rejects
 *     on its own (0x11 / 0x31 / 0x33 / 0x7E / 0x7F) is disabled and reported once; a DID
 *     omitted from a multi-DID response is read on its own in the next pass.
 *   - Dynamically defined DIDs (numbered from 0xF300 by one counter per stream, cleared on
 *     stop) ride along in the multi-DID reads like any other DID:
 *       - RAM channels are packed into them by memory address (2C 02). Without dynamic
 *         DIDs, ReadMemoryByAddress (0x23) is used per channel.
 *       - DME measurements flagged composable are packed into them by identifier (2C 01,
 *         BMW's STATUS_BLOCK_LESEN): each entry is a whole source record (position 1,
 *         size = record length). A dynamic DID whose definition the ECU rejects with
 *         0x13 / 0x14 / 0x31 is retried as two halves; when both halves work, the smaller
 *         entry count is used for that ECU's remaining dynamic DIDs of the stream. Any
 *         other refusal (or too many failed definitions) stops composing on that ECU.
 *         Whatever could not be composed is read as plain DIDs; one log line per ECU says
 *         why.
 *     ASSUMPTION: at most 16 entries and 64 data bytes per dynamic DID are conservative
 *     guesses for BMW DMEs (not verified on a car); the halving adapts to lower limits.
 *     When a definition is refused with 0x7E / 0x7F before anything was defined on that
 *     ECU, the extended session (10 03) is tried once, kept alive with 3E 80, and the
 *     default session is restored on stop.
 *   - Derived channels are computed after decoding; unavailable values are NaN.
 *   - Per-request errors go to onError and polling continues; a lost connection ends
 *     the stream (reported once).
 *
 * Only services on the UDS allowlist (uds.ts) can be sent.
 */
import type { AdapterKind, ChannelDef } from '@shared/types'
import type { DmeChannelSet, DmeDataResolver } from '../bmwdata/types'
import type { SampleFrame, StreamHandle, VehicleAdapter, VehicleInfo } from './adapter'
import { decodeChannelSource, loadDefinitionFiles, selectDefinitionSets, type DefinitionSet } from './definitions'
import { candidateHosts, discoverGateways, scanTcp, subnetHosts } from './discovery'
import {
  ECU_ADDRESS,
  HSFZ_DIAG_PORT,
  HsfzConnection,
  HsfzConnectionClosedError,
  HsfzGatewayError,
  HsfzTimeoutError,
  toHex,
  type TrafficDirection
} from './hsfz'
import { OBD_DID_BASE, OBD_PIDS, SUPPORTED_PID_DIDS, buildObdPlan, parseSupportedPids, type ObdPlan } from './obdChannels'
import { DYNAMIC_DID_LAST, DiagnosticSession, NegativeResponseError, UdsClient, UdsProtocolError, isDynamicDid } from './uds'

export type NetworkAdapterKind = Exclude<AdapterKind, 'simulator'>

export interface EnetAdapterOptions {
  kind: NetworkAdapterKind
  /** Gateway / adapter IP. Skips discovery. */
  host?: string
  /** HSFZ TCP port (default 6801). */
  port?: number
  /** Folder of JSON channel definition files (see definitions.ts). */
  definitionsDir?: string
  /** Raw HSFZ bytes in both directions (captures). */
  capture?: (direction: TrafficDirection, bytes: Buffer) => void
  /** UDP discovery port (default 6811; for tests). */
  discoveryPort?: number
  /** Replaces the broadcast addresses used for discovery (tests, known subnets). */
  discoveryTargets?: string[]
  /**
   * Picks the BMW DME measurement set for the diagnostic index read from the car (F150;
   * undefined when unreadable). Its channels are added on top of the OBD channels.
   */
  dmeData?: DmeDataResolver
  /**
   * WiFi kinds: when discovery and the likely addresses find nothing, scan every address of
   * the local network on the HSFZ port (the iOS app: iOS doesn't allow the UDP broadcast).
   */
  scanSubnet?: boolean
  /** Timeout of the first identification requests (VIN), default 1500 ms. */
  identTimeoutMs?: number
  log?: (message: string) => void
}

const KIND_LABEL: Record<NetworkAdapterKind, string> = {
  enet: 'ENET',
  'mhd-wifi': 'MHD WiFi',
  'bm3-wifi': 'bootmod3 WiFi'
}

const DISCOVERY_TIMEOUT_MS = 1500
const CANDIDATE_PROBE_TIMEOUT_MS = 800
const SUBNET_PROBE_TIMEOUT_MS = 500
const CONNECT_TIMEOUT_MS = 3000
const IDENT_TIMEOUT_MS = 1500
const PID_PROBE_TIMEOUT_MS = 500
const POLL_TIMEOUT_MS = 1000
const CLEANUP_TIMEOUT_MS = 500
const INITIAL_DIDS_PER_REQUEST = 8
const TESTER_PRESENT_INTERVAL_MS = 2000
/** Pause between passes when nothing can be polled (keeps the event loop free). */
const IDLE_PERIOD_MS = 100
const DYNAMIC_DID_BASE = 0xf300
/** ASSUMPTION: conservative per-DID limits for dynamic DIDs (both 2C 01 and 2C 02). */
const MAX_DYNAMIC_DID_ENTRIES = 16
const MAX_DYNAMIC_DID_BYTES = 64
/** Failed 2C 01 definitions per ECU after which the remaining DIDs are read plainly. */
const MAX_COMPOSE_FAILURES = 8

const DID_SVK = 0xf101
const SOFTWARE_ID_DIDS = [DID_SVK, 0xf189, 0xf1a0]
/** BMW diagnostic index (job IDENT, result ID_SGBD_INDEX). */
export const DID_SGBD_INDEX = 0xf150

/** NRCs that mean "this batch is too big / contains something unsupported": split it. */
const BATCH_REJECTION_NRCS = new Set([0x13, 0x14, 0x31])
/** NRCs that will not change while the session lasts: stop polling that item. */
const PERMANENT_NRCS = new Set([0x11, 0x31, 0x33, 0x7e, 0x7f])
/** NRCs that may go away in the extended diagnostic session. */
const SESSION_NRCS = new Set([0x7e, 0x7f])

const hexByte = (n: number): string => `0x${n.toString(16).toUpperCase().padStart(2, '0')}`
const hexWord = (n: number): string => `0x${n.toString(16).toUpperCase().padStart(4, '0')}`
const hexAddress = (n: number): string => `0x${n.toString(16).toUpperCase().padStart(8, '0')}`
const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))
const isClosed = (err: unknown): boolean => err instanceof HsfzConnectionClosedError
const hasNrc = (err: unknown, nrcs: ReadonlySet<number>): boolean => err instanceof NegativeResponseError && nrcs.has(err.nrc)

// ------------------------------------------------------------------ identification

/**
 * BMW process classes of SVK entries (E-Sys naming). ASSUMPTION: list as used by E-Sys /
 * PSdZ; unknown classes make the SVK parse fail and fall back to F189.
 */
const PROCESS_CLASSES: Readonly<Record<number, string>> = {
  0x01: 'HWEL', 0x02: 'HWAP', 0x03: 'HWFR', 0x04: 'GWTB', 0x05: 'CAFD', 0x06: 'BTLD', 0x07: 'FLSL',
  0x08: 'SWFL', 0x09: 'SWFF', 0x0a: 'SWPF', 0x0b: 'ONPS', 0x0f: 'FAFP', 0x1a: 'TLRT', 0x1b: 'TPRG',
  0x1c: 'BLUP', 0x1d: 'FLUP', 0xa0: 'ENTD', 0xa1: 'NAVD', 0xa2: 'FCFN', 0xc0: 'SWUP', 0xc1: 'SWIP'
}

/** Bytes between the 4-byte SVK header and the entries (programming date, km, ...). ASSUMPTION. */
const SVK_FINGERPRINT_LENGTH = 13

export interface SvkEntry {
  processClass: number
  className: string
  id: number
  version: [number, number, number]
}

/**
 * Parses the BMW SVK (DID F101). ASSUMED layout: SVK version (1), programming-dependency
 * flag (1), entry count (u16 BE), a fingerprint block, then `count` 8-byte entries of
 * process class (1), SGBM id (u32 BE) and version (3 x u8). Since the fingerprint length
 * is not certain the entries are located from the end of the record first, then at the
 * assumed and the minimal offset; a candidate is accepted when every class is known.
 */
export function parseSvk(data: Buffer): SvkEntry[] | undefined {
  if (data.length < 4) return undefined
  const count = data.readUInt16BE(2)
  const size = count * 8
  if (count === 0 || data.length < 4 + size) return undefined
  for (const offset of new Set([data.length - size, 4 + SVK_FINGERPRINT_LENGTH, 4])) {
    if (offset < 4 || offset + size > data.length) continue
    const entries: SvkEntry[] = []
    for (let i = 0; i < count; i++) {
      const p = offset + i * 8
      const className = PROCESS_CLASSES[data[p]]
      if (!className) break
      entries.push({ processClass: data[p], className, id: data.readUInt32BE(p + 1), version: [data[p + 5], data[p + 6], data[p + 7]] })
    }
    if (entries.length === count) return entries
  }
  return undefined
}

/** E-Sys style "SWFL_00002A6F_005_100_010". */
export function formatSvkEntry(e: SvkEntry): string {
  const version = e.version.map((v) => String(v).padStart(3, '0')).join('_')
  return `${e.className}_${e.id.toString(16).toUpperCase().padStart(8, '0')}_${version}`
}

export interface SoftwareIdentification {
  /** Compact software string used to match definition sets (BTLD + SWFL entries of the SVK). */
  softwareVersion?: string
  /** HWEL entry of the SVK. */
  hardwareNumber?: string
}

function printable(data: Buffer): string | undefined {
  const text = data.toString('latin1').replace(/\0+$/, '').trim()
  return text.length > 0 && /^[\x20-\x7e]+$/.test(text) ? text : undefined
}

/** Reads the ECU's software identification; never throws except on a closed connection. */
export async function readSoftwareIdentification(
  uds: UdsClient,
  target: number,
  log: (message: string) => void
): Promise<SoftwareIdentification> {
  let fallback: string | undefined
  for (const did of SOFTWARE_ID_DIDS) {
    let data: Buffer | undefined
    try {
      data = (await uds.readDataByIdentifier(target, [did], undefined, { timeoutMs: IDENT_TIMEOUT_MS })).get(did)
    } catch (err) {
      if (isClosed(err)) throw err
      log(`Software id DID ${hexWord(did)} on ECU ${hexByte(target)}: ${describe(err)}`)
      continue
    }
    if (!data || data.length === 0) continue
    if (did === DID_SVK) {
      const svk = parseSvk(data)
      if (svk) {
        const software = svk.filter((e) => e.className === 'BTLD' || e.className === 'SWFL')
        const hardware = svk.find((e) => e.className === 'HWEL')
        return {
          softwareVersion: (software.length > 0 ? software : svk).map(formatSvkEntry).join(' '),
          hardwareNumber: hardware && formatSvkEntry(hardware)
        }
      }
      log(`SVK (F101) has an unexpected layout: ${toHex(data)}`)
    } else {
      const text = printable(data)
      if (text) return { softwareVersion: text }
    }
    fallback ??= toHex(data, '').toUpperCase()
  }
  return { softwareVersion: fallback }
}

export interface SgbdIndex {
  /** The index as a number, e.g. 0x0F2426. */
  value: number
  /** "0x0F2426" (at least 6 hex digits). */
  hex: string
  /** Raw F150 data bytes (without the DID echo). */
  raw: Buffer
}

/** "0x0F2426": at least 6 hex digits, 8 when the value needs them. */
export function formatSgbdIndex(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(value > 0xffffff ? 8 : 6, '0')}`
}

/**
 * Parses the F150 record. ASSUMPTION (layout unverified): the index is the big-endian
 * unsigned integer of the first (up to) 4 data bytes; BMW's SGBDs type ID_SGBD_INDEX as a
 * long and show values like 0x0F2426.
 */
export function parseSgbdIndex(data: Uint8Array): SgbdIndex | undefined {
  if (data.length === 0) return undefined
  const raw = Buffer.from(data)
  const value = raw.readUIntBE(0, Math.min(4, raw.length))
  return { value, hex: formatSgbdIndex(value), raw }
}

/** Reads the DME's diagnostic (SGBD) index; never throws except on a closed connection. */
export async function readSgbdIndex(uds: UdsClient, target: number, log: (message: string) => void): Promise<SgbdIndex | undefined> {
  let data: Buffer | undefined
  try {
    data = (await uds.readDataByIdentifier(target, [DID_SGBD_INDEX], undefined, { timeoutMs: IDENT_TIMEOUT_MS })).get(DID_SGBD_INDEX)
  } catch (err) {
    if (isClosed(err)) throw err
    log(`Diagnostic index (DID F150) on ECU ${hexByte(target)}: ${describe(err)}`)
    return undefined
  }
  const index = data && parseSgbdIndex(data)
  const extra = data && data.length > 4 ? ` (${data.length} bytes; the first 4 were used)` : ''
  log(`Diagnostic index (DID F150) on ECU ${hexByte(target)}: raw [${toHex(data)}] -> ${index ? index.hex : 'no data'}${extra}`)
  return index
}

/**
 * OBD PIDs the ECU supports, from the bitmask DIDs. When F400 itself is unreadable every
 * known PID DID is tried individually (giving up after three consecutive timeouts).
 */
export async function detectSupportedPids(uds: UdsClient, target: number, log: (message: string) => void): Promise<Set<number>> {
  const supported = new Set<number>()
  for (const did of SUPPORTED_PID_DIDS) {
    let data: Buffer | undefined
    try {
      data = (await uds.readDataByIdentifier(target, [did], undefined, { timeoutMs: IDENT_TIMEOUT_MS })).get(did)
    } catch (err) {
      if (isClosed(err)) throw err
      if (did === SUPPORTED_PID_DIDS[0]) {
        log(`Supported-PID bitmask ${hexWord(did)} unreadable (${describe(err)}); probing PIDs individually`)
        return probePidsIndividually(uds, target, log)
      }
      log(`Supported-PID bitmask ${hexWord(did)} unreadable: ${describe(err)}`)
      break
    }
    if (!data) break
    const flagged = parseSupportedPids(did, data)
    // The last bit of each bitmask announces the next bitmask DID, not a data PID.
    for (const pid of flagged) if (pid % 0x20 !== 0) supported.add(pid)
    if (!flagged.includes(did - OBD_DID_BASE + 0x20)) break
  }
  log(`ECU ${hexByte(target)} supports OBD PIDs ${[...supported].map((p) => p.toString(16).padStart(2, '0')).join(' ') || '(none)'}`)
  return supported
}

async function probePidsIndividually(uds: UdsClient, target: number, log: (message: string) => void): Promise<Set<number>> {
  const supported = new Set<number>()
  let timeouts = 0
  for (const pid of new Set(OBD_PIDS.map((p) => p.pid))) {
    try {
      await uds.readDataByIdentifier(target, [OBD_DID_BASE + pid], undefined, { timeoutMs: PID_PROBE_TIMEOUT_MS })
      supported.add(pid)
      timeouts = 0
    } catch (err) {
      if (isClosed(err)) throw err
      if (!(err instanceof HsfzTimeoutError)) continue
      if (++timeouts >= 3) {
        log('PID probing stopped after three timeouts')
        break
      }
    }
  }
  log(`ECU ${hexByte(target)} answered OBD PIDs ${[...supported].map((p) => p.toString(16).padStart(2, '0')).join(' ') || '(none)'}`)
  return supported
}

// ------------------------------------------------------------------ channel registry

type Decoder = (data: Buffer) => number

type ChannelSource =
  | {
      type: 'did'
      target: number
      did: number
      /** Record length; undefined when unknown (the DID is then read on its own). */
      length: number | undefined
      /** May be packed into a dynamically defined DID by identifier (2C 01). */
      composable: boolean
      decode: Decoder
    }
  | { type: 'memory'; target: number; address: number; size: number; decode: Decoder }
  | { type: 'derived'; inputs: readonly string[]; compute: (inputs: readonly number[]) => number }

interface Session {
  conn: HsfzConnection
  uds: UdsClient
  info: VehicleInfo
  channels: ChannelDef[]
  sources: Map<string, ChannelSource>
}

/**
 * Layers, later ones replacing channels with the same id (the channel keeps its first
 * position): OBD channels, OBD derived channels, BMW DME measurements and their derived
 * channels, user definition sets. Derived channels with unavailable inputs are dropped.
 */
function buildChannelRegistry(
  obd: ObdPlan,
  dme: number,
  dmeSet: DmeChannelSet | undefined,
  sets: readonly DefinitionSet[],
  log: (message: string) => void
): { channels: ChannelDef[]; sources: Map<string, ChannelSource> } {
  const defs = new Map<string, ChannelDef>()
  const sources = new Map<string, ChannelSource>()
  const add = (channel: ChannelDef, source: ChannelSource): void => {
    defs.set(channel.id, channel)
    sources.set(channel.id, source)
  }
  for (const r of obd.reads) add(r.channel, { type: 'did', target: dme, did: r.did, length: r.length, composable: false, decode: r.decode })
  for (const d of obd.derived) add(d.channel, { type: 'derived', inputs: d.inputs, compute: d.compute })
  if (dmeSet) {
    for (const r of dmeSet.reads) {
      add(r.channel, { type: 'did', target: dmeSet.ecuAddress, did: r.did, length: r.length, composable: r.composable, decode: r.decode })
    }
    for (const d of dmeSet.derived) add(d.channel, { type: 'derived', inputs: [...d.inputs], compute: d.compute })
  }
  for (const set of sets) {
    for (const { channel, source } of set.channels) {
      const decode: Decoder = (data) => decodeChannelSource(source, data)
      add(
        channel,
        source.type === 'did'
          ? { type: 'did', target: set.ecuAddress, did: source.did, length: source.didLength, composable: false, decode }
          : { type: 'memory', target: set.ecuAddress, address: source.address, size: source.size, decode }
      )
    }
  }
  // Drop derived channels that can never compute (repeat: they may feed each other).
  for (let changed = true; changed; ) {
    changed = false
    for (const [id, source] of sources) {
      if (source.type !== 'derived') continue
      const missing = source.inputs.filter((input) => !sources.has(input))
      if (missing.length === 0) continue
      log(`Derived channel ${id} dropped: ${missing.join(', ')} not available`)
      sources.delete(id)
      defs.delete(id)
      changed = true
    }
  }
  return { channels: [...defs.values()], sources }
}

// ------------------------------------------------------------------ adapter

export class EnetAdapter implements VehicleAdapter {
  readonly kind: NetworkAdapterKind
  private readonly opts: EnetAdapterOptions
  private session: Session | undefined
  private stream: PollStream | undefined
  /** Largest multi-DID request size each ECU accepted, learned while streaming. */
  private readonly didsPerRequest = new Map<number, number>()

  constructor(opts: EnetAdapterOptions) {
    this.kind = opts.kind
    this.opts = opts
  }

  async connect(signal?: AbortSignal): Promise<VehicleInfo> {
    await this.disconnect()
    this.didsPerRequest.clear()
    const port = this.opts.port ?? HSFZ_DIAG_PORT
    const host = this.opts.host ?? (await this.findGateway(port, signal))
    this.log(`Connecting to ${host}:${port}`)
    const conn = await HsfzConnection.connect(host, port, {
      timeoutMs: CONNECT_TIMEOUT_MS,
      signal,
      onTraffic: this.opts.capture,
      log: (m) => this.log(m)
    })
    try {
      const session = await this.identify(conn, host, port, signal)
      conn.on('close', (err) => {
        if (this.session !== session) return
        this.session = undefined
        if (err) this.log(err.message)
      })
      this.session = session
      return session.info
    } catch (err) {
      await conn.close()
      throw err
    }
  }

  channels(): ChannelDef[] {
    return [...(this.session?.channels ?? [])]
  }

  async startStreaming(
    channelIds: string[],
    onFrame: (frame: SampleFrame) => void,
    opts: { maxRateHz?: number; onError?: (err: Error) => void } = {}
  ): Promise<StreamHandle> {
    const session = this.session
    if (!session) throw new Error('Not connected to a vehicle')
    const previous = this.stream
    this.stream = undefined
    await previous?.stop()
    const stream = await PollStream.start({
      session,
      channelIds: [...channelIds],
      onFrame,
      maxRateHz: opts.maxRateHz,
      report: (err) => (opts.onError ? opts.onError(err) : this.log(`Streaming: ${err.message}`)),
      log: (m) => this.log(m),
      didsPerRequest: this.didsPerRequest
    })
    this.stream = stream
    return {
      stop: async () => {
        if (this.stream === stream) this.stream = undefined
        await stream.stop()
      }
    }
  }

  async disconnect(): Promise<void> {
    const stream = this.stream
    this.stream = undefined
    await stream?.stop()
    const session = this.session
    this.session = undefined
    await session?.conn.close()
  }

  private log(message: string): void {
    this.opts.log?.(message)
  }

  private async findGateway(port: number, signal?: AbortSignal): Promise<string> {
    try {
      const gateways = await discoverGateways({
        port: this.opts.discoveryPort,
        targets: this.opts.discoveryTargets,
        timeoutMs: DISCOVERY_TIMEOUT_MS,
        signal,
        log: (m) => this.log(m)
      })
      const best = gateways.find((g) => g.vin) ?? gateways[0]
      if (best) {
        this.log(`Discovered gateway at ${best.host}${best.vin ? ` (VIN ${best.vin})` : ''}`)
        return best.host
      }
    } catch (err) {
      if (signal?.aborted) throw err
      this.log(`UDP discovery failed: ${describe(err)}`)
    }
    if (this.kind === 'enet') {
      throw new Error(
        'No BMW gateway answered UDP discovery. Check the ENET cable and the ignition, and that the Ethernet adapter has a 169.254.x.x address, or enter the gateway IP manually.'
      )
    }
    const hosts = candidateHosts()
    this.log(`No discovery reply; probing ${hosts.join(', ')} on TCP ${port}`)
    const results = await scanTcp(
      hosts.map((host) => ({ host, port })),
      { timeoutMs: CANDIDATE_PROBE_TIMEOUT_MS, concurrency: 8, signal }
    )
    signal?.throwIfAborted()
    const open = results.find((r) => r.open)
    if (open) return open.host
    if (this.opts.scanSubnet) {
      const others = subnetHosts().filter((h) => !hosts.includes(h))
      if (others.length) {
        this.log(`Scanning ${others.length} addresses of the local network on TCP ${port}`)
        const found = (await scanTcp(others.map((host) => ({ host, port })), { timeoutMs: SUBNET_PROBE_TIMEOUT_MS, concurrency: 32, signal })).find(
          (r) => r.open
        )
        signal?.throwIfAborted()
        if (found) return found.host
      }
    }
    throw new Error(
      `No HSFZ gateway found (no discovery reply, nothing listening on TCP ${port} at ${hosts.join(', ')}${this.opts.scanSubnet ? ' or elsewhere on the network' : ''}). Join the ${KIND_LABEL[this.kind]} adapter's WiFi network on this device or enter its IP address.`
    )
  }

  private async identify(conn: HsfzConnection, host: string, port: number, signal?: AbortSignal): Promise<Session> {
    const uds = new UdsClient(conn, { timeoutMs: this.opts.identTimeoutMs ?? IDENT_TIMEOUT_MS })
    const dme = ECU_ADDRESS.DME
    const log = (m: string): void => this.log(m)

    let vin: string | undefined
    let dmeResponding = true
    try {
      vin = await uds.readVin(dme)
    } catch (err) {
      if (isClosed(err)) throw err
      dmeResponding = !(err instanceof HsfzTimeoutError || err instanceof HsfzGatewayError)
      log(`VIN from DME ${hexByte(dme)}: ${describe(err)}`)
    }
    signal?.throwIfAborted()
    if (!vin) {
      try {
        vin = await uds.readVin(ECU_ADDRESS.ZGW)
      } catch (err) {
        if (isClosed(err)) throw err
        log(`VIN from gateway ${hexByte(ECU_ADDRESS.ZGW)}: ${describe(err)}`)
      }
    }
    if (!dmeResponding) {
      throw new Error(
        `Connected to ${host}:${port}${vin ? ` (VIN ${vin})` : ''}, but the engine ECU (DME ${hexByte(dme)}) does not respond. Switch the ignition on and try again.`
      )
    }
    signal?.throwIfAborted()
    const sgbdIndex = await readSgbdIndex(uds, dme, log)
    signal?.throwIfAborted()
    const dmeSet = this.resolveDmeData(sgbdIndex)
    const ident = await readSoftwareIdentification(uds, dme, log)
    signal?.throwIfAborted()
    const supported = await detectSupportedPids(uds, dme, log)
    signal?.throwIfAborted()

    const sets = this.opts.definitionsDir
      ? selectDefinitionSets(
          await loadDefinitionFiles(this.opts.definitionsDir, (file, errors) => log(`Definition file ${file} skipped: ${errors.join('; ')}`)),
          ident.softwareVersion
        )
      : []
    for (const set of sets) log(`Using definition set "${set.name}" (${set.channels.length} channels)`)
    const { channels, sources } = buildChannelRegistry(buildObdPlan(supported), dme, dmeSet, sets, log)

    const info: VehicleInfo = {
      vin,
      ecu: {
        address: dme,
        softwareVersion: ident.softwareVersion,
        hardwareNumber: ident.hardwareNumber,
        definitionSet: sets.length > 0 ? sets.map((s) => s.name).join(', ') : undefined,
        sgbdIndex: sgbdIndex?.hex,
        dmeData: dmeSet?.name
      },
      endpoint: `${host}:${port}`,
      label: `${KIND_LABEL[this.kind]} · ${port === HSFZ_DIAG_PORT ? host : `${host}:${port}`}`
    }
    log(`Connected via ${info.label}: VIN ${vin ?? 'unknown'}, software ${ident.softwareVersion ?? 'unknown'}, ${channels.length} channels`)
    return { conn, uds, info, channels, sources }
  }

  /** Asks the dmeData resolver for this DME's measurement set and logs the outcome. */
  private resolveDmeData(index: SgbdIndex | undefined): DmeChannelSet | undefined {
    const what = index ? `diagnostic index ${index.hex}` : 'an unreadable diagnostic index'
    const resolver = this.opts.dmeData
    if (!resolver) {
      this.log('BMW DME data: not available (no BMW data source configured)')
      return undefined
    }
    let set: DmeChannelSet | undefined
    try {
      set = resolver(index?.value)
    } catch (err) {
      this.log(`BMW DME data: lookup for ${what} failed: ${describe(err)}`)
      return undefined
    }
    if (!set) {
      this.log(`BMW DME data: none for ${what} (not imported, switched off, or no SGBD lists this index)`)
      return undefined
    }
    this.log(
      `BMW DME data: using "${set.name}" for ${what} (${set.reads.length} measurements, ` +
        `${set.reads.filter((r) => r.composable).length} composable, ${set.derived.length} derived, ECU ${hexByte(set.ecuAddress)})`
    )
    return set
  }
}

// ------------------------------------------------------------------ polling

interface StreamContext {
  session: Session
  channelIds: string[]
  onFrame: (frame: SampleFrame) => void
  maxRateHz: number | undefined
  report: (err: Error) => void
  log: (message: string) => void
  didsPerRequest: Map<number, number>
}

interface Field {
  channelId: string
  decode: Decoder
}

interface DidRead {
  target: number
  did: number
  /** Record length; undefined means the DID is always read on its own. */
  length: number | undefined
  fields: Field[]
  /** Omitted from a multi-DID response: read alone until it answers (or is disabled). */
  solo: boolean
  disabled: boolean
}

interface MemoryRead {
  target: number
  address: number
  size: number
  field: Field
  disabled: boolean
}

interface MemoryChannel {
  channelId: string
  address: number
  size: number
  decode: Decoder
}

/** A DID that may be packed into a dynamically defined DID by identifier (2C 01). */
interface ComposableDid {
  did: number
  /** Record length: the whole record becomes one entry (position 1, size = length). */
  length: number
  fields: Field[]
}

interface DerivedStep {
  channelId: string
  inputs: readonly string[]
  compute: (inputs: readonly number[]) => number
}

/**
 * End index of the dynamic-DID sized group of `items` starting at `start`: at most
 * `maxEntries` entries and MAX_DYNAMIC_DID_BYTES bytes, but always at least one item.
 */
function groupEnd<T>(items: readonly T[], start: number, size: (item: T) => number, maxEntries: number): number {
  let end = start
  let bytes = 0
  while (end < items.length && (end === start || (end - start < maxEntries && bytes + size(items[end]) <= MAX_DYNAMIC_DID_BYTES))) {
    bytes += size(items[end])
    end++
  }
  return end
}

/** Splits `items` into dynamic-DID sized groups (see groupEnd). */
function packDynamicDids<T>(items: readonly T[], size: (item: T) => number): T[][] {
  const groups: T[][] = []
  for (let start = 0; start < items.length; ) {
    const end = groupEnd(items, start, size, MAX_DYNAMIC_DID_ENTRIES)
    groups.push(items.slice(start, end))
    start = end
  }
  return groups
}

/** A whole record of `did` fits into one 2C 01 entry of a dynamic DID. */
const isComposableRecord = (did: number, length: number): boolean =>
  Number.isInteger(length) && length >= 1 && length <= MAX_DYNAMIC_DID_BYTES && !isDynamicDid(did)

class PollStream {
  private readonly ctx: StreamContext
  /** DID reads per ECU address, in first-use order. */
  private readonly didReads = new Map<number, DidRead[]>()
  private readonly memoryReads: MemoryRead[] = []
  private readonly derived: DerivedStep[] = []
  /** Dynamic DIDs defined by this stream (by memory or by identifier), cleared on stop. */
  private readonly dynamicDids: Array<{ target: number; did: number }> = []
  /** Next free dynamic DID number, shared by both kinds of definitions so they never collide. */
  private nextDynamicDid = DYNAMIC_DID_BASE
  private readonly extendedSession = new Set<number>()
  /** ECUs on which the extended session was already tried. */
  private readonly sessionTried = new Set<number>()
  private stopped = false
  private wake: (() => void) | undefined
  private done: Promise<void> = Promise.resolve()

  private constructor(ctx: StreamContext) {
    this.ctx = ctx
  }

  static async start(ctx: StreamContext): Promise<PollStream> {
    const stream = new PollStream(ctx)
    await stream.prepare()
    stream.done = stream.run()
    return stream
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.wake?.()
    await this.done
  }

  // ---------------------------------------------------------------- plan

  private async prepare(): Promise<void> {
    const { sources } = this.ctx.session
    const needed = new Set<string>()
    const unknown: string[] = []
    const visit = (id: string): void => {
      if (needed.has(id)) return
      const source = sources.get(id)
      if (!source) {
        unknown.push(id)
        return
      }
      needed.add(id)
      if (source.type === 'derived') {
        source.inputs.forEach(visit)
        this.derived.push({ channelId: id, inputs: source.inputs, compute: source.compute })
      }
    }
    this.ctx.channelIds.forEach(visit)
    if (unknown.length > 0) this.ctx.log(`Not available on this ECU (streamed as NaN): ${unknown.join(', ')}`)

    const memory = new Map<number, MemoryChannel[]>()
    const dids = new Map<string, { target: number; did: number; length: number | undefined; composable: boolean; fields: Field[] }>()
    for (const channelId of needed) {
      const source = sources.get(channelId)
      if (source?.type === 'did') {
        const field: Field = { channelId, decode: source.decode }
        const key = `${source.target}:${source.did}`
        const group = dids.get(key)
        if (!group) {
          dids.set(key, { target: source.target, did: source.did, length: source.length, composable: source.composable, fields: [field] })
        } else {
          // Composed only when every channel of the DID allows it and agrees on the length.
          group.composable &&= source.composable && source.length === group.length
          group.length ??= source.length
          group.fields.push(field)
        }
      } else if (source?.type === 'memory') {
        const list = memory.get(source.target) ?? []
        list.push({ channelId, address: source.address, size: source.size, decode: source.decode })
        memory.set(source.target, list)
      }
    }
    const composable = new Map<number, ComposableDid[]>()
    for (const g of dids.values()) {
      if (g.composable && g.length !== undefined && isComposableRecord(g.did, g.length)) {
        const list = composable.get(g.target) ?? []
        list.push({ did: g.did, length: g.length, fields: g.fields })
        composable.set(g.target, list)
      } else {
        for (const field of g.fields) this.addDidField(g.target, g.did, g.length, field)
      }
    }
    for (const [target, channels] of memory) await this.prepareMemory(target, channels)
    for (const [target, list] of composable) await this.prepareComposed(target, list)
  }

  private addDidField(target: number, did: number, length: number | undefined, field: Field): void {
    let reads = this.didReads.get(target)
    if (!reads) {
      reads = []
      this.didReads.set(target, reads)
    }
    let read = reads.find((r) => r.did === did)
    if (!read) {
      read = { target, did, length, fields: [], solo: false, disabled: false }
      reads.push(read)
    }
    read.length ??= length
    read.fields.push(field)
  }

  /** Polls a defined dynamic DID like any DID; each part's fields decode their slice of the record. */
  private addDynamicDidFields(target: number, did: number, parts: ReadonlyArray<{ size: number; fields: readonly Field[] }>): void {
    const total = parts.reduce((sum, p) => sum + p.size, 0)
    let offset = 0
    for (const part of parts) {
      const start = offset
      const end = (offset += part.size)
      for (const f of part.fields) {
        this.addDidField(target, did, total, { channelId: f.channelId, decode: (data) => f.decode(data.subarray(start, end)) })
      }
    }
  }

  private async prepareMemory(target: number, channels: readonly MemoryChannel[]): Promise<void> {
    const { uds } = this.ctx.session
    for (const chunk of packDynamicDids(channels, (c) => c.size)) {
      const result = await this.defineDynamicDid(target, (did) =>
        uds.defineDidByMemory(target, did, chunk.map((c) => ({ address: c.address, size: c.size })))
      )
      const names = chunk.map((c) => c.channelId).join(', ')
      if (!(result instanceof Error)) {
        this.addDynamicDidFields(target, result, chunk.map((c) => ({ size: c.size, fields: [{ channelId: c.channelId, decode: c.decode }] })))
        this.ctx.log(`RAM channels ${names} on ECU ${hexByte(target)} mapped to dynamic DID ${hexWord(result)}`)
      } else {
        this.ctx.log(`Dynamic DID for ${names} refused by ECU ${hexByte(target)} (${result.message}); reading them with ReadMemoryByAddress`)
        for (const c of chunk) {
          this.memoryReads.push({ target, address: c.address, size: c.size, field: { channelId: c.channelId, decode: c.decode }, disabled: false })
        }
      }
    }
  }

  /**
   * Packs composable DIDs into dynamic DIDs by identifier (2C 01). A definition rejected
   * with 0x13 / 0x14 / 0x31 (too big, or a source DID the ECU will not compose) is retried
   * as two halves; when both halves work, their entry count becomes this ECU's limit. Any
   * other refusal, or MAX_COMPOSE_FAILURES failed definitions, stops composing. Everything
   * not composed (including single leftovers: a one-entry dynamic DID gains nothing) is
   * read as plain DIDs. Logs at most one success and one fallback line per ECU.
   */
  private async prepareComposed(target: number, dids: readonly ComposableDid[]): Promise<void> {
    const { uds } = this.ctx.session
    const plain: ComposableDid[] = []
    const defined: number[] = []
    let composed = 0
    let maxEntries = MAX_DYNAMIC_DID_ENTRIES
    let failures = 0
    let firstFailure: Error | undefined
    let refusal: Error | undefined

    /** True when every DID of `chunk` ended up in a dynamic DID. */
    const compose = async (chunk: readonly ComposableDid[]): Promise<boolean> => {
      if (chunk.length < 2 || refusal) {
        plain.push(...chunk)
        return false
      }
      const result = await this.defineDynamicDid(target, (did) =>
        uds.defineDidByIdentifier(target, did, chunk.map((c) => ({ sourceDid: c.did, position: 1, size: c.length })))
      )
      if (!(result instanceof Error)) {
        this.addDynamicDidFields(target, result, chunk.map((c) => ({ size: c.length, fields: c.fields })))
        defined.push(result)
        composed += chunk.length
        return true
      }
      firstFailure ??= result
      if (++failures >= MAX_COMPOSE_FAILURES) refusal = new Error(`${failures} definitions failed, the last with: ${result.message}`)
      else if (!hasNrc(result, BATCH_REJECTION_NRCS)) refusal = result
      if (refusal) {
        plain.push(...chunk)
        return false
      }
      const half = Math.ceil(chunk.length / 2)
      const first = await compose(chunk.slice(0, half))
      const second = await compose(chunk.slice(half))
      // Both halves worked: the definition was too big for this ECU, not a bad source DID.
      if (first && second && half < maxEntries) maxEntries = half
      return first && second
    }

    for (let start = 0; start < dids.length; ) {
      const end = groupEnd(dids, start, (d) => d.length, maxEntries)
      await compose(dids.slice(start, end))
      start = end
    }
    for (const d of plain) for (const field of d.fields) this.addDidField(target, d.did, d.length, field)

    const ecu = `ECU ${hexByte(target)}`
    if (defined.length > 0) {
      const range = defined.length === 1 ? hexWord(defined[0]) : `${hexWord(defined[0])}..${hexWord(defined[defined.length - 1])}`
      const limit = maxEntries < MAX_DYNAMIC_DID_ENTRIES ? `; at most ${maxEntries} entries per dynamic DID` : ''
      this.ctx.log(`${ecu}: ${composed} DIDs composed into ${defined.length} dynamic DID(s) ${range} (2C 01)${limit}`)
    }
    const reason = refusal ?? firstFailure
    if (reason && plain.length > 0) {
      this.ctx.log(
        `${ecu}: ${plain.length} DID(s) read individually instead of composed (${reason.message}): ${plain.map((d) => hexWord(d.did)).join(', ')}`
      )
    }
  }

  /**
   * Clears and defines the next free dynamic DID on `target` with `define`, and registers
   * it for cleanup. A refusal with 0x7E / 0x7F is retried once in the extended session, but
   * only before anything is defined on that ECU (a session change clears definitions).
   * Returns the DID, or the failure.
   */
  private async defineDynamicDid(target: number, define: (did: number) => Promise<void>): Promise<number | Error> {
    const did = this.nextDynamicDid
    if (did > DYNAMIC_DID_LAST) return new Error(`all dynamic DIDs ${hexWord(DYNAMIC_DID_BASE)}..${hexWord(DYNAMIC_DID_LAST)} in use`)
    let error = await this.clearAndDefine(target, did, define)
    if (
      error &&
      hasNrc(error, SESSION_NRCS) &&
      !this.sessionTried.has(target) &&
      !this.dynamicDids.some((d) => d.target === target) &&
      (await this.enterExtendedSession(target))
    ) {
      error = await this.clearAndDefine(target, did, define)
    }
    if (error) return error
    this.nextDynamicDid = did + 1
    this.dynamicDids.push({ target, did })
    return did
  }

  /** Clears, then defines a dynamic DID. Returns the failure, or undefined on success. */
  private async clearAndDefine(target: number, did: number, define: (did: number) => Promise<void>): Promise<Error | undefined> {
    try {
      await this.ctx.session.uds.clearDynamicDid(target, did)
    } catch (err) {
      // A DID that was never defined may be refused here; only the define below matters.
      if (isClosed(err)) throw err
    }
    try {
      await define(did)
      return undefined
    } catch (err) {
      if (isClosed(err)) throw err
      return toError(err)
    }
  }

  private async enterExtendedSession(target: number): Promise<boolean> {
    this.sessionTried.add(target)
    try {
      await this.ctx.session.uds.sessionControl(target, DiagnosticSession.Extended)
    } catch (err) {
      if (isClosed(err)) throw err
      this.ctx.log(`Extended diagnostic session refused by ECU ${hexByte(target)}: ${describe(err)}`)
      return false
    }
    this.extendedSession.add(target)
    this.ctx.log(`ECU ${hexByte(target)} switched to the extended diagnostic session for dynamic DIDs`)
    return true
  }

  // ---------------------------------------------------------------- loop

  private activeReads(): number {
    let n = this.memoryReads.filter((r) => !r.disabled).length
    for (const reads of this.didReads.values()) n += reads.filter((r) => !r.disabled).length
    return n
  }

  private async run(): Promise<void> {
    const { session, channelIds, onFrame, report, maxRateHz } = this.ctx
    const t0 = performance.now()
    const ratePeriodMs = maxRateHz !== undefined && maxRateHz > 0 ? 1000 / maxRateHz : 0
    let lastTesterPresent = t0
    const values = new Map<string, number>()
    try {
      while (!this.stopped) {
        if (!session.conn.isOpen) throw new HsfzConnectionClosedError('connection closed')
        const start = performance.now()
        values.clear()
        for (const [target, reads] of this.didReads) await this.pollDids(target, reads, values)
        for (const read of this.memoryReads) await this.pollMemory(read, values)
        for (const step of this.derived) {
          values.set(step.channelId, step.compute(step.inputs.map((id) => values.get(id) ?? NaN)))
        }
        const end = performance.now()
        try {
          onFrame({ t: ((start + end) / 2 - t0) / 1000, values: channelIds.map((id) => values.get(id) ?? NaN) })
        } catch (err) {
          report(toError(err))
        }
        if (this.extendedSession.size > 0 && end - lastTesterPresent >= TESTER_PRESENT_INTERVAL_MS) {
          lastTesterPresent = end
          await this.keepSessionsAlive()
        }
        const period = Math.max(ratePeriodMs, this.activeReads() === 0 ? IDLE_PERIOD_MS : 0)
        const wait = period - (performance.now() - start)
        if (wait > 0 && !this.stopped) await this.sleep(wait)
      }
    } catch (err) {
      if (!this.stopped) report(isClosed(err) ? new Error(`Connection to the vehicle lost: ${describe(err)}`) : toError(err))
    } finally {
      await this.cleanup()
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.wake = undefined
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.wake = done
    })
  }

  private async pollDids(target: number, reads: readonly DidRead[], values: Map<string, number>): Promise<void> {
    const active = reads.filter((r) => !r.disabled)
    const batchable = active.filter((r) => r.length !== undefined && !r.solo)
    const size = this.ctx.didsPerRequest.get(target) ?? INITIAL_DIDS_PER_REQUEST
    for (let i = 0; i < batchable.length; i += size) await this.readBatch(target, batchable.slice(i, i + size), values)
    for (const read of active) if (read.length === undefined || read.solo) await this.readBatch(target, [read], values)
  }

  private async readBatch(target: number, batch: DidRead[], values: Map<string, number>): Promise<void> {
    const lengths = new Map<number, number>()
    for (const r of batch) if (r.length !== undefined) lengths.set(r.did, r.length)
    try {
      const response = await this.ctx.session.uds.readDataByIdentifier(
        target,
        batch.map((r) => r.did),
        lengths,
        { timeoutMs: POLL_TIMEOUT_MS }
      )
      for (const read of batch) {
        const data = response.get(read.did)
        // ISO 14229 lets the ECU skip unsupported DIDs in a multi-DID response; reading
        // the DID alone next pass either brings it back or gets it disabled.
        read.solo = !data
        if (!data) continue
        if (batch.length === 1 && read.length !== undefined && data.length !== read.length) {
          this.ctx.log(`DID ${hexWord(read.did)} on ECU ${hexByte(target)} has ${data.length} bytes, not ${read.length}; adjusted`)
          read.length = data.length
        }
        for (const field of read.fields) values.set(field.channelId, field.decode(data))
      }
    } catch (err) {
      if (isClosed(err)) throw err
      if (batch.length > 1 && (hasNrc(err, BATCH_REJECTION_NRCS) || err instanceof UdsProtocolError)) {
        const half = Math.ceil(batch.length / 2)
        await this.readBatch(target, batch.slice(0, half), values)
        await this.readBatch(target, batch.slice(half), values)
        // If a single DID was the culprit it is disabled now; otherwise the size was the problem.
        const current = this.ctx.didsPerRequest.get(target) ?? INITIAL_DIDS_PER_REQUEST
        if (!batch.some((r) => r.disabled) && half < current) {
          this.ctx.didsPerRequest.set(target, half)
          this.ctx.log(`ECU ${hexByte(target)} rejected ${batch.length} DIDs per request (${describe(err)}); now using ${half}`)
        }
        return
      }
      if (batch.length === 1 && hasNrc(err, PERMANENT_NRCS)) {
        const read = batch[0]
        read.disabled = true
        this.ctx.report(
          new Error(`DID ${hexWord(read.did)} on ECU ${hexByte(target)} unavailable (${describe(err)}); not polling ${read.fields.map((f) => f.channelId).join(', ')}`)
        )
        return
      }
      this.ctx.report(toError(err))
    }
  }

  private async pollMemory(read: MemoryRead, values: Map<string, number>): Promise<void> {
    if (read.disabled) return
    try {
      const data = await this.ctx.session.uds.readMemoryByAddress(read.target, read.address, read.size, 4, 1, { timeoutMs: POLL_TIMEOUT_MS })
      values.set(read.field.channelId, read.field.decode(data))
    } catch (err) {
      if (isClosed(err)) throw err
      if (hasNrc(err, PERMANENT_NRCS)) {
        read.disabled = true
        this.ctx.report(
          new Error(`RAM ${hexAddress(read.address)} on ECU ${hexByte(read.target)} unavailable (${describe(err)}); not polling ${read.field.channelId}`)
        )
        return
      }
      this.ctx.report(toError(err))
    }
  }

  private async keepSessionsAlive(): Promise<void> {
    for (const target of this.extendedSession) {
      try {
        await this.ctx.session.uds.testerPresent(target)
      } catch (err) {
        if (isClosed(err)) throw err
        this.ctx.report(toError(err))
      }
    }
  }

  /** Best effort: drop dynamic DIDs and return to the default session. */
  private async cleanup(): Promise<void> {
    const { conn, uds } = this.ctx.session
    if (!conn.isOpen) return
    const opts = { timeoutMs: CLEANUP_TIMEOUT_MS }
    for (const { target, did } of this.dynamicDids) {
      try {
        await uds.clearDynamicDid(target, did, opts)
      } catch (err) {
        this.ctx.log(`Clearing dynamic DID ${hexWord(did)} on ECU ${hexByte(target)}: ${describe(err)}`)
      }
    }
    for (const target of this.extendedSession) {
      try {
        await uds.sessionControl(target, DiagnosticSession.Default, opts)
      } catch (err) {
        this.ctx.log(`Returning ECU ${hexByte(target)} to the default session: ${describe(err)}`)
      }
    }
  }
}
