// In-process fake of a BMW HSFZ gateway (ZGW 0x10) with an engine DME (0x12) behind it.
//
// TCP (HSFZ, ephemeral port on 127.0.0.1): ACK echoes, F190 VIN on both ECUs; the DME adds
// SVK F101, the diagnostic index F150, supported-PID bitmasks F400.., live OBD DIDs F4xx and
// a few BMW-style DIDs (FAKE_DME_DID; invented numbers and scalings, not BMW data) driven by
// a small engine model, multi-DID reads (NRC 0x13 above a configurable count), extra static
// DIDs, emulated RAM via 0x23, dynamic DIDs (2C 01 by identifier, 2C 02 by memory, 2C 03
// clear; optional entry limit, sub-function 01 can be switched off), sessions, tester
// present, optional response-pending (0x78), alive checks and HSFZ error 0x0043 for unknown
// targets.
// UDP (optional, 127.0.0.1): answers vehicle identification requests.
import dgram from 'node:dgram'
import net from 'node:net'
import { HsfzControl, HsfzFrameReader, encodeDiagnosticFrame, encodeFrame } from '../src/core/vehicle/hsfz'

export const FAKE_VIN = 'WBATEST0000000001'
export const FAKE_MAC = '001A37C0FFEE'
const ZGW = 0x10
const DME = 0x12

/** Supported by default: 04 05 0B 0C 0D 0F 11 33 34 42 46 49 5C 62 63. */
export const DEFAULT_PIDS = [0x04, 0x05, 0x0b, 0x0c, 0x0d, 0x0f, 0x11, 0x33, 0x34, 0x42, 0x46, 0x49, 0x5c, 0x62, 0x63]

/** SVK: header, 13-byte fingerprint, HWEL / BTLD / SWFL entries. */
export const FAKE_SVK = Buffer.from([
  0x01, 0x01, 0x00, 0x03,
  ...new Array<number>(13).fill(0),
  0x01, 0x00, 0x00, 0x12, 0x34, 1, 2, 3,
  0x06, 0x00, 0x00, 0x1f, 0x2e, 2, 3, 4,
  0x08, 0x00, 0x00, 0x2a, 0x6f, 5, 100, 10
])
export const FAKE_SOFTWARE = 'BTLD_00001F2E_002_003_004 SWFL_00002A6F_005_100_010'

/** Default F150 record (diagnostic index 0x0F2426). */
export const FAKE_SGBD_INDEX = Buffer.from([0x0f, 0x24, 0x26])

/**
 * Made-up BMW-style DME DIDs. The numbers and scalings are invented for tests; they are not
 * taken from BMW data. Encodings:
 *   rpm       u16 BE, 0.5 rpm per bit           (1500..5500 rpm)
 *   map       u16 BE, hPa absolute              (1000..2500 hPa)
 *   iat       u8, °C + 48                       (35 °C)
 *   baro      u16 BE, hPa                       (1000 hPa)
 *   ignition  s16 BE, 0.01 ° crank              (25 .. 5 °)
 *   lambda    u16 LE, 1/4096                    (1.0 .. 0.8)
 *   rail      u32 BE, 0.1 kPa                   (5 .. 20 MPa)
 */
export const FAKE_DME_DID = {
  rpm: 0x4a10,
  map: 0x4b22,
  iat: 0x4c05,
  baro: 0x4d31,
  ignition: 0x5a31,
  lambda: 0x5b47,
  rail: 0x5e02
} as const

/** Record length of each FAKE_DME_DID. */
export const FAKE_DME_DID_LENGTH: Readonly<Record<number, number>> = {
  [FAKE_DME_DID.rpm]: 2,
  [FAKE_DME_DID.map]: 2,
  [FAKE_DME_DID.iat]: 1,
  [FAKE_DME_DID.baro]: 2,
  [FAKE_DME_DID.ignition]: 2,
  [FAKE_DME_DID.lambda]: 2,
  [FAKE_DME_DID.rail]: 4
}

export interface FakeGatewayOptions {
  vin?: string
  /** false: the DME stays silent (ignition off); the gateway still ACKs. */
  dmeOnline?: boolean
  /** Max DIDs per 0x22 request before NRC 0x13 (default 8). */
  maxDidsPerRequest?: number
  /** Every Nth response is preceded by 7F xx 78 and delayed (0 = never). */
  pendingEvery?: number
  pendingDelayMs?: number
  /** Send ACK echo frames (default true). */
  ack?: boolean
  /** How frames hit the socket: one write each, ACK+response in one write, or 3-byte pieces. */
  writeMode?: 'separate' | 'coalesced' | 'fragmented'
  /** Send an alive check to every client at this interval (0 = never). */
  aliveCheckIntervalMs?: number
  supportedPids?: number[]
  /** false: bitmask DIDs F400.. answer NRC 0x31. */
  supportedPidMasks?: boolean
  svk?: Buffer
  /** Extra static DME DIDs. */
  dids?: Record<number, Buffer>
  /** Emulated DME RAM; undefined = 0x23 not supported. */
  memory?: (address: number, size: number) => Buffer | undefined
  /** Dynamic DID support: in any session (default), extended session only, or none (NRC 0x11). */
  dynamicDids?: 'default' | 'extended' | 'none'
  /** false: define by identifier (2C 01) answers NRC 0x12; by memory still works. */
  defineByIdentifier?: boolean
  /** Entries a dynamic DID may hold; more answer NRC 0x31 (default unlimited). */
  maxDynamicDidEntries?: number
  /** Source DIDs that 2C 01 refuses with NRC 0x31. */
  nonComposableDids?: number[]
  /** DME DIDs this ECU doesn't have: reads answer NRC 0x31 (or skip them) and 2C 01 refuses them. */
  missingDids?: number[]
  /** F150 record; null: F150 is not supported (default FAKE_SGBD_INDEX). */
  sgbdIndex?: Buffer | null
  /** Start the UDP identification responder. */
  udp?: boolean
}

export interface FakeRequest {
  target: number
  uds: Buffer
}

type DynamicEntry =
  | { kind: 'memory'; address: number; size: number }
  | { kind: 'did'; sourceDid: number; position: number; size: number }

interface Client {
  socket: net.Socket
  reader: HsfzFrameReader
  session: number
  dynamic: Map<number, DynamicEntry[]>
  responses: number
  inFlight: number
}

const u16 = (v: number): number[] => [(v >> 8) & 0xff, v & 0xff]
const clampByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v)))
const clampWord = (v: number): number => Math.max(0, Math.min(0xffff, Math.round(v)))

export class FakeGateway {
  readonly requests: FakeRequest[] = []
  aliveReplies = 0
  maxInFlight = 0
  testerPresentCount = 0

  private readonly opts: FakeGatewayOptions
  private readonly server: net.Server
  private readonly clients = new Set<Client>()
  private readonly supported: Set<number>
  private readonly startedAt = Date.now()
  private udp: dgram.Socket | undefined
  private aliveTimer: ReturnType<typeof setInterval> | undefined

  private constructor(opts: FakeGatewayOptions) {
    this.opts = opts
    this.supported = new Set(opts.supportedPids ?? DEFAULT_PIDS)
    this.server = net.createServer((socket) => this.accept(socket))
  }

  static async start(opts: FakeGatewayOptions = {}): Promise<FakeGateway> {
    const gw = new FakeGateway(opts)
    await new Promise<void>((resolve) => gw.server.listen(0, '127.0.0.1', resolve))
    if (opts.udp) {
      const udp = dgram.createSocket('udp4')
      udp.on('message', (msg, rinfo) => {
        if (msg.length < 6 || msg.readUInt16BE(4) !== HsfzControl.VehicleIdent) return
        const ident = Buffer.from(`DIAGADR10BMWMAC${FAKE_MAC}BMWVIN${gw.vin}`, 'latin1')
        udp.send(encodeFrame(HsfzControl.VehicleIdent, ident), rinfo.port, rinfo.address)
      })
      await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve))
      gw.udp = udp
    }
    if (opts.aliveCheckIntervalMs) {
      gw.aliveTimer = setInterval(() => {
        for (const c of gw.clients) c.socket.write(encodeFrame(HsfzControl.AliveCheck))
      }, opts.aliveCheckIntervalMs)
    }
    return gw
  }

  get port(): number {
    return (this.server.address() as net.AddressInfo).port
  }

  get udpPort(): number {
    if (!this.udp) throw new Error('UDP responder not started')
    return this.udp.address().port
  }

  get vin(): string {
    return this.opts.vin ?? FAKE_VIN
  }

  /** 0x22 requests seen, as DID lists. */
  didRequests(): number[][] {
    return this.requests
      .filter((r) => r.uds[0] === 0x22)
      .map((r) => Array.from({ length: (r.uds.length - 1) / 2 }, (_, i) => r.uds.readUInt16BE(1 + 2 * i)))
  }

  /** Dynamic DIDs currently defined on the DME (over all connections). */
  definedDynamicDids(): number[] {
    return [...new Set([...this.clients].flatMap((c) => [...c.dynamic.keys()]))].sort((a, b) => a - b)
  }

  /** Kills every client connection (socket death). */
  dropConnections(): void {
    for (const c of this.clients) c.socket.destroy()
  }

  async close(): Promise<void> {
    clearInterval(this.aliveTimer)
    this.dropConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    if (this.udp) await new Promise<void>((resolve) => this.udp?.close(() => resolve()))
  }

  // ---------------------------------------------------------------- TCP

  private accept(socket: net.Socket): void {
    socket.setNoDelay(true)
    const client: Client = { socket, reader: new HsfzFrameReader(), session: 1, dynamic: new Map(), responses: 0, inFlight: 0 }
    this.clients.add(client)
    socket.on('close', () => this.clients.delete(client))
    socket.on('error', () => undefined)
    socket.on('data', (chunk) => {
      for (const frame of client.reader.push(chunk)) {
        if (frame.control === HsfzControl.AliveCheck) this.aliveReplies++
        else if (frame.control === HsfzControl.Diagnostic && frame.payload.length >= 3) {
          this.handle(client, frame.payload[0], frame.payload[1], frame.payload.subarray(2))
        }
      }
    })
  }

  private send(client: Client, frames: Buffer[]): void {
    if (client.socket.destroyed || frames.length === 0) return
    const mode = this.opts.writeMode ?? 'separate'
    if (mode === 'separate') {
      for (const f of frames) client.socket.write(f)
      return
    }
    const all = Buffer.concat(frames)
    if (mode === 'coalesced') client.socket.write(all)
    else for (let i = 0; i < all.length; i += 3) client.socket.write(all.subarray(i, i + 3))
  }

  private handle(client: Client, source: number, target: number, uds: Buffer): void {
    this.requests.push({ target, uds: Buffer.from(uds) })
    const frames: Buffer[] = []
    if (this.opts.ack !== false) frames.push(encodeFrame(HsfzControl.Ack, Buffer.concat([Buffer.from([source, target]), uds])))
    if (target !== ZGW && target !== DME) {
      frames.push(encodeFrame(0x0043, Buffer.from([source, target])))
      this.send(client, frames)
      return
    }
    const response = target === DME && this.opts.dmeOnline === false ? undefined : this.respond(client, target, uds)
    if (!response) {
      this.send(client, frames)
      return
    }
    const reply = encodeDiagnosticFrame(target, source, response)
    client.responses++
    client.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, client.inFlight)
    const every = this.opts.pendingEvery ?? 0
    if (every > 0 && client.responses % every === 0) {
      frames.push(encodeDiagnosticFrame(target, source, Buffer.from([0x7f, uds[0], 0x78])))
      this.send(client, frames)
      setTimeout(() => {
        client.inFlight--
        this.send(client, [reply])
      }, this.opts.pendingDelayMs ?? 20)
      return
    }
    client.inFlight--
    this.send(client, [...frames, reply])
  }

  private respond(client: Client, target: number, uds: Buffer): Buffer | undefined {
    const sid = uds[0]
    const nrc = (code: number): Buffer => Buffer.from([0x7f, sid, code])
    switch (sid) {
      case 0x10: {
        const session = uds[1] & 0x7f
        if (uds.length !== 2 || (session !== 0x01 && session !== 0x03)) return nrc(0x12)
        if (session !== client.session) client.dynamic.clear()
        client.session = session
        return Buffer.from([0x50, session, 0x00, 0x32, 0x01, 0xf4])
      }
      case 0x3e:
        this.testerPresentCount++
        return uds[1] & 0x80 ? undefined : Buffer.from([0x7e, 0x00])
      case 0x22: {
        if (uds.length < 3 || (uds.length - 1) % 2 !== 0) return nrc(0x13)
        const count = (uds.length - 1) / 2
        if (count > (this.opts.maxDidsPerRequest ?? 8)) return nrc(0x13)
        const parts: Buffer[] = [Buffer.from([0x62])]
        for (let i = 0; i < count; i++) {
          const did = uds.readUInt16BE(1 + 2 * i)
          const data = this.readDid(client, target, did)
          if (data) parts.push(Buffer.from(u16(did)), data)
        }
        return parts.length > 1 ? Buffer.concat(parts) : nrc(0x31)
      }
      case 0x23: {
        if (target !== DME || !this.opts.memory) return nrc(0x11)
        const addrLen = uds[1] & 0x0f
        const sizeLen = uds[1] >> 4
        if (uds.length !== 2 + addrLen + sizeLen) return nrc(0x13)
        const data = this.opts.memory(uds.readUIntBE(2, addrLen), uds.readUIntBE(2 + addrLen, sizeLen))
        return data ? Buffer.concat([Buffer.from([0x63]), data]) : nrc(0x31)
      }
      case 0x2c:
        return this.dynamicDid(client, target, uds)
      default:
        return nrc(0x11)
    }
  }

  private dynamicDid(client: Client, target: number, uds: Buffer): Buffer {
    const nrc = (code: number): Buffer => Buffer.from([0x7f, 0x2c, code])
    const mode = this.opts.dynamicDids ?? 'default'
    if (target !== DME || mode === 'none') return nrc(0x11)
    if (mode === 'extended' && client.session !== 0x03) return nrc(0x7f)
    if (uds.length < 4) return nrc(0x13)
    const sub = uds[1]
    const did = uds.readUInt16BE(2)
    if (did < 0xf200 || did > 0xf3ff) return nrc(0x31)
    if (sub === 0x03) {
      client.dynamic.delete(did)
      return Buffer.from([0x6c, 0x03, ...u16(did)])
    }
    const entries: DynamicEntry[] = []
    if (sub === 0x01) {
      if (this.opts.defineByIdentifier === false) return nrc(0x12)
      if (uds.length < 8 || (uds.length - 4) % 4 !== 0) return nrc(0x13)
      for (let pos = 4; pos < uds.length; pos += 4) {
        const entry = { kind: 'did' as const, sourceDid: uds.readUInt16BE(pos), position: uds[pos + 2], size: uds[pos + 3] }
        const isDynamic = entry.sourceDid >= 0xf200 && entry.sourceDid <= 0xf3ff
        const record = isDynamic ? undefined : this.readDid(client, target, entry.sourceDid)
        if (
          !record ||
          this.opts.nonComposableDids?.includes(entry.sourceDid) ||
          entry.position < 1 ||
          entry.size < 1 ||
          entry.position - 1 + entry.size > record.length
        ) {
          return nrc(0x31)
        }
        entries.push(entry)
      }
    } else if (sub === 0x02) {
      if (uds.length < 5) return nrc(0x13)
      const addrLen = uds[4] & 0x0f
      const sizeLen = uds[4] >> 4
      for (let pos = 5; pos < uds.length; pos += addrLen + sizeLen) {
        if (pos + addrLen + sizeLen > uds.length) return nrc(0x13)
        const entry = { kind: 'memory' as const, address: uds.readUIntBE(pos, addrLen), size: uds.readUIntBE(pos + addrLen, sizeLen) }
        if (!this.opts.memory?.(entry.address, entry.size)) return nrc(0x31)
        entries.push(entry)
      }
    } else {
      return nrc(0x12)
    }
    // Definitions append to an existing dynamic DID.
    const all = [...(client.dynamic.get(did) ?? []), ...entries]
    if (all.length > (this.opts.maxDynamicDidEntries ?? Infinity)) return nrc(0x31)
    client.dynamic.set(did, all)
    return Buffer.from([0x6c, sub, ...u16(did)])
  }

  private readDid(client: Client, target: number, did: number): Buffer | undefined {
    if (did === 0xf190) return Buffer.from(this.vin, 'latin1')
    if (target !== DME || this.opts.missingDids?.includes(did)) return undefined
    if (did === 0xf101) return this.opts.svk ?? FAKE_SVK
    if (did === 0xf150) return this.opts.sgbdIndex === null ? undefined : (this.opts.sgbdIndex ?? FAKE_SGBD_INDEX)
    if (did >= 0xf400 && did <= 0xf4ff) {
      const pid = did - 0xf400
      if (pid % 0x20 === 0) return this.opts.supportedPidMasks === false ? undefined : this.mask(pid)
      return this.supported.has(pid) ? this.pidData(pid) : undefined
    }
    const dynamic = client.dynamic.get(did)
    if (dynamic) {
      const blocks = dynamic.map((e) =>
        e.kind === 'memory'
          ? this.opts.memory?.(e.address, e.size)
          : this.readDid(client, target, e.sourceDid)?.subarray(e.position - 1, e.position - 1 + e.size)
      )
      return blocks.every((b) => b !== undefined) ? Buffer.concat(blocks as Buffer[]) : undefined
    }
    return this.opts.dids?.[did] ?? this.dmeData(did)
  }

  private mask(base: number): Buffer {
    const out = Buffer.alloc(4)
    for (const pid of this.supported) {
      if (pid <= base || pid > base + 0x20) continue
      const bit = pid - base - 1
      out[bit >> 3] |= 0x80 >> (bit & 7)
    }
    if ([...this.supported].some((p) => p > base + 0x20)) out[3] |= 0x01
    return out
  }

  /** Engine model: a slow sine sweep through the rev range. */
  private engine(): { phase: number; rpm: number } {
    const t = (Date.now() - this.startedAt) / 1000
    const phase = (Math.sin(t * 2) + 1) / 2 // 0..1
    return { phase, rpm: 1500 + 4000 * phase }
  }

  /** FAKE_DME_DID records (invented encodings, see FAKE_DME_DID). */
  private dmeData(did: number): Buffer | undefined {
    const { phase, rpm } = this.engine()
    const out = Buffer.alloc(FAKE_DME_DID_LENGTH[did] ?? 0)
    switch (did) {
      case FAKE_DME_DID.rpm: out.writeUInt16BE(clampWord(rpm * 2)); break
      case FAKE_DME_DID.map: out.writeUInt16BE(clampWord(1000 + 1500 * phase)); break
      case FAKE_DME_DID.iat: out.writeUInt8(35 + 48); break
      case FAKE_DME_DID.baro: out.writeUInt16BE(1000); break
      case FAKE_DME_DID.ignition: out.writeInt16BE(Math.round((25 - 20 * phase) * 100)); break
      case FAKE_DME_DID.lambda: out.writeUInt16LE(clampWord((1 - 0.2 * phase) * 4096)); break
      case FAKE_DME_DID.rail: out.writeUInt32BE(Math.round((5 + 15 * phase) * 10_000)); break
      default: return undefined
    }
    return out
  }

  private pidData(pid: number): Buffer | undefined {
    const { phase, rpm } = this.engine()
    switch (pid) {
      case 0x04: return Buffer.from([clampByte(((20 + 70 * phase) * 255) / 100)])
      case 0x05: return Buffer.from([90 + 40])
      case 0x0b: return Buffer.from([clampByte(100 + 140 * phase)])
      case 0x0c: return Buffer.from(u16(clampWord(rpm * 4)))
      case 0x0d: return Buffer.from([clampByte(60 + 80 * phase)])
      case 0x0f: return Buffer.from([35 + 40])
      case 0x11: return Buffer.from([clampByte(((10 + 80 * phase) * 255) / 100)])
      case 0x33: return Buffer.from([100])
      case 0x34: return Buffer.from([...u16(clampWord(((1 - 0.2 * phase) * 65536) / 2)), 0x80, 0x00])
      case 0x42: return Buffer.from(u16(14200))
      case 0x46: return Buffer.from([20 + 40])
      case 0x49: return Buffer.from([clampByte(((15 + 70 * phase) * 255) / 100)])
      case 0x5c: return Buffer.from([105 + 40])
      case 0x62: return Buffer.from([clampByte(125 + 20 + 70 * phase)])
      case 0x63: return Buffer.from(u16(600))
      default: return undefined
    }
  }
}
