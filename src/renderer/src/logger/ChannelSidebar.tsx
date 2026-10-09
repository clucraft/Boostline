import { useMemo, useState } from 'react'
import { ChevronDown, FolderOpen, Save, X } from 'lucide-react'
import type { ChannelDef, ChannelGroup } from '@shared/types'
import { GROUP_ORDER, MAX_LIVE_CHANNELS } from '@shared/catalog'
import { useApp } from '../store'
import { channelView } from '../lib/format'
import { PromptModal } from '../components/ui'

export function ChannelSidebar() {
  const channels = useApp((s) => s.channels)
  const settings = useApp((s) => s.settings)!
  const presets = useApp((s) => s.presets)
  const updateSettings = useApp((s) => s.updateSettings)
  const setPresets = useApp((s) => s.setPresets)
  const toast = useApp((s) => s.toast)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [selectedPreset, setSelectedPreset] = useState('')
  const [saving, setSaving] = useState(false)

  const selected = settings.liveChannels
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const activePreset = presets.channels.find(
    (p) => p.channelIds.length === selected.length && p.channelIds.every((id, i) => id === selected[i])
  )

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (c: ChannelDef): boolean => !q || c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)
    const byGroup = new Map<ChannelGroup, ChannelDef[]>()
    for (const c of channels) {
      if (!match(c)) continue
      byGroup.set(c.group, [...(byGroup.get(c.group) ?? []), c])
    }
    return GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => ({ group: g, items: byGroup.get(g)! }))
  }, [channels, query])

  const toggle = (id: string): void => {
    if (selectedSet.has(id)) void updateSettings({ liveChannels: selected.filter((x) => x !== id) })
    else if (selected.length >= MAX_LIVE_CHANNELS) toast(`Up to ${MAX_LIVE_CHANNELS} live channels`, 'error')
    else void updateSettings({ liveChannels: [...selected, id] })
  }

  const loadPreset = (): void => {
    const p = presets.channels.find((x) => x.name === selectedPreset)
    if (!p) return
    void updateSettings({ liveChannels: p.channelIds.slice(0, MAX_LIVE_CHANNELS) })
    toast(`Loaded preset “${p.name}”`)
  }

  const savePreset = (name: string): void => {
    const others = presets.channels.filter((p) => p.name !== name)
    void setPresets({ ...presets, channels: [...others, { name, channelIds: selected }] })
    setSelectedPreset(name)
    toast(`Saved preset “${name}”`, 'success')
  }

  return (
    <aside className="sidebar">
      <section className="card">
        <h3 className="card-title">Preset</h3>
        <select className="select" value={selectedPreset || activePreset?.name || ''} onChange={(e) => setSelectedPreset(e.target.value)}>
          <option value="">Custom</option>
          {presets.channels.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn sm" style={{ flex: 1 }} onClick={() => setSaving(true)}>
            <Save size={13} /> Save preset
          </button>
          <button className="btn sm" style={{ flex: 1 }} onClick={loadPreset} disabled={!selectedPreset}>
            <FolderOpen size={13} /> Load preset
          </button>
        </div>
      </section>

      <section className="card flex grow">
        <h3 className="card-title">
          <span>
            Channels{' '}
            <span className="count-badge">
              {selected.length}/{MAX_LIVE_CHANNELS}
            </span>
          </span>
          <button className="btn sm" onClick={() => updateSettings({ liveChannels: [] })} disabled={!selected.length}>
            <X size={12} /> Clear
          </button>
        </h3>
        <input className="input" placeholder="Search channels..." value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="channel-list">
          {groups.map(({ group, items }) => {
            const open = query !== '' || !collapsed.has(group)
            const count = items.filter((c) => selectedSet.has(c.id)).length
            return (
              <div className="channel-group" key={group}>
                <div
                  className="collapsible-head"
                  onClick={() => {
                    const next = new Set(collapsed)
                    if (next.has(group)) next.delete(group)
                    else next.add(group)
                    setCollapsed(next)
                  }}
                >
                  <span className="chevron">
                    <ChevronDown size={12} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
                  </span>
                  {group}
                  {count > 0 && <span className="count-badge">· {count}</span>}
                </div>
                {open &&
                  items.map((c) => {
                    const checked = selectedSet.has(c.id)
                    return (
                      <label key={c.id} className={`channel-item ${checked ? 'checked' : ''}`}>
                        <input type="checkbox" checked={checked} onChange={() => toggle(c.id)} />
                        <span>
                          <div className="name">{c.name}</div>
                          <div className="id">{c.id}</div>
                        </span>
                        <span className="unit">{channelView(c, settings.units).unit.label}</span>
                      </label>
                    )
                  })}
              </div>
            )
          })}
          {!groups.length && <div className="muted small" style={{ padding: 8 }}>No channels match “{query}”.</div>}
        </div>
      </section>
      {saving && (
        <PromptModal
          title="Save channel preset"
          label="Preset name"
          initial={activePreset?.name ?? selectedPreset ?? ''}
          onSubmit={savePreset}
          onClose={() => setSaving(false)}
        />
      )}
    </aside>
  )
}
