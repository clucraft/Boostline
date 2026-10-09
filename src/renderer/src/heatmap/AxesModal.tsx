import { useState } from 'react'
import type { ChannelDef, HeatmapAxisPrefs, UnitPrefs } from '@shared/types'
import { makeEdges } from '@shared/analysis/heatmap'
import { Modal } from '../components/ui'
import { channelView } from '../lib/format'
import { MAX_CELLS_PER_AXIS } from './model'

interface AxisDraft {
  channelId: string
  start: string
  step: string
  end: string
}

const toDraft = (a: HeatmapAxisPrefs): AxisDraft => ({ channelId: a.channelId, start: String(a.start), step: String(a.step), end: String(a.end) })

function parseAxis(d: AxisDraft): HeatmapAxisPrefs | string {
  const start = parseFloat(d.start)
  const step = parseFloat(d.step)
  const end = parseFloat(d.end)
  if (![start, step, end].every(Number.isFinite)) return 'Enter numbers for start, step and end.'
  if (step <= 0) return 'Step must be greater than 0.'
  if (end <= start) return 'End must be greater than start.'
  const cells = makeEdges(start, step, end).length - 1
  if (cells > MAX_CELLS_PER_AXIS) return `That makes ${cells} cells; use at most ${MAX_CELLS_PER_AXIS}.`
  return { channelId: d.channelId, start, step, end }
}

export function AxesModal({
  x,
  y,
  channels,
  units,
  autoEdges,
  onSave,
  onClose
}: {
  x: HeatmapAxisPrefs
  y: HeatmapAxisPrefs
  channels: ChannelDef[]
  units: UnitPrefs
  /** Suggested edges for a channel from the loaded data (display units). */
  autoEdges: (channelId: string) => number[] | null
  onSave: (x: HeatmapAxisPrefs, y: HeatmapAxisPrefs) => void
  onClose: () => void
}) {
  const [drafts, setDrafts] = useState({ x: toDraft(x), y: toDraft(y) })
  const [error, setError] = useState('')

  const set = (axis: 'x' | 'y', patch: Partial<AxisDraft>): void => {
    setDrafts({ ...drafts, [axis]: { ...drafts[axis], ...patch } })
    setError('')
  }
  const auto = (axis: 'x' | 'y'): void => {
    const edges = autoEdges(drafts[axis].channelId)
    if (!edges) {
      setError('Not enough data in the loaded logs to size this axis automatically.')
      return
    }
    set(axis, { start: String(edges[0]), step: String(+(edges[1] - edges[0]).toPrecision(6)), end: String(edges[edges.length - 1]) })
  }
  const save = (): void => {
    const px = parseAxis(drafts.x)
    const py = parseAxis(drafts.y)
    if (typeof px === 'string' || typeof py === 'string') {
      setError(`${typeof px === 'string' ? `Columns: ${px}` : ''} ${typeof py === 'string' ? `Rows: ${py}` : ''}`.trim())
      return
    }
    onSave(px, py)
    onClose()
  }

  const sorted = [...channels].sort((a, b) => a.name.localeCompare(b.name))
  const axisEditor = (axis: 'x' | 'y', title: string) => {
    const d = drafts[axis]
    const def = channels.find((c) => c.id === d.channelId)
    const unit = def ? channelView(def, units).unit.label : ''
    return (
      <div className="card" style={{ padding: 12 }}>
        <div className="section-label">{title}</div>
        <div className="field">
          <label>Channel</label>
          <select className="select" value={d.channelId} onChange={(e) => set(axis, { channelId: e.target.value })}>
            {!def && <option value={d.channelId}>{d.channelId} (not in these logs)</option>}
            {sorted.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid-3" style={{ marginTop: 10 }}>
          {(['start', 'step', 'end'] as const).map((k) => (
            <div className="field" key={k}>
              <label>
                {k[0].toUpperCase() + k.slice(1)} {unit && `· ${unit}`}
              </label>
              <input className="input" value={d[k]} onChange={(e) => set(axis, { [k]: e.target.value })} />
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn sm" onClick={() => auto(axis)}>
            Auto from data
          </button>
          <span className="muted small">
            {(() => {
              const p = parseAxis(d)
              return typeof p === 'string' ? '' : `${makeEdges(p.start, p.step, p.end).length - 1} cells`
            })()}
          </span>
        </div>
      </div>
    )
  }

  return (
    <Modal
      title="Heatmap axes"
      onClose={onClose}
      wide
      footer={
        <>
          {error && (
            <span className="small" style={{ color: 'var(--red)', marginRight: 'auto' }}>
              {error}
            </span>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Apply
          </button>
        </>
      }
    >
      <div className="grid-2" style={{ gap: 14 }}>
        {axisEditor('x', 'Columns (x)')}
        {axisEditor('y', 'Rows (y)')}
      </div>
      <div className="muted small" style={{ marginTop: 10, lineHeight: 1.5 }}>
        Each cell covers start ≤ value &lt; start + step. Samples outside the range are left out and counted as &quot;outside the axes&quot;. To line the
        grid up with a map in your tune, use the same breakpoints.
      </div>
    </Modal>
  )
}
