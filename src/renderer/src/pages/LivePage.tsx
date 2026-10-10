import { useEffect, useState } from 'react'
import { MAX_LIVE_CHANNELS } from '@shared/catalog'
import { api, isOnline, useApp } from '../store'
import { MenuButton, PromptModal, type MenuItem } from '../components/ui'
import { connectTo } from '../components/AppHeader'
import { ChannelsIcon, CheckIcon, PauseIcon, PlayIcon, PlugIcon, PresetsIcon, SaveIcon, SimulatorIcon } from '../components/icons'
import { LiveTiles } from '../live/LiveTiles'
import { ChannelPalette } from '../live/ChannelPalette'
import { LogViewer } from '../logviewer/LogViewer'

export function LivePage({ active }: { active: boolean }) {
  const settings = useApp((s) => s.settings)!
  const presets = useApp((s) => s.presets)
  const status = useApp((s) => s.status)
  const adapters = useApp((s) => s.adapters)
  const updateSettings = useApp((s) => s.updateSettings)
  const setPresets = useApp((s) => s.setPresets)
  const toast = useApp((s) => s.toast)
  const [expanded, setExpanded] = useState(false)
  const [picking, setPicking] = useState(false)
  const [savingPreset, setSavingPreset] = useState(false)

  const online = isOnline(status)
  const live = status.state === 'live'
  const selected = settings.liveChannels
  const activePreset = presets.channels.find((p) => p.channelIds.length === selected.length && p.channelIds.every((id, i) => id === selected[i]))

  // Ctrl+K / ⌘+K opens the channel picker while this page is shown.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPicking(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  const presetItems: MenuItem[] = [
    { label: 'Channel presets', heading: true },
    ...(presets.channels.length
      ? presets.channels.map((p) => ({
          label: p.name,
          icon: p === activePreset ? <CheckIcon size={15} weight="bold" /> : <span style={{ width: 15 }} />,
          onClick: () => {
            void updateSettings({ liveChannels: p.channelIds.slice(0, MAX_LIVE_CHANNELS) })
            toast(`Loaded preset “${p.name}”`)
          }
        }))
      : [{ label: 'No presets yet', disabled: true }]),
    { label: '', separator: true },
    { label: 'Save current channels as preset…', icon: <SaveIcon size={15} />, onClick: () => setSavingPreset(true), disabled: !selected.length }
  ]

  const savePreset = (name: string): void => {
    const others = presets.channels.filter((p) => p.name !== name)
    void setPresets({ ...presets, channels: [...others, { name, channelIds: selected }] })
    toast(`Saved preset “${name}”`, 'success')
  }

  const lastKind = settings.connection.kind
  const shortcut = api.platform === 'darwin' ? '⌘K' : 'Ctrl K'

  return (
    <div className="page scroll live-page">
      <div className="page-toolbar">
        <h1>Live</h1>
        <span className="sub">
          {live ? (
            <>
              <span className="dot live" /> Streaming {selected.length} channel{selected.length === 1 ? '' : 's'}
              {status.sampleRateHz ? <span className="mono">· {status.sampleRateHz.toFixed(1)} Hz</span> : null}
            </>
          ) : online ? (
            <>
              <span className="dot connected" /> Stream paused
            </>
          ) : status.state === 'connecting' ? (
            <>
              <span className="dot connecting" /> Connecting…
            </>
          ) : (
            <>
              <span className="dot" /> Not connected
            </>
          )}
        </span>
        <div className="spacer" />
        <MenuButton label={activePreset ? activePreset.name : 'Presets'} className="btn" icon={<PresetsIcon size={15} />} items={presetItems} />
        <button className="btn" onClick={() => setPicking(true)} title={`Pick channels (${shortcut})`}>
          <ChannelsIcon size={15} /> Channels
          <span className="kbd">{shortcut}</span>
        </button>
        {online &&
          (live ? (
            <button className="btn" onClick={() => api.stopLive()} disabled={!!status.recording} title={status.recording ? 'Stop the capture first' : undefined}>
              <PauseIcon size={14} weight="fill" /> Pause stream
            </button>
          ) : (
            <button className="btn primary" onClick={() => api.startLive()}>
              <PlayIcon size={14} weight="fill" /> Resume stream
            </button>
          ))}
      </div>

      {!expanded && !online && status.state !== 'connecting' && (
        <div className="connect-cta">
          <div className="icon-wrap">
            <PlugIcon size={22} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3>Not connected</h3>
            <p>Plug in the ENET cable or join the MHD / bootmod3 adapter’s WiFi, switch the ignition on, then connect. The simulator works without a car.</p>
          </div>
          <button className="btn primary" onClick={() => connectTo(lastKind)}>
            <PlugIcon size={15} weight="bold" /> Connect · {adapters.find((a) => a.kind === lastKind)?.label ?? lastKind}
          </button>
          {lastKind !== 'simulator' && (
            <button className="btn" onClick={() => connectTo('simulator')}>
              <SimulatorIcon size={15} /> Try the simulator
            </button>
          )}
        </div>
      )}

      {!expanded && (
        <div className="tiles-wrap">
          <LiveTiles channelIds={selected} onAdd={() => setPicking(true)} />
        </div>
      )}

      <LogViewer mode="live" expanded={expanded} onToggleExpand={() => setExpanded(!expanded)} />

      {picking && <ChannelPalette onClose={() => setPicking(false)} />}
      {savingPreset && (
        <PromptModal
          title="Save channel preset"
          label="Preset name"
          initial={activePreset?.name ?? ''}
          onSubmit={savePreset}
          onClose={() => setSavingPreset(false)}
        />
      )}
    </div>
  )
}
