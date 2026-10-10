import { useEffect, useMemo, useRef } from 'react'
import { useApp } from '../store'
import { liveBuffer } from '../lib/liveBuffer'
import { channelView, fmt, type ChannelView } from '../lib/format'
import { CloseIcon, PlusIcon } from '../components/icons'

const SPARK_SECONDS = 12

/**
 * Actual → target channel pairs shown together in one tile, with how far apart
 * they are (native units) for a full deviation bar.
 */
export const PAIRS: Record<string, { target: string; span: number }> = {
  'boost.actual': { target: 'boost.target', span: 0.2 },
  'fuel.lambda.actual': { target: 'fuel.lambda.target', span: 0.05 },
  'fuel.rail.actual': { target: 'fuel.rail.target', span: 20 },
  'throttle.position': { target: 'throttle.target', span: 10 },
  'boost.wg_actual': { target: 'boost.wg_target', span: 10 },
  'load.engine': { target: 'load.engine_target', span: 20 },
  'load.maf': { target: 'load.maf_target', span: 50 },
  'load.torque.actual': { target: 'load.torque.target', span: 50 },
  'vanos.intake.actual': { target: 'vanos.intake.target', span: 5 },
  'vanos.exhaust.actual': { target: 'vanos.exhaust.target', span: 5 }
}

const ACCENT = '#ffad33'
const TARGET = '#8a8a93'
const GOOD = '#34d399'
const WARN = '#ffad33'
const BAD = '#f87171'

interface TileItem {
  key: string
  a: ChannelView
  t?: ChannelView
  span?: number
}

interface TileRefs {
  value?: HTMLElement | null
  target?: HTMLElement | null
  delta?: HTMLElement | null
  fill?: HTMLElement | null
  spark?: HTMLCanvasElement | null
}

/** Live value tiles for the selected channels; actual/target pairs share a tile. */
export function LiveTiles({ channelIds, onAdd }: { channelIds: string[]; onAdd: () => void }) {
  const channelMap = useApp((s) => s.channelMap)
  const units = useApp((s) => s.settings!.units)
  const updateSettings = useApp((s) => s.updateSettings)

  const items: TileItem[] = useMemo(() => {
    const present = new Set(channelIds.filter((id) => channelMap.has(id)))
    const pairedTargets = new Set(
      Object.entries(PAIRS)
        .filter(([a, p]) => present.has(a) && present.has(p.target))
        .map(([, p]) => p.target)
    )
    const out: TileItem[] = []
    for (const id of channelIds) {
      const def = channelMap.get(id)
      if (!def || pairedTargets.has(id)) continue
      const pair = PAIRS[id]
      const tDef = pair && present.has(pair.target) ? channelMap.get(pair.target) : undefined
      out.push({ key: id, a: channelView(def, units), t: tDef ? channelView(tDef, units) : undefined, span: tDef ? pair.span : undefined })
    }
    return out
  }, [channelIds, channelMap, units])

  const refs = useRef<TileRefs[]>([])

  // One animation loop updates every tile straight from the live buffer.
  useEffect(() => {
    let raf = 0
    let seen = -1
    let lastDraw = 0
    const ids = items.flatMap((it) => (it.t ? [it.a.def.id, it.t.def.id] : [it.a.def.id]))
    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw)
      if (liveBuffer.version === seen || now - lastDraw < 50) return
      seen = liveBuffer.version
      lastDraw = now
      const win = liveBuffer.window(SPARK_SECONDS, ids)
      let col = 0
      items.forEach((it, i) => {
        const r = refs.current[i]
        const aSeries = win.series[col++]
        const tSeries = it.t ? win.series[col++] : undefined
        if (!r) return
        const a = liveBuffer.latest(it.a.def.id)
        if (r.value) r.value.textContent = fmt(it.a.unit.toDisplay(a), it.a.decimals)
        if (it.t) {
          const t = liveBuffer.latest(it.t.def.id)
          if (r.target) r.target.textContent = fmt(it.t.unit.toDisplay(t), it.t.decimals)
          const ok = Number.isFinite(a) && Number.isFinite(t)
          const d = it.a.unit.toDisplay(a) - it.t.unit.toDisplay(t)
          if (r.delta) r.delta.textContent = ok ? `Δ ${d >= 0 ? '+' : ''}${d.toFixed(it.a.decimals)} ${it.a.unit.label}` : 'Δ —'
          if (r.fill) {
            const frac = ok ? Math.min(1, Math.abs(a - t) / it.span!) : 0
            const w = frac * 50
            r.fill.style.width = `${w}%`
            r.fill.style.left = a - t >= 0 ? '50%' : `${50 - w}%`
            r.fill.style.background = frac < 0.25 ? GOOD : frac < 0.75 ? WARN : BAD
          }
        }
        drawSpark(r.spark, win.t, aSeries, tSeries, it.a)
      })
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [items])

  const remove = (it: TileItem): void => {
    const drop = new Set([it.a.def.id, ...(it.t ? [it.t.def.id] : [])])
    void updateSettings({ liveChannels: channelIds.filter((id) => !drop.has(id)) })
  }

  return (
    <div className="tiles">
      {items.map((it, i) => {
        const r = (refs.current[i] ??= {})
        return (
          <div className={`tile ${it.t ? 'pair' : ''}`} key={it.key} title={it.a.def.description ?? it.a.def.id}>
            <div className="tile-head">
              <span className="name">{it.t ? `${it.a.def.name} vs target` : it.a.def.name}</span>
              <div className="tile-actions">
                <button className="icon-btn" onClick={() => remove(it)} title={`Remove ${it.a.def.name}`} aria-label={`Remove ${it.a.def.name}`}>
                  <CloseIcon size={14} />
                </button>
              </div>
            </div>
            <div className="tile-values">
              <div className="tile-value">
                <span className="v" ref={(el) => void (r.value = el)}>
                  —
                </span>
                <span className="u">{it.a.unit.label}</span>
              </div>
              {it.t && (
                <div className="tile-value secondary">
                  <span className="tag">target</span>
                  <span className="v" ref={(el) => void (r.target = el)}>
                    —
                  </span>
                </div>
              )}
              {it.t && <canvas className="inline" ref={(el) => void (r.spark = el)} />}
            </div>
            {!it.t && <canvas ref={(el) => void (r.spark = el)} />}
            {it.t && (
              <div className="dev">
                <div className="dev-track">
                  <div className="dev-fill" ref={(el) => void (r.fill = el)} />
                  <div className="dev-center" />
                </div>
                <div className="dev-label">
                  <span>below target</span>
                  <span className="d" ref={(el) => void (r.delta = el)}>
                    Δ —
                  </span>
                  <span>above target</span>
                </div>
              </div>
            )}
          </div>
        )
      })}
      {items.length < 4 && (
        <button className="tile tile-add" onClick={onAdd}>
          <PlusIcon size={16} weight="bold" /> Add channels
        </button>
      )}
    </div>
  )
}

function drawSpark(
  canvas: HTMLCanvasElement | null | undefined,
  t: number[],
  ys: (number | null)[],
  target: (number | null)[] | undefined,
  v: ChannelView
): void {
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (!w || !h) return
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr
    canvas.height = h * dpr
  }
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  let lo = Infinity
  let hi = -Infinity
  for (const arr of target ? [ys, target] : [ys]) {
    for (const y of arr) {
      if (y === null) continue
      if (y < lo) lo = y
      if (y > hi) hi = y
    }
  }
  if (!Number.isFinite(lo) || t.length < 2) {
    ctx.strokeStyle = '#2d2d32'
    ctx.lineWidth = 1
    ctx.beginPath()
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
  const line = (vals: (number | null)[], color: string, dash: number[]): void => {
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.setLineDash(dash)
    ctx.beginPath()
    let started = false
    for (let i = 0; i < t.length; i++) {
      const y = vals[i]
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
  if (target) line(target, TARGET, [4, 3])
  line(ys, ACCENT, [])
  ctx.setLineDash([])
}
