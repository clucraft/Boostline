import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Crosshair, Expand, FileSpreadsheet, Flag, Image, Minus, Plus, Save, Shrink, Trash2, X } from 'lucide-react'
import type { DragEnvironment, DragMode, DragResult, SavedDragRun, SpeedCalPoint } from '@shared/types'
import { CH } from '@shared/types'
import { analyzeDrag, DRAG_MODES, DragDetector, dragInputFromLog } from '@shared/analysis/drag'
import { parseLogCsv } from '@shared/analysis/csv'
import { convert } from '@shared/units'
import type { RunEntry } from '@shared/ipc'
import { api, isOnline, useApp } from '../store'
import { liveBuffer } from '../lib/liveBuffer'
import { stamp, uid } from '../lib/format'
import { Chart, type ChartHandle, type ChartScale, type ChartSeries } from '../components/Chart'
import { Collapsible, NumberField, PromptModal } from '../components/ui'

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

type DState = 'idle' | 'waiting-stop' | 'ready' | 'running' | 'finished' | 'aborted'
const STATE_TEXT: Record<DState, string> = {
  idle: '',
  'waiting-stop': 'Armed · come to a complete stop',
  ready: 'Ready · launch when you are',
  running: '● Running…',
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

  const arm = (): void => {
    if (armed) {
      setState('idle')
      return
    }
    detector.current = new DragDetector(drag.mode, { calibration: drag.calibration, environment: drag.environment })
    setState(detector.current.state as DState)
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
        { label: 'Raw vehicle speed', color: '#6b7a8c', scale: 'v', values: result.curve.raw.map(disp), width: 1.3, decimals: 1, unit: speedUnit },
        { label: 'Calibrated vehicle speed', color: '#3b9cff', scale: 'v', values: result.curve.calibrated.map(disp), width: 2, decimals: 1, unit: speedUnit }
      ] as ChartSeries[]
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, speedUnit])
  const scales: ChartScale[] = useMemo(() => [{ key: 'v', label: `Speed · ${speedUnit}`, side: 'left', show: true }], [speedUnit])

  const pngOut = async (): Promise<void> => {
    const data = chart.current?.toPng(current?.name ?? 'Drag', series.map((s) => ({ label: s.label, color: s.color })))
    if (data && (await api.savePngDialog(`${(current?.name ?? 'drag').replace(/[^\w-]+/g, '_')}.png`, data))) toast('Saved PNG', 'success')
  }

  const online = isOnline(status)
  const env = result?.environment ?? drag.environment

  return (
    <main className="page">
      {!expanded && (
        <aside className="sidebar" style={{ overflowY: 'auto' }}>
          <section className="card">
            <h3 className="card-title">Run</h3>
            <div className="stack">
              <div className="field">
                <label>Mode</label>
                <select className="select" value={drag.mode} disabled={armed} onChange={(e) => setDrag({ mode: e.target.value as DragMode })}>
                  {MODES.map((m) => (
                    <option key={m.mode} value={m.mode}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <button className={`btn lg block ${armed ? 'red' : 'green'}`} onClick={arm} disabled={!online && !armed}>
                {armed ? <X size={15} /> : <Crosshair size={15} />} {armed ? 'Disarm' : 'Arm drag'}
              </button>
              <button className="btn block" onClick={fromLogFile}>
                <FileSpreadsheet size={14} /> Time a log…
              </button>
              <div className={`run-state ${state}`}>
                {state === 'idle'
                  ? online
                    ? 'Ready to arm'
                    : 'Connect to arm a live run'
                  : state === 'waiting-stop' && !DRAG_MODES[drag.mode].standing
                    ? `Armed · slow below ${disp(DRAG_MODES[drag.mode].fromKmh).toFixed(0)} ${speedUnit}, then accelerate`
                    : STATE_TEXT[state]}
              </div>
            </div>
          </section>

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
            <div className="section-label" style={{ marginTop: 12 }}>
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
                <Plus size={12} /> Add point
              </button>
              <button className="btn sm" style={{ flex: 1 }} onClick={removePoint} disabled={selectedPoint < 0}>
                <Minus size={12} /> Remove point
              </button>
            </div>
            <div className="card" style={{ marginTop: 8, padding: 6, minHeight: 90, background: '#0a121b' }}>
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
                <Save size={12} /> Save profile
              </button>
            </div>
          </section>

          <section className="card">
            <h3 className="card-title">Saved runs</h3>
            <div className="run-list">
              {runs.map((r) => (
                <div key={r.id} className={`run-item ${current?.id === r.id ? 'selected' : ''}`} onClick={() => openRun(r)}>
                  <Flag size={12} className="dim" />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                  <button
                    className="icon-btn"
                    onClick={async (e) => {
                      e.stopPropagation()
                      await api.deleteRun('drag', r.id)
                      refreshRuns()
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              {!runs.length && <div className="muted small">Finished runs are saved here automatically.</div>}
            </div>
          </section>
        </aside>
      )}

      <section className="card content" style={{ gap: 0 }}>
        <div className="panel-header">
          <h2>
            <Flag size={19} /> Drag
          </h2>
          {current && (
            <span className="log-chip">
              <b>{current.name}</b>
            </span>
          )}
          <div className="actions">
            {current && !saved && (
              <button className="btn primary" onClick={() => saveRun(current)}>
                <Save size={13} /> Save run
              </button>
            )}
            <button className="btn" onClick={pngOut} disabled={!result}>
              <Image size={13} /> Save graph (PNG)
            </button>
            <button className="btn" onClick={() => setExpanded(!expanded)}>
              {expanded ? <Shrink size={13} /> : <Expand size={13} />}
              {expanded ? 'Restore' : 'Expand'}
            </button>
          </div>
        </div>

        <div className="stat-cards">
          <div className="stat-card">
            <div className="label">Mode</div>
            <div className="value" style={{ fontSize: 22 }}>
              {modeLabel(result?.mode ?? drag.mode)}
            </div>
          </div>
          <div className="stat-card">
            <div className="label">Final time</div>
            {result?.finalTime != null && (
              <div className="value">
                {result.finalTime.toFixed(3)}
                <small>s</small>
              </div>
            )}
          </div>
          <div className="stat-card">
            <div className="label">{result?.trapSpeedKmh != null && /m$/.test(result.mode) ? 'Distance · trap speed' : 'Distance'}</div>
            {result && (
              <div className="value">
                {result.distanceM.toFixed(2)}
                <small>m</small>
                {result.trapSpeedKmh != null && /m$/.test(result.mode) && (
                  <small>
                    · {disp(result.trapSpeedKmh).toFixed(1)} {speedUnit}
                  </small>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="info-line" style={{ justifyContent: 'space-between' }}>
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

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div className="card" style={{ background: '#0a131c', minHeight: 150 }}>
            <h3 className="card-title" style={{ color: '#5fb4ff' }}>
              10 {splitStep} splits
            </h3>
            <div className="splits-grid">
              {(result?.splits ?? []).map((s) => (
                <div className="split" key={s.speedKmh}>
                  <span>
                    {disp(s.speedKmh).toFixed(0)} {speedUnit}
                  </span>
                  <b>{s.time.toFixed(3)} s</b>
                </div>
              ))}
            </div>
          </div>
          <div className="card" style={{ background: '#0a131c', minHeight: 150 }}>
            <h3 className="card-title" style={{ color: '#5fb4ff' }}>
              Gear changes
            </h3>
            <div className="stack" style={{ gap: 6 }}>
              {(result?.gearChanges ?? []).map((g, i) => (
                <div className="split" key={i}>
                  <span>
                    {g.from} → {g.to}
                  </span>
                  <b>
                    {g.time.toFixed(3)} s · {disp(g.speedKmh).toFixed(1)} {speedUnit}
                  </b>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 200, display: 'flex', flexDirection: 'column', marginTop: 10 }}>
          {result ? (
            <>
              <div className="graph-legend" style={{ paddingLeft: 60 }}>
                {series.map((s) => (
                  <span key={s.label} className="legend-item">
                    <span className="swatch" style={{ background: s.color }} />
                    {s.label}
                  </span>
                ))}
              </div>
              <Chart ref={chart} x={x} xLabel="Time · s" xDecimals={0} series={series} scales={scales} tooltip />
            </>
          ) : (
            <div className="empty" style={{ margin: 'auto', maxWidth: 520 }}>
              Choose a mode and <b>arm</b> it. Standing starts wait for the car to stop, then time from the moment it moves. Or <b>time a log</b> you
              already recorded.
            </div>
          )}
        </div>

        {result && result.warnings.length > 0 && (
          <div className="warning-bar">
            <AlertTriangle size={15} />
            {result.warnings.join(' · ')}
          </div>
        )}
        <div className="warning-bar">
          <AlertTriangle size={15} />
          Closed courses only. Never time acceleration runs on public roads.
        </div>
      </section>
      {savingProfile && (
        <PromptModal title="Save drag profile" label="Profile name" initial={drag.profile ?? ''} onSubmit={saveProfile} onClose={() => setSavingProfile(false)} />
      )}
    </main>
  )
}
