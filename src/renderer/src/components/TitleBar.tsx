import { useEffect, useState, type ReactNode } from 'react'
import { Activity, Copy, Flag, Gauge, Loader2, Minus, Plug, Settings, Square, Unplug, X } from 'lucide-react'
import type { AdapterKind } from '@shared/types'
import { api, isOnline, useApp, type Page } from '../store'
import { liveBuffer } from '../lib/liveBuffer'
import { Logo, Menu } from './ui'

const NAV: { page: Page; label: string; icon: ReactNode }[] = [
  { page: 'logger', label: 'Logger', icon: <Activity size={18} /> },
  { page: 'dyno', label: 'Dyno', icon: <Gauge size={18} /> },
  { page: 'drag', label: 'Drag', icon: <Flag size={18} /> },
  { page: 'settings', label: 'Settings', icon: <Settings size={18} /> }
]

export async function connectTo(kind: AdapterKind): Promise<void> {
  const { settings, updateSettings, toast } = useApp.getState()
  const conn = settings?.connection
  const host = conn?.kind === kind ? conn.host : undefined
  liveBuffer.clear()
  await updateSettings({ connection: { ...conn, kind } })
  const status = await api.connect({ kind, host: host || undefined, port: conn?.kind === kind ? conn.port : undefined })
  if (status.state === 'error') toast(`Connection failed: ${status.error}`, 'error')
  else toast(`Connected · ${status.adapterLabel ?? kind}${status.vin ? ` · ${status.vin}` : ''}`, 'success')
}

export function TitleBar() {
  const page = useApp((s) => s.page)
  const setPage = useApp((s) => s.setPage)
  const status = useApp((s) => s.status)
  const adapters = useApp((s) => s.adapters)
  const lastKind = useApp((s) => s.settings?.connection.kind ?? 'simulator')
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [maximized, setMaximized] = useState(false)
  useEffect(() => api.onMaximized(setMaximized), [])

  const online = isOnline(status)
  const connecting = status.state === 'connecting'

  return (
    <header className="titlebar">
      <Logo />
      <nav className="nav">
        {NAV.map((n) => (
          <button key={n.page} className={page === n.page ? 'active' : ''} onClick={() => setPage(n.page)}>
            {n.icon}
            {n.label}
          </button>
        ))}
      </nav>
      <div className="titlebar-spacer" />
      {online ? (
        <button className="btn red" onClick={() => api.disconnect()}>
          <Unplug size={14} /> Disconnect
        </button>
      ) : connecting ? (
        <button className="btn" onClick={() => api.disconnect()}>
          <Loader2 size={14} className="spin" /> Connecting… cancel
        </button>
      ) : (
        <div className="row no-drag" style={{ gap: 0 }}>
          <button className="btn primary" style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }} onClick={() => connectTo(lastKind)}>
            <Plug size={14} /> Connect · {adapters.find((a) => a.kind === lastKind)?.label ?? lastKind}
          </button>
          <button
            className="btn primary"
            style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: '1px solid rgba(255,255,255,0.25)', padding: '0 8px' }}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setMenu({ x: r.right - 290, y: r.bottom + 6 })
            }}
            aria-label="Choose adapter"
          >
            ▾
          </button>
        </div>
      )}
      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          className="connect-menu"
          onClose={() => setMenu(null)}
          items={[
            { label: 'Connect with', heading: true },
            ...adapters.map((a) => ({
              label: '',
              icon: (
                <span className="opt-text">
                  <span>{a.label}</span>
                  <span className="opt-desc">{a.description}</span>
                </span>
              ),
              onClick: () => void connectTo(a.kind)
            }))
          ]}
        />
      )}
      {/* macOS uses its native traffic-light buttons instead. */}
      {api.platform !== 'darwin' && (
        <div className="window-controls">
          <button onClick={() => api.windowControl('minimize')} aria-label="Minimize">
            <Minus size={16} />
          </button>
          <button onClick={() => api.windowControl('maximize')} aria-label="Maximize">
            {maximized ? <Copy size={13} /> : <Square size={13} />}
          </button>
          <button className="close" onClick={() => api.windowControl('close')} aria-label="Close">
            <X size={17} />
          </button>
        </div>
      )}
    </header>
  )
}
