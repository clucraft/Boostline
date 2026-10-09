import { describe, expect, it } from 'vitest'
import { CH, type LogData } from '@shared/types'
import { csvHeaderLine, csvMetaLines, csvRowLine, parseLogCsv, serializeLogCsv } from '@shared/analysis/csv'

function boostlineLog(): LogData {
  const n = 41
  const time = Float64Array.from({ length: n }, (_, i) => 12.5 + i * 0.05)
  return {
    name: 'pull.csv',
    meta: {
      app: 'Boostline',
      vin: 'WBA00000000000001',
      started: '2026-05-01T10:00:00.000Z',
      adapter: 'Simulator'
    },
    time,
    channels: [
      { id: CH.rpm, name: 'Engine RPM', unit: 'rpm', quantity: 'rpm', data: time.map((t) => 2000 + Math.round((t - 12.5) * 1000)) },
      {
        id: CH.boostActual,
        name: 'Boost Pressure · Actual',
        unit: 'bar',
        quantity: 'pressure',
        data: time.map((_, i) => (i === 7 ? NaN : 1 + i * 0.0125))
      },
      { id: CH.iat, name: 'Intake Air Temp', unit: '°C', quantity: 'temperature', data: time.map(() => 31.4) },
      { id: 'custom.ratio', name: 'Ratio, raw "x"', unit: '', quantity: 'none', data: time.map((_, i) => -i / 8) },
      { id: 'custom.flag', name: 'Flag (A)', unit: '', quantity: 'none', data: time.map((_, i) => i % 2) }
    ]
  }
}

describe('Boostline CSV round trip', () => {
  it('preserves meta, ids, names, units and values', () => {
    const log = boostlineLog()
    const text = serializeLogCsv(log)
    expect(text.startsWith('# app=Boostline\n')).toBe(true)
    expect(text).toContain(`# ids=${CH.rpm},${CH.boostActual},${CH.iat},custom.ratio,custom.flag\n`)
    expect(text).toContain('Time [s],Engine RPM [rpm],Boost Pressure · Actual [bar],Intake Air Temp [°C],"Ratio, raw ""x""",Flag (A) []\n')

    const parsed = parseLogCsv(text, 'pull.csv')
    expect(parsed.name).toBe('pull.csv')
    expect(parsed.meta).toEqual(log.meta)
    expect(parsed.channels.map((c) => c.id)).toEqual(log.channels.map((c) => c.id))
    expect(parsed.channels.map((c) => c.name)).toEqual(log.channels.map((c) => c.name))
    expect(parsed.channels.map((c) => c.unit)).toEqual(['rpm', 'bar', '°C', '', ''])
    expect(parsed.channels.map((c) => c.quantity)).toEqual(['rpm', 'pressure', 'temperature', 'none', 'none'])
    expect(parsed.time.length).toBe(log.time.length)
    parsed.time.forEach((t, i) => expect(t).toBeCloseTo(log.time[i], 9))
    parsed.channels.forEach((ch, k) => {
      ch.data.forEach((v, i) => {
        const expected = log.channels[k].data[i]
        if (Number.isNaN(expected)) expect(v).toBeNaN()
        else expect(v).toBeCloseTo(expected, 9)
      })
    })
  })

  it('exports a time range, optionally rebased', () => {
    const log = boostlineLog()
    const kept = parseLogCsv(serializeLogCsv(log, { start: 13, end: 13.5 }), 'range.csv')
    expect(kept.time.length).toBe(11)
    expect(kept.time[0]).toBeCloseTo(13, 9)
    expect(kept.channels[0].data[0]).toBe(2500)

    const rebased = parseLogCsv(serializeLogCsv(log, { start: 13, end: 13.5 }, { rebase: true }), 'range.csv')
    expect(rebased.time[0]).toBeCloseTo(0, 9)
    expect(rebased.time[10]).toBeCloseTo(0.5, 9)
  })
})

describe('foreign logs', () => {
  it('reads an MHD-style log and maps well-known channels', () => {
    const text = [
      'Time,Engine speed[1/min],Accel. Pedal[%],Boost (Pre-Throttle)[psig],Boost pressure (Target)[psig],IAT[F],Gear,Vehicle speed[mph],Lambda Bank 1[-],Lambda Bank 2[-]',
      '0.000,2510,99.6,14.2,15.0,95,3,52.1,0.82,0.83',
      '0.051,2580,100,15.1,15.5,95,3,53.4,0.81,0.82',
      '0.100,2655,100,16.0,16.0,96,3,54.8,0.80,0.81'
    ].join('\r\n')
    const log = parseLogCsv(text, 'mhd.csv')
    const byId = new Map(log.channels.map((c) => [c.id, c]))
    expect([...log.time]).toEqual([0, 0.051, 0.1])
    expect(byId.get(CH.rpm)).toMatchObject({ name: 'Engine speed', unit: 'rpm', quantity: 'rpm' })
    expect(byId.get(CH.pedal)).toMatchObject({ name: 'Accel. Pedal', unit: '%', quantity: 'percent' })
    expect(byId.get(CH.boostActual)).toMatchObject({ name: 'Boost (Pre-Throttle)', unit: 'psi', quantity: 'pressure' })
    expect(byId.get(CH.boostTarget)).toMatchObject({ name: 'Boost pressure (Target)', unit: 'psi' })
    expect(byId.get(CH.iat)).toMatchObject({ unit: '°F', quantity: 'temperature' })
    expect(byId.get(CH.gear)).toMatchObject({ unit: 'gear', quantity: 'gear' })
    expect(byId.get(CH.speed)).toMatchObject({ unit: 'mph', quantity: 'speed' })
    expect(byId.get(CH.lambdaActual)?.name).toBe('Lambda Bank 1')
    expect(byId.get('lambda_bank_2')?.name).toBe('Lambda Bank 2')
    expect([...byId.get(CH.rpm)!.data]).toEqual([2510, 2580, 2655])
    expect(log.meta.warnings).toBeUndefined()
  })

  it('reads semicolon-delimited files with decimal commas', () => {
    const text = [
      'Zeit [s];Drehzahl [1/min];Ladedruck [mbar];Fahrpedal [%];Öltemp [°C];Leer',
      '0,00;850;1013,5;0,0;90;',
      '0,05;900,5;1020,25;12,5;90,5;',
      '0,10;;1030;25;91;'
    ].join('\n')
    const log = parseLogCsv(String.fromCharCode(0xfeff) + text, 'de.csv')
    expect([...log.time]).toEqual([0, 0.05, 0.1])
    expect(log.channels.map((c) => c.id)).toEqual([CH.rpm, CH.boostActual, CH.pedal, 'oltemp'])
    expect(log.channels[0].name).toBe('Drehzahl')
    const [rpm, boost, pedal] = log.channels
    expect(rpm.data[1]).toBe(900.5)
    expect(rpm.data[2]).toBeNaN()
    expect(boost.unit).toBe('mbar')
    expect([...boost.data]).toEqual([1013.5, 1020.25, 1030])
    expect([...pedal.data]).toEqual([0, 12.5, 25])
  })

  it('converts a millisecond time column to seconds', () => {
    const log = parseLogCsv('Time [ms],RPM,Speed (km/h)\n0,1000,10\n50,1100,11\n100,1200,12\n', 'ms.csv')
    expect([...log.time]).toEqual([0, 0.05, 0.1])
    expect(log.channels.map((c) => [c.id, c.unit])).toEqual([
      [CH.rpm, 'rpm'],
      [CH.speed, 'km/h']
    ])
  })

  it('synthesises time at 20 Hz when there is no time column', () => {
    const log = parseLogCsv('RPM,Boost [bar]\n1000,0.9\n1100,1.0\n1200,1.1\n', 'notime.csv')
    expect([...log.time]).toEqual([0, 0.05, 0.1])
    expect(log.channels.map((c) => c.id)).toEqual([CH.rpm, CH.boostActual])
    expect(log.meta.warnings).toMatch(/No time column/)
  })

  it('skips logger preamble lines, reads a units row and tab delimiters', () => {
    const text = [
      'bootmod3 log',
      'Time\tEngine RPM\tAccelerator pedal\tCoolant temp',
      's\trpm\t%\tC',
      '0.0\t3000\t100\t90',
      '0.1\t3100\t100\t90',
      '0.2\t3200\t100\t91'
    ].join('\n')
    const log = parseLogCsv(text, 'bm3.csv')
    expect([...log.time]).toEqual([0, 0.1, 0.2])
    expect(log.channels.map((c) => [c.id, c.unit])).toEqual([
      [CH.rpm, 'rpm'],
      [CH.pedal, '%'],
      ['coolant_temp', '°C']
    ])
  })
})

describe('streaming helpers', () => {
  it('formats meta, header and rows', () => {
    expect(csvMetaLines({ app: 'Boostline', note: 'two\nlines' })).toBe('# app=Boostline\n# note=two lines\n')
    expect(csvHeaderLine([{ id: CH.rpm, name: 'Engine RPM', unit: 'rpm' }, { id: 'x', name: 'Flag', unit: '' }])).toBe(
      'Time [s],Engine RPM [rpm],Flag\n'
    )
    expect(csvRowLine(1.23456, [6500.4, NaN, -0.0001], [0, 2, 2])).toBe('1.235,6500,,0.00\n')
  })
})
