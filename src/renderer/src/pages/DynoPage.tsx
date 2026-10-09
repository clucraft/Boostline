import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Crosshair, Expand, FileSpreadsheet, FolderOpen, Gauge, Image, Save, Shrink, Trash2, X } from 'lucide-react'
import type { DynoInput, DynoResult, DynoSetup, SavedDynoRun } from '@shared/types'
import { CH } from '@shared/types'
import { analyzeDyno, DynoDetector, dynoInputFromLog } from '@shared/analysis/dyno'
import { parseLogCsv } from '@shared/analysis/csv'
import { detectWotSegments } from '@shared/analysis/wot'
import { powerFromKw, torqueFromNm } from '@shared/units'
import type { RunEntry } from '@shared/ipc'
import { api, isOnline, useApp } from '../store'
import { liveBuffer } from '../lib/liveBuffer'
import { RUN_COLORS } from '../lib/colors'
import { stamp, uid } from '../lib/format'
import { Chart, type ChartHandle, type ChartScale, type ChartSeries } from '../components/Chart'
import { Collapsible, NumberField } from '../components/ui'

type ArmState = 'idle' | 'armed' | 'recording' | 'done'
const LIVE_IDS = [CH.rpm, CH.speed, CH.pedal, CH.gear, CH.baro, CH.ambientTemp]

const toArrays = (input: DynoInput): SavedDynoRun['input'] => ({
  t: Array.from(input.t),
  rpm: Array.from(input.rpm),
  speedKmh: Array.from(input.speedKmh),
  pedalPct: input.pedalPct ? Array.from(input.pedalPct) : undefined,
  gear: input.gear ? Array.from(input.gear) : undefined
})
const fromArrays = (a: SavedDynoRun['input']): DynoInput => ({
  t: Float64Array.from(a.t),
  rpm: Float64Array.from(a.rpm),
  speedKmh: Float64Array.from(a.speedKmh),
  pedalPct: a.pedalPct ? Float64Array.from(a.pedalPct) : undefined,
  gear: a.gear ? Float64Array.from(a.gear) : undefined
})

export function DynoPage() {
  const settings = useApp((s) => s.settings)!
  const updateSettings = useApp((s) => s.updateSettings)
  const status = useApp((s) => s.status)
  const pending = useApp((s) => s.pendingDyno)
  const requestStream = useApp((s) => s.requestStream)
  const toast = useApp((s) => s.toast)
  const setup = settings.dyno
  const units = settings.units

  const [arm, setArm] = useState<ArmState>('idle')
  const [current, setCurrent] = useState<SavedDynoRun | null>(null)
  const [saved, setSaved] = useState(true)
  const [runs, setRuns] = useState<RunEntry[]>([])
  const [compare, setCompare] = useState<SavedDynoRun[]>([])
  const [expanded, setExpanded] = useState(false)
  const detector = useRef<DynoDetector | null>(null)
  const chart = useRef<ChartHandle>(null)

  const refreshRuns = (): void => void api.listRuns('dyno').then(setRuns)
  useEffect(refreshRuns, [])

  const setSetup = (patch: Partial<DynoSetup>): void => void updateSettings({ dyno: { ...setup, ...patch } })

  // Re-analyse the current run whenever the setup changes.
  const result: DynoResult | null = useMemo(() => {
    if (!current) return null
    try {
      return analyzeDyno(fromArrays(current.input), setup)
    } catch {
      return current.result
    }
  }, [current, setup])

  const showRun = (run: SavedDynoRun, isSaved: boolean): void => {
    setCurrent(run)
    setSaved(isSaved)
  }

  const makeRun = (input: DynoInput, name: string): SavedDynoRun => {
    const r = analyzeDyno(input, setup)
    return { id: uid(), name: `${name}${r.gear ? ` · gear ${r.gear}` : ''}`, createdAt: new Date().toISOString(), vin: status.vin, result: r, input: toArrays(input) }
  }

  const saveRun = async (run: SavedDynoRun): Promise<void> => {
    await api.saveRun('dyno', { ...run, result: result ?? run.result })
    setSaved(true)
    refreshRuns()
  }

  // Runs handed over from the Log Viewer.
  useEffect(() => {
    if (!pending) return
    useApp.setState({ pendingDyno: null })
    const input = dynoInputFromLog(pending.log, pending.segment)
    if (!input) {
      toast('This log has no engine speed / vehicle speed channels to analyze', 'error')
      return
    }
    showRun(makeRun(input, pending.log.name.replace(/\.[^.]+$/, '')), false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])

  // Live arming: feed new samples into the detector until it reports a pull.
  useEffect(() => {
    requestStream('dyno', arm === 'armed' || arm === 'recording' ? LIVE_IDS : [])
    if (arm !== 'armed' && arm !== 'recording') return
    let lastT = liveBuffer.lastTime()
    const id = setInterval(() => {
      const d = detector.current
      if (!d) return
      const { t, cols } = liveBuffer.since(lastT, LIVE_IDS)
      if (!t.length) return
      lastT = t[t.length - 1]
      let state = d.state
      for (let i = 0; i < t.length; i++) {
        const gear = Number.isFinite(cols[3][i]) ? cols[3][i] : undefined
        state = d.push(t[i], cols[0][i], cols[1][i], cols[2][i], gear)
      }
      if (state === 'recording') setArm('recording')
      if (state === 'done') {
        setArm('done')
        const run = makeRun(d.input(), `Run ${stamp()}`)
        showRun(run, false)
        void saveRun(run)
        toast('Pull captured and saved', 'success')
      }
    }, 100)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arm])

  const armRun = (): void => {
    if (arm === 'armed' || arm === 'recording') {
      setArm('idle')
      return
    }
    // Take environment from the car when it reports it.
    const baro = liveBuffer.latest(CH.baro)
    const amb = liveBuffer.latest(CH.ambientTemp)
    const env: Partial<DynoSetup> = {}
    if (Number.isFinite(baro)) env.baroHpa = Math.round(baro * 1000)
    if (Number.isFinite(amb)) env.ambientTempC = Math.round(amb * 10) / 10
    if (Object.keys(env).length) setSetup(env)
    detector.current = new DynoDetector({ ...setup, ...env })
    setArm('armed')
  }

  const analyzeLogFile = async (): Promise<void> => {
    const f = await api.openLogDialog()
    if (!f) return
    const log = parseLogCsv(f.text, f.name)
    const segs = detectWotSegments(log)
    const seg = segs.reduce<(typeof segs)[number] | undefined>((best, s) => (!best || s.end - s.start > best.end - best.start ? s : best), undefined)
    const input = dynoInputFromLog(log, seg)
    if (!input) {
      toast('No engine speed / vehicle speed channels found in this log', 'error')
      return
    }
    showRun(makeRun(input, f.name.replace(/\.[^.]+$/, '')), false)
    if (segs.length > 1) toast(`${segs.length} WOT pulls found; analyzing the longest. Use the Log Viewer to pick another.`)
  }

  const openRun = async (entry: RunEntry): Promise<void> => {
    const run = (await api.loadRun('dyno', entry.id)) as SavedDynoRun | null
    if (run) showRun(run, true)
  }

  const toggleCompare = async (entry: RunEntry): Promise<void> => {
    if (compare.some((r) => r.id === entry.id)) setCompare(compare.filter((r) => r.id !== entry.id))
    else {
      const run = (await api.loadRun('dyno', entry.id)) as SavedDynoRun | null
      if (run) setCompare([...compare, run].slice(-5))
    }
  }

  const pngOut = async (): Promise<void> => {
    const data = chart.current?.toPng(current?.name ?? 'Dyno', legend)
    if (data && (await api.savePngDialog(`${(current?.name ?? 'dyno').replace(/[^\w-]+/g, '_')}.png`, data))) toast('Saved PNG', 'success')
  }

  // ------------------------------------------------------------ chart data
  const shown: { name: string; result: DynoResult; color: string; dashed: boolean }[] = [
    ...(result ? [{ name: current!.name, result, color: RUN_COLORS[0], dashed: false }] : []),
    ...compare.filter((r) => r.id !== current?.id).map((r, i) => ({ name: r.name, result: r.result, color: RUN_COLORS[(i + 1) % RUN_COLORS.length], dashed: true }))
  ]

  const { x, series, legend } = useMemo(() => {
    const rpmSet = new Set<number>()
    shown.forEach((s) => s.result.points.forEach((p) => rpmSet.add(p.rpm)))
    const x = [...rpmSet].sort((a, b) => a - b)
    const series: ChartSeries[] = []
    const legend: { label: string; color: string }[] = []
    shown.forEach((s, i) => {
      const byRpm = new Map(s.result.points.map((p) => [p.rpm, p]))
      const col = (f: (p: (typeof s.result.points)[number]) => number): (number | null)[] => x.map((r) => (byRpm.has(r) ? f(byRpm.get(r)!) : null))
      const suffix = i === 0 ? '' : ` · ${s.name}`
      const dash = s.dashed ? [6, 4] : undefined
      series.push(
        { label: `Engine · ${units.power}${suffix}`, color: i === 0 ? '#3b9cff' : s.color, scale: 'p', values: col((p) => powerFromKw(p.engineKw, units.power)), dash, width: 2, decimals: 1, unit: units.power },
        { label: `Wheel · ${units.power}${suffix}`, color: i === 0 ? '#7dd3fc' : s.color, scale: 'p', values: col((p) => powerFromKw(p.wheelKw, units.power)), dash: dash ?? [2, 3], width: 1.5, decimals: 1, unit: units.power },
        { label: `Torque · ${units.torque}${suffix}`, color: i === 0 ? '#ffa630' : s.color, scale: 't', values: col((p) => torqueFromNm(p.torqueNm, units.torque)), dash, width: 2, decimals: 0, unit: units.torque }
      )
      if (i === 0) legend.push({ label: `Engine · ${units.power}`, color: '#3b9cff' }, { label: `Wheel · ${units.power}`, color: '#7dd3fc' }, { label: `Torque · ${units.torque}`, color: '#ffa630' })
      else legend.push({ label: s.name, color: s.color })
    })
    return { x, series, legend }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, compare, units.power, units.torque, current?.id])

  const scales: ChartScale[] = useMemo(
    () => [
      { key: 'p', label: `Power · ${units.power}`, side: 'left', show: true, color: '#7f93a8' },
      { key: 't', label: `Torque · ${units.torque}`, side: 'right', show: true, color: '#7f93a8' }
    ],
    [units.power, units.torque]
  )

  const peak = (kw: number): string => powerFromKw(kw, units.power).toFixed(0)
  const live = isOnline(status)

  return (
    <main className="page">
      {!expanded && (
        <aside className="sidebar" style={{ overflowY: 'auto' }}>
          <section className="card">
            <h3 className="card-title">Run</h3>
            <div className="stack">
              <button className={`btn lg block ${arm === 'armed' || arm === 'recording' ? 'red' : 'green'}`} onClick={armRun} disabled={!live && arm !== 'armed'}>
                {arm === 'armed' || arm === 'recording' ? <X size={15} /> : <Crosshair size={15} />}
                {arm === 'armed' || arm === 'recording' ? 'Disarm' : 'Arm run'}
              </button>
              <button className="btn block" onClick={analyzeLogFile}>
                <FileSpreadsheet size={14} /> Analyze a log…
              </button>
              <div className={`run-state ${arm}`}>
                {arm === 'idle' && (live ? 'Ready to arm' : 'Connect to arm a live run')}
                {arm === 'armed' && `Armed · floor it above ${setup.startRpm} rpm`}
                {arm === 'recording' && '● Recording pull…'}
                {arm === 'done' && 'Finished'}
              </div>
            </div>
          </section>

          <section className="card">
            <h3 className="card-title">Setup</h3>
            <div className="grid-2">
              <NumberField label="Vehicle mass · kg" value={setup.massKg} onChange={(v) => setSetup({ massKg: v })} step={5} />
              <NumberField label="Drivetrain loss · %" value={setup.drivetrainLossPct} onChange={(v) => setSetup({ drivetrainLossPct: v })} />
              <NumberField label="Start RPM" value={setup.startRpm} onChange={(v) => setSetup({ startRpm: v })} step={100} />
              <NumberField label="End RPM" value={setup.endRpm} onChange={(v) => setSetup({ endRpm: v })} step={100} />
              <NumberField label="Min pedal · %" value={setup.minPedalPct} onChange={(v) => setSetup({ minPedalPct: v })} />
              <NumberField label="Smoothing · s" value={setup.smoothingSec} onChange={(v) => setSetup({ smoothingSec: v })} step={0.1} />
              <NumberField label="Outside temp · °C" value={setup.ambientTempC} onChange={(v) => setSetup({ ambientTempC: v })} step={0.5} />
              <NumberField label="Humidity · %" value={setup.humidityPct} onChange={(v) => setSetup({ humidityPct: v })} />
              <div className="field">
                <label>Vehicle gear</label>
                <div style={{ height: 30, display: 'flex', alignItems: 'center', fontWeight: 700 }}>{result?.gear ?? '—'}</div>
              </div>
              <div className="field">
                <label>Barometric pressure</label>
                <div style={{ height: 30, display: 'flex', alignItems: 'center', fontWeight: 700 }}>{setup.baroHpa} hPa</div>
              </div>
            </div>
            <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 4 }}>
              <Collapsible title="Advanced">
                <div className="grid-2">
                  <NumberField label="Baro pressure · hPa" value={setup.baroHpa} onChange={(v) => setSetup({ baroHpa: v })} />
                  <NumberField label="Drag area Cd·A · m²" value={setup.cdA} onChange={(v) => setSetup({ cdA: v })} step={0.01} />
                  <NumberField label="Rolling resistance" value={setup.crr} onChange={(v) => setSetup({ crr: v })} step={0.001} />
                  <div className="field">
                    <label>Correction</label>
                    <select className="select" value={setup.correction} onChange={(e) => setSetup({ correction: e.target.value as DynoSetup['correction'] })}>
                      <option value="none">None (uncorrected)</option>
                      <option value="SAE">SAE J1349</option>
                      <option value="DIN">DIN 70020</option>
                    </select>
                  </div>
                </div>
              </Collapsible>
            </div>
          </section>

          <section className="card">
            <h3 className="card-title">
              Saved runs <span className="count-badge">tick to compare</span>
            </h3>
            <div className="run-list">
              {runs.map((r) => {
                const cmpIdx = compare.findIndex((c) => c.id === r.id)
                return (
                  <div key={r.id} className={`run-item ${current?.id === r.id ? 'selected' : ''}`} onClick={() => openRun(r)}>
                    <input
                      type="checkbox"
                      checked={cmpIdx >= 0}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleCompare(r)}
                      style={{ accentColor: 'var(--accent)' }}
                    />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                    <button
                      className="icon-btn"
                      onClick={async (e) => {
                        e.stopPropagation()
                        await api.deleteRun('dyno', r.id)
                        setCompare(compare.filter((c) => c.id !== r.id))
                        refreshRuns()
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )
              })}
              {!runs.length && <div className="muted small">Captured pulls are saved here automatically.</div>}
            </div>
          </section>
        </aside>
      )}

      <section className="card content" style={{ gap: 0 }}>
        <div className="panel-header">
          <h2>
            <Gauge size={20} /> Dyno
          </h2>
          {current && <span className="log-chip"><b>{current.name}</b></span>}
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
            <div className="label">Engine</div>
            {result && (
              <>
                <div className="value">
                  {peak(result.peakEngine.kw)}
                  <small>{units.power}</small>
                </div>
                <div className="sub">@ {Math.round(result.peakEngine.rpm)} rpm</div>
              </>
            )}
          </div>
          <div className="stat-card">
            <div className="label">Torque</div>
            {result && (
              <>
                <div className="value">
                  {torqueFromNm(result.peakTorque.nm, units.torque).toFixed(0)}
                  <small>{units.torque}</small>
                </div>
                <div className="sub">@ {Math.round(result.peakTorque.rpm)} rpm</div>
              </>
            )}
          </div>
          <div className="stat-card">
            <div className="label">Wheel</div>
            {result && (
              <>
                <div className="value">
                  {peak(result.peakWheel.kw)}
                  <small>{units.power}</small>
                </div>
                <div className="sub">@ {Math.round(result.peakWheel.rpm)} rpm</div>
              </>
            )}
          </div>
        </div>

        <div className="info-line">
          <span>
            Gear <b>{result?.gear ?? '—'}</b>
          </span>
          <span>
            <b>{(setup.baroHpa / 1000).toFixed(2)}</b> bar
          </span>
          <span>
            <b>{setup.ambientTempC.toFixed(1)}</b> °C
          </span>
          <span>
            pedal ≥ <b>{setup.minPedalPct}%</b>
          </span>
          {result && (
            <span>
              ρ <b>{result.airDensity.toFixed(3)}</b> kg/m³
            </span>
          )}
          {result && setup.correction !== 'none' && (
            <span>
              {setup.correction} CF <b>{result.correctionFactor.toFixed(3)}</b>
            </span>
          )}
        </div>

        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {result ? (
            <>
              <div className="graph-legend" style={{ paddingLeft: 60 }}>
                {legend.map((l) => (
                  <span key={l.label} className="legend-item">
                    <span className="swatch" style={{ background: l.color }} />
                    {l.label}
                  </span>
                ))}
              </div>
              <Chart ref={chart} x={x} xLabel="Engine speed · rpm" xDecimals={0} series={series} scales={scales} tooltip />
            </>
          ) : (
            <div className="empty" style={{ margin: 'auto', maxWidth: 520 }}>
              <b>Arm a run</b>, then do a wide-open-throttle pull in one gear (3rd or 4th works best) from below {setup.startRpm} rpm to
              past {setup.endRpm} rpm. Or <b>analyze a log</b> you already recorded.
              <div className="row" style={{ justifyContent: 'center', marginTop: 14 }}>
                <button className="btn" onClick={analyzeLogFile}>
                  <FolderOpen size={13} /> Analyze a log…
                </button>
              </div>
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
          Road-dyno figures are estimated from acceleration, not measured on a calibrated dynamometer. Use a flat, closed road. Never run pulls on public
          streets.
        </div>
      </section>
    </main>
  )
}
