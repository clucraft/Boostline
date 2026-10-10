import { useState } from 'react'
import { CableIcon, DiagnosticsIcon, FolderIcon, InfoIcon, SearchIcon, SimulatorIcon, SpinnerIcon, UnitsIcon, GraphIcon, WifiIcon } from '../components/icons'
import type { AdapterKind, UnitPrefs } from '@shared/types'
import type { ProbeResult } from '@shared/ipc'
import { api, useApp } from '../store'
import { Toggle } from '../components/ui'
import { BmwDataCard } from '../components/BmwDataCard'

const UNIT_OPTIONS: { key: keyof UnitPrefs; label: string; options: [string, string][] }[] = [
  { key: 'pressure', label: 'Pressure', options: [['bar', 'bar'], ['psi', 'psi'], ['kPa', 'kPa']] },
  { key: 'temperature', label: 'Temperature', options: [['C', '°C'], ['F', '°F']] },
  { key: 'speed', label: 'Speed', options: [['km/h', 'km/h'], ['mph', 'mph']] },
  { key: 'torque', label: 'Torque', options: [['Nm', 'Nm'], ['lb-ft', 'lb-ft']] },
  { key: 'power', label: 'Power', options: [['hp', 'hp'], ['PS', 'PS'], ['kW', 'kW']] },
  { key: 'massFlow', label: 'Air mass flow', options: [['kg/h', 'kg/h'], ['g/s', 'g/s'], ['lb/min', 'lb/min']] },
  { key: 'lambda', label: 'Mixture', options: [['lambda', 'λ'], ['afr', 'AFR']] }
]

const ADAPTER_HELP: Record<AdapterKind, string> = {
  simulator: 'A simulated B58 drive cycle (launches, a 4th-gear pull, cruising). Good for trying every screen.',
  enet: 'Plug the ENET cable into the OBD port and the laptop’s Ethernet port (on most Macs, a USB-C Ethernet adapter), then switch the ignition on. The car is found automatically (UDP 6811 discovery). Enter the car’s IP only if discovery fails.',
  'mhd-wifi':
    'Join the adapter’s “MHD ENET” WiFi network (the adapter also broadcasts “MHD ECA”; that one won’t work) and switch the ignition on. Boostline finds the adapter’s ENET gateway on TCP 6801 automatically. If it isn’t found, run diagnostics below and share the report.',
  'bm3-wifi':
    'Join the adapter’s WiFi network (“BM3-NET…”) and switch the ignition on. Boostline looks for the adapter’s ENET gateway on TCP 6801. If it isn’t found, run diagnostics below and share the report.'
}

export function SettingsPage() {
  const settings = useApp((s) => s.settings)!
  const info = useApp((s) => s.info)
  const adapters = useApp((s) => s.adapters)
  const updateSettings = useApp((s) => s.updateSettings)
  const toast = useApp((s) => s.toast)
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [probing, setProbing] = useState(false)
  const conn = settings.connection

  const setConn = (patch: Partial<typeof conn>): void => void updateSettings({ connection: { ...conn, ...patch } })

  const runProbe = async (): Promise<void> => {
    setProbing(true)
    setProbe(null)
    try {
      setProbe(await api.runProbe({ kind: conn.kind, host: conn.host || undefined, port: conn.port }))
    } catch (err) {
      toast(`Diagnostics failed: ${String(err)}`, 'error')
    } finally {
      setProbing(false)
    }
  }

  const chooseDir = async (): Promise<void> => {
    const dir = await api.chooseDataDir()
    if (dir) {
      useApp.setState({ settings: await api.getSettings() })
      toast(`Data folder: ${dir}`, 'success')
    }
  }

  return (
    <div className="page scroll">
      <div className="page-toolbar">
        <h1>Settings</h1>
        <span className="sub">Saved automatically</span>
      </div>
      <div className="settings-grid">
        <section className="card">
          <h3 className="card-title">
            <span className="row">
              <CableIcon size={17} /> Connection
            </span>
          </h3>
          <div className="setting-row">
            <div>
              <div>Adapter</div>
              <div className="desc">Used by the Connect button in the top bar.</div>
            </div>
            <select className="select control" value={conn.kind} onChange={(e) => setConn({ kind: e.target.value as AdapterKind })}>
              {adapters.map((a) => (
                <option key={a.kind} value={a.kind}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <div className="note" style={{ padding: '2px 0 12px', lineHeight: 1.55, alignItems: 'flex-start', color: 'var(--muted)' }}>
            <span style={{ marginTop: 2 }}>
              {conn.kind === 'enet' ? <CableIcon size={15} /> : conn.kind === 'simulator' ? <SimulatorIcon size={15} /> : <WifiIcon size={15} />}
            </span>
            <span>{ADAPTER_HELP[conn.kind]}</span>
          </div>
          {conn.kind !== 'simulator' && (
            <>
              <div className="setting-row">
                <div>
                  <div>Gateway IP (optional)</div>
                  <div className="desc">Leave empty to auto-detect.</div>
                </div>
                <input className="input control" placeholder="auto" value={conn.host ?? ''} onChange={(e) => setConn({ host: e.target.value.trim() || undefined })} />
              </div>
              <div className="setting-row">
                <div>
                  <div>Port</div>
                  <div className="desc">HSFZ diagnostics port, normally 6801.</div>
                </div>
                <input
                  className="input control"
                  placeholder="6801"
                  value={conn.port ?? ''}
                  onChange={(e) => setConn({ port: parseInt(e.target.value, 10) || undefined })}
                />
              </div>
              <div className="setting-row">
                <div>
                  <div>Connection diagnostics</div>
                  <div className="desc">Scans the network, tries discovery and a read-only VIN request, and saves a byte-level capture.</div>
                </div>
                <button className="btn" onClick={runProbe} disabled={probing}>
                  {probing ? <SpinnerIcon size={15} className="spin" /> : <DiagnosticsIcon size={15} />} {probing ? 'Running…' : 'Run diagnostics'}
                </button>
              </div>
              {probe && (
                <div className="stack" style={{ marginTop: 6 }}>
                  <div style={{ fontWeight: 600 }}>{probe.summary}</div>
                  <div className="code-block">{JSON.stringify(probe.report, null, 2)}</div>
                  {probe.capturePath && (
                    <div className="row">
                      <span className="muted small mono" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {probe.capturePath}
                      </span>
                      <button className="btn sm" onClick={() => api.showInFolder(probe.capturePath!)}>
                        <SearchIcon size={14} /> Show file
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </section>

        <BmwDataCard />

        <section className="card">
          <h3 className="card-title">
            <span className="row">
              <UnitsIcon size={17} /> Units
            </span>
          </h3>
          {UNIT_OPTIONS.map((u) => (
            <div className="setting-row" key={u.key}>
              <div>{u.label}</div>
              <div className="segmented">
                {u.options.map(([value, label]) => (
                  <button
                    key={value}
                    className={settings.units[u.key] === value ? 'active' : ''}
                    onClick={() => updateSettings({ units: { ...settings.units, [u.key]: value } as UnitPrefs })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>

        <section className="card">
          <h3 className="card-title">
            <span className="row">
              <GraphIcon size={17} /> Graphs
            </span>
          </h3>
          {(
            [
              ['cursorPopups', 'Cursor value pop-ups', 'Show every channel’s value next to the cursor.'],
              ['scaleLegends', 'Scale legends', 'Show a colored Y axis for each channel, not just the first.'],
              ['lineSmoothing', 'Graph line smoothing', 'Draw smoothed curves instead of straight segments.']
            ] as const
          ).map(([key, label, desc]) => (
            <div className="setting-row" key={key}>
              <div>
                <div>{label}</div>
                <div className="desc">{desc}</div>
              </div>
              <Toggle on={settings.logViewer[key]} onChange={(v) => updateSettings({ logViewer: { ...settings.logViewer, [key]: v } })} />
            </div>
          ))}
          <div className="setting-row">
            <div>
              <div>Live graph window</div>
              <div className="desc">Seconds of history shown in the live graphs.</div>
            </div>
            <div className="segmented">
              {[10, 30, 60, 120].map((s) => (
                <button
                  key={s}
                  className={settings.logViewer.liveWindowSec === s ? 'active' : ''}
                  onClick={() => updateSettings({ logViewer: { ...settings.logViewer, liveWindowSec: s } })}
                >
                  {s}s
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="card">
          <h3 className="card-title">
            <span className="row">
              <FolderIcon size={17} /> Logging
            </span>
          </h3>
          <div className="setting-row">
            <div style={{ minWidth: 0 }}>
              <div>Data folder</div>
              <div className="desc mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {settings.dataDir}
              </div>
            </div>
            <div className="row">
              <button className="btn sm" onClick={() => api.openDataDir()}>
                Open
              </button>
              <button className="btn sm" onClick={chooseDir}>
                Change…
              </button>
            </div>
          </div>
          <div className="setting-row">
            <div>
              <div>Auto-capture WOT pulls</div>
              <div className="desc">Start a capture when the pedal passes 85 % and stop 3 s after lifting. Applies on the next connect.</div>
            </div>
            <Toggle on={settings.autoRecordWot} onChange={(v) => updateSettings({ autoRecordWot: v })} />
          </div>
          <div className="help-text" style={{ marginTop: 6 }}>
            Logs are CSV files in <span className="mono">Logs</span>, dyno and drag runs are JSON files in <span className="mono">Dyno</span> /{' '}
            <span className="mono">Drag</span>, and custom channel definitions go in <span className="mono">Definitions</span>.
          </div>
        </section>

        <section className="card">
          <h3 className="card-title">
            <span className="row">
              <InfoIcon size={17} /> About
            </span>
          </h3>
          <div className="stack" style={{ lineHeight: 1.6 }}>
            <div>
              <b>Boostline</b> v{info?.version} · free and open source (MIT)
            </div>
            <div className="help-text">
              Live data, log analysis, road dyno and drag timing for BMW B38/B48/B58/S58/N63/S63 engines.
              <br />
              Not affiliated with BMW, MHD or bootmod3. Use at your own risk; only read-only diagnostic services are sent to the car.
            </div>
            <div>
              <a href="https://github.com/clucraft/Boostline" target="_blank" rel="noreferrer">
                github.com/clucraft/Boostline
              </a>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
