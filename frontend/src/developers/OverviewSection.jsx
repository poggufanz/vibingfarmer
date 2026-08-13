import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listKeys, getUsage } from './portalClient.js'
import { toDevelopersPresentation } from '../secondary/secondaryRouteAdapters.js'
import { StatusNotice, TechnicalDetails } from '../components/pocket/Primitives.jsx'
import { NetworkRoute } from '../components/pocket/NetworkIdentity.jsx'
import { NETWORK_IDS } from '../design/networks.js'
import './Developers.css'

const SOURCE = 'Portal API'
const STALE_AFTER_MS = 120000

const NETWORK_CONTEXT = Object.freeze({
  hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
  sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
  destinationNetworkId: NETWORK_IDS.STELLAR_TESTNET,
  custodyNetworkId: NETWORK_IDS.STELLAR_TESTNET,
  transitState: 'none',
})

const loadingFact = () => ({
  state: 'loading',
  value: null,
  source: SOURCE,
  checkedAt: null,
  staleAfterMs: STALE_AFTER_MS,
})

const settledFact = (state, value = null, overrides = {}) => ({
  state,
  value,
  source: SOURCE,
  checkedAt: new Date().toISOString(),
  staleAfterMs: STALE_AFTER_MS,
  ...overrides,
})

const sourceOf = (read) => {
  if (!read || typeof read !== 'object') return {}
  if (read.readResult && typeof read.readResult === 'object') return read.readResult
  return read
}

const readInputOf = ({ developersRead, overviewRead, read }) =>
  developersRead ?? overviewRead ?? read ?? null

const statsOf = (read) => {
  const source = sourceOf(read)
  if (source.stats && typeof source.stats === 'object') return source.stats
  const keys = Array.isArray(source.keys) ? source.keys : []
  const usage = Array.isArray(source.usage?.usage)
    ? source.usage.usage
    : Array.isArray(source.usage)
      ? source.usage
      : []
  const today = new Date().toISOString().slice(0, 10)
  if (!Array.isArray(source.keys) && !source.usage) return null
  return {
    activeKeys: keys.filter((k) => k.enabled).length,
    today: usage.filter((r) => r.day === today).reduce((n, r) => n + (Number(r.count) || 0), 0),
  }
}

const factForPrimitive = (view) => ({
  ...view.fact,
  consequence: view.notice?.consequence ?? view.fact.consequence,
  safeNextAction: view.notice?.nextAction ?? view.fact.safeNextAction,
})

export default function OverviewSection({
  session,
  developersRead,
  overviewRead,
  read,
  previousRead,
}) {
  const injectedRead = readInputOf({ developersRead, overviewRead, read })
  const [stats, setStats] = useState(() => statsOf(injectedRead)) // { activeKeys, today }
  const [settledRead, setSettledRead] = useState(() => ({ fact: loadingFact() }))

  useEffect(() => {
    if (!session || injectedRead) return
    let on = true
    Promise.all([listKeys(session.jwt), getUsage(session.jwt)])
      .then(([keys, u]) => {
        if (!on) return
        const today = new Date().toISOString().slice(0, 10)
        const nextStats = {
          activeKeys: keys.filter((k) => k.enabled).length,
          today: u.usage.filter((r) => r.day === today).reduce((n, r) => n + r.count, 0),
        }
        setStats(nextStats)
        setSettledRead({
          fact: settledFact('current'),
          facts: { overview: settledFact('current') },
          stats: nextStats,
          keys,
          usage: u,
        })
      })
      .catch((error) => {
        if (!on) return
        setStats(null) // stats are decorative — welcome still renders
        setSettledRead({
          fact: settledFact('error', null, { error: error?.message || 'Portal read failed' }),
          facts: { overview: settledFact('error') },
        })
      })
    return () => {
      on = false
    }
  }, [session, injectedRead])

  const presentation = toDevelopersPresentation(
    injectedRead ?? settledRead,
    injectedRead?.previousRead ?? previousRead
  )
  const fact = presentation.facts?.overview?.fact
    ? presentation.facts.overview.fact
    : presentation.fact
  const view = presentation.facts?.overview || presentation
  const statusFact = factForPrimitive(view)
  const displayedStats = statsOf(injectedRead) ?? stats
  const showEvidence = Boolean(session || injectedRead)

  return (
    <div
      className="card developers-section"
      data-fact-state={fact.state}
      aria-busy={fact.state === 'loading' ? 'true' : undefined}
    >
      <div className="eyebrow">
        <span>Developers</span>
        <span>Overview</span>
      </div>
      <h1 className="h-display" data-route-heading>
        Welcome to the Vibing Farmer API
      </h1>
      <NetworkRoute compact context={NETWORK_CONTEXT} />
      <p className="lede">
        One <span className="mono">vf_</span> key gives your bot the full pipeline: AI strategy,
        risk scan, unsigned transaction build, and submit via the fee-bump relay. Server secrets
        stay on VF; signing stays on your side.
      </p>

      {showEvidence && (
        <section className="developers-evidence" aria-label="Developer portal read">
          <StatusNotice fact={statusFact} title="Developer portal read" />
          {fact.state === 'unavailable' && presentation.notice?.consequence && (
            <div className="developers-notice-copy" role="note">
              <p>{presentation.notice.consequence}</p>
              {presentation.notice.nextAction && <p>{presentation.notice.nextAction}</p>}
            </div>
          )}
          <TechnicalDetails summary="Technical details" fact={statusFact} open />
        </section>
      )}

      {session &&
        displayedStats &&
        ['current', 'confirmed', 'stale', 'partial'].includes(fact.state) && (
          <div className="flex" style={{ gap: 48, marginTop: 28 }}>
            <div>
              <span className="figure-md mono tnum">{displayedStats.activeKeys}</span>
              <p className="annot faint" style={{ marginTop: 4 }}>
                Active keys
              </p>
            </div>
            <div>
              <span className="figure-md mono tnum">{displayedStats.today}</span>
              <p className="annot faint" style={{ marginTop: 4 }}>
                Requests today
              </p>
            </div>
          </div>
        )}

      <div className="action-row" style={{ marginTop: 32 }}>
        <Link className="btn btn-primary btn-lg" to="/developers/keys">
          Create API key
        </Link>
        <Link className="btn btn-ghost btn-lg" to="/developers/docs">
          View documentation
        </Link>
      </div>

      <p className="foot-note" style={{ marginTop: 24 }}>
        Pipeline: <span className="mono">{'strategy > scan > build-tx > simulate > submit'}</span>.
        Signing stays client-side on testnet.
      </p>
    </div>
  )
}
