import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listKeys, getUsage } from './portalClient.js'

export default function OverviewSection({ session }) {
  const [stats, setStats] = useState(null) // { activeKeys, today }

  useEffect(() => {
    if (!session) return
    let on = true
    Promise.all([listKeys(session.jwt), getUsage(session.jwt)])
      .then(([keys, u]) => {
        if (!on) return
        const today = new Date().toISOString().slice(0, 10)
        setStats({
          activeKeys: keys.filter((k) => k.enabled).length,
          today: u.usage.filter((r) => r.day === today).reduce((n, r) => n + r.count, 0),
        })
      })
      .catch(() => on && setStats(null)) // stats are decorative — welcome still renders
    return () => {
      on = false
    }
  }, [session])

  return (
    <div className="card">
      <div className="eyebrow">
        <span>developers</span>
        <span>·</span>
        <span>overview</span>
      </div>
      <h1 className="h-display">Welcome to the Vibing Farmer API</h1>
      <p className="lede">
        One <span className="mono">vf_</span> key gives your bot the full pipeline — AI strategy,
        risk scan, unsigned transaction build, and gasless submit via the fee-bump relay. Server
        secrets stay on VF; signing stays on your side.
      </p>

      {session && stats && (
        <div className="flex" style={{ gap: 48, marginTop: 28 }}>
          <div>
            <span className="figure-md mono tnum">{stats.activeKeys}</span>
            <p className="annot faint" style={{ marginTop: 4 }}>active keys</p>
          </div>
          <div>
            <span className="figure-md mono tnum">{stats.today}</span>
            <p className="annot faint" style={{ marginTop: 4 }}>requests today</p>
          </div>
        </div>
      )}

      <div className="action-row" style={{ marginTop: 32 }}>
        <Link className="btn btn-primary btn-lg" to="../keys" relative="path">
          Create API key
        </Link>
        <Link className="btn btn-ghost btn-lg" to="../docs" relative="path">
          View documentation
        </Link>
      </div>

      <p className="foot-note" style={{ marginTop: 24 }}>
        Pipeline: <span className="mono">strategy → scan → build-tx → simulate → submit</span> ·
        non-custodial · testnet
      </p>
    </div>
  )
}
