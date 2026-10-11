import { useEffect, useState, type MouseEvent } from 'react'
import type { AdapterKind } from '@shared/types'
import { api, isOnline, useApp } from '../store'
import { liveBuffer } from '../lib/liveBuffer'
import { fmtDuration } from '../lib/format'
import { Logo, Menu, type MenuItem } from './ui'
import {
  CarIcon,
  CaretDownIcon,
  CloseIcon,
  CopyIcon,
  DisconnectIcon,
  MaximizeIcon,
  MinusIcon,
  PauseIcon,
  PlayIcon,
  PlugIcon,
  SettingsIcon,
  SpinnerIcon,
  StopIcon,
  WarningIcon
} from './icons'

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

export async function toggleCapture(): Promise<void> {
  const { status, toast } = useApp.getState()
  if (status.recording) {
    const file = await api.stopRecording()
    if (file) toast(`Log saved: ${file.split(/[\\/]/).pop()}`, 'success')
    return
  }
  try {
    await api.startRecording()
  } catch (err) {
    toast(String(err), 'error')
  }
}

type MenuAt = { x: number; y: number; kind: 'adapters' | 'connection' | 'vehicle' }

/** Top bar: brand, capture control, vehicle and connection status, window buttons. */
export function AppHeader() {
  const status = useApp((s) => s.status)
  const adapters = useApp((s) => s.adapters)
  const lastKind = useApp((s) => s.settings?.connection.kind ?? 'simulator')
  const [menu, setMenu] = useState<MenuAt | null>(null)
  const [maximized, setMaximized] = useState(false)
  useEffect(() => api.onMaximized(setMaximized), [])

  const online = isOnline(status)
  const recording = status.recording
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!recording) return
    const id = setInterval(() => setTick((n) => n + 1), 500)
    return () => clearInterval(id)
  }, [!!recording]) // eslint-disable-line react-hooks/exhaustive-deps

  const open = (e: MouseEvent, kind: MenuAt['kind'], width: number): void => {
    const r = e.currentTarget.getBoundingClientRect()
    setMenu({ x: Math.max(8, r.right - width), y: r.bottom + 6, kind })
  }

  const adapterItems: MenuItem[] = [
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
  ]

  const connectionItems: MenuItem[] = [
    { label: 'Connection', heading: true },
    { label: 'Adapter', value: status.adapterLabel ?? status.adapterKind ?? '—' },
    ...(status.endpoint ? [{ label: 'Address', value: status.endpoint }] : []),
    { label: 'Stream', value: status.state === 'live' ? `${status.sampleRateHz?.toFixed(1) ?? '…'} Hz` : 'paused' },
    { label: '', separator: true },
    status.state === 'live'
      ? { label: 'Pause stream', icon: <PauseIcon size={15} />, onClick: () => void api.stopLive(), disabled: !!recording }
      : { label: 'Resume stream', icon: <PlayIcon size={15} />, onClick: () => void api.startLive() },
    { label: 'Connection settings…', icon: <SettingsIcon size={15} />, onClick: () => useApp.getState().setPage('settings') },
    { label: 'Disconnect', icon: <DisconnectIcon size={15} />, onClick: () => void api.disconnect() }
  ]

  const ecu = status.ecu
  const vehicleItems: MenuItem[] = [
    { label: 'Vehicle', heading: true },
    { label: 'VIN', value: status.vin ?? '—' },
    ...(ecu?.dmeData ? [{ label: 'DME data', value: ecu.dmeData.split(' · ')[0] }] : []),
    ...(ecu?.sgbdIndex ? [{ label: 'DME index', value: ecu.sgbdIndex }] : []),
    ...(ecu?.softwareVersion ? [{ label: 'ECU software', value: ecu.softwareVersion }] : []),
    ...(status.vin
      ? [
          { label: '', separator: true },
          {
            label: 'Copy VIN',
            icon: <CopyIcon size={15} />,
            onClick: () => void api.copyText(status.vin!).then(() => useApp.getState().toast('VIN copied'))
          }
        ]
      : [])
  ]

  return (
    <header className="app-header">
      <Logo />
      <div className="spacer" />

      {online &&
        (recording ? (
          <button className="pill rec" onClick={() => void toggleCapture()} title="Stop capture and save the log">
            <span className="dot rec" />
            <b className="mono">{fmtDuration(Math.max(0, Date.now() - recording.startedAt))}</b>
            <span className="rec-samples">{recording.samples.toLocaleString()} samples</span>
            <StopIcon size={13} weight="fill" />
          </button>
        ) : (
          <button className="btn" onClick={() => void toggleCapture()} title="Record the streamed channels to a CSV log">
            <span className="rec-dot" /> <span className="btn-label">Start capture</span>
          </button>
        ))}

      {online && (status.vin || ecu?.softwareVersion) && (
        <button className="pill vehicle-pill" onClick={(e) => open(e, 'vehicle', 300)} title="Vehicle details">
          <CarIcon size={15} />
          <span className="mono">{status.vin ?? ecu?.softwareVersion}</span>
        </button>
      )}

      {online ? (
        <button className="pill" onClick={(e) => open(e, 'connection', 260)}>
          <span className={`dot ${status.state}`} />
          <b>{status.adapterLabel ?? 'Connected'}</b>
          {status.state === 'live' ? <span className="mono">{status.sampleRateHz?.toFixed(1) ?? '…'} Hz</span> : <span>paused</span>}
          <CaretDownIcon size={11} weight="bold" />
        </button>
      ) : status.state === 'connecting' ? (
        <>
          <span className="pill">
            <SpinnerIcon size={14} className="spin" />
            Connecting{status.adapterLabel ? ` to ${status.adapterLabel}` : ''}…
          </span>
          <button className="btn ghost sm" onClick={() => api.disconnect()}>
            Cancel
          </button>
        </>
      ) : (
        <>
          {status.state === 'error' && (
            <span className="pill error" title={status.error}>
              <WarningIcon size={14} />
              Connection failed
            </span>
          )}
          <div className="btn-group no-drag">
            <button className="btn primary" onClick={() => connectTo(lastKind)}>
              <PlugIcon size={15} weight="bold" /> Connect · {adapters.find((a) => a.kind === lastKind)?.label ?? lastKind}
            </button>
            <button className="btn primary" onClick={(e) => open(e, 'adapters', 310)} aria-label="Choose adapter">
              <CaretDownIcon size={12} weight="bold" />
            </button>
          </div>
        </>
      )}

      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          className={menu.kind === 'adapters' ? 'connect-menu' : undefined}
          onClose={() => setMenu(null)}
          items={menu.kind === 'adapters' ? adapterItems : menu.kind === 'connection' ? connectionItems : vehicleItems}
        />
      )}

      {/* macOS uses its native traffic-light buttons; phones have no window buttons. */}
      {api.platform === 'win32' || api.platform === 'linux' ? (
        <div className="window-controls">
          <button onClick={() => api.windowControl('minimize')} aria-label="Minimize">
            <MinusIcon size={16} />
          </button>
          <button onClick={() => api.windowControl('maximize')} aria-label="Maximize">
            {maximized ? <CopyIcon size={14} /> : <MaximizeIcon size={13} />}
          </button>
          <button className="close" onClick={() => api.windowControl('close')} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </div>
      ) : (
        <div style={{ width: 4 }} />
      )}
    </header>
  )
}
