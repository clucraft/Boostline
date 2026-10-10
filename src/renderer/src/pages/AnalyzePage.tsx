import { useEffect, useMemo, useState } from 'react'
import type { LogData } from '@shared/types'
import type { FileEntry } from '@shared/ipc'
import { api, useApp } from '../store'
import { fmtBytes } from '../lib/format'
import { FolderIcon, RefreshIcon, SearchIcon } from '../components/icons'
import { LogViewer, type OpenRequest } from '../logviewer/LogViewer'

const dayLabel = (ms: number): string => {
  const d = new Date(ms)
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
}
const timeLabel = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** Log library (recorded logs in the data folder) next to the log viewer. */
export function AnalyzePage({ active }: { active: boolean }) {
  const recording = useApp((s) => !!s.status.recording)
  const dataDir = useApp((s) => s.settings?.dataDir)
  const toast = useApp((s) => s.toast)
  const [logs, setLogs] = useState<FileEntry[]>([])
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [request, setRequest] = useState<OpenRequest | null>(null)
  const [current, setCurrent] = useState<LogData | null>(null)

  const refresh = (): void => void api.listLogs().then(setLogs)
  // Refresh when the page is shown, after a capture finishes and when the data folder moves.
  useEffect(() => {
    if (active) refresh()
  }, [active, recording, dataDir])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out: { day: string; items: FileEntry[] }[] = []
    for (const l of [...logs].sort((a, b) => b.mtime - a.mtime)) {
      if (q && !l.name.toLowerCase().includes(q)) continue
      const day = dayLabel(l.mtime)
      if (out[out.length - 1]?.day !== day) out.push({ day, items: [] })
      out[out.length - 1].items.push(l)
    }
    return out
  }, [logs, query])

  const open = async (entry: FileEntry): Promise<void> => {
    try {
      setRequest({ file: await api.readFile(entry.path), nonce: Date.now() })
    } catch (err) {
      toast(`Could not open ${entry.name}: ${String(err)}`, 'error')
    }
  }

  return (
    <div className="page">
      <div className="page-toolbar">
        <h1>Analyze</h1>
        <span className="sub">Graphs, WOT pulls and heatmaps for recorded logs</span>
      </div>
      <div className="page-body">
        {!expanded && (
          <section className="card library">
            <h3 className="card-title">
              <span>
                Logs <span className="count-badge">{logs.length}</span>
              </span>
              <span className="row" style={{ gap: 2 }}>
                <button className="icon-btn" onClick={refresh} title="Refresh">
                  <RefreshIcon size={15} />
                </button>
                <button className="icon-btn" onClick={() => api.openDataDir()} title="Show the data folder">
                  <FolderIcon size={15} />
                </button>
              </span>
            </h3>
            <div className="search-input">
              <SearchIcon size={15} />
              <input className="input" placeholder="Search logs" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="library-list">
              {groups.map((g) => (
                <div key={g.day}>
                  <div className="library-day">{g.day}</div>
                  {g.items.map((l) => (
                    <div
                      key={l.path}
                      className={`library-item ${current?.path === l.path ? 'active' : ''}`}
                      onClick={() => void open(l)}
                      title={l.path}
                    >
                      <span className="title">{l.name.replace(/\.csv$/i, '')}</span>
                      <span className="meta">
                        {timeLabel(l.mtime)} · {fmtBytes(l.size)}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
              {!groups.length && (
                <div className="muted small" style={{ padding: '14px 10px', lineHeight: 1.6 }}>
                  {query ? `No logs match “${query}”.` : 'No logs yet. Use Start capture in the top bar while connected, or open a file.'}
                </div>
              )}
            </div>
          </section>
        )}
        <LogViewer mode="log" expanded={expanded} onToggleExpand={() => setExpanded(!expanded)} openRequest={request} onLogChange={setCurrent} />
      </div>
    </div>
  )
}
