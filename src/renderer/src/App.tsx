import { useEffect, useMemo } from 'react'
import { api, useApp } from './store'
import { liveBuffer } from './lib/liveBuffer'
import { TitleBar } from './components/TitleBar'
import { StatusBar } from './components/StatusBar'
import { Toasts } from './components/ui'
import { LoggerPage } from './pages/LoggerPage'
import { DynoPage } from './pages/DynoPage'
import { DragPage } from './pages/DragPage'
import { SettingsPage } from './pages/SettingsPage'

export function App() {
  const page = useApp((s) => s.page)
  const settings = useApp((s) => s.settings)
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

  if (!settings) return <div className="app" />

  return (
    <div className="app">
      <TitleBar />
      {/* Pages stay mounted so live state (armed runs, zoom, loaded logs) survives tab switches. */}
      <div style={{ display: page === 'logger' ? 'contents' : 'none' }}>
        <LoggerPage />
      </div>
      <div style={{ display: page === 'dyno' ? 'contents' : 'none' }}>
        <DynoPage />
      </div>
      <div style={{ display: page === 'drag' ? 'contents' : 'none' }}>
        <DragPage />
      </div>
      {page === 'settings' && <SettingsPage />}
      <StatusBar />
      <Toasts />
    </div>
  )
}
