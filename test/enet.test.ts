import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CH } from '@shared/types'
import { afterEach, describe, expect, it } from 'vitest'
import type { SampleFrame } from '../src/core/vehicle/adapter'
import { decodeValue, loadDefinitionFiles, parseDefinitionSet, selectDefinitionSets } from '../src/core/vehicle/definitions'
import { EnetAdapter, formatSvkEntry, parseSvk, type EnetAdapterOptions } from '../src/core/vehicle/enet'
import { runProbe } from '../src/core/vehicle/probe'
import { FAKE_SOFTWARE, FAKE_SVK, FAKE_VIN, FakeGateway, type FakeGatewayOptions } from './fakeGateway'

const ALLOWED_SIDS = new Set([0x10, 0x19, 0x22, 0x23, 0x2c, 0x3e])
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let fake: FakeGateway | undefined
let adapter: EnetAdapter | undefined
let tmp: string | undefined

afterEach(async () => {
  await adapter?.disconnect()
  await fake?.close()
  if (tmp) await rm(tmp, { recursive: true, force: true })
  adapter = undefined
  fake = undefined
  tmp = undefined
})

async function connect(gwOpts: FakeGatewayOptions = {}, adapterOpts: Partial<EnetAdapterOptions> = {}) {
  const gw = await FakeGateway.start(gwOpts)
  fake = gw
  const logs: string[] = []
  const a = new EnetAdapter({ kind: 'enet', host: '127.0.0.1', port: gw.port, log: (m) => logs.push(m), ...adapterOpts })
  adapter = a
  const info = await a.connect()
  return { gw, a, info, logs }
}

async function record(a: EnetAdapter, ids: string[], ms = 500, maxRateHz?: number) {
  const frames: SampleFrame[] = []
  const errors: Error[] = []
  const handle = await a.startStreaming(ids, (f) => frames.push(f), { maxRateHz, onError: (e) => errors.push(e) })
  await sleep(ms)
  await handle.stop()
  return { frames, errors, column: (id: string) => frames.map((f) => f.values[ids.indexOf(id)]) }
}

function expectOnlyAllowedServices(gw: FakeGateway): void {
  for (const r of gw.requests) expect(ALLOWED_SIDS.has(r.uds[0])).toBe(true)
}

// ------------------------------------------------------------------ RAM / definitions fixture

const RAM: Record<number, number[]> = { 0xd0001000: [0x34, 0x12], 0xd0001010: [0xf6] }
const memory = (address: number, size: number): Buffer | undefined => {
  const bytes = RAM[address]
  return bytes && bytes.length === size ? Buffer.from(bytes) : undefined
}

const ch = (id: string, source: object) => ({ id, name: id, group: 'Custom', unit: '', quantity: 'none', decimals: 2, source })
const DEFINITION = {
  name: 'Test RAM',
  match: { softwareVersions: ['SWFL_00002A6F_'] },
  channels: [
    { ...ch('boost.target', { type: 'memory', address: '0xD0001000', size: 2, scale: 0.001 }), group: 'Boost', unit: 'bar', quantity: 'pressure' },
    ch('custom.knock1', { type: 'memory', address: '0xD0001010', size: 1, signed: true, scale: 0.1 }),
    ch('custom.did', { type: 'did', did: '0x4000', offset: 1, length: 2, didLength: 4, scale: 0.5 }),
    ch('custom.missing', { type: 'did', did: 16385, length: 2, didLength: 2 })
  ]
}
const OTHER = { name: 'Other DME', match: { softwareVersions: ['^NOPE'] }, channels: [ch('custom.other', { type: 'did', did: 1, length: 1 })] }

async function definitionsDir(): Promise<string> {
  tmp = await mkdtemp(join(tmpdir(), 'boostline-defs-'))
  await writeFile(join(tmp, 'ram.json'), JSON.stringify(DEFINITION))
  await writeFile(join(tmp, 'other.json'), JSON.stringify(OTHER))
  await writeFile(join(tmp, 'broken.json'), '{ "name": 1 }')
  return tmp
}

const ramGateway: FakeGatewayOptions = { memory, dids: { 0x4000: Buffer.from([0x00, 0x01, 0x90, 0xff]) } }
const RAM_IDS = ['boost.target', 'custom.knock1', 'custom.did']

// ------------------------------------------------------------------ tests

describe('EnetAdapter against the fake gateway', () => {
  it('connects, identifies the car and lists its channels', async () => {
    const { gw, a, info } = await connect()
    expect(info.vin).toBe(FAKE_VIN)
    expect(info.label).toBe(`ENET · 127.0.0.1:${gw.port}`)
    expect(info.endpoint).toBe(`127.0.0.1:${gw.port}`)
    expect(info.ecu).toMatchObject({ address: 0x12, softwareVersion: FAKE_SOFTWARE, hardwareNumber: 'HWEL_00001234_001_002_003', sgbdIndex: '0x0F2426' })
    expect(info.ecu?.dmeData).toBeUndefined()
    const ids = a.channels().map((c) => c.id)
    expect(ids).toEqual(expect.arrayContaining([CH.rpm, CH.speed, CH.pedal, CH.throttle, CH.iat, CH.baro, CH.boostActual, CH.torqueActual, CH.lambdaActual]))
    expect(ids).not.toContain('fuel.rail.actual')
    expectOnlyAllowedServices(gw)
  })

  it('streams frames with live values', async () => {
    const { gw, a } = await connect()
    const ids = a.channels().map((c) => c.id)
    const { frames, errors, column } = await record(a, ids)
    expect(errors).toEqual([])
    expect(frames.length).toBeGreaterThan(5)
    for (const f of frames) expect(f.values).toHaveLength(ids.length)
    for (const rpm of column(CH.rpm)) expect(rpm).toBeGreaterThanOrEqual(1500)
    for (const rpm of column(CH.rpm)) expect(rpm).toBeLessThanOrEqual(5500)
    const map = column('boost.map')
    column(CH.boostActual).forEach((boost, i) => expect(boost).toBeCloseTo(map[i] - 1.0, 6))
    const torquePct = column('obd.torque_actual_pct')
    column(CH.torqueActual).forEach((nm, i) => expect(nm).toBeCloseTo((torquePct[i] * 600) / 100, 6))
    for (let i = 1; i < frames.length; i++) expect(frames[i].t).toBeGreaterThan(frames[i - 1].t)
    expect(frames[0].t).toBeGreaterThanOrEqual(0)
    expect(gw.didRequests().some((dids) => dids.length === 8)).toBe(true)
    expectOnlyAllowedServices(gw)
  })

  it('splits multi-DID requests when the ECU rejects their size and remembers it', async () => {
    const { gw, a, logs } = await connect({ maxDidsPerRequest: 3 })
    const { frames, errors, column } = await record(a, a.channels().map((c) => c.id), 400)
    expect(errors).toEqual([])
    expect(frames.length).toBeGreaterThan(3)
    for (const rpm of column(CH.rpm)) expect(Number.isFinite(rpm)).toBe(true)
    const requests = gw.didRequests()
    expect(requests.some((dids) => dids.length > 3)).toBe(true)
    for (const dids of requests.slice(-10)) expect(dids.length).toBeLessThanOrEqual(3)
    expect(logs.some((l) => /now using 2/.test(l))).toBe(true)
  })

  it('respects maxRateHz', async () => {
    const { a } = await connect()
    const { frames } = await record(a, [CH.rpm], 500, 20)
    expect(frames.length).toBeGreaterThanOrEqual(5)
    expect(frames.length).toBeLessThanOrEqual(12)
  })

  it('copes with response-pending and fragmented TCP delivery', async () => {
    const { a } = await connect({ pendingEvery: 5, pendingDelayMs: 10, writeMode: 'fragmented', aliveCheckIntervalMs: 100 })
    const { frames, errors, column } = await record(a, [CH.rpm, CH.speed, CH.boostActual], 400)
    expect(errors).toEqual([])
    expect(frames.length).toBeGreaterThan(3)
    for (const rpm of column(CH.rpm)) expect(Number.isFinite(rpm)).toBe(true)
  })

  it('streams NaN for unknown channels', async () => {
    const { a } = await connect()
    const { frames, errors } = await record(a, ['nope.channel', CH.rpm], 200)
    expect(errors).toEqual([])
    expect(frames[0].values[0]).toBeNaN()
    expect(Number.isFinite(frames[0].values[1])).toBe(true)
  })

  it('logs RAM and custom DID channels through dynamic DIDs', async () => {
    const dir = await definitionsDir()
    const { gw, a, info, logs } = await connect(ramGateway, { definitionsDir: dir })
    expect(info.ecu?.definitionSet).toBe('Test RAM')
    const ids = a.channels().map((c) => c.id)
    expect(ids).toEqual(expect.arrayContaining([...RAM_IDS, 'custom.missing']))
    expect(ids).not.toContain('custom.other')
    expect(logs.some((l) => l.includes('broken.json') && l.includes('skipped'))).toBe(true)

    const { frames, errors, column } = await record(a, [...ids], 400)
    expect(frames.length).toBeGreaterThan(3)
    expect(column('boost.target').at(-1)).toBeCloseTo(4.66, 6)
    expect(column('custom.knock1').at(-1)).toBeCloseTo(-1.0, 6)
    expect(column('custom.did').at(-1)).toBe(200)
    expect(column('custom.missing').at(-1)).toBeNaN()
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toMatch(/0x4001.*custom\.missing/)
    // The unsupported DID was isolated without shrinking the batch size.
    expect(gw.didRequests().slice(-5).some((dids) => dids.length === 8)).toBe(true)

    const sent = gw.requests.map((r) => r.uds.toString('hex'))
    expect(sent).toContain('2c02f30014d000100002d000101001')
    expect(sent.at(-1)).toBe('2c03f300')
    expect(sent.some((s) => s.startsWith('23'))).toBe(false)
    expectOnlyAllowedServices(gw)
  })

  it('enters the extended session when dynamic DIDs need it, and leaves it on stop', async () => {
    const dir = await definitionsDir()
    const { gw, a } = await connect({ ...ramGateway, dynamicDids: 'extended' }, { definitionsDir: dir })
    const { errors, column } = await record(a, RAM_IDS, 300)
    expect(errors).toEqual([])
    expect(column('boost.target').at(-1)).toBeCloseTo(4.66, 6)
    const sent = gw.requests.map((r) => r.uds.toString('hex'))
    expect(sent).toContain('1003')
    expect(sent.at(-1)).toBe('1001')
  })

  it('falls back to ReadMemoryByAddress without dynamic DIDs', async () => {
    const dir = await definitionsDir()
    const { gw, a } = await connect({ ...ramGateway, dynamicDids: 'none' }, { definitionsDir: dir })
    const { errors, column } = await record(a, RAM_IDS, 300)
    expect(errors).toEqual([])
    expect(column('boost.target').at(-1)).toBeCloseTo(4.66, 6)
    expect(column('custom.knock1').at(-1)).toBeCloseTo(-1.0, 6)
    expect(gw.requests.some((r) => r.uds.toString('hex') === '2314d000100002')).toBe(true)
  })

  it('reports a lost connection once and stops', async () => {
    const { gw, a } = await connect()
    const frames: SampleFrame[] = []
    const errors: Error[] = []
    const handle = await a.startStreaming([CH.rpm], (f) => frames.push(f), { onError: (e) => errors.push(e) })
    await sleep(150)
    gw.dropConnections()
    for (let i = 0; i < 40 && errors.length === 0; i++) await sleep(25)
    await handle.stop()
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toMatch(/lost/)
    const count = frames.length
    await sleep(100)
    expect(frames.length).toBe(count)
    await expect(a.startStreaming([CH.rpm], () => undefined)).rejects.toThrow(/Not connected/)
  })

  it('refuses to connect when the DME is silent', async () => {
    const gw = await FakeGateway.start({ dmeOnline: false })
    fake = gw
    adapter = new EnetAdapter({ kind: 'mhd-wifi', host: '127.0.0.1', port: gw.port })
    await expect(adapter.connect()).rejects.toThrow(/VIN WBATEST0000000001.*ignition/)
    expect(gw.requests.some((r) => r.target === 0x10)).toBe(true)
  }, 10_000)

  it('probes PIDs one by one when the bitmask DIDs are missing', async () => {
    const { a } = await connect({ supportedPidMasks: false })
    expect(a.channels().map((c) => c.id)).toEqual(expect.arrayContaining([CH.rpm, CH.boostActual]))
  })

  it('finds the gateway through UDP discovery', async () => {
    const gw = await FakeGateway.start({ udp: true })
    fake = gw
    adapter = new EnetAdapter({ kind: 'enet', port: gw.port, discoveryPort: gw.udpPort, discoveryTargets: ['127.0.0.1'] })
    const info = await adapter.connect()
    expect(info.endpoint).toBe(`127.0.0.1:${gw.port}`)
    expect(info.vin).toBe(FAKE_VIN)
  })

  it('stops the stream on disconnect', async () => {
    const { gw, a } = await connect()
    const frames: SampleFrame[] = []
    await a.startStreaming([CH.rpm], (f) => frames.push(f))
    await sleep(100)
    await a.disconnect()
    const count = frames.length
    const requests = gw.requests.length
    await sleep(100)
    expect(frames.length).toBe(count)
    expect(gw.requests.length).toBe(requests)
    expect(a.channels()).toEqual([])
  })
})

describe('SVK parsing', () => {
  it('parses process class, SGBM id and version', () => {
    const entries = parseSvk(FAKE_SVK)
    expect(entries?.map(formatSvkEntry)).toEqual(['HWEL_00001234_001_002_003', 'BTLD_00001F2E_002_003_004', 'SWFL_00002A6F_005_100_010'])
  })

  it('rejects unknown layouts', () => {
    expect(parseSvk(Buffer.from([0x01, 0x01, 0x00, 0x02, 0xee, 0, 0, 0, 0, 0, 0, 0]))).toBeUndefined()
    expect(parseSvk(Buffer.from([0x01]))).toBeUndefined()
  })
})

describe('definition files', () => {
  it('validates and reports every problem', () => {
    const { set, errors } = parseDefinitionSet(
      {
        name: 'Bad',
        ecuAddress: '0x1FF',
        match: { softwareVersions: ['('] },
        channels: [
          { id: 'a b', name: 'x', group: 'Nope', unit: '', quantity: 'none', decimals: 1, source: { type: 'did', did: 1, length: 3, float: true } },
          { id: 'ok', name: 'ok', group: 'Custom', unit: '', quantity: 'none', decimals: 1, source: { type: 'memory', address: -1, size: 2 } }
        ]
      },
      'bad.json'
    )
    expect(set).toBeUndefined()
    expect(errors.join('\n')).toMatch(/ecuAddress/)
    expect(errors.join('\n')).toMatch(/softwareVersions\[0\]/)
    expect(errors.join('\n')).toMatch(/channels\[0\]\.id/)
    expect(errors.join('\n')).toMatch(/channels\[0\]\.group/)
    expect(errors.join('\n')).toMatch(/float values need 4 or 8 bytes/)
    expect(errors.join('\n')).toMatch(/channels\[1\]\.source\.address/)
  })

  it('loads a folder, skipping invalid files, and selects by software version', async () => {
    const dir = await definitionsDir()
    const invalid: string[] = []
    const sets = await loadDefinitionFiles(dir, (file) => invalid.push(file))
    expect(sets.map((s) => s.name).sort()).toEqual(['Other DME', 'Test RAM'])
    expect(invalid).toEqual([join(dir, 'broken.json')])
    expect(selectDefinitionSets(sets, FAKE_SOFTWARE).map((s) => s.name)).toEqual(['Test RAM'])
    expect(selectDefinitionSets(sets, undefined)).toEqual([])
    expect(await loadDefinitionFiles(join(dir, 'missing'))).toEqual([])
  })

  it('decodes integers and floats in either byte order', () => {
    const enc = { signed: false, float: false, endian: 'big' as const, scale: 1, add: 0 }
    expect(decodeValue(Buffer.from([0x12, 0x34]), 0, 2, enc)).toBe(0x1234)
    expect(decodeValue(Buffer.from([0x12, 0x34]), 0, 2, { ...enc, endian: 'little' })).toBe(0x3412)
    expect(decodeValue(Buffer.from([0xff, 0xfe]), 0, 2, { ...enc, signed: true, scale: 0.5, add: 10 })).toBe(9)
    const f = Buffer.alloc(4)
    f.writeFloatLE(1.5)
    expect(decodeValue(f, 0, 4, { ...enc, float: true, endian: 'little' })).toBe(1.5)
    expect(decodeValue(Buffer.from([1]), 0, 2, enc)).toBeNaN()
  })
})

describe('probe', () => {
  it('finds the fake gateway and writes a capture', async () => {
    const gw = await FakeGateway.start({ udp: true })
    fake = gw
    tmp = await mkdtemp(join(tmpdir(), 'boostline-probe-'))
    const capturePath = join(tmp, 'capture.txt')
    const report = await runProbe({
      kind: 'mhd-wifi',
      host: '127.0.0.1',
      capturePath,
      ports: [],
      hsfzPort: gw.port,
      discovery: { port: gw.udpPort, targets: ['127.0.0.1'], timeoutMs: 300 }
    })
    expect(report.summary).toMatch(
      new RegExp(`^HSFZ gateway found at 127\\.0\\.0\\.1:${gw.port}, VIN ${FAKE_VIN}, DME responding, SGBD index 0x0F2426 \\[0f 24 26\\]`)
    )
    expect(report.discovery.replies).toHaveLength(1)
    expect(report.hsfz[0]).toMatchObject({ vin: FAKE_VIN, vinSource: 'DME', softwareVersion: FAKE_SOFTWARE, sgbdIndex: '0x0F2426', sgbdIndexRaw: '0f 24 26' })
    expect(report.hsfz[0].obdPids).toHaveLength(15)
    expect(report.hsfz[0].multiDidRead).toMatch(/^ok/)
    expect(report.capturePath).toBe(capturePath)
    expect(JSON.parse(JSON.stringify(report)).summary).toBe(report.summary)
    const capture = await readFile(capturePath, 'utf8')
    expect(capture).toContain('00 00 00 05 00 01 f4 12 22 f1 90')
    expect(capture).toMatch(/UDP 127\.0\.0\.1:\d+ RX/)
    for (const r of gw.requests) expect(ALLOWED_SIDS.has(r.uds[0])).toBe(true)
  })
})
