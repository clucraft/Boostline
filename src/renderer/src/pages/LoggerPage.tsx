import { useState } from 'react'
import { useApp } from '../store'
import { ChannelSidebar } from '../logger/ChannelSidebar'
import { LiveDataPanel } from '../logger/LiveDataPanel'
import { LogViewer } from '../logviewer/LogViewer'

export function LoggerPage() {
  const [expanded, setExpanded] = useState(false)
  const settings = useApp((s) => s.settings)!
  return (
    <main className="page">
      {!expanded && <ChannelSidebar />}
      <div className="content">
        {!expanded && <LiveDataPanel channelIds={settings.liveChannels} />}
        <LogViewer expanded={expanded} onToggleExpand={() => setExpanded(!expanded)} />
      </div>
    </main>
  )
}
