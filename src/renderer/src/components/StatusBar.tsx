import { useEffect, useState } from 'react'
import { useApp } from '../store'
import { fmtDuration } from '../lib/format'

const STATE_LABEL: Record<string, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting',
  connected: 'Connected',
  live: 'Live',
  error: 'Error'
}

export function StatusBar() {
  const status = useApp((s) => s.status)
  const version = useApp((s) => s.info?.version)
  const recording = !!status.recording
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!recording) return
    const id = setInterval(() => setTick((n) => n + 1), 500)
    return () => clearInterval(id)
  }, [recording])

  const parts = [STATE_LABEL[status.state]]
  if (status.adapterLabel && status.state !== 'disconnected') parts.push(status.adapterLabel)
  if (status.state === 'live' && status.sampleRateHz) parts.push(`${status.sampleRateHz.toFixed(1)} Hz`)

  return (
    <footer className="statusbar">
      <div className="row" style={{ gap: 16 }}>
        <span className={`state ${status.state}`}>{parts.join(' · ')}</span>
        {status.state === 'error' && status.error && <span className="muted">{status.error}</span>}
        {status.recording && (
          <span className="rec">
            ● REC {fmtDuration(Math.max(0, Date.now() - status.recording.startedAt))} · {status.recording.samples.toLocaleString()} samples
          </span>
        )}
      </div>
      <div className="right">
        {status.ecu?.dmeData && <span>DME data: {status.ecu.dmeData.split(' · ')[0]}</span>}
        {status.ecu?.softwareVersion && <span>ECU: {status.ecu.softwareVersion}</span>}
        {status.vin && <span>VIN: {status.vin}</span>}
        <span>Boostline v{version ?? '…'}</span>
      </div>
    </footer>
  )
}
