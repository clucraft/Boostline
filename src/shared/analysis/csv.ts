// CSV log import/export.
//
// Boostline format:
//   # app=Boostline
//   # started=2026-05-01T10:00:00.000Z
//   # ids=engine.rpm,boost.actual            ← channel ids of the data columns, in order
//   Time [s],Engine RPM [rpm],Boost Pressure · Actual [bar]
//   0.000,850,1.012
//
// The parser also reads foreign logs (MHD, bootmod3, generic loggers): it
// auto-detects the delimiter (, ; tab) and decimal commas, finds the header row,
// parses "Name [unit]" / "Name (unit)" headers and an optional units row,
// locates the time column (s, ms or clock time) and maps channel names to the
// well-known ids in CH.

import { CH, type LogChannel, type LogData, type Quantity } from '@shared/types'
import { converter, guessQuantity, isKnownUnit, normalizeUnit } from '@shared/units'
import { lowerBound, upperBound } from './smoothing'

/** Sample rate assumed when a log has no usable time column. */
const FALLBACK_RATE_HZ = 20
/** Lines inspected for delimiter and header detection. */
const SAMPLE_LINES = 50
/** A unitless time column whose median step exceeds this is taken to be in milliseconds. */
const UNITLESS_MS_STEP = 5
const TIME_DECIMALS = 3
/** Exported values keep this many significant digits relative to the channel's largest value. */
const EXPORT_SIGNIFICANT_DIGITS = 6
const MAX_EXPORT_DECIMALS = 9

// ------------------------------------------------------------------ parsing

interface Column {
  name: string
  unit: string
}

/** Parses a Boostline or foreign CSV log. Never throws; problems are reported in meta.warnings. */
export function parseLogCsv(text: string, name: string): LogData {
  const meta: Record<string, string> = {}
  const warnings: string[] = []
  const unmarked = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text // strip a UTF-8 BOM
  const lines = unmarked.split(/\r\n|\r|\n/)

  let first = 0
  for (; first < lines.length; first++) {
    const line = lines[first].trim()
    if (line === '') continue
    if (!line.startsWith('#')) break
    const body = line.slice(1).trim()
    const eq = body.indexOf('=')
    if (eq > 0) meta[body.slice(0, eq).trim()] = body.slice(eq + 1).trim()
  }
  const rows: string[] = []
  for (let i = first; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed !== '' && !trimmed.startsWith('#')) rows.push(lines[i])
  }

  const delimiter = detectDelimiter(rows.slice(0, SAMPLE_LINES))
  const decimalComma = delimiter !== ','
  const split = (line: string): string[] => splitCsvLine(line, delimiter)

  const { headerIdx, dataStart: firstDataRow } = findHeaderRow(rows, split, decimalComma)
  let dataStart = firstDataRow
  let columns: Column[]
  if (headerIdx >= 0) {
    columns = split(rows[headerIdx]).map(parseHeaderCell)
  } else {
    const width = rows.length > dataStart ? split(rows[dataStart]).length : 0
    columns = Array.from({ length: width }, (_, k) => ({ name: `Column ${k + 1}`, unit: '' }))
    if (width > 0) warnings.push('No header row found; columns are named by position')
  }
  if (dataStart < rows.length) {
    const cells = split(rows[dataStart])
    if (isUnitsRow(cells, decimalComma)) {
      cells.forEach((cell, k) => {
        if (columns[k] && columns[k].unit === '') columns[k].unit = normalizeUnit(cell)
      })
      dataStart++
    }
  }

  let timeCol = findTimeColumn(columns)
  const timeUnit = timeCol >= 0 ? columns[timeCol].unit : 's'
  const dataCols = columns.map((_, k) => k).filter((k) => k !== timeCol)
  let parsed = parseRows(rows, dataStart, split, timeCol, dataCols, decimalComma)
  if (timeCol >= 0 && parsed.n === 0 && rows.length > dataStart) {
    // Unparseable time column: keep it out of the data and synthesise time instead.
    warnings.push(`Time column "${columns[timeCol].name}" could not be parsed`)
    timeCol = -1
    parsed = parseRows(rows, dataStart, split, timeCol, dataCols, decimalComma)
  }
  const { n, time, values, skippedBadTime, skippedBackwards } = parsed

  if (timeCol < 0) {
    for (let i = 0; i < n; i++) time[i] = i / FALLBACK_RATE_HZ
    if (n > 0) warnings.push(`No time column found; assuming ${FALLBACK_RATE_HZ} Hz sampling`)
  } else {
    let toSeconds = converter(timeUnit, 's')
    if (timeUnit === '') {
      toSeconds = medianStep(time, n) > UNITLESS_MS_STEP ? (v) => v / 1000 : null
      if (toSeconds) warnings.push('Time column has no unit and large steps; interpreted as milliseconds')
    } else if (!toSeconds) {
      warnings.push(`Unknown time unit "${timeUnit}"; interpreted as seconds`)
    }
    if (toSeconds) for (let i = 0; i < n; i++) time[i] = toSeconds(time[i])
  }
  if (skippedBadTime > 0) warnings.push(`${skippedBadTime} row(s) without a valid time were skipped`)
  if (skippedBackwards > 0) warnings.push(`${skippedBackwards} row(s) going back in time were skipped`)
  if (n === 0) warnings.push('The file contains no data rows')

  // Channel ids: explicit "# ids" first (aligned with the data columns), then
  // well-known names, then unique slugs. Empty columns are dropped but keep
  // their position in the ids list.
  const explicitIds = meta.ids ? meta.ids.split(',').map((s) => s.trim()) : []
  delete meta.ids
  const columnData = values.map((v) => (v.length === n ? v : v.slice(0, n)))
  const empty = columnData.map((d) => !d.some(Number.isFinite))
  const used = new Set<string>()
  const ids: Array<string | undefined> = dataCols.map((_, k) => {
    const id = explicitIds[k]
    if (empty[k] || !id || used.has(id)) return undefined
    used.add(id)
    return id
  })
  const channels: LogChannel[] = []
  dataCols.forEach((col, k) => {
    if (empty[k]) return
    const column = columns[col]
    const channelName = column.name || `Column ${col + 1}`
    const id = ids[k] ?? wellKnownId(channelName, guessQuantity(column.unit), used) ?? uniqueSlug(channelName, used)
    used.add(id)
    const unit = column.unit || defaultUnit(id, channelName)
    channels.push({ id, name: channelName, unit, quantity: guessQuantity(unit), data: columnData[k] })
  })

  if (warnings.length > 0) meta.warnings = [meta.warnings, ...warnings].filter(Boolean).join('; ')
  return { name, meta, time: time.length === n ? time : time.slice(0, n), channels }
}

interface ParsedRows {
  n: number
  time: Float64Array
  values: Float64Array[]
  skippedBadTime: number
  skippedBackwards: number
}

function parseRows(
  rows: string[],
  dataStart: number,
  split: (line: string) => string[],
  timeCol: number,
  dataCols: number[],
  decimalComma: boolean
): ParsedRows {
  const capacity = Math.max(0, rows.length - dataStart)
  const time = new Float64Array(capacity)
  const values = dataCols.map(() => new Float64Array(capacity))
  let n = 0
  let skippedBadTime = 0
  let skippedBackwards = 0
  let last = -Infinity
  for (let r = dataStart; r < rows.length; r++) {
    const cells = split(rows[r])
    if (timeCol >= 0) {
      const tv = parseTimeCell(cells[timeCol] ?? '', decimalComma)
      if (!Number.isFinite(tv)) {
        skippedBadTime++
        continue
      }
      if (tv < last) {
        skippedBackwards++
        continue
      }
      last = tv
      time[n] = tv
    }
    for (let k = 0; k < dataCols.length; k++) values[k][n] = parseNumber(cells[dataCols[k]] ?? '', decimalComma)
    n++
  }
  return { n, time, values, skippedBadTime, skippedBackwards }
}

function parseNumber(cell: string, decimalComma: boolean): number {
  const s = cell.trim()
  if (s === '') return NaN
  const v = Number(decimalComma ? s.replace(',', '.') : s)
  return Number.isFinite(v) ? v : NaN
}

/** Seconds (or the column's unit) from a number, a clock time "hh:mm:ss.fff" / "mm:ss.fff" or an ISO date. */
function parseTimeCell(cell: string, decimalComma: boolean): number {
  const s = cell.trim()
  const v = parseNumber(s, decimalComma)
  if (Number.isFinite(v) || s === '') return v
  if (/^\d+(:\d+){1,2}([.,]\d+)?$/.test(s)) {
    return s.split(':').reduce((acc, part) => acc * 60 + parseNumber(part, true), 0)
  }
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? ms / 1000 : NaN
}

function medianStep(time: Float64Array, n: number): number {
  const steps: number[] = []
  for (let i = 1; i < Math.min(n, 1000); i++) steps.push(time[i] - time[i - 1])
  if (steps.length === 0) return 0
  steps.sort((a, b) => a - b)
  return steps[steps.length >> 1]
}

/** Splits one CSV line; double-quoted cells may contain the delimiter and "" escapes. */
function splitCsvLine(line: string, delimiter: string): string[] {
  if (!line.includes('"')) return line.split(delimiter)
  const cells: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch !== '"') cur += ch
      else if (line[i + 1] === '"') {
        cur += '"'
        i++
      } else inQuotes = false
    } else if (ch === '"') inQuotes = true
    else if (ch === delimiter) {
      cells.push(cur)
      cur = ''
    } else cur += ch
  }
  cells.push(cur)
  return cells
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0
  let inQuotes = false
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === delimiter && !inQuotes) count++
  }
  return count
}

/**
 * The delimiter whose per-line count is most consistent across the sample
 * (most lines sharing the same non-zero count). Ties prefer tab, then
 * semicolon, then comma, so "1,5;2,0" decimal-comma files resolve to ';'.
 */
function detectDelimiter(sample: string[]): string {
  let best = ','
  let bestScore = 0
  for (const d of ['\t', ';', ',']) {
    const freq = new Map<number, number>()
    for (const line of sample) {
      const c = countOutsideQuotes(line, d)
      if (c > 0) freq.set(c, (freq.get(c) ?? 0) + 1)
    }
    const score = Math.max(0, ...freq.values())
    if (score > bestScore) {
      best = d
      bestScore = score
    }
  }
  return best
}

function mostCommon(values: number[]): number {
  const freq = new Map<number, number>()
  let best = 0
  let bestCount = 0
  for (const v of values) {
    const c = (freq.get(v) ?? 0) + 1
    freq.set(v, c)
    if (c > bestCount) {
      best = v
      bestCount = c
    }
  }
  return best
}

/**
 * The header is the first row of (nearly) full width whose cells are mostly
 * non-numeric; narrower rows before it (logger preamble) are skipped. When the
 * first full-width row is numeric the file has no header.
 */
function findHeaderRow(
  rows: string[],
  split: (line: string) => string[],
  decimalComma: boolean
): { headerIdx: number; dataStart: number } {
  const sample = rows.slice(0, SAMPLE_LINES).map(split)
  const width = mostCommon(sample.map((cells) => cells.length))
  for (let i = 0; i < sample.length; i++) {
    if (sample[i].length < Math.min(2, width) || sample[i].length < width - 1) continue
    const cells = sample[i].map((c) => c.trim()).filter((c) => c !== '')
    if (cells.length === 0) continue
    const textual = cells.filter((c) => !Number.isFinite(parseNumber(c, decimalComma))).length
    return textual / cells.length > 0.5 ? { headerIdx: i, dataStart: i + 1 } : { headerIdx: -1, dataStart: i }
  }
  return { headerIdx: -1, dataStart: rows.length }
}

/** A row directly below the header that holds only units, e.g. "s,rpm,%,psi". */
function isUnitsRow(cells: string[], decimalComma: boolean): boolean {
  const nonEmpty = cells.map((c) => c.trim()).filter((c) => c !== '')
  return (
    nonEmpty.length > 0 &&
    nonEmpty.every((c) => !Number.isFinite(parseNumber(c, decimalComma)) && c.length <= 12) &&
    nonEmpty.some((c) => isKnownUnit(c) && normalizeUnit(c) !== '')
  )
}

/** Single letters that are accepted as a unit in "Name (x)" headers ("(A)"/"(B)" are usually banks). */
const SINGLE_LETTER_UNITS = new Set(['s', '%', '°', 'V', 'C', 'F'])

/** Splits "Name [unit]", "Name[unit]" or "Name (unit)" (parentheses only for recognised units). */
function parseHeaderCell(raw: string): Column {
  const s = raw.trim()
  const bracket = /^(.*?)\s*\[([^[\]]*)\]$/.exec(s)
  if (bracket) return { name: bracket[1].trim() || s, unit: normalizeUnit(bracket[2]) }
  const paren = /^(.*?)\s*\(([^()]*)\)$/.exec(s)
  if (paren && paren[1].trim() !== '') {
    const u = paren[2].trim()
    if ((u.length > 1 || SINGLE_LETTER_UNITS.has(u)) && isKnownUnit(u)) return { name: paren[1].trim(), unit: normalizeUnit(u) }
  }
  return { name: s, unit: '' }
}

const TIME_NAME = /^(?:log[ _]?)?(?:time|zeit)(?:[ _]?stamp)?$|^(?:timestamp|elapsed(?: time)?|t|sec|seconds)$/i

function findTimeColumn(columns: Column[]): number {
  const exact = columns.findIndex((c) => TIME_NAME.test(c.name))
  if (exact >= 0) return exact
  return columns.findIndex((c) => /\b(?:time|zeit)\b/i.test(c.name) && (c.unit === 's' || c.unit === 'ms'))
}

// ------------------------------------------------------------------ channel ids

/** Words marking a set-point rather than a measured value. */
const NOT_ACTUAL = /target|set ?point|desired|request|\bspec\b|\bsoll\b|limit|\bmax\b|\bmin\b|deviation|error|command|\bcmd\b/
const SETPOINT = /target|set ?point|desired|request|\bspec\b|\bsoll\b/
const BOOST = /boost|charge ?pressure|ladedruck|manifold ?(?:absolute ?)?pressure|pre-?throttle/

/** Name → well-known id rules, evaluated in order (boost before throttle: "Boost (Pre-Throttle)"). */
const NAME_RULES: ReadonlyArray<{ id: string; test: (name: string, q: Quantity) => boolean }> = [
  {
    id: CH.rpm,
    test: (n, q) =>
      (q === 'rpm' || q === 'none') &&
      /\brpm\b|engine ?speed|motordrehzahl|^drehzahl|\bn_?mot\b/.test(n) &&
      !/idle|turbo|fan|limit|target/.test(n)
  },
  {
    id: CH.speed,
    test: (n, q) =>
      !/engine|gps|fan|turbo|target|limit|cruise|slip/.test(n) &&
      (/(?:vehicle|car|road|ground) ?speed|geschwindigkeit|^speed\b|\bvss\b/.test(n) || (q === 'speed' && /speed/.test(n)))
  },
  { id: CH.pedal, test: (n) => /pedal|accelerator|\bapp\b/.test(n) && !NOT_ACTUAL.test(n) },
  { id: CH.boostTarget, test: (n) => BOOST.test(n) && SETPOINT.test(n) },
  { id: CH.boostActual, test: (n) => BOOST.test(n) && !NOT_ACTUAL.test(n) },
  { id: CH.baro, test: (n) => /baro|ambient ?(?:air ?)?pressure|atmospheric|umgebungsdruck/.test(n) },
  {
    id: CH.throttle,
    test: (n) => /throttle|\btps\b|drosselklappe/.test(n) && !/pre-?throttle|pressure|pedal/.test(n) && !NOT_ACTUAL.test(n)
  },
  { id: CH.gear, test: (n) => /\bgear\b|\bgang\b/.test(n) && !/ratio|target|request|desired|shift|time|box|oil|temp/.test(n) },
  { id: CH.iat, test: (n) => /\biat\b|intake ?(?:air ?)?temp|charge ?air ?temp|ansauglufttemp/.test(n) },
  {
    id: CH.ambientTemp,
    test: (n, q) => /ambient|outside|outdoor|aussen|außen/.test(n) && (q === 'temperature' || /temp/.test(n))
  },
  { id: CH.lambdaActual, test: (n) => /lambda|\bafr\b|air[- ]?fuel/.test(n) && !NOT_ACTUAL.test(n) },
  {
    id: CH.torqueActual,
    test: (n) => /torque|drehmoment/.test(n) && !NOT_ACTUAL.test(n) && !/converter|wheel|loss|driver|wish/.test(n)
  }
]

function wellKnownId(name: string, quantity: Quantity, used: Set<string>): string | undefined {
  const n = name.toLowerCase()
  return NAME_RULES.find((rule) => !used.has(rule.id) && rule.test(n, quantity))?.id
}

function uniqueSlug(name: string, used: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'channel'
  let id = base
  for (let k = 2; used.has(id); k++) id = `${base}_${k}`
  return id
}

/** Unit for well-known channels whose header carries none. */
function defaultUnit(id: string, name: string): string {
  switch (id) {
    case CH.rpm:
      return 'rpm'
    case CH.gear:
      return 'gear'
    case CH.lambdaActual:
      return /afr|air[- ]?fuel/i.test(name) ? 'AFR' : 'λ'
    default:
      return ''
  }
}

// ------------------------------------------------------------------ writing

export interface SerializeOptions {
  /** Shift time so the range start (or the first sample) becomes 0. */
  rebase?: boolean
}

/**
 * Writes a log (optionally only samples with range.start ≤ t ≤ range.end) in
 * Boostline format. Each channel keeps 6 significant digits relative to its
 * largest value, with trailing decimals dropped when the data does not need them.
 */
export function serializeLogCsv(
  log: LogData,
  range?: { start: number; end: number },
  opts: SerializeOptions = {}
): string {
  const { time, channels } = log
  const i0 = range ? lowerBound(time, range.start) : 0
  const i1 = range ? upperBound(time, range.end) : time.length
  const origin = opts.rebase ? (range ? range.start : (time[0] ?? 0)) : 0
  const meta: Record<string, string> = { app: 'Boostline', ...log.meta }
  delete meta.ids
  meta.ids = channels.map((c) => c.id).join(',')
  const decimals = channels.map((c) => exportDecimals(c.data, i0, i1))
  const parts = [csvMetaLines(meta), csvHeaderLine(channels)]
  const values = new Array<number>(channels.length)
  for (let i = i0; i < i1; i++) {
    for (let k = 0; k < channels.length; k++) values[k] = channels[k].data[i]
    parts.push(csvRowLine(time[i] - origin, values, decimals))
  }
  return parts.join('')
}

function exportDecimals(data: Float64Array, i0: number, i1: number): number {
  let maxAbs = 0
  for (let i = i0; i < i1; i++) {
    const a = Math.abs(data[i])
    if (a > maxAbs) maxAbs = a
  }
  if (maxAbs === 0) return 0
  const limit = Math.min(
    MAX_EXPORT_DECIMALS,
    Math.max(0, EXPORT_SIGNIFICANT_DIGITS - 1 - Math.floor(Math.log10(maxAbs)))
  )
  for (let d = 0; d < limit; d++) {
    const scale = 10 ** d
    let exact = true
    for (let i = i0; i < i1 && exact; i++) {
      const x = data[i] * scale
      if (Math.abs(x - Math.round(x)) > 1e-6) exact = false // NaN compares false: skipped
    }
    if (exact) return d
  }
  return limit
}

const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim()

/** "# key=value" lines (newline-terminated). */
export function csvMetaLines(meta: Record<string, string>): string {
  return Object.entries(meta)
    .map(([k, v]) => `# ${oneLine(k)}=${oneLine(v)}\n`)
    .join('')
}

function csvCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Header line "Time [s],Name [unit],…" (newline-terminated). A unitless name
 * that itself ends in brackets gets an empty "[]" so it is not read back as a unit.
 */
export function csvHeaderLine(channels: ReadonlyArray<{ id: string; name: string; unit: string }>): string {
  const cells = channels.map((c) => {
    const name = oneLine(c.name)
    return csvCell(c.unit || /[\])]$/.test(name) ? `${name} [${oneLine(c.unit)}]` : name)
  })
  return ['Time [s]', ...cells].join(',') + '\n'
}

function formatFixed(v: number, decimals: number): string {
  if (!Number.isFinite(v)) return ''
  const s = v.toFixed(decimals)
  return s.startsWith('-') && Number(s) === 0 ? s.slice(1) : s // no "-0.00"
}

/** One data row (newline-terminated): time with ms precision, NaN as an empty cell. */
export function csvRowLine(t: number, values: ArrayLike<number>, decimals: ArrayLike<number>): string {
  let line = formatFixed(t, TIME_DECIMALS)
  for (let k = 0; k < values.length; k++) line += ',' + formatFixed(values[k], decimals[k])
  return line + '\n'
}
