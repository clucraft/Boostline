import { describe, expect, it } from 'vitest'
import {
  NegativeResponseError,
  UdsClient,
  UdsProtocolError,
  UdsSafetyError,
  assertUdsAllowed,
  parseReadDataByIdentifierResponse,
  type UdsRequestOptions,
  type UdsTransport
} from '../src/main/vehicle/uds'

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex')

class MockTransport implements UdsTransport {
  readonly sent: Array<{ target: number; data: string; opts?: UdsRequestOptions }> = []
  constructor(private readonly reply: (data: Buffer) => Buffer = () => Buffer.alloc(0)) {}
  async request(target: number, data: Buffer, opts?: UdsRequestOptions): Promise<Buffer> {
    this.sent.push({ target, data: data.toString('hex'), opts })
    return this.reply(data)
  }
}

describe('UDS allowlist', () => {
  const blocked: Array<[string, string]> = [
    ['ECU reset', '11 01'],
    ['security access', '27 01'],
    ['write data by identifier', '2e f1 90 00'],
    ['routine control', '31 01 ff 00'],
    ['request download', '34 00 44 00 00 00 00 00 00 01 00'],
    ['programming session', '10 02'],
    ['vendor session', '10 41'],
    ['communication control', '28 01 01'],
    ['control DTC setting', '85 02'],
    ['clear DTCs', '14 ff ff ff'],
    ['input/output control', '2f 12 34 03'],
    ['write memory', '3d 14 d0 00 00 00 01 00'],
    ['dynamic DID outside F200..F3FF', '2c 02 f1 90 14 d0 00 00 00 02'],
    ['define by identifier outside F200..F3FF', '2c 01 f1 90 4a 10 01 02'],
    ['define by identifier without entries', '2c 01 f3 00'],
    ['define by identifier with a truncated entry', '2c 01 f3 00 4a 10 01'],
    ['dynamic DID sub-function 04', '2c 04 f3 00'],
    ['clear all dynamic DIDs', '2c 03'],
    ['tester present with bad sub-function', '3e 01'],
    ['malformed read', '22 f1'],
    ['malformed memory read', '23 14 d0 00'],
    ['empty', '']
  ]

  it.each(blocked)('blocks %s before anything is sent', async (_name, request) => {
    const transport = new MockTransport()
    const client = new UdsClient(transport)
    await expect(client.request(0x12, hex(request))).rejects.toBeInstanceOf(UdsSafetyError)
    expect(transport.sent).toHaveLength(0)
  })

  it.each([
    '10 01', '10 03', '10 83', '19 02 ff', '22 f1 90', '22 f4 0c f4 0d', '23 14 d0 00 12 34 02',
    '2c 02 f3 00 14 d0 00 00 00 02', '2c 03 f3 00', '2c 01 f2 00 f4 0c 01 02', '2c 01 f3 ff 4a 10 01 02 5b 20 03 01', '3e 00', '3e 80'
  ])('allows %s', (request) => {
    expect(() => assertUdsAllowed(hex(request))).not.toThrow()
  })
})

describe('UdsClient', () => {
  it('throws NegativeResponseError with sid, nrc and name', async () => {
    const client = new UdsClient(new MockTransport(() => hex('7f 22 31')))
    const err = await client.readDataByIdentifier(0x12, [0xf40c]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NegativeResponseError)
    expect(err).toMatchObject({ sid: 0x22, nrc: 0x31, nrcName: 'requestOutOfRange' })
    expect((err as Error).message).toMatch(/0x31 requestOutOfRange/)
  })

  it('rejects responses for another service', async () => {
    const client = new UdsClient(new MockTransport(() => hex('63 00')))
    await expect(client.readDataByIdentifier(0x12, [0xf40c])).rejects.toBeInstanceOf(UdsProtocolError)
  })

  it('reads several DIDs in one request', async () => {
    const transport = new MockTransport(() => hex('62 f4 0c 1a f8 f4 0d 50 f4 05 7b'))
    const client = new UdsClient(transport)
    const values = await client.readDataByIdentifier(0x12, [0xf40c, 0xf40d, 0xf405], new Map([[0xf40c, 2], [0xf40d, 1], [0xf405, 1]]))
    expect(transport.sent[0]).toMatchObject({ target: 0x12, data: '22f40cf40df405' })
    expect([...values].map(([did, data]) => [did, data.toString('hex')])).toEqual([
      [0xf40c, '1af8'],
      [0xf40d, '50'],
      [0xf405, '7b']
    ])
  })

  it('passes a staleness check that only accepts the requested DIDs', async () => {
    const transport = new MockTransport(() => hex('62 f4 0c 1a f8'))
    await new UdsClient(transport).readDataByIdentifier(0x12, [0xf40c])
    const accept = transport.sent[0].opts?.accept
    expect(accept?.(hex('62 f4 0c 1a f8'))).toBe(true)
    expect(accept?.(hex('62 f4 0d 50'))).toBe(false)
  })

  it('reads a single DID without a known length', async () => {
    const client = new UdsClient(new MockTransport(() => hex('62 f1 01 01 02 03 04 05')))
    expect((await client.readDataByIdentifier(0x12, [0xf101])).get(0xf101)?.toString('hex')).toBe('0102030405')
  })

  it('applies default and per-call timeouts', async () => {
    const transport = new MockTransport(() => hex('62 f4 0c 1a f8'))
    const client = new UdsClient(transport, { timeoutMs: 700 })
    await client.readDataByIdentifier(0x12, [0xf40c])
    await client.readDataByIdentifier(0x12, [0xf40c], undefined, { timeoutMs: 200 })
    expect(transport.sent.map((s) => s.opts?.timeoutMs)).toEqual([700, 200])
  })

  it('reads the VIN', async () => {
    const client = new UdsClient(new MockTransport(() => Buffer.concat([hex('62 f1 90'), Buffer.from('WBATEST0000000001\0', 'latin1')])))
    expect(await client.readVin(0x12)).toBe('WBATEST0000000001')
  })

  it('encodes ReadMemoryByAddress', async () => {
    const transport = new MockTransport(() => hex('63 34 12'))
    const data = await new UdsClient(transport).readMemoryByAddress(0x12, 0xd0001234, 2)
    expect(transport.sent[0].data).toBe('2314d000123402')
    expect(data.toString('hex')).toBe('3412')
    await expect(new UdsClient(transport).readMemoryByAddress(0x12, 0x1_0000_0000, 2)).rejects.toBeInstanceOf(RangeError)
  })

  it('encodes dynamic DID definition and clearing', async () => {
    const transport = new MockTransport((d) => Buffer.from([0x6c, d[1], d[2], d[3]]))
    const client = new UdsClient(transport)
    await client.defineDidByMemory(0x12, 0xf300, [
      { address: 0xd0000010, size: 2 },
      { address: 0xd0000020, size: 4 }
    ])
    await client.clearDynamicDid(0x12, 0xf300)
    expect(transport.sent.map((s) => s.data)).toEqual(['2c02f30014d000001002d000002004', '2c03f300'])
  })

  it('refuses to define DIDs outside the dynamic range', async () => {
    const transport = new MockTransport()
    await expect(new UdsClient(transport).defineDidByMemory(0x12, 0xf190, [{ address: 0, size: 1 }])).rejects.toBeInstanceOf(UdsSafetyError)
    expect(transport.sent).toHaveLength(0)
  })

  it('encodes dynamic DID definition by identifier', async () => {
    const transport = new MockTransport((d) => Buffer.from([0x6c, d[1], d[2], d[3]]))
    await new UdsClient(transport).defineDidByIdentifier(0x12, 0xf301, [
      { sourceDid: 0x4a10, position: 1, size: 2 },
      { sourceDid: 0x5b20, position: 3, size: 1 },
      { sourceDid: 0x4c05, position: 1, size: 4 }
    ])
    expect(transport.sent).toEqual([{ target: 0x12, data: '2c01f3014a1001025b2003014c050104', opts: {} }])
  })

  it('blocks define-by-identifier outside F200..F3FF and rejects invalid entries before sending', async () => {
    const transport = new MockTransport((d) => Buffer.from([0x6c, d[1], d[2], d[3]]))
    const client = new UdsClient(transport)
    const entry = { sourceDid: 0x4a10, position: 1, size: 2 }
    for (const did of [0xf190, 0xf1ff, 0xf400, 0x4a10]) {
      await expect(client.defineDidByIdentifier(0x12, did, [entry])).rejects.toBeInstanceOf(UdsSafetyError)
    }
    await expect(client.defineDidByIdentifier(0x12, 0xf300, [])).rejects.toBeInstanceOf(RangeError)
    await expect(client.defineDidByIdentifier(0x12, 0xf300, [{ ...entry, position: 0 }])).rejects.toBeInstanceOf(RangeError)
    await expect(client.defineDidByIdentifier(0x12, 0xf300, [{ ...entry, size: 0 }])).rejects.toBeInstanceOf(RangeError)
    await expect(client.defineDidByIdentifier(0x12, 0xf300, [{ ...entry, size: 256 }])).rejects.toBeInstanceOf(RangeError)
    await expect(client.defineDidByIdentifier(0x12, 0xf300, [{ ...entry, sourceDid: 0x10000 }])).rejects.toBeInstanceOf(RangeError)
    expect(transport.sent).toHaveLength(0)
  })

  it('sends suppressed tester present without waiting for a response', async () => {
    const transport = new MockTransport()
    await new UdsClient(transport).testerPresent(0x12)
    expect(transport.sent[0]).toMatchObject({ data: '3e80', opts: { expectResponse: false } })
  })

  it('switches sessions and returns the timing record', async () => {
    const transport = new MockTransport(() => hex('50 03 00 32 01 f4'))
    expect((await new UdsClient(transport).sessionControl(0x12, 0x03)).toString('hex')).toBe('003201f4')
    expect(transport.sent[0].data).toBe('1003')
  })
})

describe('parseReadDataByIdentifierResponse', () => {
  const lengths = new Map([[0xf40c, 2], [0xf40d, 1], [0xf405, 1]])

  it('accepts DIDs the ECU omitted', () => {
    const values = parseReadDataByIdentifierResponse(hex('62 f4 0c 1a f8 f4 05 7b'), [0xf40c, 0xf40d, 0xf405], lengths)
    expect([...values.keys()]).toEqual([0xf40c, 0xf405])
  })

  it('rejects truncated responses', () => {
    expect(() => parseReadDataByIdentifierResponse(hex('62 f4 0c 1a f8 f4 0d'), [0xf40c, 0xf40d], lengths)).toThrow(UdsProtocolError)
    expect(() => parseReadDataByIdentifierResponse(hex('62 f4 0c 1a'), [0xf40c, 0xf40d], lengths)).toThrow(UdsProtocolError)
  })

  it('rejects unexpected and duplicated DIDs', () => {
    expect(() => parseReadDataByIdentifierResponse(hex('62 f4 0c 1a f8 f4 11 00'), [0xf40c, 0xf40d], lengths)).toThrow(/Unexpected DID/)
    expect(() => parseReadDataByIdentifierResponse(hex('62 f4 0d 01 f4 0d 02'), [0xf40c, 0xf40d], lengths)).toThrow(/Unexpected DID/)
  })

  it('detects a length mismatch as a malformed response', () => {
    // F40C actually returned 3 bytes: the parser lands mid-record and finds no valid DID.
    expect(() => parseReadDataByIdentifierResponse(hex('62 f4 0c 1a f8 00 f4 0d 50'), [0xf40c, 0xf40d], lengths)).toThrow(UdsProtocolError)
  })

  it('lets a DID of unknown length consume the rest', () => {
    const values = parseReadDataByIdentifierResponse(hex('62 f4 0c 1a f8 40 00 01 02 03'), [0xf40c, 0x4000], lengths)
    expect(values.get(0x4000)?.toString('hex')).toBe('010203')
  })
})
