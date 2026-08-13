// OnboardingFlow.jsx
// APY-first onboarding for users who have never connected a wallet.
// Screen 1: value proposition + source-backed vault evidence (no wallet needed).
// Screen 2: how it works (shown after connect, before Step 01).
// Self-fetches DeFiLlama data so the source can be inspected with zero wallet interaction.
import { useState, useEffect } from 'react'
import { YieldLine } from './SignatureMark.jsx'
import { fetchDeFiLlamaVaults } from '../defiLlama.js'
import { fetchApyHistoryBatch } from '../apyHistory.js'
import { VAULT_CATALOG } from '../config.js'
import { NETWORK_IDS } from '../design/networks.js'
import { toOnboardingPresentation } from '../secondary/secondaryRouteAdapters.js'
import { StatusNotice, TechnicalDetails, VenueTruth } from './pocket/Primitives.jsx'
import { NetworkBadge } from './pocket/NetworkIdentity.jsx'
import './OnboardingFlow.css'
import { venueYield } from '../strategy/venueTruth.js'

const WALLET_URL = 'https://www.freighter.app/'
const SEED = VAULT_CATALOG.slice(0, 3).map((v) => ({
  name: v.name,
  protocol: v.protocol,
  apy: v.apy,
  poolId: null,
}))

const DEFI_LLAMA_SOURCE = 'defiLlama'

const unavailableOnboardingFact = () => ({
  state: 'unavailable',
  value: null,
  source: null,
  checkedAt: null,
  staleAfterMs: null,
})

function productionOnboardingRead({ vaults, histories, status }) {
  const sourceVault = Array.isArray(vaults)
    ? vaults.find((vault) => {
        const hasFreshFetch =
          vault?.source === DEFI_LLAMA_SOURCE &&
          typeof vault.dataFetchedAt === 'string' &&
          vault.dataFetchedAt.trim().length > 0
        return hasFreshFetch || venueYield(vault).state === 'live'
      })
    : null

  const nestedYield = sourceVault?.yield
  const liveYield = sourceVault && venueYield(sourceVault).state === 'live' ? nestedYield : null
  const checkedAt = sourceVault?.dataFetchedAt || liveYield?.checkedAt || liveYield?.asOf || null

  const fact =
    status === 'loading'
      ? {
          state: 'loading',
          value: null,
          source: DEFI_LLAMA_SOURCE,
          checkedAt: null,
          staleAfterMs: null,
        }
      : sourceVault
        ? {
            state: 'current',
            value: null,
            source: sourceVault.source || liveYield?.source || DEFI_LLAMA_SOURCE,
            checkedAt,
            staleAfterMs: sourceVault.staleAfterMs ?? null,
          }
        : unavailableOnboardingFact()

  const venue = liveYield
    ? {
        ...sourceVault,
        yield: {
          ...liveYield,
          source: liveYield.source || sourceVault.source || DEFI_LLAMA_SOURCE,
          asOf: liveYield.asOf || checkedAt,
          checkedAt: liveYield.checkedAt || checkedAt,
        },
      }
    : undefined

  return { fact, vaults, histories, venue }
}

const HOW_STEPS = [
  {
    n: '01',
    title: 'The AI strategist proposes a vault for your risk limits.',
    sub: 'The proposal uses current market data and a fail-closed eligibility check.',
  },
  {
    n: '02',
    title: 'You approve one permission with hard limits.',
    sub: 'Max amount and vault are yours to set. Revoke anytime.',
  },
  {
    n: '03',
    title: 'Agents execute within the approved scope.',
    sub: 'Network fee sponsored by fee-bump relay.',
  },
  {
    n: '04',
    title: 'The keeper and risk radar monitor active positions.',
    sub: 'You receive an alert if APY drops or risk rises.',
  },
]

function ValueScreen({ vaults, presentation, onConnect }) {
  const fact = presentation?.fact ?? { state: 'unavailable' }
  const notice = presentation?.notice ?? {}
  const venue = presentation?.venue
  const liveApy =
    venue?.state === 'live'
      ? {
          state: 'live',
          value: venue.apy,
          source: venue.source,
          // VenueTruth snapshots APY metadata as plain display data. Keep numeric ledger
          // timestamps source-backed while adapting them to that primitive's string contract.
          freshness:
            typeof venue.checkedAt === 'number' ? String(venue.checkedAt) : venue.checkedAt,
        }
      : null
  const apyValue = ['current', 'confirmed'].includes(fact.state) && liveApy ? liveApy.value : null
  const statusFact = {
    ...fact,
    consequence: notice.consequence,
    safeNextAction: notice.nextAction,
  }

  return (
    <main className="onb-screen onb-screen--value enter">
      <div className="onb-split">
        <div className="onb-left">
          <div className="brand brand--hero">
            <span>vibing</span>
            <span className="slash">/</span>
            <span className="vibing">farmer</span>
          </div>

          <h1 className="h-display onb-h1">Your USDC can earn yield.</h1>
          <p className="lede onb-sub">
            Set your limits once. Agents deposit into approved vaults. Network fee sponsored by
            fee-bump relay.
          </p>

          <div className="onb-route" aria-label="Onboarding route">
            <NetworkBadge networkId={NETWORK_IDS.STELLAR_TESTNET} />
            <span className="onb-route-copy">
              <strong>Autofarm Vault</strong>
              <span aria-hidden="true">→</span>
              <strong>Blend Capital v2</strong>
            </span>
          </div>

          <button className="btn btn-primary btn-lg onb-cta" onClick={onConnect}>
            Connect wallet
          </button>

          <div className="foot-note onb-foot">
            Already have Freighter / xBull / Albedo? Connect above.
            <br />
            Need a wallet?{' '}
            <a href={WALLET_URL} target="_blank" rel="noopener noreferrer" className="onb-link">
              Install Freighter
            </a>
          </div>
        </div>

        <div className="onb-right">
          <div className="onb-sig">
            <YieldLine height={120} />
          </div>
          <section
            className="onb-evidence"
            aria-label="Autofarm Vault evidence"
            data-fact-state={fact.state}
            data-apy-value={apyValue === null ? 'null' : String(apyValue)}
          >
            <div className="onb-evidence-heading">
              <span>Autofarm Vault</span>
              <span className="onb-evidence-network">Stellar testnet</span>
            </div>
            <div className="onb-evidence-venue">
              <span>Yield venue</span>
              <strong>Blend Capital v2</strong>
            </div>
            <StatusNotice fact={statusFact} title="Vault read" />
            {fact.state === 'unavailable' && notice.consequence && (
              <div className="onb-notice-copy" role="status">
                <p>{notice.consequence}</p>
                {notice.nextAction && <p>{notice.nextAction}</p>}
              </div>
            )}
            <VenueTruth kind="stellar-live" venue="Autofarm Vault" fact={fact} apy={liveApy} />
            <TechnicalDetails summary="Technical details" fact={fact} open />
          </section>
          <div className="onb-vaults" aria-label="Vault catalog">
            {vaults.map((v, i) => {
              return (
                <div key={v.name || i} className="onb-vault-row">
                  <span>{v.name}</span>
                  <span className="onb-vault-row-state">Source-backed read</span>
                </div>
              )
            })}
            {!vaults.length && <div className="onb-vault-empty">No catalog records returned.</div>}
          </div>
        </div>
      </div>
    </main>
  )
}

function HowItWorksScreen({ onDone, onSkip }) {
  return (
    <main className="onb-screen onb-screen--how enter">
      <div className="onb-how-content">
        <h1 className="h-display onb-how-title">How Vibing Farmer works</h1>
        <div className="onb-how-steps">
          {HOW_STEPS.map((s) => (
            <div key={s.n} className="onb-how-step">
              <span className="mono accent onb-how-step-number">{s.n}</span>
              <div>
                <div className="onb-how-step-title">{s.title}</div>
                <div className="lede onb-how-step-sub">{s.sub}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="action-row onb-how-actions">
          <button className="btn btn-ghost" onClick={onSkip}>
            Skip intro
          </button>
          <button className="btn btn-primary btn-lg" onClick={onDone}>
            Continue
          </button>
        </div>
      </div>
    </main>
  )
}

export default function OnboardingFlow({ connected, onConnect, onComplete, onboardingRead }) {
  const [screen, setScreen] = useState(1)
  const [vaults, setVaults] = useState(SEED)
  const [histories, setHistories] = useState({})
  const [readStatus, setReadStatus] = useState('loading')

  // Fetch live vault data on mount — no wallet needed.
  useEffect(() => {
    let alive = true
    fetchDeFiLlamaVaults()
      .then((vs) => {
        if (!alive) return
        if (!Array.isArray(vs) || !vs.length) {
          setReadStatus('unavailable')
          return
        }
        const top = vs.slice(0, 3)
        setVaults(top)
        setReadStatus(
          top.some(
            (vault) =>
              vault?.source === DEFI_LLAMA_SOURCE &&
              typeof vault.dataFetchedAt === 'string' &&
              vault.dataFetchedAt.trim().length > 0
          )
            ? 'current'
            : 'unavailable'
        )
        const ids = top.map((v) => v.poolId).filter(Boolean)
        if (ids.length)
          fetchApyHistoryBatch(ids).then((m) => {
            if (alive) setHistories(m)
          })
      })
      .catch(() => {
        if (alive) setReadStatus('unavailable')
      })
    return () => {
      alive = false
    }
  }, [])

  // Advance to "how it works" once the wallet connects.
  useEffect(() => {
    if (connected && screen === 1) setScreen(2)
  }, [connected, screen])

  const injectedRead = onboardingRead
  const productionRead = productionOnboardingRead({ vaults, histories, status: readStatus })
  const settledRead = injectedRead
    ? {
        ...injectedRead,
        vaults: injectedRead.vaults ?? vaults,
        histories: injectedRead.histories ?? histories,
      }
    : productionRead
  const presentation = toOnboardingPresentation(settledRead)
  const displayVaults = Array.isArray(injectedRead?.vaults) ? injectedRead.vaults : vaults

  if (screen === 1)
    return <ValueScreen vaults={displayVaults} presentation={presentation} onConnect={onConnect} />
  return <HowItWorksScreen onDone={onComplete} onSkip={onComplete} />
}
