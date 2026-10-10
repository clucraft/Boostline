import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { ChannelDef } from '@shared/types'
import { GROUP_ORDER, MAX_LIVE_CHANNELS } from '@shared/catalog'
import { useApp } from '../store'
import { channelView } from '../lib/format'
import { CheckIcon, SearchIcon } from '../components/icons'

/** Keyboard-first channel picker for the live tiles (Ctrl/⌘+K). */
export function ChannelPalette({ onClose }: { onClose: () => void }) {
  const channels = useApp((s) => s.channels)
  const settings = useApp((s) => s.settings)!
  const updateSettings = useApp((s) => s.updateSettings)
  const toast = useApp((s) => s.toast)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const selected = settings.liveChannels
  const selectedSet = useMemo(() => new Set(selected), [selected])

  // Flat list in group order; group headings are rendered where the group changes.
  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    const words = q.split(/\s+/).filter(Boolean)
    const match = (c: ChannelDef): boolean => words.every((w) => c.name.toLowerCase().includes(w) || c.id.toLowerCase().includes(w) || c.group.toLowerCase().includes(w))
    return channels.filter(match).sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
  }, [channels, query])

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const toggle = (id: string): void => {
    if (selectedSet.has(id)) void updateSettings({ liveChannels: selected.filter((x) => x !== id) })
    else if (selected.length >= MAX_LIVE_CHANNELS) toast(`Up to ${MAX_LIVE_CHANNELS} live channels`, 'error')
    else void updateSettings({ liveChannels: [...selected, id] })
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(items.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (items[active]) toggle(items[active].id)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return createPortal(
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" onKeyDown={onKey}>
        <div className="palette-search">
          <SearchIcon size={18} />
          <input autoFocus placeholder="Search channels, e.g. “boost”, “knock cyl 3”, “temp”" value={query} onChange={(e) => setQuery(e.target.value)} />
          <span className="count-badge">
            {selected.length}/{MAX_LIVE_CHANNELS}
          </span>
        </div>
        <div className="palette-list" ref={listRef}>
          {items.map((c, i) => {
            const isSel = selectedSet.has(c.id)
            const heading = i === 0 || items[i - 1].group !== c.group
            return (
              <div key={c.id}>
                {heading && <div className="palette-group">{c.group}</div>}
                <div
                  className={`palette-item ${i === active ? 'active' : ''} ${isSel ? 'selected' : ''}`}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => toggle(c.id)}
                >
                  <span className="check">{isSel && <CheckIcon size={12} weight="bold" />}</span>
                  <span style={{ minWidth: 0 }}>
                    <div className="name">{c.name}</div>
                    <div className="id">{c.id}</div>
                  </span>
                  <span className="unit">{channelView(c, settings.units).unit.label}</span>
                </div>
              </div>
            )
          })}
          {!items.length && <div className="muted small" style={{ padding: 12 }}>No channels match “{query}”.</div>}
        </div>
        <div className="palette-foot">
          <span>
            <span className="kbd">↑</span>
            <span className="kbd">↓</span> move
          </span>
          <span>
            <span className="kbd">Enter</span> add or remove
          </span>
          <span>
            <span className="kbd">Esc</span> close
          </span>
          <span className="spacer" />
          <button className="btn sm ghost" onClick={() => updateSettings({ liveChannels: [] })} disabled={!selected.length}>
            Clear all
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
