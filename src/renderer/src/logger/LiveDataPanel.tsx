import { useEffect, useMemo, useRef } from 'react'
import { Activity, Circle, Play, Square, X } from 'lucide-react'
import { api, isOnline, useApp } from '../store'
import { liveBuffer } from '../lib/liveBuffer'
import { channelView, fmt, type ChannelView } from '../lib/format'
import { colorAt } from '../lib/colors'

const SPARK_SECONDS = 12

export function LiveDataPanel({ channelIds }: { channelIds: string[] }) {
  const channelMap = useApp((s) => s.channelMap)
  const units = useApp((s) => s.settings!.units)
  const status = useApp((s) => s.status)
  const updateSettings = useApp((s) => s.updateSettings)
  const toast = useApp((s) => s.toast)
  const online = isOnline(status)
  const live = status.state === 'live'
  const recording = !!status.recording

  const views = useMemo(
    () => channelIds.map((id) => channelMap.get(id)).filter((d) => d !== undefined).map((d) => channelView(d, units)),
    [channelIds, channelMap, units]
  )

  const valueRefs = useRef<(HTMLDivElement | null)[]>([])
  const sparkRefs = useRef<(HTMLCanvasElement | null)[]>([])

  // One animation loop updates every tile straight from the live buffer.
  useEffect(() => {
    let raf = 0
    let seen = -1
    let lastDraw = 0
    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw)
      if (liveBuffer.version === seen || now - lastDraw < 50) return
      seen = liveBuffer.version
      lastDraw = now
      const win = liveBuffer.window(SPARK_SECONDS, views.map((v) => v.def.id))
      views.forEach((v, i) => {
        const el = valueRefs.current[i]
        if (el) el.textContent = fmt(v.unit.toDisplay(liveBuffer.latest(v.def.id)), v.decimals)
        drawSpark(sparkRefs.current[i], win.t, win.series[i], colorAt(i), v)
      })
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [views])

  const record = async (): Promise<void> => {
    if (recording) {
      const file = await api.stopRecording()
      if (file) toast(`Log saved: ${file.split(/[\\/]/).pop()}`, 'success')
    } else {
      try {
        await api.startRecording()
      } catch (err) {
        toast(String(err), 'error')
      }
    }
  }

  return (
    <section className="card">
      <div className="panel-header">
        <h2>
          <Activity size={20} /> Live Data
        </h2>
        <div className="actions">
          {online &&
            (live ? (
              <button className="btn red" onClick={() => api.stopLive()} disabled={recording}>
                <Square size={11} fill="currentColor" /> Stop live
              </button>
            ) : (
              <button className="btn green" onClick={() => api.startLive()}>
                <Play size={12} fill="currentColor" /> Start live
              </button>
            ))}
          <div className="divider-v" />
          <button className={`btn ${recording ? 'red recording' : 'primary'}`} onClick={record} disabled={!online}>
            {recording ? <span className="rec-dot" /> : <Circle size={9} fill="#ff6b6b" stroke="none" />}
            {recording ? 'Stop recording' : 'Record'}
          </button>
        </div>
      </div>
      <div className="section-label">Live channels</div>
      {views.length ? (
        <div className="tiles">
          {views.map((v, i) => (
            <div className="tile" key={v.def.id} title={v.def.description ?? v.def.id}>
              <div className="tile-name">{v.def.name}</div>
              <button
                className="icon-btn tile-close"
                onClick={() => updateSettings({ liveChannels: channelIds.filter((id) => id !== v.def.id) })}
                aria-label={`Remove ${v.def.name}`}
              >
                <X size={13} />
              </button>
              <div className="tile-value" ref={(el) => void (valueRefs.current[i] = el)}>
                —
              </div>
              <div className="tile-foot">
                <span className="tile-unit">{v.unit.label}</span>
                <canvas ref={(el) => void (sparkRefs.current[i] = el)} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">Pick channels in the sidebar to watch them here (up to 40).</div>
      )}
      {!online && views.length > 0 && (
        <div className="muted small" style={{ marginTop: 8 }}>
          Not connected. Use <b>Connect</b> in the top bar (the Simulator works without a car).
        </div>
      )}
    </section>
  )
}

function drawSpark(canvas: HTMLCanvasElement | null, t: number[], ys: (number | null)[], color: string, v: ChannelView): void {
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr
    canvas.height = h * dpr
  }
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  let lo = Infinity
  let hi = -Infinity
  for (const y of ys) {
    if (y === null) continue
    if (y < lo) lo = y
    if (y > hi) hi = y
  }
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.beginPath()
  if (!Number.isFinite(lo) || t.length < 2) {
    ctx.moveTo(0, h - 2)
    ctx.lineTo(w, h - 2)
    ctx.stroke()
    return
  }
  // Keep a minimum span so noise on a flat signal doesn't fill the sparkline.
  const range = v.def.max !== undefined && v.def.min !== undefined ? (v.def.max - v.def.min) * 0.02 : 0
  const span = Math.max(hi - lo, range, 1e-6)
  const mid = (hi + lo) / 2
  const t0 = t[t.length - 1] - SPARK_SECONDS
  let started = false
  for (let i = 0; i < t.length; i++) {
    const y = ys[i]
    if (y === null) continue
    const px = ((t[i] - t0) / SPARK_SECONDS) * w
    const py = h - 2 - ((y - (mid - span / 2)) / span) * (h - 4)
    if (started) ctx.lineTo(px, py)
    else {
      ctx.moveTo(px, py)
      started = true
    }
  }
  ctx.stroke()
}
