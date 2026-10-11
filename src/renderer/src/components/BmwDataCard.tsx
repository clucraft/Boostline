import { useEffect, useState } from 'react'
import { DatabaseIcon, DownloadIcon, FolderIcon, SpinnerIcon, TrashIcon } from './icons'
import type { BmwDataProgress, BmwDataSummary } from '@shared/ipc'
import { api, useApp } from '../store'
import { fmtBytes } from '../lib/format'
import { LINKS } from '../lib/links'

const PHASE: Record<BmwDataProgress['phase'], string> = {
  release: 'Looking up the latest release…',
  download: 'Downloading',
  verify: 'Verifying checksum…',
  unpack: 'Unpacking…',
  import: 'Extracting DME tables…',
  done: 'Done'
}

/** Settings card: import BMW DME measurement data and choose which DME data to use. */
export function BmwDataCard() {
  const settings = useApp((s) => s.settings)!
  const updateSettings = useApp((s) => s.updateSettings)
  const toast = useApp((s) => s.toast)
  const status = useApp((s) => s.status)
  const [summary, setSummary] = useState<BmwDataSummary | null | undefined>(undefined)
  const [progress, setProgress] = useState<BmwDataProgress | null>(null)
  const [showTable, setShowTable] = useState(false)

  useEffect(() => {
    void api.bmwDataStatus().then(setSummary)
    return api.onBmwDataProgress(setProgress)
  }, [])

  const run = async (job: () => Promise<BmwDataSummary | null>): Promise<void> => {
    setProgress({ phase: 'release' })
    try {
      const result = await job()
      if (result) {
        setSummary(result)
        const count = result.dmes.reduce((n, d) => n + d.measurements, 0)
        toast(`Imported ${result.dmes.length} engine ECUs · ${count.toLocaleString()} measurements`, 'success')
      }
    } catch (err) {
      toast(`Import failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setProgress(null)
    }
  }

  const busy = progress !== null
  const pct = progress?.phase === 'download' && progress.total ? Math.round(((progress.received ?? 0) / progress.total) * 100) : null
  const total = summary ? summary.dmes.reduce((n, d) => n + d.measurements, 0) : 0

  return (
    <section className="card">
      <h3 className="card-title">
        <span className="row">
          <DatabaseIcon size={17} /> BMW DME data
        </span>
      </h3>
      <div className="help-text" style={{ marginBottom: 8 }}>
        Without this, real cars only report generic OBD-II channels. BMW&apos;s own DME measurement tables add boost target, wastegate, rail
        pressure, lambda, per-cylinder timing and knock, VANOS and hundreds more for B38/B48/B58, S58, S55, N55, N20, N54, N63 and S63 engines.
        They come from BMW diagnostic files decoded by the open-source{' '}
        <a href="https://github.com/gediz/bmw-unified-db" target="_blank" rel="noreferrer">
          bmw-unified-db
        </a>{' '}
        project. The data is BMW-copyrighted, so Boostline downloads it to your device instead of shipping it.{' '}
        <a href={LINKS.bmwDataGuide} target="_blank" rel="noreferrer">
          Step-by-step guide
        </a>
      </div>

      {summary === undefined ? null : summary ? (
        <>
          <div className="setting-row">
            <div>
              <div>Imported data</div>
              <div className="desc">
                {summary.source} · {new Date(summary.importedAt).toLocaleDateString()} · {summary.dmes.length} engine ECUs · {total.toLocaleString()}{' '}
                measurements
              </div>
            </div>
            <button className="btn sm" onClick={() => setShowTable(!showTable)}>
              {showTable ? 'Hide' : 'Show'} list
            </button>
          </div>
          {showTable && (
            <div style={{ maxHeight: 260, overflowY: 'auto', margin: '4px 0 8px' }}>
              <table className="cal-table">
                <thead>
                  <tr>
                    <th>DME data</th>
                    <th>Engines</th>
                    <th>Chassis</th>
                    <th>Channels</th>
                    <th>Auto</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.dmes.map((d) => (
                    <tr key={d.sgbd} title={d.name}>
                      <td className="mono">{d.sgbd}</td>
                      <td>{d.engines.join(', ') || '—'}</td>
                      <td>{d.chassis.join(', ') || '—'}</td>
                      <td>{d.measurements}</td>
                      <td>{d.autoDetect ? 'yes' : 'manual'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="setting-row">
            <div>
              <div>DME selection</div>
              <div className="desc">
                Auto picks the data matching the ID the DME reports (F150). If it finds nothing, pick one here. Applies on the next connect.
                {status.ecu?.sgbdIndex && (
                  <>
                    {' '}
                    The connected DME reports <span className="mono">{status.ecu.sgbdIndex}</span>
                    {status.ecu.dmeData ? ` → ${status.ecu.dmeData}` : ' (no match)'}.
                  </>
                )}
              </div>
            </div>
            <select className="select control" value={settings.bmwDme} onChange={(e) => updateSettings({ bmwDme: e.target.value })}>
              <option value="auto">Auto (recommended)</option>
              <option value="off">Off (OBD-II only)</option>
              {summary.dmes.map((d) => (
                <option key={d.sgbd} value={d.sgbd}>
                  {d.sgbd} · {d.engines.join('/') || d.name}
                </option>
              ))}
            </select>
          </div>
        </>
      ) : (
        <div className="setting-row">
          <div>
            <div>No DME data imported</div>
            <div className="desc">Download it once (about 130 MB; only a few MB are kept), or import a bmw.sqlite you already have.</div>
          </div>
        </div>
      )}

      <div className="row wrap" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={busy} onClick={() => run(() => api.bmwDataDownload())}>
          {busy ? <SpinnerIcon size={15} className="spin" /> : <DownloadIcon size={15} />} {summary ? 'Update from GitHub' : 'Download & import'}
        </button>
        <button className="btn" disabled={busy} onClick={() => run(() => api.bmwDataImportFile())}>
          <FolderIcon size={15} /> Import file…
        </button>
        {summary && (
          <button
            className="btn ghost"
            disabled={busy}
            onClick={async () => {
              await api.bmwDataClear()
              setSummary(null)
            }}
          >
            <TrashIcon size={15} /> Remove
          </button>
        )}
        {progress && (
          <span className="muted small">
            {PHASE[progress.phase]}
            {pct !== null && ` ${pct}% · ${fmtBytes(progress.received ?? 0)} of ${fmtBytes(progress.total ?? 0)}`}
          </span>
        )}
      </div>
    </section>
  )
}
