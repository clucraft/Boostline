import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react'
import uPlot from 'uplot'

export interface ChartSeries {
  label: string
  color: string
  /** Y scale key; series sharing a key share an axis. */
  scale: string
  values: (number | null)[]
  dash?: number[]
  width?: number
  decimals?: number
  unit?: string
}

export interface ChartScale {
  key: string
  label?: string
  color?: string
  side: 'left' | 'right'
  show: boolean
  /** Manual [min, max]; auto-ranged over the visible window when absent. */
  range?: [number, number] | null
}

export interface ChartRegion {
  from: number
  to: number
  color: string
}

export interface ChartHandle {
  toPng(title: string, legend: { label: string; color: string }[]): string
}

interface Props {
  x: number[]
  xLabel: string
  xDecimals?: number
  series: ChartSeries[]
  scales: ChartScale[]
  /** Controlled x window; null = full extent. */
  xRange?: [number, number] | null
  onXRange?: (r: [number, number] | null) => void
  regions?: ChartRegion[]
  syncKey?: string
  smooth?: boolean
  tooltip?: boolean
  /** Enables drag-zoom, Ctrl+wheel zoom and Shift+wheel pan. */
  interactive?: boolean
  onCursor?: (idx: number | null) => void
  onContextMenu?: (e: MouseEvent, xValue: number | null) => void
}

const AXIS_STROKE = '#7f93a8'
const GRID = '#142130'
const FONT_FAMILY = '"Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, sans-serif'
const FONT = `10px ${FONT_FAMILY}`

function padRange(min: number | null, max: number | null): [number, number] {
  if (min === null || max === null || !Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
  if (min === max) return [min - 1, max + 1]
  const pad = (max - min) * 0.06
  return [min - pad, max + pad]
}

export const Chart = forwardRef<ChartHandle, Props>(function Chart(props, ref) {
  const host = useRef<HTMLDivElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const applying = useRef(false)
  const latest = useRef(props)
  latest.current = props

  // Rebuild the plot only when its structure changes, not on every data tick.
  const structure = useMemo(
    () =>
      JSON.stringify({
        s: props.series.map((s) => [s.label, s.color, s.scale, s.dash, s.width]),
        a: props.scales.map((s) => [s.key, s.label, s.color, s.side, s.show, s.range]),
        x: props.xLabel,
        sm: props.smooth,
        i: props.interactive,
        k: props.syncKey
      }),
    [props.series, props.scales, props.xLabel, props.smooth, props.interactive, props.syncKey]
  )

  useLayoutEffect(() => {
    const el = host.current
    if (!el) return
    const p = latest.current
    const rect = el.getBoundingClientRect()
    const spline = uPlot.paths.spline?.()
    const firstShown = p.scales.findIndex((s) => s.show)

    const opts: uPlot.Options = {
      width: Math.max(100, rect.width),
      height: Math.max(80, rect.height),
      legend: { show: false },
      padding: [8, 4, 0, 4],
      cursor: {
        sync: p.syncKey ? { key: p.syncKey, setSeries: false } : undefined,
        drag: { x: !!p.interactive, y: false, setScale: true },
        points: { size: 5 },
        bind: p.interactive ? undefined : { dblclick: () => () => null }
      },
      scales: Object.fromEntries([
        ['x', { time: false }],
        ...p.scales.map((s) => [
          s.key,
          s.range ? { auto: false, range: () => s.range as [number, number] } : { auto: true, range: (_u: uPlot, min: number, max: number) => padRange(min, max) }
        ])
      ]),
      axes: [
        {
          scale: 'x',
          label: p.xLabel,
          labelSize: 18,
          labelFont: FONT,
          font: FONT,
          size: 28,
          stroke: AXIS_STROKE,
          grid: { stroke: GRID, width: 1 },
          ticks: { stroke: GRID, width: 1, size: 4 },
          values: (_u, splits) => {
            // Enough decimals to tell neighbouring ticks apart.
            const step = splits.length > 1 ? Math.abs(splits[1] - splits[0]) : 1
            let decimals = p.xDecimals ?? 0
            while (decimals < 3 && Math.abs(Math.round(step * 10 ** decimals) - step * 10 ** decimals) > 1e-6) decimals++
            return splits.map((v) => v.toFixed(decimals))
          }
        },
        ...p.scales.map((s, i) => ({
          scale: s.key,
          side: s.side === 'left' ? 3 : 1,
          show: s.show,
          label: s.label,
          labelSize: s.label ? 14 : 0,
          labelFont: FONT,
          font: FONT,
          size: 46,
          gap: 3,
          stroke: s.color ?? AXIS_STROKE,
          grid: { show: i === firstShown, stroke: GRID, width: 1 },
          ticks: { stroke: s.color ?? GRID, width: 1, size: 3 }
        }))
      ],
      series: [
        {},
        ...p.series.map((s) => ({
          label: s.label,
          stroke: s.color,
          width: s.width ?? 1.4,
          scale: s.scale,
          dash: s.dash,
          spanGaps: true,
          points: { show: false },
          paths: p.smooth ? spline : undefined
        }))
      ],
      hooks: {
        drawClear: [
          (u) => {
            const regions = latest.current.regions
            if (!regions?.length) return
            const ctx = u.ctx
            ctx.save()
            for (const r of regions) {
              const x0 = u.valToPos(r.from, 'x', true)
              const x1 = u.valToPos(r.to, 'x', true)
              ctx.fillStyle = r.color
              ctx.fillRect(Math.min(x0, x1), u.bbox.top, Math.abs(x1 - x0), u.bbox.height)
            }
            ctx.restore()
          }
        ],
        setScale: [
          (u, key) => {
            if (key !== 'x' || applying.current) return
            const { min, max } = u.scales.x
            if (min !== undefined && max !== undefined) latest.current.onXRange?.([min, max])
          }
        ],
        setCursor: [(u) => updateTooltip(u)]
      }
    }

    const data = [p.x, ...p.series.map((s) => s.values)] as uPlot.AlignedData
    const u = new uPlot(opts, data, el)
    plot.current = u
    applyX(u)

    const onWheel = (e: WheelEvent): void => {
      // Ctrl (Windows), ⌘ (macOS) or a trackpad pinch (reported as Ctrl) zooms; Shift pans.
      const zoom = e.ctrlKey || e.metaKey
      if (!latest.current.interactive || !(zoom || e.shiftKey)) return
      e.preventDefault()
      const xs = latest.current.x
      if (xs.length < 2) return
      const lo = xs[0]
      const hi = xs[xs.length - 1]
      let { min = lo, max = hi } = u.scales.x
      const span = max - min
      if (zoom) {
        const at = u.posToVal(e.offsetX, 'x')
        const f = e.deltaY < 0 ? 0.8 : 1.25
        min = at - (at - min) * f
        max = at + (max - at) * f
      } else {
        const shift = span * 0.12 * Math.sign(e.deltaY || e.deltaX)
        min += shift
        max += shift
      }
      if (max - min >= hi - lo) {
        min = lo
        max = hi
      } else if (min < lo) {
        max += lo - min
        min = lo
      } else if (max > hi) {
        min -= max - hi
        max = hi
      }
      u.setScale('x', { min, max })
    }
    const onContext = (e: MouseEvent): void => {
      e.preventDefault()
      const cb = latest.current.onContextMenu
      if (cb) cb(e, u.posToVal(e.offsetX, 'x'))
    }
    const onLeave = (): void => {
      if (tip.current) tip.current.style.display = 'none'
      latest.current.onCursor?.(null)
    }
    u.over.addEventListener('wheel', onWheel, { passive: false })
    u.over.addEventListener('contextmenu', onContext)
    u.over.addEventListener('mouseleave', onLeave)

    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) u.setSize({ width: r.width, height: r.height })
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      u.destroy()
      plot.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure])

  /** Applies the controlled x window (or the full extent) without echoing it back. */
  function applyX(u: uPlot): void {
    const { x, xRange } = latest.current
    if (x.length < 2) return
    const [min, max] = xRange ?? [x[0], x[x.length - 1]]
    applying.current = true
    u.setScale('x', { min, max })
    applying.current = false
  }

  function updateTooltip(u: uPlot): void {
    const p = latest.current
    const idx = u.cursor.idx ?? null
    p.onCursor?.(idx)
    const el = tip.current
    if (!el) return
    if (!p.tooltip || idx === null || u.cursor.left === undefined || u.cursor.left < 0) {
      el.style.display = 'none'
      return
    }
    const rows = p.series
      .map((s) => {
        const v = s.values[idx]
        const text = v === null || v === undefined ? '—' : v.toFixed(s.decimals ?? 2)
        return `<div class="tt-row"><span class="swatch" style="display:inline-block;width:10px;height:2px;background:${s.color}"></span>${escapeHtml(s.label)}<b>${text}${s.unit ? ' ' + escapeHtml(s.unit) : ''}</b></div>`
      })
      .join('')
    el.innerHTML = `<div class="tt-head">${escapeHtml(p.xLabel)}: ${p.x[idx]?.toFixed(p.xDecimals ?? 2) ?? ''}</div>${rows}`
    el.style.display = 'block'
    const hostRect = host.current!.getBoundingClientRect()
    const overRect = u.over.getBoundingClientRect()
    const left = overRect.left - hostRect.left + u.cursor.left
    const top = overRect.top - hostRect.top + (u.cursor.top ?? 0)
    const flip = left + el.offsetWidth + 18 > hostRect.width
    el.style.left = `${flip ? left - el.offsetWidth - 14 : left + 14}px`
    el.style.top = `${Math.max(0, Math.min(top - 10, hostRect.height - el.offsetHeight))}px`
  }

  // Data and x-window updates go straight to the existing plot.
  useEffect(() => {
    const u = plot.current
    if (!u) return
    u.setData([props.x, ...props.series.map((s) => s.values)] as uPlot.AlignedData, false)
    applyX(u)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.x, props.series, props.xRange, structure])

  useEffect(() => {
    plot.current?.redraw(false)
  }, [props.regions])

  useImperativeHandle(ref, () => ({
    toPng(title, legend) {
      const u = plot.current
      if (!u) return ''
      const src = u.ctx.canvas
      const dpr = window.devicePixelRatio || 1
      const pad = 14 * dpr
      const head = 52 * dpr
      const canvas = document.createElement('canvas')
      canvas.width = src.width + pad * 2
      canvas.height = src.height + head + pad
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#0b131c'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = '#5fb4ff'
      ctx.font = `700 ${16 * dpr}px ${FONT_FAMILY}`
      ctx.fillText(title, pad, pad + 14 * dpr)
      ctx.font = `${11 * dpr}px ${FONT_FAMILY}`
      let lx = pad
      const ly = pad + 36 * dpr
      for (const item of legend) {
        ctx.fillStyle = item.color
        ctx.fillRect(lx, ly - 4 * dpr, 14 * dpr, 2 * dpr)
        ctx.fillStyle = '#c4d2e1'
        ctx.fillText(item.label, lx + 20 * dpr, ly)
        lx += ctx.measureText(item.label).width + 40 * dpr
      }
      ctx.drawImage(src, pad, head)
      ctx.fillStyle = '#3e5268'
      ctx.font = `${10 * dpr}px ${FONT_FAMILY}`
      ctx.textAlign = 'right'
      ctx.fillText('Boostline', canvas.width - pad, pad + 14 * dpr)
      return canvas.toDataURL('image/png')
    }
  }))

  return (
    <div className="chart-host" ref={host}>
      <div className="chart-tooltip" ref={tip} style={{ display: 'none' }} />
    </div>
  )
})

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
