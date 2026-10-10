import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LogData, WotSegment } from '@shared/types'
import type { OpenedFile } from '@shared/ipc'
import { MAX_GRAPHS } from '@shared/catalog'
import { parseLogCsv, serializeLogCsv } from '@shared/analysis/csv'
import { detectWotSegments } from '@shared/analysis/wot'
import { api, isOnline, useApp } from '../store'
import { liveBuffer } from '../lib/liveBuffer'
import { Menu, MenuButton, PromptModal, type MenuItem } from '../components/ui'
import type { ChartRegion } from '../components/Chart'
import {
  AxesIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CloseIcon,
  CompareIcon,
  CsvIcon,
  DragIcon,
  DynoIcon,
  ExpandIcon,
  FolderIcon,
  GraphIcon,
  ImageIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SaveIcon,
  SearchIcon,
  ShrinkIcon,
  TilesIcon,
  ZoomOutIcon
} from '../components/icons'
import { GraphPanel, type GraphPanelHandle } from './GraphPanel'
import { EditChannelsModal } from './EditChannelsModal'
import { HeatmapView } from '../heatmap/HeatmapView'
import type { HeatmapSpan } from '@shared/analysis/heatmap'
import { logSource, newGraph, type GraphConfig, type SeriesSource } from './types'

const DEFAULT_GRAPHS = (): GraphConfig[] => [
  newGraph('Graph 1', ['engine.rpm', 'boost.actual', 'boost.target', 'boost.wg_actual', 'fuel.rail.actual'])
]

const LIVE_FPS_MS = 66

/** Request from outside (e.g. the log library) to show a file. */
export interface OpenRequest {
  file: OpenedFile
  nonce: number
}

export function LogViewer({
  mode,
  expanded,
  onToggleExpand,
  openRequest,
  onLogChange
}: {
  /** 'live' graphs the stream from the car; 'log' shows recorded log files. */
  mode: 'live' | 'log'
  expanded: boolean
  onToggleExpand: () => void
  openRequest?: OpenRequest | null
  onLogChange?: (log: LogData | null) => void
}) {
  const settings = useApp((s) => s.settings)!
  const channelMap = useApp((s) => s.channelMap)
  const channels = useApp((s) => s.channels)
  const presets = useApp((s) => s.presets)
  const status = useApp((s) => s.status)
  const toast = useApp((s) => s.toast)
  const requestStream = useApp((s) => s.requestStream)

  const [graphs, setGraphs] = useState<GraphConfig[]>(DEFAULT_GRAPHS)
  const [log, setLog] = useState<LogData | null>(null)
  const [compare, setCompare] = useState<{ log: LogData; offset: number } | null>(null)
  const [paused, setPaused] = useState(false)
  const [xRange, setXRange] = useState<[number, number] | null>(null)
  const [wotIdx, setWotIdx] = useState(-1)
  const [view, setView] = useState<'graphs' | 'heatmap'>('graphs')
  /** Moment picked from a heatmap cell, shaded in the graphs. */
  const [highlight, setHighlight] = useState<[number, number] | null>(null)
  const [fullscreen, setFullscreen] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [savingLayout, setSavingLayout] = useState(false)
  const [ctx, setCtx] = useState<{ x: number; y: number; graph: string; at: number | null } | null>(null)
  const [liveSource, setLiveSource] = useState<SeriesSource | null>(null)
  const panels = useRef(new Map<string, GraphPanelHandle | null>())

  const live = mode === 'live'
  const allIds = useMemo(() => [...new Set(graphs.flatMap((g) => g.channelIds))], [graphs])
  const allKey = allIds.join('|')

  // Live graph channels must be sampled by the main process too.
  useEffect(() => {
    if (live) requestStream('livegraphs', allIds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, allKey, requestStream])

  // Live mode: poll the ring buffer at ~15 fps.
  useEffect(() => {
    if (!live || paused) return
    let raf = 0
    let seen = -1
    let last = 0
    const ids = allKey ? allKey.split('|') : []
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick)
      if (liveBuffer.version === seen || now - last < LIVE_FPS_MS) return
      seen = liveBuffer.version
      last = now
      const w = liveBuffer.window(settings.logViewer.liveWindowSec, ids)
      const byId = new Map(ids.map((id, i) => [id, w.series[i]]))
      setLiveSource({ x: w.t, a: (id) => byId.get(id), defs: useApp.getState().channelMap })
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [live, paused, allKey, settings.logViewer.liveWindowSec])

  const source: SeriesSource = useMemo(() => {
    if (log) return logSource(log, channelMap, compare ?? undefined)
    if (live && liveSource) return liveSource
    return { x: [], a: () => undefined, defs: channelMap }
  }, [log, live, compare, liveSource, channelMap])

  const segments: WotSegment[] = useMemo(() => (log ? detectWotSegments(log) : []), [log])

  const regions: ChartRegion[] = useMemo(
    () => [
      ...segments.map((s, i) => ({
        from: s.start,
        to: s.end,
        color: i === wotIdx ? 'rgba(255, 173, 51, 0.075)' : 'rgba(255, 173, 51, 0.035)'
      })),
      ...(highlight ? [{ from: highlight[0], to: highlight[1], color: 'rgba(56, 189, 248, 0.2)' }] : [])
    ],
    [segments, wotIdx, highlight]
  )

  const liveFollowing = live && !paused
  const effectiveRange: [number, number] | null = liveFollowing
    ? source.x.length
      ? [Math.max(source.x[0], source.x[source.x.length - 1] - settings.logViewer.liveWindowSec), source.x[source.x.length - 1]]
      : null
    : xRange

  const onXRange = useCallback((r: [number, number] | null) => {
    setXRange((prev) => (prev && r && Math.abs(prev[0] - r[0]) < 1e-9 && Math.abs(prev[1] - r[1]) < 1e-9 ? prev : r))
  }, [])

  // ------------------------------------------------------------ log files

  const showLog = (next: LogData): void => {
    setLog(next)
    onLogChange?.(next)
    setCompare(null)
    setXRange(null)
    setWotIdx(-1)
    setHighlight(null)
    // Foreign logs rarely share our ids: fall back to the first channels of the log.
    const ids = new Set(next.channels.map((c) => c.id))
    setGraphs((gs) => {
      if (gs.some((g) => g.channelIds.some((id) => ids.has(id)))) return gs
      return [newGraph('Graph 1', next.channels.slice(0, 5).map((c) => c.id))]
    })
  }

  const loadLog = (text: string, name: string, path?: string): void => {
    try {
      const parsed = parseLogCsv(text, name)
      parsed.path = path
      showLog(parsed)
      toast(`Opened ${name} · ${parsed.channels.length} channels · ${duration(parsed).toFixed(1)} s`, 'success')
    } catch (err) {
      toast(`Could not read ${name}: ${String(err)}`, 'error')
    }
  }

  useEffect(() => {
    if (openRequest) loadLog(openRequest.file.text, openRequest.file.name, openRequest.file.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest])

  const openLog = async (): Promise<void> => {
    const f = await api.openLogDialog()
    if (f) loadLog(f.text, f.name, f.path)
  }

  const openCompare = async (): Promise<void> => {
    const f = await api.openLogDialog()
    if (!f) return
    try {
      const other = parseLogCsv(f.text, f.name)
      const segB = detectWotSegments(other)
      const offset = segments[0] && segB[0] ? segments[0].start - segB[0].start : 0
      setCompare({ log: other, offset })
      toast(`Comparing with ${f.name}${offset ? ' · aligned on first WOT pull' : ''}`)
    } catch (err) {
      toast(`Could not read ${f.name}: ${String(err)}`, 'error')
    }
  }

  const closeLog = (): void => {
    setLog(null)
    onLogChange?.(null)
    setCompare(null)
    setXRange(null)
    setWotIdx(-1)
    setHighlight(null)
  }

  const exportRange = async (range: [number, number] | null): Promise<void> => {
    if (!log) return
    const r = range ?? [log.time[0], log.time[log.time.length - 1]]
    const text = serializeLogCsv(log, { start: r[0], end: r[1] })
    const base = log.name.replace(/\.[^.]+$/, '')
    const file = await api.saveTextDialog(`${base}_${r[0].toFixed(1)}-${r[1].toFixed(1)}s.csv`, text, 'csv')
    if (file) toast('CSV exported', 'success')
  }

  const savePng = async (key: string): Promise<void> => {
    const g = graphs.find((x) => x.key === key)
    const data = panels.current.get(key)?.png()
    if (!g || !data) return
    const file = await api.savePngDialog(`${g.title.replace(/[^\w-]+/g, '_')}.png`, data)
    if (file) toast('Graph saved as PNG', 'success')
  }

  const goWot = (i: number): void => {
    const s = segments[i]
    if (!s) return
    setWotIdx(i)
    const pad = Math.max(0.5, (s.end - s.start) * 0.15)
    setXRange([s.start - pad, s.end + pad])
  }

  const sendTo = (page: 'dyno' | 'drag', segment?: WotSegment): void => {
    if (!log) return
    useApp.setState(page === 'dyno' ? { pendingDyno: { log, segment }, page } : { pendingDrag: { log, segment }, page })
  }

  /** Shows a moment picked in the heatmap: switches to the graphs, zoomed in and shaded. */
  const jumpTo = (target: LogData, span: HeatmapSpan): void => {
    if (target !== log) showLog(target)
    const pad = Math.max(1.5, (span.end - span.start) * 0.6)
    setWotIdx(-1)
    setView('graphs')
    setXRange([span.start - pad, span.end + pad])
    setHighlight([span.start, span.end])
  }

  // --------------------------------------------------------------- graphs

  const updateGraph = (cfg: GraphConfig): void => setGraphs((gs) => gs.map((g) => (g.key === cfg.key ? cfg : g)))
  const moveGraph = (key: string, dir: -1 | 1): void =>
    setGraphs((gs) => {
      const i = gs.findIndex((g) => g.key === key)
      const j = i + dir
      if (j < 0 || j >= gs.length || gs[j].pinned) return gs
      const next = [...gs]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  const removeGraph = (key: string): void => setGraphs((gs) => gs.filter((g) => g.key !== key))
  const addGraph = (): void => {
    if (graphs.length >= MAX_GRAPHS) return
    setGraphs([...graphs, newGraph(`Graph ${graphs.length + 1}`)])
    setEditing(null)
  }

  const applyLayout = (name: string): void => {
    const layout = presets.layouts.find((l) => l.name === name)
    if (!layout) return
    setGraphs(layout.graphs.slice(0, MAX_GRAPHS).map((g) => ({ ...newGraph(g.title, g.channelIds.slice(0, 5)), pinned: !!g.pinned })))
    toast(`Layout “${name}” applied`)
  }
  const saveLayout = (name: string): void => {
    const layouts = presets.layouts.filter((l) => l.name !== name)
    const graphsOut = graphs.map((g) => ({ title: g.title, channelIds: g.channelIds, pinned: g.pinned }))
    void useApp.getState().setPresets({ ...presets, layouts: [...layouts, { name, graphs: graphsOut }] })
    toast(`Layout “${name}” saved`, 'success')
  }
  const layoutItems: MenuItem[] = presets.layouts.length
    ? presets.layouts.map((l) => ({ label: l.name, icon: <TilesIcon size={15} />, onClick: () => applyLayout(l.name) }))
    : [{ label: 'No saved layouts yet', disabled: true }]

  const editingGraph = graphs.find((g) => g.key === editing)
  const availableForEdit = log
    ? [...new Map([...log.channels, ...(compare?.log.channels ?? [])].map((c) => [c.id, source.defs.get(c.id)!])).values()]
    : channels

  const contextItems = (graphKey: string, at: number | null): MenuItem[] => {
    const segIdx = at === null ? -1 : segments.findIndex((s) => at >= s.start && at <= s.end)
    return [
      { label: 'Zoom to fit', icon: <ZoomOutIcon size={15} />, onClick: () => setXRange(null), disabled: liveFollowing },
      ...(segIdx >= 0
        ? [
            { label: `Zoom to WOT pull ${segIdx + 1}`, icon: <SearchIcon size={15} />, onClick: () => goWot(segIdx) },
            { label: 'Analyze this pull on Dyno', icon: <DynoIcon size={15} />, onClick: () => sendTo('dyno', segments[segIdx]) },
            { label: 'Export this pull as CSV…', icon: <CsvIcon size={15} />, onClick: () => exportRange([segments[segIdx].start, segments[segIdx].end]) }
          ]
        : []),
      { separator: true, label: '' },
      { label: 'Export visible range as CSV…', icon: <CsvIcon size={15} />, onClick: () => exportRange(xRange), disabled: !log },
      { label: 'Save graph as PNG…', icon: <ImageIcon size={15} />, onClick: () => savePng(graphKey) },
      {
        label: fullscreen === graphKey ? 'Exit fullscreen' : 'Fullscreen',
        icon: <ExpandIcon size={15} />,
        onClick: () => setFullscreen(fullscreen === graphKey ? null : graphKey)
      },
      { label: 'Edit channels…', icon: <TilesIcon size={15} />, onClick: () => setEditing(graphKey) },
      ...(live ? [{ label: paused ? 'Resume graphs' : 'Freeze graphs', icon: paused ? <PlayIcon size={15} /> : <PauseIcon size={15} />, onClick: () => setPaused(!paused) }] : [])
    ]
  }

  const online = isOnline(status)

  return (
    <section className="card logviewer">
      <div className="panel-header">
        {live ? (
          <h2>
            <GraphIcon size={18} /> Live graphs
          </h2>
        ) : (
          <>
            <div className="segmented">
              <button className={view === 'graphs' ? 'active' : ''} onClick={() => setView('graphs')}>
                Graphs
              </button>
              <button className={view === 'heatmap' ? 'active' : ''} onClick={() => setView('heatmap')}>
                Heatmap
              </button>
            </div>
            {log && (
              <span className="log-chip">
                <CsvIcon size={15} />
                <b title={log.path}>{log.name}</b>
                <span className="mono">
                  {duration(log).toFixed(1)} s · {log.channels.length} ch
                </span>
                <button className="icon-btn" onClick={closeLog} title="Close log">
                  <CloseIcon size={13} />
                </button>
              </span>
            )}
            {compare && (
              <span className="log-chip">
                <CompareIcon size={15} />
                <b>{compare.log.name}</b>
                offset
                <input
                  className="input"
                  style={{ width: 74, height: 26 }}
                  type="number"
                  step={0.1}
                  value={compare.offset}
                  onChange={(e) => setCompare({ ...compare, offset: parseFloat(e.target.value) || 0 })}
                />
                s
                <button className="icon-btn" onClick={() => setCompare(null)} title="Stop comparing">
                  <CloseIcon size={13} />
                </button>
              </span>
            )}
          </>
        )}
        <div className="actions">
          {live ? (
            <button className="btn" onClick={() => setPaused(!paused)} disabled={!online && !paused}>
              {paused ? <PlayIcon size={14} weight="fill" /> : <PauseIcon size={14} weight="fill" />}
              {paused ? 'Resume graphs' : 'Freeze graphs'}
            </button>
          ) : (
            <MenuButton
              label="Open"
              className="btn"
              icon={<FolderIcon size={15} />}
              items={() => [
                { label: 'Open log file…', icon: <FolderIcon size={15} />, onClick: openLog },
                { label: 'Compare with another log…', icon: <CompareIcon size={15} />, onClick: openCompare, disabled: !log }
              ]}
            />
          )}
          <button className="btn ghost" onClick={onToggleExpand} title={expanded ? 'Restore' : 'Give the graphs the whole page'}>
            {expanded ? <ShrinkIcon size={15} /> : <ExpandIcon size={15} />}
            {expanded ? 'Restore' : 'Expand'}
          </button>
        </div>
      </div>

      {view === 'heatmap' && !live ? (
        <HeatmapView log={log} range={xRange} onJump={jumpTo} onOpenLog={openLog} />
      ) : (
        <>
          {log && segments.length > 0 && (
            <div className="pull-bar">
              <div className="wot-nav">
                WOT pulls
                <button className="icon-btn" onClick={() => goWot(wotIdx <= 0 ? segments.length - 1 : wotIdx - 1)} title="Previous pull">
                  <CaretLeftIcon size={14} weight="bold" />
                </button>
                <span className="mono">{wotIdx >= 0 ? `${wotIdx + 1} / ${segments.length}` : `${segments.length} found`}</span>
                <button className="icon-btn" onClick={() => goWot((wotIdx + 1) % segments.length)} title="Next pull">
                  <CaretRightIcon size={14} weight="bold" />
                </button>
              </div>
              {wotIdx >= 0 && (
                <>
                  <span className="muted small mono">
                    {segments[wotIdx].start.toFixed(1)}–{segments[wotIdx].end.toFixed(1)} s
                    {segments[wotIdx].gear ? ` · gear ${segments[wotIdx].gear}` : ''}
                    {segments[wotIdx].peakRpm ? ` · peak ${Math.round(segments[wotIdx].peakRpm!)} rpm` : ''}
                  </span>
                  <button className="btn sm" onClick={() => sendTo('dyno', segments[wotIdx])}>
                    <DynoIcon size={14} /> Dyno this pull
                  </button>
                  <button className="btn sm" onClick={() => exportRange([segments[wotIdx].start, segments[wotIdx].end])}>
                    <CsvIcon size={14} /> Export pull
                  </button>
                </>
              )}
              <button className="btn sm ghost" onClick={() => sendTo('drag')}>
                <DragIcon size={14} /> Drag timing from log
              </button>
            </div>
          )}

          <div className="graphs">
            {(live || log) &&
              graphs.map((g, i) => (
                <GraphPanel
                  key={g.key}
                  ref={(h) => void panels.current.set(g.key, h)}
                  config={g}
                  index={i}
                  count={graphs.length}
                  source={source}
                  compareLabel={compare?.log.name}
                  units={settings.units}
                  prefs={settings.logViewer}
                  xRange={effectiveRange}
                  onXRange={liveFollowing ? undefined : onXRange}
                  interactive={!liveFollowing}
                  regions={regions}
                  fullscreen={fullscreen === g.key}
                  live={live}
                  onChange={updateGraph}
                  onRemove={() => removeGraph(g.key)}
                  onMove={(d) => moveGraph(g.key, d)}
                  onToggleFullscreen={() => setFullscreen(fullscreen === g.key ? null : g.key)}
                  onEditChannels={() => setEditing(g.key)}
                  onExportCsv={log ? () => exportRange(xRange) : undefined}
                  onSavePng={() => savePng(g.key)}
                  onContextMenu={(e, at) => setCtx({ x: e.clientX, y: e.clientY, graph: g.key, at })}
                />
              ))}
            {live && !online && (
              <div className="empty">Live graphs fill in once connected. Recorded logs open in Analyze.</div>
            )}
            {!live && !log && (
              <div className="empty" style={{ margin: 'auto', maxWidth: 520 }}>
                Pick a log from the library, or open a file. Boostline, MHD, bootmod3 and generic CSV logs work.
                <div className="row" style={{ justifyContent: 'center', marginTop: 14 }}>
                  <button className="btn" onClick={openLog}>
                    <FolderIcon size={15} /> Open log file…
                  </button>
                </div>
              </div>
            )}
          </div>

          {(live || log) && (
            <div className="viewer-footer">
              <button className="btn sm" onClick={addGraph} disabled={graphs.length >= MAX_GRAPHS}>
                <PlusIcon size={13} weight="bold" /> Add graph
              </button>
              <MenuButton label="Layouts" icon={<AxesIcon size={14} />} items={layoutItems} />
              <MenuButton
                label="Save"
                icon={<SaveIcon size={14} />}
                items={[
                  { label: 'Save layout as…', icon: <TilesIcon size={15} />, onClick: () => setSavingLayout(true) },
                  { label: 'Export visible range as CSV…', icon: <CsvIcon size={15} />, onClick: () => exportRange(xRange), disabled: !log }
                ]}
              />
              <span className="hint">
                {api.platform === 'darwin' ? '⌘+scroll or pinch to zoom' : 'Ctrl+scroll to zoom'} · Shift+scroll to pan · drag to zoom in · double-click to reset
              </span>
            </div>
          )}
        </>
      )}

      {ctx && <Menu x={ctx.x} y={ctx.y} items={contextItems(ctx.graph, ctx.at)} onClose={() => setCtx(null)} />}
      {editingGraph && (
        <EditChannelsModal
          graph={editingGraph}
          available={availableForEdit}
          units={settings.units}
          onSave={updateGraph}
          onClose={() => setEditing(null)}
        />
      )}
      {savingLayout && (
        <PromptModal title="Save graph layout" label="Layout name" initial="" onSubmit={saveLayout} onClose={() => setSavingLayout(false)} />
      )}
    </section>
  )
}

function duration(log: LogData): number {
  return log.time.length ? log.time[log.time.length - 1] - log.time[0] : 0
}
