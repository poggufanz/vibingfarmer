// ReplayPage.jsx
// Public historical-replay surface for Vibing Farmer. Zero wallet, zero RPC —
// fetches two static JSON files (on-chain ground truth from a pinned mainnet
// fork + a seeded Monte Carlo summary) and renders the Assumptions panel plus
// the manual-vs-agentic outcome range.
//
// Statistical honesty: the manual leg is a Monte Carlo band (P5/P50/P95) over
// reaction-time variance; the agentic leg is ONE deterministic value (first
// block after signal) — no fake distribution for a near-instant action.
//
// Aesthetic: matches ExplorerPage — dark canvas, single accent, mono for raw values only.

import { useEffect, useState } from 'react'
import NavBar from './NavBar.jsx'
import { toDisplay } from '../stellar/format.js'
import { toReplayPresentation } from '../secondary/secondaryRouteAdapters.js'
import { StatusNotice, TechnicalDetails } from './pocket/Primitives.jsx'
import './ReplayPage.css'

const GROUND_URL = '/data/replay-usdc-depeg.json'
const MC_URL = '/data/replay-mc.json'

const fmtWeth = (wei) => `${(Number(wei) / 1e18).toFixed(2)} WETH`
const fmtUsdc = (raw) => `${toDisplay(raw).toLocaleString()} USDC`
const fmtSeed = (seed) => `${seed} (0x${Number(seed).toString(16).toUpperCase()})`

/* ----------------------------- data hook ----------------------------- */

function useReplayData() {
  const [state, setState] = useState({ ground: null, mc: null, error: null })

  useEffect(() => {
    let alive = true
    Promise.all([fetch(GROUND_URL), fetch(MC_URL)])
      .then(([g, m]) => {
        if (!g.ok || !m.ok) throw new Error('Replay data not found')
        return Promise.all([g.json(), m.json()])
      })
      .then(([ground, mc]) => {
        if (alive) setState({ ground, mc, error: null })
      })
      .catch((err) => {
        if (alive) setState({ ground: null, mc: null, error: err.message })
      })
    return () => {
      alive = false
    }
  }, [])

  return state
}

function fallbackReplayRead({ ground, mc, error }) {
  const state = error ? 'error' : ground && mc ? 'current' : ground || mc ? 'partial' : 'loading'
  const checkedAt = ground?.depegDate || mc?.provenance?.depegDate || null

  return {
    ground,
    mc,
    error,
    fact: {
      state,
      value: null,
      source: 'Static replay fixture',
      checkedAt,
      staleAfterMs: null,
    },
  }
}

function payloadSource(read) {
  if (read && typeof read.readResult === 'object' && read.readResult !== null) {
    return read.readResult
  }
  return read && typeof read === 'object' ? read : {}
}

function factForPrimitive(presentation) {
  return {
    ...presentation.fact,
    consequence: presentation.notice?.consequence ?? presentation.fact.consequence,
    safeNextAction: presentation.notice?.nextAction ?? presentation.fact.safeNextAction,
  }
}

function ReplayEvidence({ presentation, ground, mc, error }) {
  const state = presentation.fact.state
  const title =
    state === 'loading'
      ? 'Loading replay payloads'
      : state === 'error'
        ? 'Replay data unavailable'
        : state === 'empty'
          ? 'No replay payloads available'
          : state === 'unavailable'
            ? 'Replay payload unavailable'
            : 'Replay payload status'
  const fact = factForPrimitive(presentation)
  const hasPartialPayload = Boolean(ground) !== Boolean(mc)
  const showPayloadStatus = hasPartialPayload || state === 'partial'

  return (
    <section className="rp-evidence" aria-label="Replay evidence" data-fact-state={state}>
      <StatusNotice fact={fact} title={title}>
        {error && <p>{error}</p>}
        {showPayloadStatus && (
          <div className="rp-payload-status">
            <p>{ground ? 'Ground truth payload loaded.' : 'Ground truth payload unavailable.'}</p>
            <p>{mc ? 'Monte Carlo payload loaded.' : 'Monte Carlo payload unavailable.'}</p>
          </div>
        )}
        {state === 'unavailable' && <p>Do not act on unverified replay evidence.</p>}
        {state === 'error' && (
          <p>
            Generate it via <code>scripts/replay/monteCarlo.ts</code>.
          </p>
        )}
      </StatusNotice>
      <TechnicalDetails summary="Technical details" fact={fact} open />
    </section>
  )
}

/* ----------------------------- bar chart ----------------------------- */

function OutcomeBarChart({ manual, agentic }) {
  const agVal = Number(agentic.deterministic)
  const manP5 = Number(manual.p5)
  const manP50 = Number(manual.p50)
  const manP95 = Number(manual.p95)

  const values = [manP5, manP50, manP95, agVal]
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const range = hi - lo || 1
  const pad = range * 0.15
  const min = lo - pad
  const max = hi + pad

  const getPct = (val) => Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100))

  const agPct = getPct(agVal)
  const manP50Pct = getPct(manP50)
  const manP5Pct = getPct(manP5)
  const manP95Pct = getPct(manP95)

  return (
    <div className="rp-chart-container">
      <div className="rp-chart-row rp-chart-row--agentic">
        <div className="rp-chart-label-col">
          <span className="rp-row-badge rp-row-badge--agentic">AGENTIC</span>
          <span className="rp-row-title">Swarm Execution</span>
          <span className="rp-row-desc">First-block deterministic execution</span>
        </div>
        <div className="rp-chart-bar-col">
          <div className="rp-bar-wrapper">
            <div className="rp-bar rp-bar--agentic" style={{ width: `${agPct}%` }}>
              <span className="rp-bar-val">{fmtWeth(agVal)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="rp-chart-row rp-chart-row--manual">
        <div className="rp-chart-label-col">
          <span className="rp-row-badge rp-row-badge--manual">MANUAL</span>
          <span className="rp-row-title">Human Reaction</span>
          <span className="rp-row-desc">Monte Carlo delay distribution (P50)</span>
        </div>
        <div className="rp-chart-bar-col">
          <div className="rp-bar-wrapper">
            <div className="rp-bar rp-bar--manual" style={{ width: `${manP50Pct}%` }}>
              <span className="rp-bar-val">{fmtWeth(manP50)}</span>
            </div>
          </div>
          <div
            className="rp-bar-whisker"
            style={{
              left: `${manP5Pct}%`,
              width: `${manP95Pct - manP5Pct}%`,
            }}
          >
            <div className="rp-whisker-cap rp-whisker-cap--left" />
            <div className="rp-whisker-cap rp-whisker-cap--right" />
            <span className="rp-whisker-label rp-whisker-label--left">P5 (worst)</span>
            <span className="rp-whisker-label rp-whisker-label--right">P95 (best)</span>
          </div>
        </div>
      </div>

      <div className="rp-chart-axis">
        <span className="rp-axis-tick-val">{fmtWeth(min)}</span>
        <span className="rp-axis-tick-title">WETH Received (Scale Zoomed)</span>
        <span className="rp-axis-tick-val">{fmtWeth(max)}</span>
      </div>
    </div>
  )
}

/* ----------------------------- pieces ----------------------------- */

function ComparisonHero({ manual, agentic }) {
  const manVal = Number(manual.p50) / 1e18
  const agVal = Number(agentic.deterministic) / 1e18
  const delta = agVal - manVal
  const pctDelta = manVal > 0 ? ((delta / manVal) * 100).toFixed(1) : '0.0'
  const isPositive = delta >= 0

  return (
    <div className="rp-compare">
      <div className="rp-hero-card rp-hero-card--manual">
        <div className="rp-hero-tag">
          <span className="rp-hero-dot rp-hero-dot--manual" />
          MANUAL (P50)
        </div>
        <div className="rp-hero-val">{manVal.toFixed(4)}</div>
        <div className="rp-hero-unit">WETH</div>
        <div className="rp-hero-sub">Median across reaction delays</div>
      </div>

      <div className={'rp-delta' + (isPositive ? ' positive' : ' negative')}>
        <span className="rp-delta-val">
          {isPositive ? '+' : ''}
          {delta.toFixed(4)} WETH
        </span>
        <span className="rp-delta-pct">
          {isPositive ? '+' : ''}
          {pctDelta}%
        </span>
        <span className="rp-delta-label">Difference from manual P50</span>
      </div>

      <div className="rp-hero-card rp-hero-card--agentic">
        <div className="rp-hero-tag">
          <span className="rp-hero-dot rp-hero-dot--agentic" />
          AGENTIC
        </div>
        <div className="rp-hero-val">{agVal.toFixed(4)}</div>
        <div className="rp-hero-unit">WETH</div>
        <div className="rp-hero-sub">First block after signal</div>
      </div>
    </div>
  )
}

function StatBlock({ label, value, variant }) {
  return (
    <div className={`rp-stat ${variant || ''}`}>
      <div className="rp-stat__value">{value}</div>
      <div className="rp-stat__label">{label}</div>
    </div>
  )
}

function AssumptionRow({ label, value }) {
  return (
    <div className="rp-arow">
      <span className="rp-arow__k">{label}</span>
      <span className="rp-arow__v">{value}</span>
    </div>
  )
}

/* ------------------------------ page ------------------------------ */

export default function ReplayPage({ replayRead } = {}) {
  const fetchedRead = useReplayData()
  const read = replayRead ?? fallbackReplayRead(fetchedRead)
  const source = payloadSource(read)
  const ground = source.ground ?? null
  const mc = source.mc ?? null
  const error = source.error ?? null
  const presentation = toReplayPresentation(read)
  const state = presentation.fact.state
  const hasBothPayloads = Boolean(ground && mc)
  const canRenderPayload = ['current', 'confirmed', 'stale', 'partial'].includes(state)

  return (
    <div className="rp-page">
      <NavBar />

      <main className="rp-main" aria-busy={state === 'loading' ? 'true' : undefined}>
        <header className="rp-header">
          <div className="rp-header__top">
            <h1 className="rp-title">Historical Replay</h1>
            <span className="rp-net">
              <span className="rp-net__dot" />
              <span>Ethereum mainnet fork</span>
              <span>Static historical replay</span>
              <span>No wallet or RPC execution</span>
            </span>
          </div>
          <p className="rp-lede">
            Ethereum mainnet case study, predating the product's Stellar/Soroban migration: USDC
            depeg, March 11 2023, replayed on a pinned mainnet fork. Real on-chain swaps at five
            reaction delays; illustrates manual-vs-agentic execution speed, not a Stellar demo or a
            prediction.
          </p>
        </header>

        <ReplayEvidence presentation={presentation} ground={ground} mc={mc} error={error} />

        {hasBothPayloads && canRenderPayload && (
          <>
            <section className="rp-section" aria-labelledby="rp-outcome">
              <h2 id="rp-outcome" className="rp-section__title">
                Outcome Range
              </h2>
              <p className="rp-section__sub">
                Swapping {fmtUsdc(ground.amountInUsdc)} for WETH at block{' '}
                {mc.provenance.signalBlock}. Each leg shows what the same swap would have returned
                at a different reaction delay.
              </p>

              <ComparisonHero manual={mc.manual} agentic={mc.agentic} />
              <OutcomeBarChart manual={mc.manual} agentic={mc.agentic} />

              <div className="rp-stats">
                <StatBlock
                  label="Manual P5 (worst)"
                  value={fmtWeth(mc.manual.p5)}
                  variant="rp-stat--manual"
                />
                <StatBlock
                  label="Manual P50 (median)"
                  value={fmtWeth(mc.manual.p50)}
                  variant="rp-stat--manual"
                />
                <StatBlock
                  label="Manual P95 (best)"
                  value={fmtWeth(mc.manual.p95)}
                  variant="rp-stat--manual"
                />
                <StatBlock
                  label="Agentic (deterministic)"
                  value={fmtWeth(mc.agentic.deterministic)}
                  variant="rp-stat--agentic"
                />
              </div>
            </section>

            <section className="rp-section" aria-labelledby="rp-assumptions">
              <h2 id="rp-assumptions" className="rp-section__title">
                Assumptions
              </h2>
              <div className="rp-arows">
                <AssumptionRow
                  label="Ground truth source"
                  value={mc.assumptions.groundTruthSource}
                />
                <AssumptionRow label="Amount in" value={fmtUsdc(ground.amountInUsdc)} />
                <AssumptionRow label="Manual delay model" value={mc.assumptions.manualDelay} />
                <AssumptionRow label="Agentic delay model" value={mc.assumptions.agenticDelay} />
                <AssumptionRow
                  label="Iterations"
                  value={mc.assumptions.iterations.toLocaleString()}
                />
                <AssumptionRow label="Seed" value={fmtSeed(mc.seed)} />
                <AssumptionRow
                  label="Signal block"
                  value={`#${mc.provenance.signalBlock.toLocaleString()}`}
                />
                <AssumptionRow label="Chain ID" value={mc.provenance.chainId} />
                <AssumptionRow label="Depeg date" value={mc.provenance.depegDate} />
              </div>
              <p className="rp-disclaimer">
                {mc.label}. This replay does not predict future outcomes.
              </p>
            </section>
          </>
        )}

        <footer className="rp-foot">
          <span className="rp-foot__mark">vibing / farmer</span>
          <span className="rp-foot__tag">Set once. Vibe forever.</span>
        </footer>
      </main>
    </div>
  )
}
