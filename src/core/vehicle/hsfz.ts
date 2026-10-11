/**
 * HSFZ transport ("High-Speed-Fahrzeug-Zugang": BMW diagnostics over IP).
 *
 * The central gateway of F/G-series BMWs (ZGW; BDC on most G-series) speaks HSFZ on the
 * Ethernet pins of the OBD connector (ENET cable). The MHD and bootmod3 WiFi adapters are
 * sold as E-Sys / ISTA / BimmerCode compatible, so we ASSUME they relay the same protocol
 * transparently on their WiFi side. That is unconfirmed; probe.ts exists to verify it.
 *
 * Wire format (community documented; implemented by E-Sys, ISTA and EdiabasLib):
 *
 *   +-----------------+------------------+-------------------------+
 *   | LENGTH (u32 BE) | CONTROL (u16 BE) | payload (LENGTH bytes)  |
 *   +-----------------+------------------+-------------------------+
 *
 *   Diagnostic payload (control 0x0001): source address, target address, UDS bytes.
 *
 * Facts relied upon:
 *   - TCP 6801 carries diagnostics; UDP 6811 answers vehicle identification (discovery.ts).
 *   - No routing activation or other handshake (unlike ISO 13400 DoIP): connect and talk.
 *   - Tester 0xF4, gateway (ZGW) 0x10, engine DME 0x12 (N63/S63 second DME 0x13).
 *     Responses come back with source = ECU, target = tester.
 *   - Control words 0x0040..0x0045 and 0x00FF report gateway-level errors.
 *
 * Assumptions and tolerances (verify with a capture from real hardware, see probe.ts):
 *   - The gateway acknowledges each request with control 0x0002 carrying the request's
 *     addresses and some or all of its UDS bytes, before the ECU response. A missing or
 *     truncated ACK is tolerated, as is an echo sent as a 0x0001 frame with the tester as
 *     source; neither is ever mistaken for the response.
 *   - Alive check (control 0x0012) sent by the gateway is answered with control 0x0012 and
 *     payload [testerAddress, 0x00]. The exact reply format is unconfirmed, so replies are
 *     rate limited and logged and can neither loop nor break the session.
 *   - UDS "response pending" (7F <sid> 78) is handled here, extending the deadline (5 s
 *     by default) instead of resolving the request.
 */
import { EventEmitter } from 'events'
import { runtime, type TcpSocket } from '../runtime'

export const HSFZ_DIAG_PORT = 6801
export const HSFZ_IDENT_PORT = 6811
export const HSFZ_HEADER_LENGTH = 6
/** LENGTH values above this mean the byte stream lost sync (real frames are a few KiB at most). */
export const HSFZ_MAX_PAYLOAD = 256 * 1024

export const HsfzControl = {
  Diagnostic: 0x0001,
  Ack: 0x0002,
  VehicleIdent: 0x0011,
  AliveCheck: 0x0012
} as const

export const TESTER_ADDRESS = 0xf4
export const ECU_ADDRESS = { ZGW: 0x10, DME: 0x12, DME2: 0x13 } as const

const GATEWAY_ERRORS: Readonly<Record<number, string>> = {
  0x0040: 'incorrect tester address',
  0x0041: 'incorrect control word',
  0x0042: 'incorrect format',
  0x0043: 'incorrect destination address',
  0x0044: 'message too large',
  0x0045: 'diagnostic application not ready',
  0x00ff: 'out of memory'
}

/** Default deadline after a "response pending" (NRC 0x78). */
const DEFAULT_PENDING_TIMEOUT_MS = 5000
/** How long a request without an expected response waits for the gateway ACK (or an error). */
const NO_RESPONSE_SETTLE_MS = 100
/** Alive checks arriving faster than this are not answered (guards against ping-pong). */
const ALIVE_REPLY_MIN_INTERVAL_MS = 250
/** Recurring protocol events are logged this often per kind, then suppressed. */
const MAX_NOTES_PER_KIND = 5

// ------------------------------------------------------------------ helpers

/** "f4 12 22 f1 90" */
export function toHex(bytes: Uint8Array | undefined, separator = ' '): string {
  return bytes ? Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(separator) : ''
}

const hexWord = (n: number): string => `0x${n.toString(16).toUpperCase().padStart(4, '0')}`
const hexByte = (n: number): string => `0x${n.toString(16).toUpperCase().padStart(2, '0')}`

/** The error to reject with when an AbortSignal fires. */
export function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  const err = new Error('Operation aborted')
  err.name = 'AbortError'
  return err
}

// ------------------------------------------------------------------ errors

export class HsfzError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'HsfzError'
  }
}

/** The gateway answered with one of the HSFZ error control words (0x0040..0x0045, 0x00FF). */
export class HsfzGatewayError extends HsfzError {
  readonly code: number
  constructor(code: number, payload: Uint8Array) {
    const detail = payload.length > 0 ? ` [${toHex(payload)}]` : ''
    super(`Gateway reported HSFZ error ${hexWord(code)} (${GATEWAY_ERRORS[code] ?? 'unknown'})${detail}`)
    this.name = 'HsfzGatewayError'
    this.code = code
  }
}

export class HsfzTimeoutError extends HsfzError {
  constructor(message: string) {
    super(message)
    this.name = 'HsfzTimeoutError'
  }
}

/** The TCP connection is gone; every pending and future request fails with this. */
export class HsfzConnectionClosedError extends HsfzError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'HsfzConnectionClosedError'
  }
}

/** The byte stream cannot be parsed as HSFZ (desynchronised or not an HSFZ peer). */
export class HsfzProtocolError extends HsfzError {
  constructor(message: string) {
    super(message)
    this.name = 'HsfzProtocolError'
  }
}

export function isGatewayErrorControl(control: number): boolean {
  return GATEWAY_ERRORS[control] !== undefined
}

// ------------------------------------------------------------------ frame codec

export interface HsfzFrame {
  control: number
  payload: Buffer
}

export interface DiagnosticMessage {
  source: number
  target: number
  uds: Buffer
}

export function encodeFrame(control: number, payload: Uint8Array = Buffer.alloc(0)): Buffer {
  const frame = Buffer.alloc(HSFZ_HEADER_LENGTH + payload.length)
  frame.writeUInt32BE(payload.length, 0)
  frame.writeUInt16BE(control, 4)
  frame.set(payload, HSFZ_HEADER_LENGTH)
  return frame
}

export function encodeDiagnosticFrame(source: number, target: number, uds: Uint8Array): Buffer {
  const payload = Buffer.alloc(2 + uds.length)
  payload[0] = source
  payload[1] = target
  payload.set(uds, 2)
  return encodeFrame(HsfzControl.Diagnostic, payload)
}

/** Splits a diagnostic (or ACK) payload into addresses and UDS bytes. */
export function decodeDiagnosticPayload(payload: Buffer): DiagnosticMessage | undefined {
  if (payload.length < 2) return undefined
  return { source: payload[0], target: payload[1], uds: payload.subarray(2) }
}

/**
 * Reassembles HSFZ frames from a TCP byte stream: a chunk may hold a partial frame,
 * exactly one frame, or several frames. Throws HsfzProtocolError when a LENGTH field is
 * implausible, which means the stream is out of sync and the connection must be dropped.
 */
export class HsfzFrameReader {
  private buffer: Buffer = Buffer.alloc(0)

  /** Bytes held back waiting for the rest of a frame. */
  get bufferedBytes(): number {
    return this.buffer.length
  }

  push(chunk: Uint8Array): HsfzFrame[] {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk])
    const frames: HsfzFrame[] = []
    let offset = 0
    while (this.buffer.length - offset >= HSFZ_HEADER_LENGTH) {
      const length = this.buffer.readUInt32BE(offset)
      if (length > HSFZ_MAX_PAYLOAD) {
        throw new HsfzProtocolError(`HSFZ frame length ${length} exceeds ${HSFZ_MAX_PAYLOAD} bytes; stream out of sync`)
      }
      const end = offset + HSFZ_HEADER_LENGTH + length
      if (this.buffer.length < end) break
      frames.push({
        control: this.buffer.readUInt16BE(offset + 4),
        payload: Buffer.from(this.buffer.subarray(offset + HSFZ_HEADER_LENGTH, end))
      })
      offset = end
    }
    this.buffer = offset === this.buffer.length ? Buffer.alloc(0) : this.buffer.subarray(offset)
    return frames
  }
}

// ------------------------------------------------------------------ connection

export type TrafficDirection = 'tx' | 'rx'

export interface HsfzConnectOptions {
  /** TCP connect timeout (default 3000 ms). */
  timeoutMs?: number
  signal?: AbortSignal
  /** Tester (source) address, default 0xF4. */
  testerAddress?: number
  /** Raw bytes as written to / read from the socket (captures, probe hex dumps). */
  onTraffic?: (direction: TrafficDirection, bytes: Buffer) => void
  /** Protocol events worth knowing about: alive checks, stray frames, gateway errors. */
  log?: (message: string) => void
}

export interface HsfzRequestOptions {
  /** Deadline for the response (default 1000 ms). */
  timeoutMs?: number
  /** Deadline restarted by every "response pending" NRC 0x78 (default 5000 ms). */
  pendingTimeoutMs?: number
  /** false for suppressed-response requests (e.g. 3E 80): resolve with an empty buffer once sent. */
  expectResponse?: boolean
  /**
   * Extra check on a positive response; responses failing it are ignored as stale
   * (e.g. a late answer to an earlier request that timed out).
   */
  accept?: (uds: Buffer) => boolean
}

interface PendingRequest {
  target: number
  uds: Buffer
  timeoutMs: number
  pendingTimeoutMs: number
  expectResponse: boolean
  accept: ((uds: Buffer) => boolean) | undefined
  resolve: (uds: Buffer) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined
}

export type HsfzConnectionEvents = {
  /** The socket closed. `error` is set unless close() was called. */
  close: [error: Error | undefined]
}

/**
 * One TCP connection to an HSFZ gateway. Requests are strictly serialized: one request is
 * on the wire at a time and the rest wait in a FIFO queue, because responses carry no
 * request id and HSFZ gateways are not designed for pipelining.
 */
export class HsfzConnection extends EventEmitter<HsfzConnectionEvents> {
  readonly host: string
  readonly port: number
  readonly testerAddress: number

  private readonly socket: TcpSocket
  private readonly reader = new HsfzFrameReader()
  private readonly queue: PendingRequest[] = []
  private readonly onTraffic: HsfzConnectOptions['onTraffic']
  private readonly log: (message: string) => void
  private readonly closed: Promise<void>
  private active: PendingRequest | undefined
  private open = true
  private closingByUser = false
  private failure: Error | undefined
  private lastAliveReplyAt = -Infinity
  private readonly noteCounts = new Map<string, number>()

  private constructor(socket: TcpSocket, host: string, port: number, opts: HsfzConnectOptions) {
    super()
    this.socket = socket
    this.host = host
    this.port = port
    this.testerAddress = opts.testerAddress ?? TESTER_ADDRESS
    this.onTraffic = opts.onTraffic
    this.log = opts.log ?? (() => undefined)
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 5000)
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', (err) => {
      this.failure ??= err
    })
    this.closed = new Promise((resolve) => {
      socket.once('close', () => {
        this.onClose()
        resolve()
      })
    })
  }

  /** Opens the TCP connection. HSFZ needs no handshake, so the connection is usable at once. */
  static connect(host: string, port: number = HSFZ_DIAG_PORT, opts: HsfzConnectOptions = {}): Promise<HsfzConnection> {
    const { timeoutMs = 3000, signal } = opts
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal))
        return
      }
      const socket = runtime().createTcpConnection(host, port)
      let settled = false
      const finish = (err?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        socket.off('connect', onConnect)
        socket.off('error', onError)
        if (err) {
          socket.on('error', () => undefined)
          socket.destroy()
          reject(err)
        } else {
          resolve(new HsfzConnection(socket, host, port, opts))
        }
      }
      const onConnect = (): void => finish()
      const onError = (err: Error): void =>
        finish(new HsfzError(`Cannot connect to ${host}:${port}: ${err.message}`, { cause: err }))
      const onAbort = (): void => finish(abortError(signal as AbortSignal))
      const timer = setTimeout(
        () => finish(new HsfzTimeoutError(`No TCP connection to ${host}:${port} within ${timeoutMs} ms`)),
        timeoutMs
      )
      socket.once('connect', onConnect)
      socket.once('error', onError)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  get isOpen(): boolean {
    return this.open
  }

  /**
   * Sends a UDS request to `target` and resolves with the ECU's UDS response bytes
   * (addresses stripped). Negative responses other than 0x78 resolve too: interpreting
   * them is the UDS layer's job.
   */
  request(target: number, uds: Uint8Array, opts: HsfzRequestOptions = {}): Promise<Buffer> {
    if (!this.open) {
      return Promise.reject(new HsfzConnectionClosedError(`Connection to ${this.host}:${this.port} is closed`))
    }
    if (!Number.isInteger(target) || target < 0 || target > 0xff) {
      return Promise.reject(new RangeError(`Invalid diagnostic address ${target}`))
    }
    if (uds.length === 0 || uds.length + 2 > HSFZ_MAX_PAYLOAD) {
      return Promise.reject(new RangeError(`Invalid UDS request length ${uds.length}`))
    }
    return new Promise((resolve, reject) => {
      this.queue.push({
        target,
        uds: Buffer.from(uds),
        timeoutMs: opts.timeoutMs ?? 1000,
        pendingTimeoutMs: opts.pendingTimeoutMs ?? DEFAULT_PENDING_TIMEOUT_MS,
        expectResponse: opts.expectResponse ?? true,
        accept: opts.accept,
        resolve,
        reject,
        timer: undefined
      })
      this.pump()
    })
  }

  /** Closes the socket; pending requests reject with HsfzConnectionClosedError. */
  close(): Promise<void> {
    if (this.open) {
      this.closingByUser = true
      this.socket.destroy()
    }
    return this.closed
  }

  // ---------------------------------------------------------------- internals

  /** Logs a recurring protocol event, at most MAX_NOTES_PER_KIND times per kind. */
  private note(kind: string, message: string): void {
    const count = (this.noteCounts.get(kind) ?? 0) + 1
    this.noteCounts.set(kind, count)
    if (count > MAX_NOTES_PER_KIND) return
    this.log(count === MAX_NOTES_PER_KIND ? `${message} (further "${kind}" messages suppressed)` : message)
  }

  private write(frame: Buffer): void {
    this.onTraffic?.('tx', frame)
    this.socket.write(frame)
  }

  private pump(): void {
    if (this.active || !this.open) return
    const next = this.queue.shift()
    if (!next) return
    this.active = next
    this.write(encodeDiagnosticFrame(this.testerAddress, next.target, next.uds))
    if (next.expectResponse) {
      this.arm(next, next.timeoutMs)
    } else {
      next.timer = setTimeout(() => this.settle(next, Buffer.alloc(0)), Math.min(next.timeoutMs, NO_RESPONSE_SETTLE_MS))
    }
  }

  private arm(req: PendingRequest, ms: number): void {
    clearTimeout(req.timer)
    req.timer = setTimeout(() => {
      this.fail(
        req,
        new HsfzTimeoutError(`No response from ECU ${hexByte(req.target)} to ${toHex(req.uds.subarray(0, 8))} within ${ms} ms`)
      )
    }, ms)
  }

  private settle(req: PendingRequest, uds: Buffer): void {
    if (this.active !== req) return
    clearTimeout(req.timer)
    this.active = undefined
    req.resolve(uds)
    this.pump()
  }

  private fail(req: PendingRequest, err: Error): void {
    if (this.active !== req) return
    clearTimeout(req.timer)
    this.active = undefined
    req.reject(err)
    this.pump()
  }

  private onData(chunk: Buffer): void {
    this.onTraffic?.('rx', chunk)
    let frames: HsfzFrame[]
    try {
      frames = this.reader.push(chunk)
    } catch (err) {
      this.failure = err as Error
      this.log((err as Error).message)
      this.socket.destroy()
      return
    }
    for (const frame of frames) this.onFrame(frame)
  }

  private onFrame(frame: HsfzFrame): void {
    switch (frame.control) {
      case HsfzControl.Diagnostic: {
        const msg = decodeDiagnosticPayload(frame.payload)
        if (msg) this.onDiagnostic(msg)
        else this.note('short frame', `Ignored short diagnostic frame [${toHex(frame.payload)}]`)
        return
      }
      case HsfzControl.Ack:
        this.onAck(frame.payload)
        return
      case HsfzControl.AliveCheck:
        this.onAliveCheck(frame.payload)
        return
      default:
        if (isGatewayErrorControl(frame.control)) {
          const err = new HsfzGatewayError(frame.control, frame.payload)
          if (this.active) this.fail(this.active, err)
          else this.note('gateway error', err.message)
        } else {
          this.note('unknown control', `Ignored frame with unknown control word ${hexWord(frame.control)} [${toHex(frame.payload)}]`)
        }
    }
  }

  private onDiagnostic(msg: DiagnosticMessage): void {
    const req = this.active
    if (!req) {
      this.note('unsolicited', `Unsolicited diagnostic frame ${hexByte(msg.source)}→${hexByte(msg.target)} [${toHex(msg.uds)}]`)
      return
    }
    // Some bridges echo the request as a diagnostic frame instead of (or besides) an ACK.
    if (msg.source === this.testerAddress && msg.target === req.target) return
    if (msg.source !== req.target || msg.target !== this.testerAddress) {
      this.note('foreign frame', `Ignored diagnostic frame ${hexByte(msg.source)}→${hexByte(msg.target)} [${toHex(msg.uds)}]`)
      return
    }
    const sid = req.uds[0]
    if (msg.uds[0] === 0x7f && msg.uds.length >= 3 && msg.uds[1] === sid) {
      if (msg.uds[2] === 0x78) {
        this.arm(req, req.pendingTimeoutMs)
        return
      }
      this.settle(req, msg.uds)
      return
    }
    if (msg.uds[0] === ((sid + 0x40) & 0xff) && (req.accept?.(msg.uds) ?? true)) {
      this.settle(req, msg.uds)
      return
    }
    this.note('stale response', `Ignored stale or unexpected response from ${hexByte(msg.source)} [${toHex(msg.uds)}]`)
  }

  private onAck(payload: Buffer): void {
    const req = this.active
    const ack = decodeDiagnosticPayload(payload)
    if (!req || !ack || ack.source !== this.testerAddress || ack.target !== req.target) {
      this.note('ack', `Ignored ACK [${toHex(payload)}]`)
      return
    }
    if (!req.expectResponse) this.settle(req, Buffer.alloc(0))
  }

  private onAliveCheck(payload: Buffer): void {
    const now = Date.now()
    if (now - this.lastAliveReplyAt < ALIVE_REPLY_MIN_INTERVAL_MS) {
      this.note('alive check', `Alive check [${toHex(payload)}] not answered (previous reply ${now - this.lastAliveReplyAt} ms ago)`)
      return
    }
    this.lastAliveReplyAt = now
    const reply = Buffer.from([this.testerAddress, 0x00])
    this.write(encodeFrame(HsfzControl.AliveCheck, reply))
    this.note('alive check', `Alive check from gateway [${toHex(payload)}] answered with [${toHex(reply)}]`)
  }

  private onClose(): void {
    this.open = false
    const reason = this.closingByUser
      ? new HsfzConnectionClosedError(`Connection to ${this.host}:${this.port} closed`)
      : new HsfzConnectionClosedError(
          `Connection to ${this.host}:${this.port} lost${this.failure ? `: ${this.failure.message}` : ''}`,
          { cause: this.failure }
        )
    const pending = [...(this.active ? [this.active] : []), ...this.queue.splice(0)]
    this.active = undefined
    for (const req of pending) {
      clearTimeout(req.timer)
      req.reject(reason)
    }
    this.emit('close', this.closingByUser ? undefined : reason)
  }
}
