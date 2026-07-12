// frontend/src/components/console/MonitorZone.jsx
// Observe-only heartbeat. EKG from the (already localStorage-persistent) cycle journal.
import { useEffect, useState } from 'react'
import ZoneFrame from './ZoneFrame.jsx'
import Ekg from './instruments/Ekg.jsx'
import { remainText } from './consoleUtils.js'

export default function MonitorZone({ running, rows = [], summary = null, phase, nextTickAt, heartbeatMs }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const cycling = Boolean(phase && phase !== 'sleep')
  const remaining = running && nextTickAt ? Math.max(0, nextTickAt - now) : null
  let consecutiveOk = 0
  for (const r of rows) {
    if (r.verdict === 'keep') consecutiveOk += 1
    else break
  }

  return (
    <ZoneFrame
      title="monitor loop"
      hue="info"
      led={!running ? 'idle' : cycling ? 'warn' : 'ok'}
      className="console-monitor"
      meta={<span className="con-chip">observe-only</span>}
    >
      <Ekg rows={rows} running={running} />
      <div className="instrument-caption">
        {running
          ? cycling
            ? `cycle running · ${phase}`
            : remaining != null
              ? `next check ${remainText(remaining)}`
              : 'awaiting first heartbeat'
          : 'loop stopped'}
      </div>
      <div className="mon-vitals">
        <div className="mon-vital">
          <span className="mon-num tnum">{summary?.total ?? 0}</span>
          <span className="mon-label mono">cycles</span>
        </div>
        <div className="mon-vital">
          <span className="mon-num tnum">{consecutiveOk}</span>
          <span className="mon-label mono">consecutive ok</span>
        </div>
        <div className="mon-vital">
          <span className="mon-num tnum">{heartbeatMs ? Math.round(heartbeatMs / 60_000) : '--'}</span>
          <span className="mon-label mono">interval · min</span>
        </div>
      </div>
    </ZoneFrame>
  )
}
