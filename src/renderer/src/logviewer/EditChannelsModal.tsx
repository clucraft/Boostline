import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import type { ChannelDef, UnitPrefs } from '@shared/types'
import { GROUP_ORDER, MAX_GRAPH_CHANNELS } from '@shared/catalog'
import { Modal } from '../components/ui'
import { channelView } from '../lib/format'
import { colorAt } from '../lib/colors'
import type { GraphConfig } from './types'

export function EditChannelsModal({
  graph,
  available,
  units,
  onSave,
  onClose
}: {
  graph: GraphConfig
  available: ChannelDef[]
  units: UnitPrefs
  onSave: (cfg: GraphConfig) => void
  onClose: () => void
}) {
  const [ids, setIds] = useState(graph.channelIds)
  const [ranges, setRanges] = useState<Record<string, [string, string]>>(() =>
    Object.fromEntries(Object.entries(graph.ranges).map(([id, [lo, hi]]) => [id, [String(lo), String(hi)]]))
  )
  const [query, setQuery] = useState('')
  const byId = useMemo(() => new Map(available.map((c) => [c.id, c])), [available])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return available
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
      .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
  }, [available, query])

  const toggle = (id: string): void => {
    if (ids.includes(id)) setIds(ids.filter((x) => x !== id))
    else if (ids.length < MAX_GRAPH_CHANNELS) setIds([...ids, id])
  }
  const move = (i: number, dir: -1 | 1): void => {
    const next = [...ids]
    ;[next[i], next[i + dir]] = [next[i + dir], next[i]]
    setIds(next)
  }

  const save = (): void => {
    const parsed: Record<string, [number, number]> = {}
    for (const id of ids) {
      const r = ranges[id]
      if (!r) continue
      const lo = parseFloat(r[0])
      const hi = parseFloat(r[1])
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) parsed[id] = [lo, hi]
    }
    onSave({ ...graph, channelIds: ids, ranges: parsed })
    onClose()
  }

  return (
    <Modal
      title={`Edit channels · ${graph.title}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Apply
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
        <div className="stack" style={{ minHeight: 0 }}>
          <input className="input" placeholder="Search channels..." value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
          <div style={{ maxHeight: 380, overflowY: 'auto' }}>
            {filtered.map((c) => (
              <label key={c.id} className={`channel-item ${ids.includes(c.id) ? 'checked' : ''} ${!ids.includes(c.id) && ids.length >= MAX_GRAPH_CHANNELS ? 'disabled' : ''}`}>
                <input type="checkbox" checked={ids.includes(c.id)} onChange={() => toggle(c.id)} />
                <span>
                  <div className="name">{c.name}</div>
                  <div className="id">
                    {c.group} · {c.id}
                  </div>
                </span>
                <span className="unit">{channelView(c, units).unit.label}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="stack">
          <div className="section-label">
            Selected {ids.length}/{MAX_GRAPH_CHANNELS}
          </div>
          {ids.map((id, i) => {
            const def = byId.get(id)
            const unit = def ? channelView(def, units).unit.label : ''
            const r = ranges[id] ?? ['', '']
            return (
              <div key={id} className="card" style={{ padding: 10 }}>
                <div className="row">
                  <span style={{ width: 12, height: 3, borderRadius: 2, background: colorAt(i) }} />
                  <b style={{ flex: 1, fontSize: 12 }}>{def?.name ?? id}</b>
                  <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp size={14} />
                  </button>
                  <button className="icon-btn" disabled={i === ids.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown size={14} />
                  </button>
                  <button className="icon-btn" onClick={() => toggle(id)}>
                    <X size={14} />
                  </button>
                </div>
                <div className="grid-2" style={{ marginTop: 8 }}>
                  <div className="field">
                    <label>Scale min {unit && `(${unit})`}</label>
                    <input className="input" placeholder="auto" value={r[0]} onChange={(e) => setRanges({ ...ranges, [id]: [e.target.value, r[1]] })} />
                  </div>
                  <div className="field">
                    <label>Scale max {unit && `(${unit})`}</label>
                    <input className="input" placeholder="auto" value={r[1]} onChange={(e) => setRanges({ ...ranges, [id]: [r[0], e.target.value] })} />
                  </div>
                </div>
              </div>
            )
          })}
          {!ids.length && <div className="muted small">Tick up to {MAX_GRAPH_CHANNELS} channels on the left.</div>}
        </div>
      </div>
    </Modal>
  )
}
