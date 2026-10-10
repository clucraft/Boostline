import { useEffect, useMemo, type ReactNode } from 'react'
import { api, useApp, type Page } from './store'
import { liveBuffer } from './lib/liveBuffer'
import { AppHeader } from './components/AppHeader'
import { Toasts } from './components/ui'
import { AnalyzeIcon, DragIcon, DynoIcon, LiveIcon, SettingsIcon } from './components/icons'
import { LivePage } from './pages/LivePage'
import { AnalyzePage } from './pages/AnalyzePage'
import { DynoPage } from './pages/DynoPage'
import { DragPage } from './pages/DragPage'
import { SettingsPage } from './pages/SettingsPage'

const SECTIONS: { page: Page; label: string; icon: ReactNode }[] = [
  { page: 'live', label: 'Live', icon: <LiveIcon size={22} /> },
  { page: 'analyze', label: 'Analyze', icon: <AnalyzeIcon size={22} /> },
  { page: 'dyno', label: 'Dyno', icon: <DynoIcon size={22} /> },
  { page: 'drag', label: 'Drag', icon: <DragIcon size={22} /> }
]

export function App() {
  const page = useApp((s) => s.page)
  const setPage = useApp((s) => s.setPage)
  const settings = useApp((s) => s.settings)
  const version = useApp((s) => s.info?.version)
  const recording = useApp((s) => !!s.status.recording)
  const streamRequests = useApp((s) => s.streamRequests)

  // Initial load + main-process event subscriptions.
  useEffect(() => {
    const s = useApp.getState()
    void Promise.all([api.appInfo(), api.getSettings(), api.getPresets(), api.adapterOptions(), api.status(), api.channels()]).then(
      ([info, settings, presets, adapters, status, channels]) => {
        useApp.setState({ info, settings, presets, adapters, status })
        s.setChannels(channels)
      }
    )
    const offs = [
      api.onStatus((status) => useApp.setState({ status })),
      api.onChannels((c) => useApp.getState().setChannels(c)),
      api.onLiveBatch((b) => liveBuffer.push(b))
    ]
    return () => offs.forEach((off) => off())
  }, [])

  // Everything any view needs streamed, merged into one request to main.
  const streamIds = useMemo(() => {
    const ids = new Set(settings?.liveChannels ?? [])
    for (const list of Object.values(streamRequests)) list.forEach((id) => ids.add(id))
    return [...ids]
  }, [settings?.liveChannels, streamRequests])
  useEffect(() => {
    void api.setStreamChannels(streamIds)
  }, [streamIds])

  const railItem = (s: { page: Page; label: string; icon: ReactNode }): ReactNode => (
    <button key={s.page} className={`rail-item ${page === s.page ? 'active' : ''}`} onClick={() => setPage(s.page)} title={s.label}>
      {s.icon}
      {s.label}
      {s.page === 'live' && recording && page !== 'live' && <span className="rail-badge" />}
    </button>
  )

  return (
    <div className="app-shell">
      <AppHeader />
      <nav className="rail">
        {SECTIONS.map(railItem)}
        <div className="rail-spacer" />
        {railItem({ page: 'settings', label: 'Settings', icon: <SettingsIcon size={22} /> })}
        <div className="rail-version">v{version ?? '…'}</div>
      </nav>
      <main className="app-main">
        {settings && (
          <>
            {/* Pages stay mounted so live state (armed runs, zoom, loaded logs) survives section switches. */}
            <div style={{ display: page === 'live' ? 'contents' : 'none' }}>
              <LivePage active={page === 'live'} />
            </div>
            <div style={{ display: page === 'analyze' ? 'contents' : 'none' }}>
              <AnalyzePage active={page === 'analyze'} />
            </div>
            <div style={{ display: page === 'dyno' ? 'contents' : 'none' }}>
              <DynoPage />
            </div>
            <div style={{ display: page === 'drag' ? 'contents' : 'none' }}>
              <DragPage />
            </div>
            {page === 'settings' && <SettingsPage />}
          </>
        )}
      </main>
      <Toasts />
    </div>
  )
}
