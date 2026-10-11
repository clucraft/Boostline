import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEnvironment, DragMode, DragResult, SavedDragRun, SpeedCalPoint } from '@shared/types'
import { CH } from '@shared/types'
import { analyzeDrag, DRAG_MODES, DragDetector, dragInputFromLog } from '@shared/analysis/drag'
import { parseLogCsv } from '@shared/analysis/csv'
import { convert } from '@shared/units'
import type { RunEntry } from '@shared/ipc'
import { api, isOnline, useApp } from '../store'
import { liveBuffer } from '../lib/liveBuffer'
import { stamp, uid } from '../lib/format'
import { Chart, type ChartHandle, type ChartRegion, type ChartScale, type ChartSeries } from '../components/Chart'
import { Collapsible, NumberField, PromptModal, useClosedCourseNotice } from '../components/ui'
import {
  ArmIcon,
  CloseIcon,
  CsvIcon,
  DragIcon,
  ExpandIcon,
  ImageIcon,
  MinusIcon,
  PlusIcon,
  SaveIcon,
  ShrinkIcon,
  TrashIcon,
  WarningIcon
} from '../components/icons'
import { RUN_COLORS } from '../lib/colors'
import { RunSteps } from './RunSteps'

const MODES: { mode: DragMode; label: string }[] = [
  { mode: '0-100', label: '0–100 km/h' },
  { mode: '100-200', label: '100–200 km/h' },
  { mode: '200-300', label: '200–300 km/h' },
  { mode: '0-60mph', label: '0–60 mph' },
  { mode: '60-130mph', label: '60–130 mph' },
  { mode: '201m', label: '1/8 mile (201 m)' },
  { mode: '402m', label: '1/4 mile (402 m)' }
]
const modeLabel = (m: DragMode): string => MODES.find((x) => x.mode === m)?.label ?? m
const LIVE_IDS = [CH.speed, CH.gear, CH.rpm]
const SHIFT_MARK = 'rgba(237, 237, 238, 0.3)'

type DState = 'idle' | 'waiting-stop' | 'ready' | 'running' | 'finished' | 'aborted'
const STATE_TEXT: Record<DState, string> = {
  idle: '',
  'waiting-stop': 'Armed · come to a complete stop',
  ready: 'Ready · launch when you are',
  running: 'Running…',
  finished: 'Finished',
  aborted: 'Aborted · speed dropped before the finish'
}

export function DragPage() {
  const settings = useApp((s) => s.settings)!
  const updateSettings = useApp((s) => s.updateSettings)
  const presets = useApp((s) => s.presets)
  const setPresets = useApp((s) => s.setPresets)
  const status = useApp((s) => s.status)
  const pending = useApp((s) => s.pendingDrag)
  const requestStream = useApp((s) => s.requestStream)
  const toast = useApp((s) => s.toast)
  const drag = settings.drag
  const speedUnit = settings.units.speed

  const [state, setState] = useState<DState>('idle')
  const [current, setCurrent] = useState<SavedDragRun | null>(null)
  const [saved, setSaved] = useState(true)
  const [runs, setRuns] = useState<RunEntry[]>([])
  const [expanded, setExpanded] = useState(false)
  const [newPoint, setNewPoint] = useState({ ecu: '', gps: '' })
  const [selectedPoint, setSelectedPoint] = useState(-1)
  const [savingProfile, setSavingProfile] = useState(false)
  const detector = useRef<DragDetector | null>(null)
  const chart = useRef<ChartHandle>(null)

  const refreshRuns = (): void => void api.listRuns('drag').then(setRuns)
  useEffect(refreshRuns, [])

  const setDrag = (patch: Partial<typeof drag>): void => void updateSettings({ drag: { ...drag, ...patch } })
  const setEnv = (patch: Partial<DragEnvironment>): void => setDrag({ environment: { ...drag.environment, ...patch } })

  const toRun = (result: DragResult, name: string): SavedDragRun => ({
    id: uid(),
    name: `${modeLabel(result.mode)} · ${result.finalTime !== null ? `${result.finalTime.toFixed(3)} s` : 'unfinished'} · ${name}`,
    createdAt: new Date().toISOString(),
    vin: status.vin,
    result
  })

  const saveRun = async (run: SavedDragRun): Promise<void> => {
    await api.saveRun('drag', run)
    setSaved(true)
    refreshRuns()
  }

  useEffect(() => {
    if (!pending) return
    useApp.setState({ pendingDrag: null })
    const input = dragInputFromLog(pending.log)
    if (!input) {
      toast('This log has no vehicle speed channel', 'error')
      return
    }
    const result = analyzeDrag(input, drag.mode, { calibration: drag.calibration, environment: drag.environment })
    setCurrent(toRun(result, pending.log.name.replace(/\.[^.]+$/, '')))
    setSaved(false)
    if (!result.finished) toast(`No complete ${modeLabel(drag.mode)} run found in this log`, 'error')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])

  // Live arming loop.
  const armed = state === 'waiting-stop' || state === 'ready' || state === 'running'
  useEffect(() => {
    requestStream('drag', armed ? LIVE_IDS : [])
    if (!armed) return
    let lastT = liveBuffer.lastTime()
    const id = setInterval(() => {
      const d = detector.current
      if (!d) return
      const { t, cols } = liveBuffer.since(lastT, LIVE_IDS)
      if (!t.length) return
      lastT = t[t.length - 1]
      let s: DState = state
      for (let i = 0; i < t.length; i++) {
        s = d.push(t[i], cols[0][i], Number.isFinite(cols[1][i]) ? cols[1][i] : undefined, Number.isFinite(cols[2][i]) ? cols[2][i] : undefined)
      }
      if (s !== state) setState(s)
      if (s === 'finished' || s === 'aborted') {
        const result = analyzeDrag(d.input(), drag.mode, { calibration: drag.calibration, environment: drag.environment })
        const run = toRun(result, stamp())
        setCurrent(run)
        if (result.finished) {
          void saveRun(run)
          toast(`${modeLabel(drag.mode)}: ${result.finalTime?.toFixed(3)} s`, 'success')
        } else setSaved(false)
      }
    }, 50)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  const closedCourse = useClosedCourseNotice()
  const arm = (): void => {
    if (armed) {
      setState('idle')
      return
    }
    closedCourse.confirm(() => {
      detector.current = new DragDetector(drag.mode, { calibration: drag.calibration, environment: drag.environment })
      setState(detector.current.state as DState)
    })
  }

  const fromLogFile = async (): Promise<void> => {
    const f = await api.openLogDialog()
    if (!f) return
    useApp.setState({ pendingDrag: { log: parseLogCsv(f.text, f.name) } })
  }

  const openRun = async (entry: RunEntry): Promise<void> => {
    const run = (await api.loadRun('drag', entry.id)) as SavedDragRun | null
    if (run) {
      setCurrent(run)
      setSaved(true)
    }
  }

  // ------------------------------------------------------------ calibration
  const addPoint = (): void => {
    const ecu = parseFloat(newPoint.ecu)
    const gps = parseFloat(newPoint.gps)
    if (!Number.isFinite(ecu) || !Number.isFinite(gps) || ecu <= 0 || gps <= 0) {
      toast('Enter both the ECU speed and the GPS speed', 'error')
      return
    }
    const toKmh = (v: number): number => convert(v, speedUnit, 'km/h')
    const points = [...drag.calibration.filter((p) => Math.abs(p.ecu - toKmh(ecu)) > 0.05), { ecu: toKmh(ecu), gps: toKmh(gps) }].sort((a, b) => a.ecu - b.ecu)
    setDrag({ calibration: points })
    setNewPoint({ ecu: '', gps: '' })
  }
  const removePoint = (): void => {
    if (selectedPoint < 0) return
    setDrag({ calibration: drag.calibration.filter((_, i) => i !== selectedPoint) })
    setSelectedPoint(-1)
  }
  const loadProfile = (name: string): void => {
    const p = presets.dragProfiles.find((x) => x.name === name)
    if (p) setDrag({ profile: name, calibration: p.calibration, environment: p.environment })
  }
  const saveProfile = (name: string): void => {
    const others = presets.dragProfiles.filter((p) => p.name !== name)
    void setPresets({ ...presets, dragProfiles: [...others, { name, calibration: drag.calibration, environment: drag.environment }] })
    setDrag({ profile: name })
    toast(`Profile “${name}” saved`, 'success')
  }

  // ------------------------------------------------------------ display
  const result = current?.result ?? null
  const disp = (kmh: number): number => convert(kmh, 'km/h', speedUnit)
  const splitStep = result && /mph/.test(result.mode) ? 'mph' : 'km/h'

  const { x, series } = useMemo(() => {
    if (!result) return { x: [] as number[], series: [] as ChartSeries[] }
    return {
      x: result.curve.t,
      series: [
        { label: 'Raw vehicle speed', color: '#6b6b74', scale: 'v', values: result.curve.raw.map(disp), width: 1.3, decimals: 1, unit: speedUnit },
        { label: 'Calibrated vehicle speed', color: RUN_COLORS[0], scale: 'v', values: result.curve.calibrated.map(disp), width: 2, decimals: 1, unit: speedUnit }
      ] as ChartSeries[]
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, speedUnit])
  const scales: ChartScale[] = useMemo(() => [{ key: 'v', label: `Speed · ${speedUnit}`, side: 'left', show: true }], [speedUnit])
  // Thin vertical marks where the gearbox shifted.
  const shiftMarks: ChartRegion[] = useMemo(
    () => (result?.gearChanges ?? []).map((g) => ({ from: g.time - 0.006, to: g.time + 0.006, color: SHIFT_MARK })),
    [result]
  )

  const pngOut = async (): Promise<void> => {
    const data = chart.current?.toPng(current?.name ?? 'Drag', series.map((s) => ({ label: s.label, color: s.color })))
    if (data && (await api.savePngDialog(`${(current?.name ?? 'drag').replace(/[^\w-]+/g, '_')}.png`, data))) toast('Saved PNG', 'success')
  }

  const online = isOnline(status)
  const env = result?.environment ?? drag.environment
  const step = armed ? 1 : result ? 2 : 0
  const distanceMode = !!result && /m$/.test(result.mode)
  const maxSplit = Math.max(1e-6, ...(result?.splits ?? []).map((s) => s.time))
  const stateText =
    state === 'idle'
      ? online
        ? 'Ready to arm'
        : 'Connect to arm a live run'
      : state === 'waiting-stop' && !DRAG_MODES[drag.mode].standing
        ? `Armed · slow below ${disp(DRAG_MODES[drag.mode].fromKmh).toFixed(0)} ${speedUnit}, then accelerate`
        : STATE_TEXT[state]

  return (
    <div className="page">
      {closedCourse.notice}
      <div className="page-toolbar">
        <h1>Drag</h1>
        <RunSteps step={step} labels={['Set up', 'Run', 'Results']} />
        <span
          className={`status-line ${state === 'running' ? 'running' : state === 'waiting-stop' || state === 'ready' ? 'armed' : state === 'finished' ? 'done' : ''}`}
        >
          {(state === 'waiting-stop' || state === 'ready') && <span className="dot connecting" />}
          {state === 'running' && <span className="dot rec" />}
          {stateText}
        </span>
        <div className="spacer" />
        <select className="select" style={{ width: 170 }} value={drag.mode} disabled={armed} onChange={(e) => setDrag({ mode: e.target.value as DragMode })} title="Mode">
          {MODES.map((m) => (
            <option key={m.mode} value={m.mode}>
              {m.label}
            </option>
          ))}
        </select>
        <button className="btn" onClick={fromLogFile}>
          <CsvIcon size={15} /> Time a log…
        </button>
        <button className={`btn ${armed ? 'danger' : 'primary'}`} onClick={arm} disabled={!online && !armed}>
          {armed ? <CloseIcon size={15} /> : <ArmIcon size={15} weight="bold" />} {armed ? 'Disarm' : 'Arm run'}
        </button>
      </div>

      <div className="page-body">
        <div className="page-main scroll">
          <div className="metrics">
            <div className="metric hero">
              <div className="label">Final time</div>
              <div className={`value ${result?.finalTime != null ? '' : 'placeholder'}`}>
                {result?.finalTime != null ? result.finalTime.toFixed(3) : '—'}
                <small>s</small>
              </div>
              <div className="sub">{modeLabel(result?.mode ?? drag.mode)}</div>
            </div>
            <div className="metric">
              <div className="label">Distance</div>
              <div className={`value ${result ? '' : 'placeholder'}`}>
                {result ? result.distanceM.toFixed(2) : '—'}
                <small>m</small>
              </div>
              <div className="sub">{result && !result.finished ? 'run not finished' : ' '}</div>
            </div>
            <div className="metric">
              <div className="label">{distanceMode ? 'Trap speed' : 'Speed at finish'}</div>
              <div className={`value ${result?.trapSpeedKmh != null ? '' : 'placeholder'}`}>
                {result?.trapSpeedKmh != null ? disp(result.trapSpeedKmh).toFixed(1) : '—'}
                <small>{speedUnit}</small>
              </div>
              <div className="sub">{' '}</div>
            </div>
          </div>

          <div className="info-line">
            <span>
              Altitude <b>{env.altitudeM} m</b>
            </span>
            <span>
              Outside temperature <b>{env.ambientTempC.toFixed(1)} °C</b>
            </span>
            <span>
              Relative humidity <b>{env.humidityPct} %</b>
            </span>
          </div>

          <div className="split-panels">
            <section className="card">
              <h3 className="card-title">
                10 {splitStep} splits <span className="count-badge">time from start</span>
              </h3>
              {result?.splits.length ? (
                <div className="bar-list">
                  {result.splits.map((s) => (
                    <div className="bar-row" key={s.speedKmh}>
                      <span>
                        {disp(s.speedKmh).toFixed(0)} {speedUnit}
                      </span>
                      <div className="bar-track">
                        <div className="bar-fill" style={{ width: `${(s.time / maxSplit) * 100}%` }} />
                      </div>
                      <b>{s.time.toFixed(3)} s</b>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="muted small">Splits appear here after a run.</div>
              )}
            </section>
            <section className="card">
              <h3 className="card-title">Gear changes</h3>
              {result?.gearChanges.length ? (
                <div className="shift-list">
                  {result.gearChanges.map((g, i) => (
                    <div className="shift" key={i}>
                      <span className="gears">
                        {g.from} → {g.to}
                      </span>
                      <span className="mono">
                        {disp(g.speedKmh).toFixed(1)} {speedUnit}
                      </span>
                      <b>{g.time.toFixed(3)} s</b>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="muted small">Shifts appear here when the log has a gear channel.</div>
              )}
            </section>
          </div>

          <section className="card flex result-chart">
            <div className="panel-header">
              <h2 className="ellipsis">{current ? current.name : 'Speed'}</h2>
              <div className="actions">
                {current && !saved && (
                  <button className="btn primary sm" onClick={() => saveRun(current)}>
                    <SaveIcon size={14} /> Save run
                  </button>
                )}
                <button className="btn sm" onClick={pngOut} disabled={!result}>
                  <ImageIcon size={14} /> Save PNG
                </button>
                <button className="btn sm ghost" onClick={() => setExpanded(!expanded)} title={expanded ? 'Show setup and saved runs' : 'Hide setup and saved runs'}>
                  {expanded ? <ShrinkIcon size={14} /> : <ExpandIcon size={14} />}
                  {expanded ? 'Restore' : 'Expand'}
                </button>
              </div>
            </div>
            {result ? (
              <>
                <div className="graph-legend" style={{ paddingLeft: 60 }}>
                  {series.map((s) => (
                    <span key={s.label} className="legend-item">
                      <span className="swatch" style={{ background: s.color }} />
                      {s.label}
                    </span>
                  ))}
                  {result.gearChanges.length > 0 && (
                    <span className="legend-item">
                      <span className="swatch" style={{ background: SHIFT_MARK, width: 3, height: 12 }} />
                      Gear change
                    </span>
                  )}
                </div>
                <Chart ref={chart} x={x} xLabel="Time · s" xDecimals={0} series={series} scales={scales} regions={shiftMarks} tooltip />
              </>
            ) : (
              <div className="empty" style={{ margin: 'auto', maxWidth: 540 }}>
                Choose a mode and <b>arm</b> it. Standing starts wait for the car to stop, then time from the moment it moves. Or <b>time a log</b> you
                already recorded.
              </div>
            )}
          </section>

          {result && result.warnings.length > 0 && (
            <div className="warning-bar">
              <WarningIcon size={16} />
              {result.warnings.join(' · ')}
            </div>
          )}
          <div className="warning-bar">
            <WarningIcon size={16} />
            Closed courses only. Never time acceleration runs on public roads.
          </div>
        </div>

        {!expanded && (
          <aside className="inspector">
            <section className="card">
              <h3 className="card-title">Setup</h3>
              <div className="field">
                <label>Saved profiles</label>
                <select className="select" value={drag.profile ?? ''} onChange={(e) => loadProfile(e.target.value)}>
                  <option value="">—</option>
                  {presets.dragProfiles.map((p) => (
                    <option key={p.name}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div className="section-label" style={{ marginTop: 14 }}>
                Speed calibration
              </div>
              <div className="grid-2">
                <div className="field">
                  <label>ECU/raw · {speedUnit}</label>
                  <input className="input" value={newPoint.ecu} onChange={(e) => setNewPoint({ ...newPoint, ecu: e.target.value })} />
                </div>
                <div className="field">
                  <label>GPS · {speedUnit}</label>
                  <input
                    className="input"
                    value={newPoint.gps}
                    onChange={(e) => setNewPoint({ ...newPoint, gps: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && addPoint()}
                  />
                </div>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn sm" style={{ flex: 1 }} onClick={addPoint}>
                  <PlusIcon size={13} weight="bold" /> Add point
                </button>
                <button className="btn sm" style={{ flex: 1 }} onClick={removePoint} disabled={selectedPoint < 0}>
                  <MinusIcon size={13} weight="bold" /> Remove point
                </button>
              </div>
              <div className="card inset" style={{ marginTop: 8, padding: 6, minHeight: 90 }}>
                {drag.calibration.length ? (
                  <table className="cal-table">
                    <thead>
                      <tr>
                        <th>ECU</th>
                        <th>GPS</th>
                        <th>Factor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {drag.calibration.map((p: SpeedCalPoint, i) => (
                        <tr key={i} className={i === selectedPoint ? 'selected' : ''} onClick={() => setSelectedPoint(i === selectedPoint ? -1 : i)} style={{ cursor: 'pointer' }}>
                          <td>{disp(p.ecu).toFixed(1)}</td>
                          <td>{disp(p.gps).toFixed(1)}</td>
                          <td>{(p.gps / p.ecu).toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="muted small" style={{ padding: 6 }}>
                    No calibration: the ECU speed is used as is. Add points that compare ECU speed with a GPS reading at steady speed.
                  </div>
                )}
              </div>
              <div style={{ marginTop: 8 }}>
                <Collapsible title="Environment">
                  <div className="grid-3">
                    <NumberField label="Altitude · m" value={drag.environment.altitudeM} onChange={(v) => setEnv({ altitudeM: v })} step={10} />
                    <NumberField label="Temp · °C" value={drag.environment.ambientTempC} onChange={(v) => setEnv({ ambientTempC: v })} step={0.5} />
                    <NumberField label="Humidity · %" value={drag.environment.humidityPct} onChange={(v) => setEnv({ humidityPct: v })} />
                  </div>
                </Collapsible>
              </div>
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
                <button className="btn sm" onClick={() => setSavingProfile(true)}>
                  <SaveIcon size={13} /> Save profile
                </button>
              </div>
            </section>

            <section className="card">
              <h3 className="card-title">Saved runs</h3>
              <div className="run-list">
                {runs.map((r) => (
                  <div key={r.id} className={`run-item ${current?.id === r.id ? 'selected' : ''}`} onClick={() => openRun(r)}>
                    <DragIcon size={14} className="dim" />
                    <span className="ellipsis" style={{ flex: 1 }}>
                      {r.name}
                    </span>
                    <button
                      className="icon-btn"
                      title="Delete run"
                      onClick={async (e) => {
                        e.stopPropagation()
                        await api.deleteRun('drag', r.id)
                        refreshRuns()
                      }}
                    >
                      <TrashIcon size={14} />
                    </button>
                  </div>
                ))}
                {!runs.length && <div className="muted small">Finished runs are saved here automatically.</div>}
              </div>
            </section>
          </aside>
        )}
      </div>
      {savingProfile && (
        <PromptModal title="Save drag profile" label="Profile name" initial={drag.profile ?? ''} onSubmit={saveProfile} onClose={() => setSavingProfile(false)} />
      )}
    </div>
  )
}
