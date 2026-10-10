import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { LogViewerPrefs, UnitPrefs } from '@shared/types'
import { Chart, type ChartHandle, type ChartRegion, type ChartScale, type ChartSeries } from '../components/Chart'
import { MenuButton } from '../components/ui'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChannelsIcon,
  CsvIcon,
  ExpandIcon,
  ImageIcon,
  PinIcon,
  RenameIcon,
  ResetIcon,
  ShrinkIcon,
  TrashIcon,
  UnpinIcon
} from '../components/icons'
import { channelView, fmt } from '../lib/format'
import { colorAt } from '../lib/colors'
import type { GraphConfig, SeriesSource } from './types'

export interface GraphPanelHandle {
  png(): string
}

interface Props {
  config: GraphConfig
  index: number
  count: number
  source: SeriesSource
  compareLabel?: string
  units: UnitPrefs
  prefs: LogViewerPrefs
  xRange: [number, number] | null
  onXRange?: (r: [number, number] | null) => void
  interactive: boolean
  regions: ChartRegion[]
  fullscreen: boolean
  live: boolean
  onChange: (cfg: GraphConfig) => void
  onRemove: () => void
  onMove: (dir: -1 | 1) => void
  onToggleFullscreen: () => void
  onEditChannels: () => void
  onExportCsv?: () => void
  onSavePng: () => void
  onContextMenu: (e: MouseEvent, x: number | null) => void
}

export const GraphPanel = forwardRef<GraphPanelHandle, Props>(function GraphPanel(p, ref) {
  const chart = useRef<ChartHandle>(null)
  const [renaming, setRenaming] = useState(false)
  const [cursor, setCursor] = useState<number | null>(null)

  const views = useMemo(
    () => p.config.channelIds.map((id) => p.source.defs.get(id)).filter((d) => d !== undefined).map((d) => channelView(d, p.units)),
    [p.config.channelIds, p.source.defs, p.units]
  )

  const { series, scales } = useMemo(() => {
    const series: ChartSeries[] = []
    const scales: ChartScale[] = []
    views.forEach((v, i) => {
      const color = colorAt(i)
      const scale = `y${i}`
      const conv = (arr: (number | null)[] | undefined): (number | null)[] =>
        arr ? arr.map((x) => (x === null ? null : v.unit.toDisplay(x))) : p.source.x.map(() => null)
      const label = `${v.def.name}${v.unit.label ? ` · ${v.unit.label}` : ''}`
      series.push({ label, color, scale, values: conv(p.source.a(v.def.id)), decimals: v.decimals, unit: v.unit.label })
      if (p.source.b) {
        series.push({
          label: `${label} (compare)`,
          color,
          scale,
          values: conv(p.source.b(v.def.id)),
          dash: [5, 4],
          width: 1.1,
          decimals: v.decimals,
          unit: v.unit.label
        })
      }
      scales.push({
        key: scale,
        label: v.unit.label,
        color,
        side: 'right',
        show: p.prefs.scaleLegends || i === 0,
        range: p.config.ranges[v.def.id] ?? null
      })
    })
    return { series, scales }
  }, [views, p.source, p.prefs.scaleLegends, p.config.ranges])

  const legend = series.filter((s) => !s.dash).map((s) => ({ label: s.label, color: s.color }))

  useImperativeHandle(ref, () => ({ png: () => chart.current?.toPng(p.config.title, legend) ?? '' }))

  const valueAt = (s: ChartSeries): string => {
    let idx = cursor
    if (idx === null && p.live) {
      for (let k = s.values.length - 1; k >= 0 && k >= s.values.length - 10; k--) {
        if (s.values[k] !== null) {
          idx = k
          break
        }
      }
    }
    return idx === null ? '' : fmt(s.values[idx], s.decimals ?? 2)
  }

  const set = (patch: Partial<GraphConfig>): void => p.onChange({ ...p.config, ...patch })

  return (
    <div className={`graph ${p.fullscreen ? 'fullscreen' : ''}`}>
      <div className="graph-head">
        <div className="graph-title">
          {renaming ? (
            <input
              autoFocus
              defaultValue={p.config.title}
              onBlur={(e) => {
                set({ title: e.target.value.trim() || p.config.title })
                setRenaming(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setRenaming(false)
              }}
            />
          ) : (
            <span onDoubleClick={() => setRenaming(true)} title="Double-click to rename">
              {p.config.title}
            </span>
          )}
          {p.config.pinned && <PinIcon size={14} weight="fill" className="dim" />}
        </div>
        <button className="btn sm" onClick={p.onEditChannels}>
          <ChannelsIcon size={14} /> Channels
        </button>
        <MenuButton
          label="Save"
          icon={<ImageIcon size={14} />}
          items={[
            { label: 'Graph as PNG…', icon: <ImageIcon size={15} />, onClick: p.onSavePng },
            { label: 'Visible range as CSV…', icon: <CsvIcon size={15} />, onClick: p.onExportCsv, disabled: !p.onExportCsv }
          ]}
        />
        <div className="graph-tools">
          <button className="icon-btn" title="Rename graph" onClick={() => setRenaming(true)}>
            <RenameIcon size={16} />
          </button>
          <button
            className="icon-btn"
            title="Reset Y scales"
            disabled={!Object.keys(p.config.ranges).length}
            onClick={() => set({ ranges: {} })}
          >
            <ResetIcon size={16} />
          </button>
          <button className={`icon-btn ${p.config.pinned ? 'on' : ''}`} title={p.config.pinned ? 'Unpin graph' : 'Pin graph position'} onClick={() => set({ pinned: !p.config.pinned })}>
            {p.config.pinned ? <UnpinIcon size={16} /> : <PinIcon size={16} />}
          </button>
          <button className="icon-btn" title="Move up" disabled={p.config.pinned || p.index === 0} onClick={() => p.onMove(-1)}>
            <ArrowUpIcon size={16} />
          </button>
          <button className="icon-btn" title="Move down" disabled={p.config.pinned || p.index === p.count - 1} onClick={() => p.onMove(1)}>
            <ArrowDownIcon size={16} />
          </button>
          <button className="icon-btn" title={p.fullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={p.onToggleFullscreen}>
            {p.fullscreen ? <ShrinkIcon size={16} /> : <ExpandIcon size={16} />}
          </button>
          <button className="icon-btn" title="Remove graph" disabled={p.config.pinned || p.count <= 1} onClick={p.onRemove}>
            <TrashIcon size={16} />
          </button>
        </div>
      </div>
      <div className="graph-legend">
        {series.map((s, i) => (
          <span key={i} className={`legend-item ${s.dash ? 'compare' : ''}`}>
            <span className="swatch" style={{ background: s.dash ? `repeating-linear-gradient(90deg, ${s.color} 0 4px, transparent 4px 7px)` : s.color }} />
            {s.dash ? p.compareLabel ?? 'Compare' : s.label}
            <span className="val">{valueAt(s)}</span>
          </span>
        ))}
        {!series.length && <span className="dim">No channels yet. Use “Channels” to add up to 5.</span>}
      </div>
      <Chart
        ref={chart}
        x={p.source.x}
        xLabel="Time · s"
        xDecimals={0}
        series={series}
        scales={scales}
        xRange={p.xRange}
        onXRange={p.onXRange}
        regions={p.regions}
        syncKey="logviewer"
        smooth={p.prefs.lineSmoothing}
        tooltip={p.prefs.cursorPopups}
        interactive={p.interactive}
        onCursor={setCursor}
        onContextMenu={p.onContextMenu}
      />
    </div>
  )
})
