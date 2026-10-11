// EnetAdapter with BMW DME data: diagnostic index (F150), DME channel layering, and fast
// block reads through dynamically defined DIDs by identifier (2C 01), with fallbacks.
// The DIDs and scalings used here are invented (see FAKE_DME_DID), not BMW data.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CH, type ChannelDef } from '@shared/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DmeChannelRead, DmeChannelSet, DmeDataResolver } from '../src/core/bmwdata/types'
import type { SampleFrame } from '../src/core/vehicle/adapter'
import { EnetAdapter, formatSgbdIndex, parseSgbdIndex, type EnetAdapterOptions } from '../src/core/vehicle/enet'
import { FAKE_DME_DID, FAKE_DME_DID_LENGTH, FakeGateway, type FakeGatewayOptions } from './fakeGateway'

const ALLOWED_SIDS = new Set([0x10, 0x19, 0x22, 0x23, 0x2c, 0x3e])
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const hex16 = (n: number): string => n.toString(16).padStart(4, '0')
const hex8 = (n: number): string => n.toString(16).padStart(2, '0')

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

// ------------------------------------------------------------------ fixture: invented DME data

const channel = (id: string, extra: Partial<ChannelDef> = {}): ChannelDef => ({
  id,
  name: id,
  group: 'DME',
  unit: '',
  quantity: 'none',
  decimals: 2,
  ...extra
})

function dmeRead(did: number, ch: ChannelDef, decode: (d: Buffer) => number, composable = true): DmeChannelRead {
  const length = FAKE_DME_DID_LENGTH[did]
  return { channel: ch, did, length, composable, decode: (d) => (d.length < length ? NaN : decode(d)) }
}

const RPM_NAME = 'Engine Speed (DME)'

/** A small DmeChannelSet over the fake DME's invented DIDs; `nonComposable` DIDs are flagged so. */
function testDmeSet(nonComposable: readonly number[] = []): DmeChannelSet {
  const read = (did: number, ch: ChannelDef, decode: (d: Buffer) => number): DmeChannelRead =>
    dmeRead(did, ch, decode, !nonComposable.includes(did))
  return {
    name: 'fake_dme · Invented Test DME',
    sgbd: 'fake_dme',
    ecuAddress: 0x12,
    reads: [
      read(FAKE_DME_DID.rpm, channel(CH.rpm, { name: RPM_NAME, group: 'Engine', unit: 'rpm', quantity: 'rpm', decimals: 0 }), (d) => d.readUInt16BE(0) / 2),
      read(FAKE_DME_DID.map, channel('dme.map', { unit: 'hPa', quantity: 'pressure' }), (d) => d.readUInt16BE(0)),
      read(FAKE_DME_DID.iat, channel('dme.iat', { unit: '°C', quantity: 'temperature' }), (d) => d[0] - 48),
      read(FAKE_DME_DID.baro, channel('dme.baro', { unit: 'hPa', quantity: 'pressure' }), (d) => d.readUInt16BE(0)),
      read(FAKE_DME_DID.ignition, channel('dme.ignition', { unit: '°', quantity: 'angle' }), (d) => d.readInt16BE(0) / 100),
      read(FAKE_DME_DID.lambda, channel('dme.lambda', { unit: 'λ', quantity: 'lambda' }), (d) => d.readUInt16LE(0) / 4096),
      read(FAKE_DME_DID.rail, channel('dme.rail', { unit: 'MPa', quantity: 'pressure' }), (d) => d.readUInt32BE(0) / 10_000)
    ],
    derived: [
      {
        channel: channel('dme.boost', { unit: 'bar', quantity: 'pressure' }),
        inputs: ['dme.map', 'dme.baro'],
        compute: ([map, baro]) => (map - baro) / 1000
      },
      // Mixes a DME and an OBD input.
      { channel: channel('dme.rpm_per_kmh'), inputs: [CH.rpm, CH.speed], compute: ([rpm, speed]) => rpm / speed },
      // Its input does not exist: dropped from the registry.
      { channel: channel('dme.orphan'), inputs: ['dme.nope'], compute: () => 0 }
    ]
  }
}

const DME_IDS = [CH.rpm, 'dme.map', 'dme.iat', 'dme.baro', 'dme.ignition', 'dme.lambda', 'dme.rail']
const DME_DIDS: number[] = Object.values(FAKE_DME_DID)
const STREAM_IDS = [...DME_IDS, 'dme.boost', 'dme.rpm_per_kmh', CH.speed]

async function connect(gwOpts: FakeGatewayOptions = {}, adapterOpts: Partial<EnetAdapterOptions> = {}, set: DmeChannelSet | null = testDmeSet()) {
  const gw = await FakeGateway.start(gwOpts)
  fake = gw
  const logs: string[] = []
  const resolver = vi.fn<DmeDataResolver>(() => set ?? undefined)
  const a = new EnetAdapter({ kind: 'enet', host: '127.0.0.1', port: gw.port, log: (m) => logs.push(m), dmeData: resolver, ...adapterOpts })
  adapter = a
  const info = await a.connect()
  return { gw, a, info, logs, resolver }
}

async function record(a: EnetAdapter, ids: string[], ms = 400) {
  const frames: SampleFrame[] = []
  const errors: Error[] = []
  const handle = await a.startStreaming(ids, (f) => frames.push(f), { onError: (e) => errors.push(e) })
  await sleep(ms)
  return {
    frames,
    errors,
    column: (id: string) => frames.map((f) => f.values[ids.indexOf(id)]),
    stop: () => handle.stop()
  }
}

/** Every DME value is finite and inside the fake engine model's range. */
function expectPlausibleDmeValues(column: (id: string) => number[]): void {
  const within = (id: string, min: number, max: number): void => {
    const values = column(id)
    expect(values.length).toBeGreaterThan(0)
    for (const v of values) {
      expect(Number.isFinite(v), `${id} = ${v}`).toBe(true)
      expect(v).toBeGreaterThanOrEqual(min)
      expect(v).toBeLessThanOrEqual(max)
    }
  }
  within(CH.rpm, 1500, 5500)
  within('dme.map', 1000, 2500)
  within('dme.iat', 35, 35)
  within('dme.baro', 1000, 1000)
  within('dme.ignition', 5, 25)
  within('dme.lambda', 0.8, 1.0)
  within('dme.rail', 5, 20)
}

const defineByIdentifierRequests = (gw: FakeGateway): string[] =>
  gw.requests.filter((r) => r.uds[0] === 0x2c && r.uds[1] === 0x01).map((r) => r.uds.toString('hex'))

/** Plain (non-dynamic) 0x22 reads of the invented DME DIDs. */
const plainDmeReads = (gw: FakeGateway): number[] => gw.didRequests().flat().filter((did) => DME_DIDS.includes(did))

function expectOnlyAllowedServices(gw: FakeGateway): void {
  for (const r of gw.requests) expect(ALLOWED_SIDS.has(r.uds[0])).toBe(true)
}

// ------------------------------------------------------------------ tests

describe('diagnostic index (F150)', () => {
  it('parses up to 4 bytes big-endian and formats at least 6 hex digits', () => {
    expect(parseSgbdIndex(Buffer.from([0x0f, 0x24, 0x26]))).toMatchObject({ value: 0x0f2426, hex: '0x0F2426' })
    expect(parseSgbdIndex(Buffer.from([0x00, 0x0f, 0x19, 0x10]))).toMatchObject({ value: 0xf1910, hex: '0x0F1910' })
    expect(parseSgbdIndex(Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a]))?.value).toBe(0x12345678)
    expect(parseSgbdIndex(Buffer.from([0x07]))?.hex).toBe('0x000007')
    expect(parseSgbdIndex(Buffer.alloc(0))).toBeUndefined()
    expect(formatSgbdIndex(0xab123456)).toBe('0xAB123456')
  })

  it('reads the index on connect and passes it to the DME data resolver', async () => {
    const { info, logs, resolver } = await connect()
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(resolver).toHaveBeenCalledWith(0x0f2426)
    expect(info.ecu).toMatchObject({ sgbdIndex: '0x0F2426', dmeData: 'fake_dme · Invented Test DME' })
    expect(logs.some((l) => l.includes('F150') && l.includes('raw [0f 24 26]') && l.includes('0x0F2426'))).toBe(true)
    expect(logs.some((l) => l.includes('using "fake_dme · Invented Test DME"'))).toBe(true)
  })

  it('handles a 4-byte index', async () => {
    const { info, resolver } = await connect({ sgbdIndex: Buffer.from([0x00, 0x0f, 0x19, 0x10]) })
    expect(resolver).toHaveBeenCalledWith(0xf1910)
    expect(info.ecu?.sgbdIndex).toBe('0x0F1910')
  })

  it('connects without F150 and without matching DME data', async () => {
    const { a, info, logs, resolver } = await connect({ sgbdIndex: null }, {}, null)
    expect(resolver).toHaveBeenCalledWith(undefined)
    expect(info.ecu?.sgbdIndex).toBeUndefined()
    expect(info.ecu?.dmeData).toBeUndefined()
    expect(logs.some((l) => /BMW DME data: none for an unreadable diagnostic index/.test(l))).toBe(true)
    expect(a.channels().some((c) => c.id.startsWith('dme.'))).toBe(false)
    expect(a.channels().map((c) => c.id)).toContain(CH.rpm)
  })

  it('survives a resolver that throws', async () => {
    const gw = await FakeGateway.start()
    fake = gw
    const logs: string[] = []
    adapter = new EnetAdapter({
      kind: 'enet',
      host: '127.0.0.1',
      port: gw.port,
      log: (m) => logs.push(m),
      dmeData: () => {
        throw new Error('pack corrupt')
      }
    })
    const info = await adapter.connect()
    expect(info.ecu?.dmeData).toBeUndefined()
    expect(logs.some((l) => l.includes('pack corrupt'))).toBe(true)
  })
})

describe('DME channel registry', () => {
  it('adds DME channels over the OBD ones; user definition sets win over both', async () => {
    const plain = await connect({}, {}, null)
    const obdIds = plain.a.channels().map((c) => c.id)
    await plain.a.disconnect()
    await plain.gw.close()

    tmp = await mkdtemp(join(tmpdir(), 'boostline-dme-'))
    await writeFile(
      join(tmp, 'user.json'),
      JSON.stringify({
        name: 'User IAT',
        match: { softwareVersions: [] },
        channels: [
          {
            id: 'dme.iat',
            name: 'IAT (user)',
            group: 'Custom',
            unit: '°C',
            quantity: 'temperature',
            decimals: 0,
            source: { type: 'did', did: '0x4C05', length: 1, didLength: 1, add: -48 }
          }
        ]
      })
    )
    const { a, logs } = await connect({}, { definitionsDir: tmp })
    const channels = a.channels()
    const ids = channels.map((c) => c.id)
    // Replaced channels keep their position; new ones are appended.
    expect(ids.slice(0, obdIds.length)).toEqual(obdIds)
    expect(ids).toEqual(expect.arrayContaining([...DME_IDS, 'dme.boost', 'dme.rpm_per_kmh']))
    expect(ids.filter((id) => id === CH.rpm)).toHaveLength(1)
    expect(channels.find((c) => c.id === CH.rpm)?.name).toBe(RPM_NAME)
    expect(channels.find((c) => c.id === 'dme.iat')?.name).toBe('IAT (user)')
    expect(ids).not.toContain('dme.orphan')
    expect(logs.some((l) => l.includes('dme.orphan') && l.includes('dme.nope'))).toBe(true)

    // The user's DID source is plain (not composable); it still streams.
    const { column, errors, stop } = await record(a, ['dme.iat', CH.rpm, 'dme.map'], 250)
    await stop()
    expect(errors).toEqual([])
    expect(column('dme.iat').at(-1)).toBe(35)
  })
})

describe('DME streaming through dynamic DIDs', () => {
  it('composes DME DIDs with 2C 01, reads the dynamic DID and clears it on stop', async () => {
    const { gw, a, logs } = await connect()
    const set = testDmeSet()
    const { frames, errors, column, stop } = await record(a, STREAM_IDS)
    expect(errors).toEqual([])
    expect(frames.length).toBeGreaterThan(3)
    expectPlausibleDmeValues(column)

    // One dynamic DID holding every DME DID as a whole record, in channel order.
    const expected = `2c01f300${set.reads.map((r) => `${hex16(r.did)}01${hex8(r.length)}`).join('')}`
    expect(defineByIdentifierRequests(gw)).toEqual([expected])
    expect(gw.didRequests().some((dids) => dids.includes(0xf300))).toBe(true)
    expect(plainDmeReads(gw)).toEqual([])
    expect(logs.some((l) => /7 DIDs composed into 1 dynamic DID\(s\) 0xF300/.test(l))).toBe(true)

    // Derived channels: DME-only inputs and mixed DME / OBD inputs.
    const map = column('dme.map')
    const baro = column('dme.baro')
    column('dme.boost').forEach((boost, i) => expect(boost).toBeCloseTo((map[i] - baro[i]) / 1000, 9))
    const rpm = column(CH.rpm)
    const speed = column(CH.speed)
    column('dme.rpm_per_kmh').forEach((v, i) => expect(v).toBeCloseTo(rpm[i] / speed[i], 9))

    expect(gw.definedDynamicDids()).toEqual([0xf300])
    await stop()
    expect(gw.definedDynamicDids()).toEqual([])
    expect(gw.requests.at(-1)?.uds.toString('hex')).toBe('2c03f300')
    expectOnlyAllowedServices(gw)
  })

  it.each<[string, FakeGatewayOptions, RegExp]>([
    ['2C not supported at all', { dynamicDids: 'none' }, /NRC 0x11/],
    ['2C 01 not supported', { defineByIdentifier: false }, /NRC 0x12/]
  ])('falls back to plain DID reads when %s', async (_name, gwOpts, reason) => {
    const { gw, a, logs } = await connect(gwOpts)
    const { frames, errors, column, stop } = await record(a, STREAM_IDS)
    await stop()
    expect(errors).toEqual([])
    expect(frames.length).toBeGreaterThan(3)
    expectPlausibleDmeValues(column)
    expect(new Set(plainDmeReads(gw))).toEqual(new Set(DME_DIDS))
    // Plain DME DIDs still share multi-DID requests.
    expect(gw.didRequests().some((dids) => dids.filter((d) => DME_DIDS.includes(d)).length > 1)).toBe(true)
    // Refused once; not retried for further chunks or passes.
    expect(gw.requests.filter((r) => r.uds[0] === 0x2c && r.uds[1] === 0x01)).toHaveLength(1)
    const fallback = logs.filter((l) => l.includes('read individually instead of composed'))
    expect(fallback).toHaveLength(1)
    expect(fallback[0]).toMatch(reason)
    expect(gw.definedDynamicDids()).toEqual([])
  })

  it('halves dynamic DIDs the ECU finds too big and keeps the smaller entry count', async () => {
    const { gw, a, logs } = await connect({ maxDynamicDidEntries: 3 })
    const { errors, column, stop } = await record(a, STREAM_IDS)
    expect(errors).toEqual([])
    expectPlausibleDmeValues(column)
    expect(plainDmeReads(gw)).toEqual([])
    // 7 entries refused, 4 refused, 2 + 2 accepted, 3 accepted.
    expect(defineByIdentifierRequests(gw).map((r) => (r.length / 2 - 4) / 4)).toEqual([7, 4, 2, 2, 3])
    expect(gw.definedDynamicDids()).toEqual([0xf300, 0xf301, 0xf302])
    expect(logs.some((l) => /7 DIDs composed into 3 dynamic DID\(s\) 0xF300\.\.0xF302 \(2C 01\); at most 2 entries/.test(l))).toBe(true)
    await stop()
    expect(gw.definedDynamicDids()).toEqual([])
  })

  it('reads DIDs that cannot be composed as plain DIDs and composes the rest', async () => {
    // lambda: the ECU refuses to compose it; rail: flagged non-composable by the data.
    const { gw, a, logs } = await connect({ nonComposableDids: [FAKE_DME_DID.lambda] }, {}, testDmeSet([FAKE_DME_DID.rail]))
    const { errors, column, stop } = await record(a, STREAM_IDS)
    await stop()
    expect(errors).toEqual([])
    expectPlausibleDmeValues(column)
    expect(new Set(plainDmeReads(gw))).toEqual(new Set([FAKE_DME_DID.lambda, FAKE_DME_DID.rail]))
    expect(defineByIdentifierRequests(gw).some((r) => r.includes(hex16(FAKE_DME_DID.rail)))).toBe(false)
    expect(logs.some((l) => /5 DIDs composed into 2 dynamic DID/.test(l))).toBe(true)
    expect(logs.some((l) => /1 DID\(s\) read individually.*NRC 0x31.*0x5B47/.test(l))).toBe(true)
  })

  it('switches to the extended session when the ECU wants it, and back on stop', async () => {
    const { gw, a } = await connect({ dynamicDids: 'extended' })
    const { errors, column, stop } = await record(a, STREAM_IDS, 300)
    await stop()
    expect(errors).toEqual([])
    expectPlausibleDmeValues(column)
    expect(plainDmeReads(gw)).toEqual([])
    const sent = gw.requests.map((r) => r.uds.toString('hex'))
    expect(sent.filter((s) => s === '1003')).toHaveLength(1)
    expect(sent.slice(-2)).toEqual(['2c03f300', '1001'])
  })

  it('numbers RAM and DME dynamic DIDs from one counter and clears both', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'boostline-dme-'))
    await writeFile(
      join(tmp, 'ram.json'),
      JSON.stringify({
        name: 'RAM',
        match: { softwareVersions: [] },
        channels: [
          { id: 'ram.a', name: 'RAM a', group: 'Custom', unit: '', quantity: 'none', source: { type: 'memory', address: '0xD0001000', size: 2 } },
          { id: 'ram.b', name: 'RAM b', group: 'Custom', unit: '', quantity: 'none', source: { type: 'memory', address: '0xD0001010', size: 1, signed: true } }
        ]
      })
    )
    const ram: Record<number, number[]> = { 0xd0001000: [0x34, 0x12], 0xd0001010: [0xf6] }
    const memory = (address: number, size: number): Buffer | undefined =>
      ram[address]?.length === size ? Buffer.from(ram[address]) : undefined
    const { gw, a } = await connect({ memory }, { definitionsDir: tmp })
    const { errors, column, stop } = await record(a, [...STREAM_IDS, 'ram.a', 'ram.b'], 300)
    expect(errors).toEqual([])
    expectPlausibleDmeValues(column)
    expect(column('ram.a').at(-1)).toBe(0x1234)
    expect(column('ram.b').at(-1)).toBe(-10)
    const sent = gw.requests.map((r) => r.uds.toString('hex'))
    expect(sent).toContain('2c02f30014d000100002d000101001')
    expect(sent.some((s) => s.startsWith('2c01f301'))).toBe(true)
    expect(gw.definedDynamicDids()).toEqual([0xf300, 0xf301])
    await stop()
    expect(gw.definedDynamicDids()).toEqual([])
    const after = gw.requests.map((r) => r.uds.toString('hex'))
    expect(after).toEqual(expect.arrayContaining(['2c03f300', '2c03f301']))
  })
})

describe('OBD fallback', () => {
  it('reads a channel from OBD-II again when the ECU refuses its DME measurement', async () => {
    // This "car" has no rpm or MAP measurement. Engine speed goes back to OBD PID 0C, and
    // boost (a DME channel derived from dme.map here) to its OBD version from PIDs 0B and 33.
    // dme.map has no OBD version and stays blank, as does dme.boost, derived from it.
    const set = testDmeSet()
    set.derived.push({
      channel: channel(CH.boostActual, { name: 'Boost (DME)', unit: 'bar', quantity: 'pressure' }),
      inputs: ['dme.map', 'dme.baro'],
      compute: ([map, baro]) => (map - baro) / 1000
    })
    const { gw, a, logs } = await connect({ missingDids: [FAKE_DME_DID.rpm, FAKE_DME_DID.map] }, {}, set)
    const ids = [CH.rpm, 'dme.map', 'dme.iat', CH.boostActual, 'dme.boost']
    const { frames, errors, column, stop } = await record(a, ids, 500)
    await stop()

    const last = frames.at(-1)
    expect(last).toBeDefined()
    const value = (id: string): number => last?.values[ids.indexOf(id)] ?? NaN
    expect(value(CH.rpm)).toBeGreaterThanOrEqual(1500)
    expect(value(CH.rpm)).toBeLessThanOrEqual(5500)
    expect(value(CH.boostActual)).toBeGreaterThanOrEqual(-0.05)
    expect(value(CH.boostActual)).toBeLessThanOrEqual(1.45)
    expect(value('dme.iat')).toBe(35)
    expect(value('dme.map')).toBeNaN()
    expect(value('dme.boost')).toBeNaN()
    expect(column(CH.rpm).filter(Number.isFinite).length).toBeGreaterThan(3)

    // The OBD PIDs are read, and the switch is reported once per refused DID.
    const read = new Set(gw.didRequests().flat())
    for (const did of [0xf40c, 0xf40b, 0xf433]) expect(read.has(did)).toBe(true)
    expect(errors.map((e) => e.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/DID 0x4A10 .*unavailable.*; using the standard OBD-II reading for engine\.rpm$/),
        expect.stringMatching(/DID 0x4B22 .*unavailable.*; using the standard OBD-II reading for boost\.actual; not polling dme\.map$/)
      ])
    )
    expect(errors).toHaveLength(2)
    expect(logs.filter((l) => l.startsWith('Using the standard OBD-II reading'))).toHaveLength(2)
    expectOnlyAllowedServices(gw)
  })

  it('keeps the OBD channels of a car without BMW DME data unchanged', async () => {
    const { a } = await connect({}, {}, null)
    const { errors, column, stop } = await record(a, [CH.rpm, CH.boostActual], 250)
    await stop()
    expect(errors).toEqual([])
    expect(Number.isFinite(column(CH.rpm).at(-1))).toBe(true)
  })
})
