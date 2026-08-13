// VaultDetailPage.jsx — canonical vault detail route (/vault/:protocol)
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { VAULT_CATALOG } from '../config.js'
import { fetchDeFiLlamaVaults } from '../defiLlama.js'
import { fetchApyHistory } from '../apyHistory.js'
import { calcApyStats, generateSparkline } from '../sparkline.js'
import { useNavigateTo } from '../router.js'
import { normalizeCoreAmount } from '../core/coreRouteAdapters.js'
import { toVaultPresentation } from '../secondary/secondaryRouteAdapters.js'
import { NETWORK_IDS } from '../design/networks.js'
import { MoneyFigure, StatusNotice, TechnicalDetails, VenueTruth } from './pocket/Primitives.jsx'
import { NetworkRoute } from './pocket/NetworkIdentity.jsx'
import './VaultDetailPage.css'
import { venueYield } from '../strategy/venueTruth.js'

const CANONICAL_VAULT_NAME = 'Autofarm Vault'
const CANONICAL_VENUE_NAME = 'Blend Capital v2'
const STELLAR_ROUTE = Object.freeze({
  hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
  sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
  destinationNetworkId: NETWORK_IDS.STELLAR_TESTNET,
  custodyNetworkId: NETWORK_IDS.STELLAR_TESTNET,
  transitState: 'none',
})
const UNKNOWN_ROUTE = Object.freeze({ transitState: 'unknown' })
const POSITION_DECIMALS = 7

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const hasOwn = (value, key) => isRecord(value) && Object.prototype.hasOwnProperty.call(value, key)
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '')
const timestampValue = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) return value.trim()
  return null
}

const short = (address) => (text(address) ? `${address.slice(0, 10)}…${address.slice(-8)}` : '')

function sourceOf(read) {
  if (!isRecord(read)) return {}
  return isRecord(read.readResult) ? read.readResult : read
}

function factForPrimitive(view) {
  const fact = view?.fact || { state: 'unavailable', value: null }
  return {
    ...fact,
    consequence: view?.notice?.consequence ?? fact.consequence,
    safeNextAction: view?.notice?.nextAction ?? fact.safeNextAction,
  }
}

function unavailableFact() {
  return {
    state: 'unavailable',
    value: null,
    source: null,
    checkedAt: null,
    staleAfterMs: null,
    confirmedLedger: null,
    confirmedBlock: null,
  }
}

function asCanonicalPositionAmount(entry) {
  if (!isRecord(entry)) return null

  const candidate = isRecord(entry.amount)
    ? entry.amount
    : isRecord(entry.value)
      ? entry.value
      : null
  if (candidate) {
    try {
      return normalizeCoreAmount(candidate)
    } catch {
      return null
    }
  }

  const raw = entry.balance ?? entry.units
  const units = typeof raw === 'bigint' ? raw.toString() : raw
  if (typeof units !== 'string' || !/^[0-9]+$/.test(units)) return null

  try {
    return normalizeCoreAmount({
      token: text(entry.token) || 'USDC',
      units,
      decimals: Number.isInteger(entry.decimals) ? entry.decimals : POSITION_DECIMALS,
    })
  } catch {
    return null
  }
}

function findPosition(positions, address) {
  if (!isRecord(positions) || !text(address)) return null
  const wanted = address.toLowerCase()
  const match = Object.entries(positions).find(
    ([candidate]) => typeof candidate === 'string' && candidate.toLowerCase() === wanted
  )
  return match ? match[1] : null
}

function staticCatalogFor(protocol) {
  return VAULT_CATALOG.find((entry) => entry.protocol === protocol) || null
}

function catalogSignalsAreStellar(raw, protocol, canonical) {
  if (!isRecord(raw) || !canonical) return false
  if (Object.keys(raw).length === 0) return false
  if (text(raw.protocol) && raw.protocol !== protocol) return false
  if (text(raw.chain) && !['stellar', 'stellar-testnet'].includes(raw.chain.toLowerCase())) {
    return false
  }
  if (text(raw.networkId) && raw.networkId !== NETWORK_IDS.STELLAR_TESTNET) return false
  if (text(raw.venueKind) && raw.venueKind !== 'stellar-live') return false

  const address = text(raw.address || raw.addr || raw.vaultAddress)
  if (address && (address.startsWith('0x') || address !== canonical.address)) return false

  const networkText = `${text(raw.network)} ${text(raw.networkName)}`.toLowerCase()
  if (networkText.includes('ethereum') || networkText.includes('base')) return false

  const rawName = text(raw.name).toLowerCase()
  return !rawName.includes('aave') && !rawName.includes('ethereum') && !rawName.includes('morpho')
}

function venueSignalsAreStellar(raw) {
  if (!isRecord(raw)) return true
  if (text(raw.chain) && !['stellar', 'stellar-testnet'].includes(raw.chain.toLowerCase())) {
    return false
  }
  if (text(raw.networkId) && raw.networkId !== NETWORK_IDS.STELLAR_TESTNET) return false
  if (text(raw.venueKind) && raw.venueKind !== 'stellar-live') return false

  const address = text(raw.address || raw.addr || raw.vaultAddress)
  if (address.startsWith('0x')) return false

  const rawName =
    `${text(raw.name)} ${text(raw.protocol)} ${text(raw.network)} ${text(raw.networkName)}`.toLowerCase()
  return !rawName.includes('aave') && !rawName.includes('ethereum') && !rawName.includes('morpho')
}

function isCanonicalSource(source, protocol, canonicalCatalog) {
  if (!canonicalCatalog) return false
  if (text(source.protocol) && source.protocol !== protocol) return false
  const hasExplicitCatalog = hasOwn(source, 'catalog') || hasOwn(source, 'vault')
  const explicitCatalog = hasOwn(source, 'catalog') ? source.catalog : source.vault
  if (
    hasExplicitCatalog &&
    !catalogSignalsAreStellar(explicitCatalog, protocol, canonicalCatalog)
  ) {
    return false
  }
  if (hasOwn(source, 'venue')) {
    if (!venueSignalsAreStellar(source.venue)) return false
    if (text(source.venue?.protocol) && source.venue.protocol !== protocol) return false
  }
  return true
}

function liveVenueInput(raw) {
  if (!isRecord(raw)) return undefined
  try {
    if (venueYield(raw).state !== 'live') return undefined
  } catch {
    return undefined
  }
  const sourceYield = raw.yield
  const checkedAt = sourceYield.checkedAt || sourceYield.asOf || raw.dataFetchedAt
  if (!checkedAt) return undefined
  return {
    ...raw,
    yield: {
      ...sourceYield,
      source: text(sourceYield.source) || text(raw.source) || 'DeFiLlama',
      asOf: sourceYield.asOf || checkedAt,
      checkedAt,
    },
  }
}

function fallbackFact(liveData, catalog) {
  if (!catalog) {
    return {
      state: 'rejected',
      value: null,
      source: 'Vault catalog',
      checkedAt: null,
      staleAfterMs: null,
    }
  }

  const venue = liveVenueInput(liveData)
  const checkedAt =
    timestampValue(liveData?.dataFetchedAt) || timestampValue(venue?.yield?.checkedAt)
  return {
    state: liveData && checkedAt ? 'current' : liveData ? 'unavailable' : 'loading',
    value: null,
    source: text(liveData?.source) || 'DeFiLlama',
    checkedAt: checkedAt || null,
    staleAfterMs: null,
  }
}

function fallbackRead({ catalog, liveData, apyStats }) {
  const fact = fallbackFact(liveData, catalog)
  const venue = liveVenueInput(liveData)
  return {
    fact,
    facts: {
      tvl: fact,
      apy: {
        ...fact,
        value: null,
        source: text(liveData?.source) || fact.source,
      },
    },
    catalog,
    venue: venue || (isRecord(liveData?.venue) ? liveVenueInput(liveData.venue) : undefined),
    apyStats: apyStats || undefined,
  }
}

function readFactView(presentation, keys) {
  for (const key of keys) {
    const view = presentation?.facts?.[key]
    if (view?.fact) return view
  }
  return presentation
}

function moneyState(view) {
  const state = view?.fact?.state
  if (state === 'confirmed') return 'current'
  return ['loading', 'current', 'stale', 'empty', 'error', 'unavailable'].includes(state)
    ? state
    : 'unavailable'
}

function yieldEvidence(presentation) {
  const view = readFactView(presentation, ['apy', 'yield', 'apr', 'rate'])
  const state = view?.fact?.state
  const venue = presentation?.venue
  const current = state === 'current' || state === 'confirmed'
  if (!current || venue?.state !== 'live' || !Number.isFinite(venue.apy)) {
    return { view, apy: null }
  }
  return {
    view,
    apy: {
      state: 'live',
      value: venue.apy,
      source: venue.source,
      freshness: venue.checkedAt,
    },
  }
}

function isRenderableHistory(stats) {
  return (
    isRecord(stats) &&
    Array.isArray(stats.values) &&
    stats.values.length > 1 &&
    stats.values.every((value) => typeof value === 'number' && Number.isFinite(value)) &&
    typeof stats.avg7d === 'number' &&
    Number.isFinite(stats.avg7d) &&
    typeof stats.current === 'number' &&
    Number.isFinite(stats.current) &&
    typeof stats.change7d === 'string'
  )
}

function ApyHistory({ stats, source }) {
  if (!isRenderableHistory(stats)) return null
  return (
    <section className="vault-history" aria-labelledby="vault-history-title">
      <div className="vault-history__head">
        <h2 id="vault-history-title">APY history</h2>
        <span>Source: {source || 'Unavailable'}</span>
      </div>
      <span
        className="vault-history__sparkline"
        dangerouslySetInnerHTML={{
          __html: generateSparkline(stats.values, { width: 280, height: 48, strokeWidth: 2 }),
        }}
      />
      <div className="vault-history__labels">
        <span>{stats.values[0].toFixed(1)}%</span>
        <span>{stats.avg7d.toFixed(1)}% average</span>
        <span>{stats.current.toFixed(1)}%</span>
      </div>
    </section>
  )
}

export default function VaultDetailPage({ positions = {}, vaultRead } = {}) {
  const { protocol } = useParams()
  const navigateTo = useNavigateTo()
  const catalogFromConfig = staticCatalogFor(protocol)
  const [liveData, setLiveData] = useState(null)
  const [apyStats, setApyStats] = useState(null)

  useEffect(() => {
    fetchDeFiLlamaVaults()
      .then((vaults) => {
        const match = vaults.find((vault) => vault.protocol === protocol)
        if (match) setLiveData(match)
      })
      .catch(() => {})
  }, [protocol])

  // APY 7d history — fetch once live pool ID is known. Non-blocking, cached.
  useEffect(() => {
    const poolId = liveData?.poolId
    if (!poolId) return undefined
    let alive = true
    fetchApyHistory(poolId).then((history) => {
      if (alive && history) setApyStats(calcApyStats(history))
    })
    return () => {
      alive = false
    }
  }, [liveData?.poolId])

  const injected = vaultRead != null
  const source = sourceOf(vaultRead)
  const hasExplicitCatalog = injected && (hasOwn(source, 'catalog') || hasOwn(source, 'vault'))
  const explicitCatalog = hasOwn(source, 'catalog') ? source.catalog : source.vault
  const rawCatalog = hasExplicitCatalog ? explicitCatalog : catalogFromConfig
  const canonicalCatalog = catalogSignalsAreStellar(rawCatalog, protocol, catalogFromConfig)
    ? catalogFromConfig
    : null
  const canonicalSource = isCanonicalSource(source, protocol, canonicalCatalog)
  const settledRead = injected
    ? vaultRead
    : fallbackRead({ catalog: catalogFromConfig, liveData, apyStats })
  const adapterInput = canonicalSource
    ? settledRead
    : {
        ...settledRead,
        fact: unavailableFact(),
        facts: undefined,
        venue: undefined,
        catalog: null,
      }
  const presentation = toVaultPresentation(adapterInput, source.previousRead)
  const fact = factForPrimitive(presentation)
  const state = presentation.fact?.state || 'unavailable'
  const catalogAvailable = Boolean(canonicalCatalog && canonicalSource)
  const tvlView = readFactView(presentation, ['tvl', 'totalAssets', 'vault', 'assets'])
  const tvlAmount = tvlView?.value || null
  const tvlFigureState = tvlAmount ? moneyState(tvlView) : 'unavailable'
  const yieldView = yieldEvidence(presentation)
  const yieldFact = factForPrimitive(yieldView.view || presentation)
  const displayStats = source.apyStats || apyStats
  const routeContext = catalogAvailable ? STELLAR_ROUTE : UNKNOWN_ROUTE
  const positionEntry = catalogAvailable ? findPosition(positions, canonicalCatalog.address) : null
  const positionAmount = asCanonicalPositionAmount(positionEntry)
  const positionState = positionAmount ? (state === 'stale' ? 'stale' : 'current') : 'unavailable'
  const positionUnits = positionAmount ? Number(positionAmount.units) : NaN
  const positionValue = Number.isFinite(positionUnits)
    ? positionUnits / 10 ** positionAmount.decimals
    : null
  const dailyEstimate =
    yieldView.apy && positionValue !== null
      ? ((positionValue * Number(yieldView.apy.value)) / 100 / 365).toFixed(4)
      : null

  const handleBack = () => {
    if (window.history.length > 1) window.history.back()
    else navigateTo('home')
  }

  const handleFarm = () => {
    if (!catalogAvailable) return
    sessionStorage.setItem('yv_prefill_protocol', protocol)
    sessionStorage.setItem('yv_prefill_name', text(catalogFromConfig.name) || CANONICAL_VAULT_NAME)
    if (yieldView.apy) sessionStorage.setItem('yv_prefill_apy', String(yieldView.apy.value))
    else sessionStorage.removeItem('yv_prefill_apy')
    navigateTo('strategy')
  }

  const handleWithdraw = () => navigateTo('agent')
  const statusTitle =
    state === 'loading'
      ? 'Checking vault read'
      : state === 'error'
        ? 'Vault read failed'
        : catalogAvailable
          ? 'Vault status'
          : 'Vault unavailable'

  return (
    <main
      className="vault-page"
      data-fact-state={state}
      aria-busy={state === 'loading' ? 'true' : undefined}
    >
      <header className="vault-header">
        <button className="vault-back" type="button" onClick={handleBack}>
          Back to vaults
        </button>
        <p className="vault-protocol">{catalogAvailable ? protocol : 'Vault read'}</p>
        <h1>{catalogAvailable ? CANONICAL_VAULT_NAME : 'Vault details'}</h1>
        {catalogAvailable && (
          <p className="vault-description">
            Source-backed deposits supply USDC from the Autofarm Vault into Blend Capital v2 on
            Stellar testnet.
          </p>
        )}
      </header>

      <section className="vault-route" aria-label="Vault route">
        <NetworkRoute context={routeContext} />
        {catalogAvailable && (
          <p className="vault-route__venue">Yield venue: {CANONICAL_VENUE_NAME}</p>
        )}
      </section>

      <section className="vault-evidence" aria-label="Vault evidence" data-fact-state={state}>
        <StatusNotice fact={fact} title={statusTitle} />
        <VenueTruth
          kind={catalogAvailable ? 'stellar-live' : 'unknown'}
          venue={CANONICAL_VAULT_NAME}
          fact={yieldFact}
          apy={yieldView.apy}
        />
        <TechnicalDetails summary="Technical details" fact={fact} />
      </section>

      <section className="vault-metrics" aria-label="Vault metrics">
        <div className="vault-metric">
          <span className="vault-metric__label">Vault value</span>
          <MoneyFigure state={tvlFigureState} amount={tvlAmount} freshness={tvlView?.freshness} />
        </div>
        <div className="vault-metric">
          <span className="vault-metric__label">Current rate</span>
          {yieldView.apy ? (
            <span className="vault-rate">{yieldView.apy.value}% APY</span>
          ) : (
            <span className="vault-rate vault-rate--unavailable">Unavailable</span>
          )}
        </div>
      </section>

      {catalogAvailable && (
        <section className="vault-profile" aria-labelledby="vault-profile-title">
          <h2 id="vault-profile-title">Risk profile</h2>
          <p>
            <strong>{text(catalogFromConfig.risk) || 'Unavailable'}</strong>{' '}
            {text(catalogFromConfig.description) || 'Vault description unavailable.'}
          </p>
        </section>
      )}

      {positionAmount && catalogAvailable && yieldView.apy && (
        <section className="vault-position" aria-labelledby="vault-position-title">
          <div>
            <h2 id="vault-position-title">Your position</h2>
            <MoneyFigure state={positionState} amount={positionAmount} />
            {dailyEstimate !== null && (
              <p className="vault-position__estimate">+{dailyEstimate} USDC/day estimated</p>
            )}
          </div>
          <button className="vault-secondary-action" type="button" onClick={handleWithdraw}>
            Withdraw
          </button>
        </section>
      )}

      {catalogAvailable && (
        <section className="vault-deployment" aria-labelledby="vault-deployment-title">
          <h2 id="vault-deployment-title">Soroban deployment</h2>
          <div className="vault-deployment__row">
            <code title={canonicalCatalog.address}>{short(canonicalCatalog.address)}</code>
            <a
              href={`https://stellar.expert/explorer/testnet/contract/${canonicalCatalog.address}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              View on Stellar Expert
            </a>
          </div>
        </section>
      )}

      {!catalogAvailable && (
        <section className="vault-missing" aria-label="Vault catalog status">
          <h2>Vault not found</h2>
          <p>No verified vault data is available for this route.</p>
        </section>
      )}

      {catalogAvailable && (
        <div className="vault-actions">
          <button className="btn btn-primary" type="button" onClick={handleFarm}>
            Farm this vault
          </button>
        </div>
      )}

      {catalogAvailable && (
        <ApyHistory
          stats={displayStats}
          source={
            yieldView.apy?.source ||
            presentation.facts?.apy?.fact?.source ||
            presentation.fact?.source
          }
        />
      )}
    </main>
  )
}
