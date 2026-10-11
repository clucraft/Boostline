import { CH } from '@shared/types'
import { describe, expect, it } from 'vitest'
import {
  OBD_DERIVED,
  OBD_PIDS,
  SUPPORTED_PID_DIDS,
  buildObdPlan,
  obdDid,
  parseSupportedPids
} from '../src/core/vehicle/obdChannels'

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex')
const decode = (pid: number, data: string): number => {
  const def = OBD_PIDS.find((p) => p.pid === pid)
  if (!def) throw new Error(`no decoder for PID ${pid}`)
  return def.decode(hex(data))
}

describe('OBD decoders', () => {
  it.each([
    [0x0c, '1a f8', 1726],
    [0x0d, '64', 100],
    [0x05, '7b', 83],
    [0x0f, '28', 0],
    [0x46, '00', -40],
    [0x5c, 'a5', 125],
    [0x0b, '65', 1.01],
    [0x33, '64', 1.0],
    [0x11, 'ff', 100],
    [0x49, '80', (128 * 100) / 255],
    [0x04, '00', 0],
    [0x06, '80', 0],
    [0x07, '00', -100],
    [0x0e, '80', 0],
    [0x10, '01 f4', 5],
    [0x1f, '01 00', 256],
    [0x23, '0d ac', 350],
    [0x34, '80 00 80 00', 1.0],
    [0x24, '73 33 00 00', 0.9],
    [0x44, '80 00', 1.0],
    [0x3c, '1f 40', 760],
    [0x42, '3a 98', 15],
    [0x43, '00 ff', 100],
    [0x5e, '00 c8', 10],
    [0x61, 'e1', 100],
    [0x62, '7d', 0],
    [0x63, '02 58', 600],
    [0xa4, '02 30 0d 48', 3]
  ])('PID %i decodes %s', (pid, data, value) => {
    expect(decode(pid, data)).toBeCloseTo(value, 3)
  })

  it('returns NaN for short data and invalid gear', () => {
    expect(decode(0x0c, '1a')).toBeNaN()
    expect(decode(0xa4, '00 30 0d 48')).toBeNaN()
  })

  it('maps PIDs to F4xx DIDs', () => {
    expect(obdDid(0x0c)).toBe(0xf40c)
    for (const p of OBD_PIDS) expect(p.did).toBe(0xf400 + p.pid)
  })

  it('uses the well-known ids and unique channel ids per PID', () => {
    const ids = OBD_PIDS.map((p) => p.channel.id)
    for (const id of [CH.rpm, CH.speed, CH.pedal, CH.throttle, CH.iat, CH.ambientTemp, CH.baro, CH.lambdaActual, CH.gear]) {
      expect(ids).toContain(id)
    }
    // Only the lambda alternatives (0x34 / 0x24) share an id.
    expect(ids.length - new Set(ids).size).toBe(1)
    expect(OBD_PIDS.find((p) => p.channel.id === CH.baro)?.channel.unit).toBe('bar')
  })
})

describe('supported PID bitmasks', () => {
  it('parses the classic BE1FA813 example', () => {
    expect(parseSupportedPids(0xf400, hex('be 1f a8 13'))).toEqual([
      0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x13, 0x15, 0x1c, 0x1f, 0x20
    ])
  })

  it('offsets by the bitmask DID', () => {
    expect(parseSupportedPids(0xf440, hex('40 00 00 01'))).toEqual([0x42, 0x60])
  })

  it('covers F400..F4A0', () => {
    expect(SUPPORTED_PID_DIDS[0]).toBe(0xf400)
    expect(SUPPORTED_PID_DIDS.at(-1)).toBe(0xf4a0)
  })
})

describe('buildObdPlan', () => {
  it('offers derived boost when MAP and baro are supported', () => {
    const plan = buildObdPlan(new Set([0x0b, 0x33, 0x0c]))
    const ids = plan.channels.map((c) => c.id)
    expect(ids).toEqual([CH.rpm, 'boost.map', CH.baro, CH.boostActual])
    expect(plan.reads.map((r) => r.did)).toEqual([0xf40c, 0xf40b, 0xf433])
    expect(plan.derived.map((d) => d.inputs)).toEqual([['boost.map', CH.baro]])
  })

  it('drops derived channels with a missing input', () => {
    expect(buildObdPlan(new Set([0x0b])).channels.map((c) => c.id)).not.toContain(CH.boostActual)
    expect(buildObdPlan(new Set([0x62])).channels.map((c) => c.id)).not.toContain(CH.torqueActual)
  })

  it('reads only the preferred PID when alternatives are supported', () => {
    const plan = buildObdPlan(new Set([0x24, 0x34]))
    expect(plan.reads.map((r) => r.pid)).toEqual([0x34])
    expect(buildObdPlan(new Set([0x24])).reads.map((r) => r.pid)).toEqual([0x24])
  })

  it('computes the derived values', () => {
    const boost = OBD_DERIVED.find((d) => d.channel.id === CH.boostActual)
    const torque = OBD_DERIVED.find((d) => d.channel.id === CH.torqueActual)
    expect(boost?.compute([2.2, 1.0])).toBeCloseTo(1.2)
    expect(torque?.compute([50, 600])).toBe(300)
  })
})
