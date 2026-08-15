import { useEffect, useMemo, useState } from 'react'
import { listKeys, getUsage } from './portalClient.js'
import { toDevelopersPresentation } from '../secondary/secondaryRouteAdapters.js'
import { MoneyFigure, StatusNotice, TechnicalDetails } from '../components/pocket/Primitives.jsx'
import { NetworkRoute } from '../components/pocket/NetworkIdentity.jsx'
import { NETWORK_IDS } from '../design/networks.js'
import './Developers.css'

const SOURCE = 'Portal API'
const STALE_AFTER_MS = 120000
const STATES_WITH_ROWS = ['current', 'confirmed', 'stale', 'partial']

const NETWORK_CONTEXT = Object.freeze({
  hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
  sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
  destinationNetworkId: NETWORK_IDS.STELLAR_TESTNET,
  custodyNetworkId: NETWORK_IDS.STELLAR_TESTNET,
  transitState: 'none',
})

const factFor = (state, value = null, overrides = {}) => ({
  state,
  value,
  source: SOURCE,
  checkedAt: new Date().toISOString(),
  staleAfterMs: STALE_AFTER_MS,
  ...overrides,
})

const loadingRead = () => ({
  fact: factFor('loading', null, { checkedAt: null }),
  facts: {
    usage: factFor('loading', null, { checkedAt: null }),
    cap: factFor('loading', null, { checkedAt: null }),
  },
})

const sourceOf = (read) => {
  if (!read || typeof read !== 'object') return {}
  if (read.readResult && typeof read.readResult === 'object') return read.readResult
  return read
}

const readInputOf = ({ developersRead, usageRead, read }) =>
  developersRead ?? usageRead ?? read ?? null

const keysOf = (source) => (Array.isArray(source.keys) ? source.keys : [])

const dataOf = (source) => {
  if (source.data && typeof source.data === 'object') return source.data
  if (source.usage && !Array.isArray(source.usage)) return source.usage
  return {
    usage: Array.isArray(source.usage) ? source.usage : [],
    cap: source.cap,
    sinceDay: source.sinceDay,
  }
}

const canonicalCap = (value) => {
  if (value && typeof value === 'object') {
    if (
      typeof value.token === 'string' &&
      typeof value.units === 'string' &&
      /^[0-9]+$/.test(value.units) &&
      Number.isInteger(value.decimals) &&
      value.decimals >= 0
    ) {
      return { token: value.token, units: value.units, decimals: value.decimals }
    }
    return null
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return { token: 'requests', units: String(value), decimals: 0 }
  }
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    return { token: 'requests', units: value, decimals: 0 }
  }
  return null
}

const factForPrimitive = (view) => ({
  ...view.fact,
  consequence: view.notice?.consequence ?? view.fact.consequence,
  safeNextAction: view.notice?.nextAction ?? view.fact.safeNextAction,
})

function readForUsage(state, keys, data) {
  const cap = canonicalCap(data?.cap)
  return {
    fact: factFor(state),
    facts: {
      usage: factFor(state),
      cap: factFor(state, cap),
    },
    keys,
    usage: data,
  }
}

const fmtDay = (d) => d // YYYY-MM-DD is already the document-grade format

export default function UsageSection({ session, developersRead, usageRead, read, previousRead }) {
  const injectedRead = readInputOf({ developersRead, usageRead, read })
  const injectedSource = sourceOf(injectedRead)
  const [keys, setKeys] = useState(() => keysOf(injectedSource))
  const [data, setData] = useState(() => (injectedRead ? dataOf(injectedSource) : null))
  const [settledRead, setSettledRead] = useState(loadingRead)
  const [error, setError] = useState('')
  const [keyFilter, setKeyFilter] = useState('all')

  useEffect(() => {
    if (!session?.jwt || injectedRead) return undefined
    let on = true
    Promise.all([listKeys(session.jwt), getUsage(session.jwt)])
      .then(([k, u]) => {
        if (!on || injectedRead) return
        setKeys(k)
        setData(u)
        setError('')
        setSettledRead(readForUsage('current', k, u))
      })
      .catch((e) => {
        if (!on || injectedRead) return
        setError(e.message)
        setSettledRead(readForUsage('error', [], null))
      })
    return () => {
      on = false
    }
  }, [session?.jwt, injectedRead])

  const source = sourceOf(injectedRead ?? settledRead)
  const presentation = toDevelopersPresentation(
    injectedRead ?? settledRead,
    injectedRead?.previousRead ?? previousRead
  )
  const view = presentation.facts?.usage || presentation
  const capView = presentation.facts?.cap || presentation
  const fact = view.fact
  const statusFact = factForPrimitive(view)
  const displayedKeys = keys
  const displayedData = data
  const rows = useMemo(() => {
    if (
      !displayedData ||
      !Array.isArray(displayedData.usage) ||
      !STATES_WITH_ROWS.includes(fact.state)
    ) {
      return []
    }
    return keyFilter === 'all'
      ? displayedData.usage
      : displayedData.usage.filter((r) => r.key_id === keyFilter)
  }, [displayedData, fact.state, keyFilter])

  const hintOf = useMemo(() => {
    const map = new Map(displayedKeys.map((k) => [k.id, k.key_hint]))
    return (id) => map.get(id) || id
  }, [displayedKeys])

  const today = new Date().toISOString().slice(0, 10)
  const todayTotal = rows
    .filter((r) => r.day === today)
    .reduce((n, r) => n + (Number(r.count) || 0), 0)
  const rawCap = displayedData?.cap ?? capView.value
  const capAmount = canonicalCap(rawCap)
  const visibleError = injectedRead ? source.error || source.errors || '' : error
  const showMetrics =
    STATES_WITH_ROWS.includes(fact.state) &&
    (source.usage != null || source.cap != null || source.keys != null || source.data != null)

  return (
    <div
      className="card developers-section"
      data-fact-state={fact.state}
      aria-busy={fact.state === 'loading' ? 'true' : undefined}
    >
      <div className="eyebrow">
        <span>Developers</span>
        <span>Usage</span>
      </div>
      <h1 className="h-display" data-route-heading>
        Usage
      </h1>
      <NetworkRoute compact context={NETWORK_CONTEXT} />
      <p className="lede">
        Daily request counts per endpoint, aggregated from the gateway log. Per-key limit is
        enforced per minute; all keys share a global daily budget.
      </p>

      {visibleError && typeof visibleError === 'string' && (
        <p role="alert" className="mono developers-error">
          {visibleError}
        </p>
      )}

      <section className="developers-evidence" aria-label="Usage read">
        <StatusNotice fact={statusFact} title="Usage read" />
        {fact.state === 'unavailable' && presentation.notice?.consequence && (
          <div className="developers-notice-copy" role="note">
            <p>{presentation.notice.consequence}</p>
            {presentation.notice.nextAction && <p>{presentation.notice.nextAction}</p>}
          </div>
        )}
        <TechnicalDetails summary="Technical details" fact={statusFact} open />
      </section>

      {showMetrics && (
        <div className="flex developers-usage-figures">
          <div>
            <span className="developers-money-label">Requests today</span>
            <span className="figure-md mono tnum">{todayTotal}</span>
            <p className="annot faint">Budget shown in the daily cap figure.</p>
          </div>
          <div>
            <span className="developers-money-label">Daily cap</span>
            <MoneyFigure
              state={capView.fact.state}
              amount={capAmount}
              freshness={capView.freshness}
              className="developers-cap"
            />
            <p className="annot faint">Requests per shared daily budget.</p>
          </div>
          <div>
            <span className="figure-md mono tnum">
              {keyFilter === 'all'
                ? displayedKeys.filter((k) => k.enabled).length
                : (displayedKeys.find((k) => k.id === keyFilter)?.rate_limit ?? 60)}
            </span>
            <p className="annot faint">
              {keyFilter === 'all' ? 'Active keys' : 'Requests/minute limit'}
            </p>
          </div>
        </div>
      )}

      <div role="tablist" aria-label="Filter by key" className="flex developers-filter-tabs">
        {[{ id: 'all', key_hint: 'All keys' }, ...displayedKeys].map((k) => (
          <button
            key={k.id}
            type="button"
            role="tab"
            aria-selected={keyFilter === k.id}
            className="btn btn-ghost"
            onClick={() => setKeyFilter(k.id)}
          >
            {k.key_hint}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="mono faint developers-empty">
          No requests since {displayedData?.sinceDay || 'the available window'}. Call the API with a
          key to see usage here.
        </p>
      ) : (
        <div className="perm-doc developers-usage-table">
          <div className="perm-doc-row developers-usage-row developers-usage-row--head">
            <span className="perm-doc-k">Day</span>
            <span className="perm-doc-k">Endpoint</span>
            <span className="perm-doc-k">Key</span>
            <span className="perm-doc-k developers-usage-count">Requests</span>
          </div>
          {rows.map((r) => (
            <div
              className="perm-doc-row developers-usage-row"
              key={`${r.key_id}|${r.day}|${r.endpoint}`}
            >
              <span className="perm-doc-v annot">{fmtDay(r.day)}</span>
              <span className="perm-doc-v">{r.endpoint}</span>
              <span className="perm-doc-v annot">{hintOf(r.key_id)}</span>
              <span className="perm-doc-v mono tnum developers-usage-count">{r.count}</span>
            </div>
          ))}
        </div>
      )}

      <p className="foot-note developers-footnote">
        Only aggregates are stored; per-request telemetry is not. The window covers the last 30
        days.
      </p>
    </div>
  )
}
