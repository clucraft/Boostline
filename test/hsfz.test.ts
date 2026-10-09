import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  candidateHosts,
  directedBroadcast,
  discoverGateways,
  encodeDiscoveryRequest,
  listIpv4Interfaces,
  parseDiscoveryResponse
} from '../src/main/vehicle/discovery'
import {
  HSFZ_MAX_PAYLOAD,
  HsfzConnection,
  HsfzConnectionClosedError,
  HsfzControl,
  HsfzError,
  HsfzFrameReader,
  HsfzGatewayError,
  HsfzProtocolError,
  HsfzTimeoutError,
  decodeDiagnosticPayload,
  encodeDiagnosticFrame,
  encodeFrame,
  type TrafficDirection
} from '../src/main/vehicle/hsfz'
import { FAKE_MAC, FAKE_VIN, FakeGateway, type FakeGatewayOptions } from './fakeGateway'

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex')
const READ_VIN = hex('22 f1 90')

describe('HSFZ frame codec', () => {
  it('encodes a diagnostic request with length, control word and addresses', () => {
    expect(encodeDiagnosticFrame(0xf4, 0x12, READ_VIN).toString('hex')).toBe('000000050001f41222f190')
  })

  it('encodes header-only frames', () => {
    expect(encodeFrame(HsfzControl.VehicleIdent).toString('hex')).toBe('000000000011')
  })

  it('decodes diagnostic payloads', () => {
    const msg = decodeDiagnosticPayload(hex('12 f4 62 f4 0c 1a f8'))
    expect(msg?.source).toBe(0x12)
    expect(msg?.target).toBe(0xf4)
    expect(msg?.uds.toString('hex')).toBe('62f40c1af8')
    expect(decodeDiagnosticPayload(hex('12'))).toBeUndefined()
  })

  const stream = Buffer.concat([
    encodeFrame(HsfzControl.Ack, hex('f4 12 22 f4 0c')),
    encodeDiagnosticFrame(0x12, 0xf4, hex('62 f4 0c 1a f8')),
    encodeFrame(HsfzControl.AliveCheck)
  ])
  const expected = [
    [HsfzControl.Ack, 'f41222f40c'],
    [HsfzControl.Diagnostic, '12f462f40c1af8'],
    [HsfzControl.AliveCheck, '']
  ]

  it('reassembles frames split at every possible byte boundary', () => {
    for (let split = 0; split <= stream.length; split++) {
      const reader = new HsfzFrameReader()
      const frames = [...reader.push(stream.subarray(0, split)), ...reader.push(stream.subarray(split))]
      expect(frames.map((f) => [f.control, f.payload.toString('hex')])).toEqual(expected)
      expect(reader.bufferedBytes).toBe(0)
    }
  })

  it('reassembles byte-by-byte delivery and merged chunks', () => {
    const reader = new HsfzFrameReader()
    const frames = Array.from(stream).flatMap((b) => reader.push(Buffer.from([b])))
    expect(frames.map((f) => [f.control, f.payload.toString('hex')])).toEqual(expected)
    const merged = new HsfzFrameReader().push(Buffer.concat([stream, stream]))
    expect(merged).toHaveLength(6)
  })

  it('keeps a partial frame buffered', () => {
    const reader = new HsfzFrameReader()
    expect(reader.push(stream.subarray(0, 8))).toHaveLength(0)
    expect(reader.bufferedBytes).toBe(8)
  })

  it('rejects an implausible length as a desynchronised stream', () => {
    const bad = Buffer.alloc(6)
    bad.writeUInt32BE(HSFZ_MAX_PAYLOAD + 1, 0)
    expect(() => new HsfzFrameReader().push(bad)).toThrow(HsfzProtocolError)
  })
})

describe('HsfzConnection', () => {
  let fake: FakeGateway | undefined
  let conn: HsfzConnection | undefined

  afterEach(async () => {
    await conn?.close()
    await fake?.close()
    conn = undefined
    fake = undefined
  })

  async function open(opts: FakeGatewayOptions = {}, onTraffic?: (d: TrafficDirection, b: Buffer) => void) {
    const gw = await FakeGateway.start(opts)
    fake = gw
    const c = await HsfzConnection.connect('127.0.0.1', gw.port, { timeoutMs: 2000, onTraffic })
    conn = c
    return { gw, c }
  }

  const vinResponse = (): string => Buffer.concat([hex('62 f1 90'), Buffer.from(FAKE_VIN, 'latin1')]).toString('hex')

  it('returns the UDS response, skipping the ACK echo', async () => {
    const { c } = await open()
    expect((await c.request(0x12, READ_VIN)).toString('hex')).toBe(vinResponse())
  })

  it('works when the gateway sends no ACK', async () => {
    const { c } = await open({ ack: false })
    expect((await c.request(0x12, READ_VIN)).toString('hex')).toBe(vinResponse())
  })

  it.each(['coalesced', 'fragmented'] as const)('handles %s TCP delivery', async (writeMode) => {
    const { c } = await open({ writeMode })
    for (let i = 0; i < 5; i++) expect((await c.request(0x12, READ_VIN)).toString('hex')).toBe(vinResponse())
  })

  it('serializes concurrent requests and matches each response to its request', async () => {
    const { gw, c } = await open({ pendingEvery: 2, pendingDelayMs: 5 })
    const pids = [0x0c, 0x0d, 0x05, 0x0f, 0x11, 0x33, 0x42, 0x46, 0x49, 0x5c]
    const responses = await Promise.all(pids.map((pid) => c.request(0x12, Buffer.from([0x22, 0xf4, pid]))))
    responses.forEach((r, i) => expect(r.subarray(0, 3).toString('hex')).toBe(`62f4${pids[i].toString(16).padStart(2, '0')}`))
    expect(gw.maxInFlight).toBe(1)
    expect(gw.requests).toHaveLength(pids.length)
  })

  it('keeps waiting through response-pending (NRC 0x78)', async () => {
    const { c } = await open({ pendingEvery: 1, pendingDelayMs: 150 })
    const res = await c.request(0x12, READ_VIN, { timeoutMs: 100, pendingTimeoutMs: 1000 })
    expect(res.toString('hex')).toBe(vinResponse())
  })

  it('times out on a silent ECU and stays usable', async () => {
    const { c } = await open({ dmeOnline: false })
    await expect(c.request(0x12, READ_VIN, { timeoutMs: 100 })).rejects.toBeInstanceOf(HsfzTimeoutError)
    expect((await c.request(0x10, READ_VIN)).toString('hex')).toBe(vinResponse())
  })

  it('surfaces gateway error control words as typed errors', async () => {
    const { c } = await open()
    const err = await c.request(0x40, READ_VIN).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HsfzGatewayError)
    expect((err as HsfzGatewayError).code).toBe(0x43)
    expect((err as Error).message).toMatch(/incorrect destination address/)
  })

  it('passes negative responses through to the caller', async () => {
    const { c } = await open()
    expect((await c.request(0x12, hex('22 12 34'))).toString('hex')).toBe('7f2231')
  })

  it('resolves suppressed-response requests once acknowledged', async () => {
    const { gw, c } = await open()
    expect(await c.request(0x12, hex('3e 80'), { expectResponse: false })).toHaveLength(0)
    expect(gw.testerPresentCount).toBe(1)
  })

  it('answers alive checks without disturbing requests', async () => {
    const { gw, c } = await open({ aliveCheckIntervalMs: 300 })
    const until = Date.now() + 700
    while (Date.now() < until) expect((await c.request(0x12, READ_VIN)).toString('hex')).toBe(vinResponse())
    expect(gw.aliveReplies).toBeGreaterThanOrEqual(1)
  })

  it('rejects active and queued requests when the socket dies', async () => {
    const { gw, c } = await open({ dmeOnline: false })
    const closed = new Promise<Error | undefined>((resolve) => c.once('close', resolve))
    const first = c.request(0x12, READ_VIN, { timeoutMs: 5000 })
    const second = c.request(0x10, READ_VIN)
    await new Promise((r) => setTimeout(r, 50))
    gw.dropConnections()
    await expect(first).rejects.toBeInstanceOf(HsfzConnectionClosedError)
    await expect(second).rejects.toBeInstanceOf(HsfzConnectionClosedError)
    expect(await closed).toBeInstanceOf(HsfzConnectionClosedError)
    expect(c.isOpen).toBe(false)
    await expect(c.request(0x12, READ_VIN)).rejects.toBeInstanceOf(HsfzConnectionClosedError)
  })

  it('emits close without an error after close()', async () => {
    const { c } = await open()
    const closed = new Promise<Error | undefined>((resolve) => c.once('close', resolve))
    await c.close()
    expect(await closed).toBeUndefined()
  })

  it('reports raw traffic in both directions', async () => {
    const traffic: Array<[TrafficDirection, string]> = []
    const { c } = await open({}, (d, b) => traffic.push([d, b.toString('hex')]))
    await c.request(0x12, READ_VIN)
    expect(traffic[0]).toEqual(['tx', '000000050001f41222f190'])
    expect(traffic.filter(([d]) => d === 'rx').map(([, b]) => b).join('')).toContain('0002f41222f190')
  })

  it('fails to connect to a closed port', async () => {
    const server = net.createServer()
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as net.AddressInfo).port
    await new Promise<void>((r) => server.close(() => r()))
    await expect(HsfzConnection.connect('127.0.0.1', port, { timeoutMs: 1000 })).rejects.toBeInstanceOf(HsfzError)
  })

  it('honours an abort signal while connecting', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(HsfzConnection.connect('127.0.0.1', 1, { signal: ctrl.signal })).rejects.toThrow(/abort/i)
  })
})

describe('discovery', () => {
  it('parses an identification reply', () => {
    const msg = encodeFrame(HsfzControl.VehicleIdent, Buffer.from('DIAGADR10BMWMAC001A37ABCDEFBMWVINWBA8E9C50XKA12345', 'latin1'))
    expect(parseDiscoveryResponse(msg, '169.254.10.20')).toEqual({
      host: '169.254.10.20',
      port: 6801,
      vin: 'WBA8E9C50XKA12345',
      mac: '001A37ABCDEF',
      diagAddress: 0x10,
      ident: 'DIAGADR10BMWMAC001A37ABCDEFBMWVINWBA8E9C50XKA12345'
    })
  })

  it('tolerates a missing header and separators', () => {
    const gw = parseDiscoveryResponse(Buffer.from('DIAGADR 10 BMWVIN: wba8e9c50xka12345\0', 'latin1'), '10.0.0.2')
    expect(gw?.vin).toBe('WBA8E9C50XKA12345')
    expect(gw?.diagAddress).toBe(0x10)
    expect(gw?.mac).toBeUndefined()
  })

  it('ignores datagrams that are not identification replies', () => {
    expect(parseDiscoveryResponse(encodeDiscoveryRequest(), '10.0.0.2')).toBeUndefined()
  })

  it('computes directed broadcast addresses', () => {
    expect(directedBroadcast('169.254.12.34', '255.255.0.0')).toBe('169.254.255.255')
    expect(directedBroadcast('192.168.4.23', '255.255.255.0')).toBe('192.168.4.255')
  })

  it('guesses adapter hosts from the interfaces', () => {
    const ifaces = listIpv4Interfaces({
      wifi: [{ address: '192.168.4.23', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:01', internal: false, cidr: '192.168.4.23/24' }],
      enet: [{ address: '169.254.7.8', netmask: '255.255.0.0', family: 'IPv4', mac: '00:00:00:00:00:02', internal: false, cidr: '169.254.7.8/16' }],
      lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }]
    })
    expect(ifaces.find((i) => i.name === 'enet')?.linkLocal).toBe(true)
    expect(candidateHosts(ifaces)).toEqual(['192.168.4.1', '192.168.0.10'])
  })

  it('finds the fake gateway over UDP', async () => {
    const gw = await FakeGateway.start({ udp: true })
    try {
      const found = await discoverGateways({ port: gw.udpPort, targets: ['127.0.0.1'], timeoutMs: 300 })
      expect(found).toHaveLength(1)
      expect(found[0]).toMatchObject({ host: '127.0.0.1', vin: FAKE_VIN, mac: FAKE_MAC, diagAddress: 0x10 })
    } finally {
      await gw.close()
    }
  })
})
