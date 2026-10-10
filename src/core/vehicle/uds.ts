/**
 * UDS (ISO 14229-1) client restricted to read-only services.
 *
 * SAFETY: every request passes assertUdsAllowed() before it reaches the transport. Only
 * these services can ever be sent:
 *
 *   0x10 DiagnosticSessionControl   default (0x01) and extended (0x03) sessions only;
 *                                   never programming (0x02) or vendor sessions
 *   0x19 ReadDTCInformation         read only
 *   0x22 ReadDataByIdentifier
 *   0x23 ReadMemoryByAddress
 *   0x2C DynamicallyDefineDataIdentifier  sub-functions 01 (by identifier), 02 (by memory
 *                                   address) and 03 (clear), only for the dynamic DID range
 *                                   0xF200..0xF3FF; these definitions live in ECU RAM and
 *                                   vanish on session change or reset (used for fast block
 *                                   reads of several DIDs or RAM cells with one 0x22)
 *   0x3E TesterPresent
 *
 * Anything else (writes, routines, resets, security access, downloads, communication or
 * DTC control) throws UdsSafetyError without touching the wire.
 *
 * The client is transport agnostic (UdsTransport); HsfzConnection implements it.
 */

export interface UdsRequestOptions {
  timeoutMs?: number
  /** false for suppressed-positive-response requests (sub-function bit 7 set). */
  expectResponse?: boolean
  /** Rejects stale positive responses (see HsfzRequestOptions.accept). */
  accept?: (response: Buffer) => boolean
}

export interface UdsTransport {
  /** Sends `data` to ECU `target`; resolves with the raw UDS response (may be a 7F negative response). */
  request(target: number, data: Buffer, opts?: UdsRequestOptions): Promise<Buffer>
}

export const UdsService = {
  DiagnosticSessionControl: 0x10,
  ReadDtcInformation: 0x19,
  ReadDataByIdentifier: 0x22,
  ReadMemoryByAddress: 0x23,
  DynamicallyDefineDataIdentifier: 0x2c,
  TesterPresent: 0x3e
} as const

export const DiagnosticSession = { Default: 0x01, Extended: 0x03 } as const
export type AllowedSession = (typeof DiagnosticSession)[keyof typeof DiagnosticSession]

export const DID_VIN = 0xf190
/** Dynamically defined DIDs (ISO 14229-1 Annex C). */
export const DYNAMIC_DID_FIRST = 0xf200
export const DYNAMIC_DID_LAST = 0xf3ff

export const isDynamicDid = (did: number): boolean => did >= DYNAMIC_DID_FIRST && did <= DYNAMIC_DID_LAST

const NRC_NAMES: Readonly<Record<number, string>> = {
  0x10: 'generalReject',
  0x11: 'serviceNotSupported',
  0x12: 'subFunctionNotSupported',
  0x13: 'incorrectMessageLengthOrInvalidFormat',
  0x14: 'responseTooLong',
  0x21: 'busyRepeatRequest',
  0x22: 'conditionsNotCorrect',
  0x24: 'requestSequenceError',
  0x25: 'noResponseFromSubnetComponent',
  0x26: 'failurePreventsExecutionOfRequestedAction',
  0x31: 'requestOutOfRange',
  0x33: 'securityAccessDenied',
  0x35: 'invalidKey',
  0x36: 'exceededNumberOfAttempts',
  0x37: 'requiredTimeDelayNotExpired',
  0x70: 'uploadDownloadNotAccepted',
  0x72: 'generalProgrammingFailure',
  0x78: 'requestCorrectlyReceivedResponsePending',
  0x7e: 'subFunctionNotSupportedInActiveSession',
  0x7f: 'serviceNotSupportedInActiveSession',
  0x81: 'rpmTooHigh',
  0x82: 'rpmTooLow',
  0x83: 'engineIsRunning',
  0x84: 'engineIsNotRunning',
  0x88: 'vehicleSpeedTooHigh',
  0x92: 'voltageTooHigh',
  0x93: 'voltageTooLow'
}

export function nrcName(nrc: number): string {
  return NRC_NAMES[nrc] ?? 'unknown'
}

const hx = (n: number, digits = 2): string => `0x${n.toString(16).toUpperCase().padStart(digits, '0')}`
const hexBytes = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')

// ------------------------------------------------------------------ errors

export class NegativeResponseError extends Error {
  readonly sid: number
  readonly nrc: number
  readonly nrcName: string
  constructor(sid: number, nrc: number) {
    super(`ECU rejected service ${hx(sid)}: NRC ${hx(nrc)} ${nrcName(nrc)}`)
    this.name = 'NegativeResponseError'
    this.sid = sid
    this.nrc = nrc
    this.nrcName = nrcName(nrc)
  }
}

/** A request outside the read-only allowlist was attempted. Nothing was sent. */
export class UdsSafetyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UdsSafetyError'
  }
}

/** The ECU's response could not be interpreted. */
export class UdsProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UdsProtocolError'
  }
}

// ------------------------------------------------------------------ allowlist

/** Throws UdsSafetyError unless `request` is a well-formed, read-only, allowlisted request. */
export function assertUdsAllowed(request: Uint8Array): void {
  const deny = (why: string): never => {
    throw new UdsSafetyError(`Blocked UDS request [${hexBytes(request.subarray(0, 8))}]: ${why}`)
  }
  if (request.length === 0) deny('empty request')
  const sid = request[0]
  switch (sid) {
    case UdsService.DiagnosticSessionControl: {
      const session = request[1] & 0x7f
      if (request.length !== 2 || (session !== DiagnosticSession.Default && session !== DiagnosticSession.Extended)) {
        deny('only the default (0x01) and extended (0x03) sessions are allowed')
      }
      return
    }
    case UdsService.ReadDtcInformation:
      if (request.length < 2) deny('missing sub-function')
      return
    case UdsService.ReadDataByIdentifier:
      if (request.length < 3 || (request.length - 1) % 2 !== 0) deny('malformed DID list')
      return
    case UdsService.ReadMemoryByAddress: {
      const addrLen = request[1] & 0x0f
      const sizeLen = request[1] >> 4
      if (request.length < 4 || addrLen === 0 || sizeLen === 0 || request.length !== 2 + addrLen + sizeLen) {
        deny('malformed address/size')
      }
      return
    }
    case UdsService.DynamicallyDefineDataIdentifier: {
      const sub = request[1] & 0x7f
      if (sub < 0x01 || sub > 0x03 || request.length < 4) deny('unsupported sub-function or missing DID')
      const did = (request[2] << 8) | request[3]
      if (!isDynamicDid(did)) deny(`DID ${hx(did, 4)} is outside the dynamic range F200..F3FF`)
      // By identifier: one or more {source DID (2), position (1), size (1)} entries.
      if (sub === 0x01 && (request.length < 8 || (request.length - 4) % 4 !== 0)) deny('malformed define-by-identifier entries')
      return
    }
    case UdsService.TesterPresent:
      if (request.length !== 2 || (request[1] & 0x7f) !== 0x00) deny('malformed TesterPresent')
      return
    default:
      deny(`service ${hx(sid)} is not on the read-only allowlist`)
  }
}

// ------------------------------------------------------------------ response parsing

/**
 * Parses a positive ReadDataByIdentifier response (62 [DID data]...) for `dids`.
 *
 * - A single-DID request needs no length: its data is the rest of the response.
 * - In a multi-DID request every DID needs a known length (`lengths`), except that a DID of
 *   unknown length consumes the rest of the response (so it must come last).
 * - DIDs the ECU omitted (ISO 14229 lets it skip unsupported ones) are absent from the map.
 *
 * Throws UdsProtocolError on truncated data, unexpected or duplicated DIDs.
 */
export function parseReadDataByIdentifierResponse(
  response: Buffer,
  dids: readonly number[],
  lengths?: ReadonlyMap<number, number>
): Map<number, Buffer> {
  if (response[0] !== 0x62 || response.length < 3) {
    throw new UdsProtocolError(`Malformed ReadDataByIdentifier response [${hexBytes(response.subarray(0, 16))}]`)
  }
  const expected = new Set(dids)
  const out = new Map<number, Buffer>()
  let pos = 1
  while (pos < response.length) {
    if (pos + 2 > response.length) throw new UdsProtocolError(`Truncated DID header at byte ${pos}`)
    const did = response.readUInt16BE(pos)
    if (!expected.delete(did)) {
      throw new UdsProtocolError(`Unexpected DID ${hx(did, 4)} at byte ${pos} of the response`)
    }
    pos += 2
    const length = dids.length === 1 ? undefined : lengths?.get(did)
    const end = length === undefined ? response.length : pos + length
    if (end > response.length) {
      throw new UdsProtocolError(`DID ${hx(did, 4)}: expected ${length} bytes, got ${response.length - pos}`)
    }
    out.set(did, response.subarray(pos, end))
    pos = end
  }
  return out
}

// ------------------------------------------------------------------ client

export interface MemoryEntry {
  address: number
  size: number
}

/** One source of a dynamically defined DID (2C 01): `size` bytes of `sourceDid`'s record. */
export interface DidSourceEntry {
  sourceDid: number
  /** 1-based position of the first byte within the source record (ISO 14229-1). */
  position: number
  size: number
}

function writeUInt(buf: Buffer, value: number, offset: number, bytes: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** (8 * bytes)) {
    throw new RangeError(`${what} ${value} does not fit in ${bytes} byte(s)`)
  }
  buf.writeUIntBE(value, offset, bytes)
}

function alfid(addrLen: number, sizeLen: number): number {
  if (!Number.isInteger(addrLen) || addrLen < 1 || addrLen > 4 || !Number.isInteger(sizeLen) || sizeLen < 1 || sizeLen > 4) {
    throw new RangeError(`Unsupported address/size length ${addrLen}/${sizeLen}`)
  }
  return (sizeLen << 4) | addrLen
}

export class UdsClient {
  private readonly transport: UdsTransport
  private readonly defaults: UdsRequestOptions

  constructor(transport: UdsTransport, defaults: UdsRequestOptions = {}) {
    this.transport = transport
    this.defaults = defaults
  }

  /**
   * Sends an allowlisted request and returns the positive response (SID byte included).
   * Throws NegativeResponseError for 7F responses and UdsProtocolError for anything else.
   */
  async request(target: number, data: Uint8Array | readonly number[], opts: UdsRequestOptions = {}): Promise<Buffer> {
    const req = Buffer.from(data)
    assertUdsAllowed(req)
    const merged = { ...this.defaults, ...opts }
    const res = await this.transport.request(target, req, merged)
    if (merged.expectResponse === false) return res
    if (res.length >= 3 && res[0] === 0x7f && res[1] === req[0]) throw new NegativeResponseError(res[1], res[2])
    if (res.length === 0 || res[0] !== ((req[0] + 0x40) & 0xff)) {
      throw new UdsProtocolError(`Unexpected response to service ${hx(req[0])}: [${hexBytes(res.subarray(0, 16))}]`)
    }
    return res
  }

  /** ReadDataByIdentifier for one or more DIDs (see parseReadDataByIdentifierResponse). */
  async readDataByIdentifier(
    target: number,
    dids: readonly number[],
    lengths?: ReadonlyMap<number, number>,
    opts: UdsRequestOptions = {}
  ): Promise<Map<number, Buffer>> {
    if (dids.length === 0) throw new RangeError('No DIDs requested')
    if (new Set(dids).size !== dids.length) throw new RangeError('Duplicate DIDs requested')
    const req = Buffer.alloc(1 + 2 * dids.length)
    req[0] = UdsService.ReadDataByIdentifier
    dids.forEach((did, i) => writeUInt(req, did, 1 + 2 * i, 2, 'DID'))
    const requested = new Set(dids)
    const res = await this.request(target, req, {
      ...opts,
      accept: (r) => r.length >= 3 && requested.has(r.readUInt16BE(1))
    })
    return parseReadDataByIdentifierResponse(res, dids, lengths)
  }

  /** VIN from DID F190 (17 characters, extracted tolerantly from padded responses). */
  async readVin(target: number, opts: UdsRequestOptions = {}): Promise<string> {
    const data = (await this.readDataByIdentifier(target, [DID_VIN], undefined, opts)).get(DID_VIN)
    const vin = data ? /[A-HJ-NPR-Z0-9]{17}/.exec(data.toString('latin1').toUpperCase())?.[0] : undefined
    if (!vin) throw new UdsProtocolError(`No VIN in DID F190 response [${data ? hexBytes(data) : ''}]`)
    return vin
  }

  /** ReadMemoryByAddress (0x23); returns exactly `size` bytes. */
  async readMemoryByAddress(
    target: number,
    address: number,
    size: number,
    addrLen = 4,
    sizeLen = 1,
    opts: UdsRequestOptions = {}
  ): Promise<Buffer> {
    if (size < 1) throw new RangeError(`Invalid memory size ${size}`)
    const req = Buffer.alloc(2 + addrLen + sizeLen)
    req[0] = UdsService.ReadMemoryByAddress
    req[1] = alfid(addrLen, sizeLen)
    writeUInt(req, address, 2, addrLen, 'Address')
    writeUInt(req, size, 2 + addrLen, sizeLen, 'Size')
    const res = await this.request(target, req, opts)
    if (res.length < 1 + size) {
      throw new UdsProtocolError(`ReadMemoryByAddress returned ${res.length - 1} bytes, expected ${size}`)
    }
    return res.subarray(1, 1 + size)
  }

  /**
   * DynamicallyDefineDataIdentifier by memory address (2C 02): reading `did` afterwards
   * returns the concatenated memory blocks. Definitions append to an existing one, so clear
   * the DID first.
   */
  async defineDidByMemory(
    target: number,
    did: number,
    entries: readonly MemoryEntry[],
    addrLen = 4,
    sizeLen = 1,
    opts: UdsRequestOptions = {}
  ): Promise<void> {
    if (entries.length === 0) throw new RangeError('No memory entries')
    const req = Buffer.alloc(5 + entries.length * (addrLen + sizeLen))
    req[0] = UdsService.DynamicallyDefineDataIdentifier
    req[1] = 0x02
    writeUInt(req, did, 2, 2, 'DID')
    req[4] = alfid(addrLen, sizeLen)
    entries.forEach((e, i) => {
      const pos = 5 + i * (addrLen + sizeLen)
      writeUInt(req, e.address, pos, addrLen, 'Address')
      writeUInt(req, e.size, pos + addrLen, sizeLen, 'Size')
    })
    await this.request(target, req, opts)
  }

  /**
   * DynamicallyDefineDataIdentifier by identifier (2C 01): reading `did` afterwards returns
   * the concatenated slices of the source DIDs' records, in entry order. Request layout:
   * `2C 01 <did hi lo> { <source DID hi lo> <position> <size> }*`. Definitions append to an
   * existing one, so clear the DID first.
   */
  async defineDidByIdentifier(target: number, did: number, entries: readonly DidSourceEntry[], opts: UdsRequestOptions = {}): Promise<void> {
    if (entries.length === 0) throw new RangeError('No source DIDs')
    const req = Buffer.alloc(4 + entries.length * 4)
    req[0] = UdsService.DynamicallyDefineDataIdentifier
    req[1] = 0x01
    writeUInt(req, did, 2, 2, 'DID')
    entries.forEach((e, i) => {
      const pos = 4 + i * 4
      if (e.position < 1) throw new RangeError(`Position ${e.position} is not 1-based`)
      if (e.size < 1) throw new RangeError(`Invalid size ${e.size}`)
      writeUInt(req, e.sourceDid, pos, 2, 'Source DID')
      writeUInt(req, e.position, pos + 2, 1, 'Position')
      writeUInt(req, e.size, pos + 3, 1, 'Size')
    })
    await this.request(target, req, opts)
  }

  /** Clears a dynamically defined DID (2C 03). */
  async clearDynamicDid(target: number, did: number, opts: UdsRequestOptions = {}): Promise<void> {
    const req = Buffer.alloc(4)
    req[0] = UdsService.DynamicallyDefineDataIdentifier
    req[1] = 0x03
    writeUInt(req, did, 2, 2, 'DID')
    await this.request(target, req, opts)
  }

  /** TesterPresent; with `suppress` (3E 80) the ECU sends no response. */
  async testerPresent(target: number, suppress = true, opts: UdsRequestOptions = {}): Promise<void> {
    const sub = suppress ? 0x80 : 0x00
    await this.request(target, [UdsService.TesterPresent, sub], suppress ? { ...opts, expectResponse: false } : opts)
  }

  /** DiagnosticSessionControl; returns the session parameter record (P2 / P2* timing). */
  async sessionControl(target: number, session: AllowedSession, opts: UdsRequestOptions = {}): Promise<Buffer> {
    const res = await this.request(target, [UdsService.DiagnosticSessionControl, session], {
      ...opts,
      accept: (r) => r.length >= 2 && r[1] === session
    })
    return res.subarray(2)
  }
}
