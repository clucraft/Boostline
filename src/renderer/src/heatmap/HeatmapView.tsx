import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, Copy, FileSpreadsheet, FolderOpen, Image, Plus, SlidersHorizontal, X } from 'lucide-react'
import type { HeatmapPrefs, HeatmapStatPref, LogData } from '@shared/types'
import { GROUP_ORDER } from '@shared/catalog'
import { autoEdges, cellValue, type HeatmapSpan } from '@shared/analysis/heatmap'
import { parseLogCsv } from '@shared/analysis/csv'
import { findChannel } from '@shared/analysis/channelLookup'
import { displayUnitFor } from '@shared/units'
import { api, useApp } from '../store'
import { MenuButton } from '../components/ui'
import { AxesModal } from './AxesModal'
import { heatmapPng, heatmapTable } from './exportHeatmap'
import { buildModel, cellColor, DEFAULT_HEATMAP, derivedInfo, fmtEdge, fmtVal, legendGradient, prepareSource, PRESETS, type HeatmapModel } from './model'

const STATS: { id: HeatmapStatPref; label: string }[] = [
  { id: 'mean', label: 'Mean' },
  { id: 'worst', label: 'Worst' },
  { id: 'min', label: 'Min' },
  { id: 'max', label: 'Max' },
  { id: 'std', label: 'Std deviation' },
  { id: 'n', label: 'Samples' },
  { id: 'time', label: 'Time spent (s)' }
]

/** Words for the two ends of a diverging scale. */
const ENDS: Record<string, [string, string]> = {
  'derived.lambda_error': ['rich', 'lean'],
  'derived.boost_error': ['under target', 'over target'],
  'derived.rail_drop': ['above target', 'below target'],
  'derived.timing_corr.avg': ['pulled', ''],
  'derived.timing_corr.worst': ['pulled', '']
}

const MAX_SPAN_CHIPS = 12

export function HeatmapView({
  log,
  range,
  onJump,
  onOpenLog
}: {
  log: LogData | null
  range: [number, number] | null
  onJump: (log: LogData, span: HeatmapSpan) => void
  onOpenLog: () => void
}) {
  const settings = useApp((s) => s.settings)!
  const updateSettings = useApp((s) => s.updateSettings)
  const channelMap = useApp((s) => s.channelMap)
  const toast = useApp((s) => s.toast)
  const prefs: HeatmapPrefs = { ...DEFAULT_HEATMAP, ...settings.heatmap, filters: { ...DEFAULT_HEATMAP.filters, ...settings.heatmap?.filters } }
  const [extra, setExtra] = useState<LogData[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [editingAxes, setEditingAxes] = useState(false)

  const setPrefs = (patch: Partial<HeatmapPrefs>): void => {
    const next = { ...prefs, ...patch }
    // A manual value/stat change leaves the preset unless it still matches one.
    if ((patch.valueId || patch.stat) && !patch.preset) {
      next.preset = PRESETS.find((p) => p.valueId === next.valueId && p.stat === next.stat)?.id ?? 'custom'
    }
    void updateSettings({ heatmap: next })
  }
  const setFilters = (patch: Partial<HeatmapPrefs['filters']>): void => setPrefs({ filters: { ...prefs.filters, ...patch } })

  const logs = useMemo(() => (log ? [log, ...extra.filter((l) => l !== log)] : []), [log, extra])
  const sources = useMemo(() => logs.map((l) => prepareSource(l, channelMap)), [logs, channelMap])
  const rangeKey = prefs.filters.visibleOnly ? range : null
  const model = useMemo(
    () => buildModel(sources, { prefs, units: settings.units, range: rangeKey }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sources, JSON.stringify(prefs), settings.units, rangeKey?.[0], rangeKey?.[1]]
  )
  useEffect(() => setSelected(null), [model])

  // Every channel offered by any source, derived ones first.
  const options = useMemo(() => {
    const all = new Map<string, { id: string; name: string; group: string }>()
    for (const s of sources) for (const d of s.defs.values()) if (!all.has(d.id)) all.set(d.id, { id: d.id, name: d.name, group: d.id.startsWith('derived.') ? 'Derived' : d.group })
    const groups = ['Derived', ...GROUP_ORDER]
    return [...all.values()].sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group) || a.name.localeCompare(b.name))
  }, [sources])
  const hasGear = sources.some((s) => !!findChannel(s.log, 'vehicle.gear'))

  const addLogs = async (): Promise<void> => {
    const files = await api.openLogsDialog()
    const known = new Set(logs.map((l) => l.path))
    const parsed = files.filter((f) => !known.has(f.path)).map((f) => ({ ...parseLogCsv(f.text, f.name), path: f.path }))
    if (parsed.length) setExtra([...extra, ...parsed])
  }

  if (!log) {
    return (
      <div className="empty" style={{ margin: 'auto', maxWidth: 520 }}>
        Heatmaps are built from recorded logs. Open a log (or several), or record one with <b>Record</b> first.
        <div className="row" style={{ justifyContent: 'center', marginTop: 14 }}>
          <button className="btn" onClick={onOpenLog}>
            <FolderOpen size={13} /> Open log
          </button>
        </div>
      </div>
    )
  }

  const m: HeatmapModel | null = 'error' in model ? null : model
  const info = derivedInfo(prefs.valueId)
  const preset = PRESETS.find((p) => p.id === prefs.preset)
  const totalMinutes = logs.reduce((s, l) => s + (l.time.length ? l.time[l.time.length - 1] - l.time[0] : 0), 0) / 60

  const exportItems = m
    ? [
        {
          label: 'Copy table',
          icon: <Copy size={14} />,
          onClick: async () => {
            await api.copyText(heatmapTable(m, '\t'))
            toast('Table copied: paste it into Excel or a map editor', 'success')
          }
        },
        {
          label: 'Save as CSV…',
          icon: <FileSpreadsheet size={14} />,
          onClick: async () => {
            if (await api.saveTextDialog(`heatmap_${prefs.valueId.replace(/\W+/g, '_')}.csv`, heatmapTable(m, ','), 'csv')) toast('Heatmap saved', 'success')
          }
        },
        {
          label: 'Save as PNG…',
          icon: <Image size={14} />,
          onClick: async () => {
            const title = `${m.valueDef.name} · ${STATS.find((s) => s.id === prefs.stat)?.label}`
            const subtitle = `${logs.map((l) => l.name).join(', ')} · min ${prefs.minSamples} samples per cell`
            if (await api.savePngDialog(`heatmap_${prefs.valueId.replace(/\W+/g, '_')}.png`, heatmapPng(m, title, subtitle))) toast('Heatmap saved', 'success')
          }
        }
      ]
    : [{ label: 'Nothing to export yet', disabled: true }]

  return (
    <div className="heatmap">
      <div className="hm-toolbar">
        <div className="field">
          <label>Preset</label>
          <select
            className="select"
            value={prefs.preset}
            onChange={(e) => {
              const p = PRESETS.find((x) => x.id === e.target.value)
              if (p) setPrefs({ preset: p.id, valueId: p.valueId, stat: p.stat })
            }}
          >
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {prefs.preset === 'custom' && <option value="custom">Custom</option>}
          </select>
        </div>
        <div className="field" style={{ flex: 2 }}>
          <label>Value</label>
          <select className="select" value={prefs.valueId} onChange={(e) => setPrefs({ valueId: e.target.value })}>
            {!options.some((o) => o.id === prefs.valueId) && <option value={prefs.valueId}>{derivedInfo(prefs.valueId)?.name ?? prefs.valueId} (not available)</option>}
            {[...new Set(options.map((o) => o.group))].map((g) => (
              <optgroup key={g} label={g}>
                {options
                  .filter((o) => o.group === g)
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Statistic</label>
          <select className="select" value={prefs.stat} onChange={(e) => setPrefs({ stat: e.target.value as HeatmapStatPref })}>
            {STATS.filter((s) => s.id !== 'worst' || info).map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <button className="btn" onClick={() => setEditingAxes(true)} style={{ alignSelf: 'flex-end' }}>
          <SlidersHorizontal size={13} /> Axes
        </button>
        <span style={{ alignSelf: 'flex-end' }}>
          <MenuButton label="Export" className="btn" icon={<FileSpreadsheet size={13} />} items={exportItems} />
        </span>
      </div>

      <div className="hm-filters">
        {(
          [
            ['warm', 'Warm engine', 'Only samples with coolant at or above 80 °C'],
            ['excludeTransients', 'Exclude transients', 'Skips tip-in/out, shifts and spool spikes (fast load or rpm changes)'],
            ['excludeFuelCut', 'Exclude fuel cut', 'Skips overrun with the pedal released']
          ] as const
        ).map(([key, label, title]) => (
          <button key={key} className={`chip ${prefs.filters[key] ? 'on' : ''}`} title={title} onClick={() => setFilters({ [key]: !prefs.filters[key] })}>
            {label}
          </button>
        ))}
        <div className="segmented">
          {(['all', 'wot', 'part'] as const).map((t) => (
            <button key={t} className={prefs.filters.throttle === t ? 'active' : ''} onClick={() => setFilters({ throttle: t })}>
              {t === 'all' ? 'All throttle' : t === 'wot' ? 'WOT' : 'Part throttle'}
            </button>
          ))}
        </div>
        {hasGear && (
          <select className="select" style={{ width: 110, height: 26 }} value={prefs.filters.gear ?? ''} onChange={(e) => setFilters({ gear: e.target.value === '' ? null : Number(e.target.value) })}>
            <option value="">All gears</option>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((g) => (
              <option key={g} value={g}>
                Gear {g}
              </option>
            ))}
          </select>
        )}
        <button
          className={`chip ${prefs.filters.visibleOnly ? 'on' : ''}`}
          title={range ? 'Only the time range visible in the graphs' : 'Zoom the graphs to a range first'}
          onClick={() => setFilters({ visibleOnly: !prefs.filters.visibleOnly })}
        >
          Visible range only
        </button>
        <span className="hm-min">
          Min samples
          <input type="range" min={1} max={50} step={1} value={prefs.minSamples} onChange={(e) => setPrefs({ minSamples: Number(e.target.value) })} />
          <b>{prefs.minSamples}</b>
        </span>
      </div>

      <div className="hm-sources">
        <span className="log-chip">
          <b title={log.path}>{log.name}</b>
        </span>
        {extra
          .filter((l) => l !== log)
          .map((l) => (
            <span key={l.path ?? l.name} className="log-chip">
              <b title={l.path}>{l.name}</b>
              <button className="icon-btn" onClick={() => setExtra(extra.filter((x) => x !== l))} aria-label={`Remove ${l.name}`}>
                <X size={12} />
              </button>
            </span>
          ))}
        <button className="btn sm" onClick={addLogs}>
          <Plus size={12} /> Add logs
        </button>
        <span className="muted small" style={{ marginLeft: 'auto' }}>
          {logs.length} log{logs.length > 1 ? 's' : ''} · {totalMinutes.toFixed(1)} min
          {m && ` · ${m.grid.samples.toLocaleString()} samples in the grid${m.grid.outside ? ` · ${m.grid.outside.toLocaleString()} outside the axes` : ''}`}
        </span>
      </div>

      {(preset?.beta || info?.beta) && (
        <div className="warning-bar" style={{ marginTop: 0, marginBottom: 8 }}>
          <AlertTriangle size={14} />
          Beta: timing correction is estimated from the spread between the cylinders&apos; ignition timing, after removing each cylinder&apos;s normal
          offset. It catches cylinder-specific pulls; a retard applied equally to all cylinders isn&apos;t visible.
        </div>
      )}

      {m && m.grid.outside > 0.1 * (m.grid.samples + m.grid.outside) && (
        <div className="warning-bar" style={{ marginTop: 0, marginBottom: 8 }}>
          <AlertTriangle size={14} />
          {Math.round((100 * m.grid.outside) / (m.grid.samples + m.grid.outside))}% of the samples fall outside the axes. Widen them with Axes → Auto from
          data.
        </div>
      )}

      {'error' in model ? (
        <div className="empty" style={{ margin: '24px auto', maxWidth: 560 }}>
          {model.error}
        </div>
      ) : (
        <div className="hm-body">
          <div className="hm-main">
            <HeatmapGridView model={model} selected={selected} onSelect={setSelected} />
          </div>
          <aside className="hm-side">
            {selected !== null ? (
              <CellDetail model={model} index={selected} logs={logs} onJump={onJump} />
            ) : (
              <div className="hm-detail muted">Click a cell to see its statistics and jump to the moments that landed there.</div>
            )}
          </aside>
        </div>
      )}

      {m && (m.unavailableFilters.length > 0 || m.skipped.length > 0) && (
        <div className="muted small" style={{ marginTop: 6, color: 'var(--amber)' }}>
          {m.unavailableFilters.length > 0 && <>Not applied: {m.unavailableFilters.join('; ')}. </>}
          {m.skipped.map((s) => `${logs[s.index].name} skipped (${s.reason})`).join('; ')}
        </div>
      )}


      {editingAxes && (
        <AxesModal
          x={prefs.x}
          y={prefs.y}
          channels={[...(sources[0]?.defs.values() ?? [])]}
          units={settings.units}
          autoEdges={(id) => {
            const src = sources[0]
            const def = src?.defs.get(id)
            const ch = src && findChannel(src.log, id)
            if (!def || !ch) return null
            const unit = displayUnitFor(def, settings.units)
            return autoEdges(ch.data.map((v) => unit.toDisplay(v)), id === 'engine.rpm' ? 13 : 11)
          }}
          onSave={(x, y) => setPrefs({ x, y })}
          onClose={() => setEditingAxes(false)}
        />
      )}
    </div>
  )
}

function HeatmapGridView({ model, selected, onSelect }: { model: HeatmapModel; selected: number | null; onSelect: (i: number) => void }) {
  const { xEdges, yEdges } = model.grid
  const cols = xEdges.length - 1
  const rows = yEdges.length - 1
  const ends = ENDS[model.valueDef.id] ?? ['', '']
  const lo = model.scale.kind === 'diverging' ? -model.scale.limit : model.scale.min
  const hi = model.scale.kind === 'diverging' ? model.scale.limit : model.scale.max
  const cellsDesc: ReactNode[] = []
  for (let r = rows - 1; r >= 0; r--) {
    cellsDesc.push(
      <div key={`l${r}`} className="hm-label">
        {fmtEdge(yEdges[r])}
      </div>
    )
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      const cell = model.grid.cells[i]
      const v = model.values[i]
      const tip = `${fmtEdge(xEdges[c])}–${fmtEdge(xEdges[c + 1])} ${model.xUnit.label} · ${fmtEdge(yEdges[r])}–${fmtEdge(yEdges[r + 1])} ${model.yUnit.label}\n${
        cell.n ? `${Number.isFinite(v) ? `${fmtVal(v, model.decimals)} · ` : ''}${cell.n} samples · ${cell.time.toFixed(1)} s` : 'No data'
      }`
      if (!Number.isFinite(v)) {
        cellsDesc.push(<div key={i} className={`hm-cell hm-empty ${cell.n ? 'few' : ''}`} title={cell.n ? `${tip} (below the minimum)` : tip} />)
        continue
      }
      const { bg, fg } = cellColor(model, v)
      cellsDesc.push(
        <div key={i} className={`hm-cell ${selected === i ? 'sel' : ''}`} style={{ background: bg, color: fg }} title={tip} onClick={() => onSelect(i)}>
          {fmtVal(v, model.decimals)}
        </div>
      )
    }
  }
  return (
    <>
      <div className="hm-axis-y">
        {model.yDef.name} · {model.yUnit.label}
      </div>
      <div className="hm-grid" style={{ gridTemplateColumns: `52px repeat(${cols}, minmax(0, 1fr))` }}>
        {cellsDesc}
        <div />
        {Array.from({ length: cols }, (_, c) => (
          <div key={`x${c}`} className="hm-xlabel">
            {fmtEdge(xEdges[c])}
          </div>
        ))}
      </div>
      <div className="hm-axis-x">
        {model.xDef.name} · {model.xUnit.label}
      </div>
      <div className="hm-legend">
        <span>
          {fmtVal(lo, model.decimals)}
          {ends[0] && ` ${ends[0]}`}
        </span>
        <div className="bar" style={{ background: legendGradient(model) }} />
        <span>
          {fmtVal(hi, model.decimals)} {model.valueUnit.label}
          {ends[1] && ` ${ends[1]}`}
        </span>
        <span className="hm-nodata">
          <span /> no data
        </span>
      </div>
    </>
  )
}

function CellDetail({ model, index, logs, onJump }: { model: HeatmapModel; index: number; logs: LogData[]; onJump: (log: LogData, span: HeatmapSpan) => void }) {
  const { xEdges, yEdges, cells } = model.grid
  const cols = xEdges.length - 1
  const c = index % cols
  const r = Math.floor(index / cols)
  const cell = cells[index]
  const d = model.decimals
  const stats: [string, string][] = [
    ['Mean', fmtVal(cellValue(cell, 'mean'), d)],
    ['Min', fmtVal(cellValue(cell, 'min'), d)],
    ['Max', fmtVal(cellValue(cell, 'max'), d)],
    ['Std deviation', fmtVal(cellValue(cell, 'std'), d + 1)],
    ['Samples', cell.n.toLocaleString()],
    ['Time', `${cell.time.toFixed(1)} s`]
  ]
  const spans = [...cell.spans].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, MAX_SPAN_CHIPS)
  return (
    <div className="hm-detail">
      <div className="hm-detail-head">
        {fmtEdge(xEdges[c])}–{fmtEdge(xEdges[c + 1])} {model.xUnit.label} · {fmtEdge(yEdges[r])}–{fmtEdge(yEdges[r + 1])} {model.yUnit.label}
        <span className="muted"> · {model.valueDef.name} ({model.valueUnit.label || 'no unit'})</span>
      </div>
      <div className="hm-stats">
        {stats.map(([k, v]) => (
          <div key={k}>
            <div className="dim small">{k}</div>
            <b>{v}</b>
          </div>
        ))}
      </div>
      <div className="small muted" style={{ marginBottom: 6 }}>
        Landed here {cell.spanCount} time{cell.spanCount === 1 ? '' : 's'}
        {cell.spanCount > spans.length ? ` (longest ${spans.length} shown)` : ''}. Click one to see it in the graphs:
      </div>
      <div className="row wrap">
        {spans.map((s, i) => (
          <button key={i} className="chip" onClick={() => onJump(logs[s.log], s)}>
            {logs.length > 1 && `${logs[s.log].name.replace(/\.[^.]+$/, '')} · `}
            {s.start.toFixed(1)}–{s.end.toFixed(1)} s
          </button>
        ))}
      </div>
    </div>
  )
}
