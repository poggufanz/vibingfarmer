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
// Aesthetic: matches ExplorerPage — dark canvas, single acid accent, mono stats.

import { useEffect, useState } from 'react'
import NavBar from './NavBar.jsx'
import { toDisplay } from '../stellar/format.js'

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

/* ----------------------------- band chart ----------------------------- */

const CHART_X0 = 50
const CHART_X1 = 590
const CHART_W = CHART_X1 - CHART_X0

/* ----------------------------- bar chart comparison ----------------------------- */

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

  const getPct = (val) => {
    return Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100))
  }

  const agPct = getPct(agVal)
  const manP50Pct = getPct(manP50)
  const manP5Pct = getPct(manP5)
  const manP95Pct = getPct(manP95)

  return (
    <div className="rp-chart-container">
      {/* Agentic Bar Row */}
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

      {/* Manual Bar Row */}
      <div className="rp-chart-row rp-chart-row--manual">
        <div className="rp-chart-label-col">
          <span className="rp-row-badge rp-row-badge--manual">MANUAL</span>
          <span className="rp-row-title">Human Reaction</span>
          <span className="rp-row-desc">Monte Carlo delay distribution (P50)</span>
        </div>
        <div className="rp-chart-bar-col">
          <div className="rp-bar-wrapper">
            {/* The main bar goes up to P50 */}
            <div className="rp-bar rp-bar--manual" style={{ width: `${manP50Pct}%` }}>
              <span className="rp-bar-val">{fmtWeth(manP50)}</span>
            </div>
          </div>
          {/* Whisker line showing P5 to P95 range */}
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

      {/* X Axis Labels */}
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
      {/* Manual card */}
      <div className="rp-hero-card rp-hero-card--manual">
        <div className="rp-hero-tag">
          <span className="rp-hero-dot rp-hero-dot--manual" />
          MANUAL (P50)
        </div>
        <div className="rp-hero-val">{manVal.toFixed(4)}</div>
        <div className="rp-hero-unit">WETH</div>
        <div className="rp-hero-sub">Median across reaction delays</div>
      </div>

      {/* Delta badge */}
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

      {/* Agentic card */}
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

export default function ReplayPage() {
  const { ground, mc, error } = useReplayData()

  return (
    <div className="rp-page">
      <ReplayStyle />
      <NavBar />

      <main className="rp-main">
        <header className="rp-header">
          <div className="rp-header__top">
            <h1 className="rp-title">Historical Replay</h1>
            <span className="rp-net">
              <span className="rp-net__dot" /> Static JSON. No wallet or RPC.
            </span>
          </div>
          <p className="rp-lede">
            USDC depeg, March 11 2023, replayed on a pinned mainnet fork. Real on-chain swaps at
            five reaction delays; never a prediction.
          </p>
        </header>

        {error && (
          <div className="rp-empty">
            Replay data unavailable ({error}). Generate it via{' '}
            <code>scripts/replay/monteCarlo.ts</code>.
          </div>
        )}

        {!error && !mc && <div className="rp-empty">Loading replay data…</div>}

        {mc && ground && (
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

              {/* comparison hero cards */}
              <ComparisonHero manual={mc.manual} agentic={mc.agentic} />

              {/* horizontal bar comparison chart */}
              <OutcomeBarChart manual={mc.manual} agentic={mc.agentic} />

              {/* stat grid */}
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

/* ------------------------------ styles ------------------------------ */

function ReplayStyle() {
  return (
    <style>{`
.rp-page {
  position: fixed;
  inset: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  background: var(--bg-base, #0e0f0c);
  color: var(--text, #ecebe1);
  font-family: var(--font-body, "Geist", system-ui, sans-serif);
}
.rp-page::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background-image:
    linear-gradient(rgba(255,255,255,0.016) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.016) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: radial-gradient(ellipse 90% 60% at 50% 0%, #000 20%, transparent 100%);
}

.rp-main {
  position: relative;
  z-index: 1;
  max-width: 1040px;
  margin: 0 auto;
  padding: calc(64px + clamp(2.5rem, 7vw, 5rem)) clamp(1.1rem, 5vw, 2.6rem) 4rem;
}

/* ---------- header ---------- */
.rp-header { padding-bottom: clamp(2rem, 5vw, 3.4rem); border-bottom: 1px solid var(--border, rgba(255,255,255,0.06)); }
.rp-header__top { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.rp-title {
  font-family: var(--font-display, "Geist", sans-serif);
  font-weight: 700;
  letter-spacing: -0.04em;
  line-height: 1;
  font-size: clamp(2.6rem, 7vw, 4.6rem);
  color: var(--text, #ecebe1);
}
.rp-net {
  display: inline-flex;
  align-items: center;
  gap: 0.55ch;
  font-family: var(--font-mono, monospace);
  font-size: 0.74rem;
  letter-spacing: 0.04em;
  color: var(--text-muted, #95958a);
}
.rp-net__dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--text-faint, #7a7a70);
}
.rp-lede {
  margin-top: 1.1rem;
  max-width: 60ch;
  font-family: var(--font-mono, monospace);
  font-size: clamp(0.82rem, 1.1vw, 0.95rem);
  line-height: 1.7;
  color: var(--text-muted, #95958a);
}

/* ---------- sections ---------- */
.rp-section { padding: clamp(2.2rem, 5vw, 3.6rem) 0; border-bottom: 1px solid var(--border, rgba(255,255,255,0.06)); }
.rp-section:last-of-type { border-bottom: none; }
.rp-section__title {
  font-family: var(--font-mono, monospace);
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--accent, #cfff3d);
  margin-bottom: 0.6rem;
}
.rp-section__sub {
  display: block;
  margin: 0 0 1.5rem;
  max-width: 64ch;
  font-family: var(--font-mono, monospace);
  font-size: 0.8rem;
  line-height: 1.6;
  color: var(--text-muted, #95958a);
}

/* ---------- comparison hero cards ---------- */
.rp-compare {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 0.7rem;
  align-items: stretch;
  margin-bottom: 2rem;
}
.rp-hero-card {
  border: 1px solid var(--border-strong, rgba(255,255,255,0.13));
  border-radius: 14px;
  padding: 1.5rem 1.3rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  position: relative;
  overflow: hidden;
}
.rp-hero-card--manual {
  background: var(--bg-card, #1a1b16);
}
.rp-hero-card--agentic {
  background: linear-gradient(145deg, rgba(207,255,61,0.06) 0%, var(--bg-card, #1a1b16) 60%);
  border-color: rgba(207,255,61,0.2);
  box-shadow: 0 0 40px -8px rgba(207,255,61,0.1);
}
.rp-hero-card--agentic::before {
  content: '';
  position: absolute;
  top: -40%; right: -30%;
  width: 180px; height: 180px;
  background: radial-gradient(circle, rgba(207,255,61,0.08) 0%, transparent 70%);
  pointer-events: none;
}
.rp-hero-tag {
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
  font-family: var(--font-mono, monospace);
  font-size: 0.62rem;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-faint, #56564f);
}
.rp-hero-dot {
  width: 6px; height: 6px; border-radius: 50%;
}
.rp-hero-dot--manual { background: var(--text-faint, #56564f); }
.rp-hero-dot--agentic {
  background: var(--accent, #cfff3d);
  box-shadow: 0 0 6px rgba(207,255,61,0.5);
}
.rp-hero-val {
  font-family: var(--font-mono, monospace);
  font-size: clamp(1.8rem, 3.5vw, 2.6rem);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1;
  color: var(--text, #ecebe1);
}
.rp-hero-card--agentic .rp-hero-val {
  background: linear-gradient(135deg, var(--accent, #cfff3d), #e8ff8a);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.rp-hero-unit {
  font-family: var(--font-mono, monospace);
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text-muted, #95958a);
}
.rp-hero-sub {
  font-family: var(--font-mono, monospace);
  font-size: 0.68rem;
  color: var(--text-faint, #56564f);
  margin-top: auto;
  padding-top: 0.5rem;
}

/* delta badge */
.rp-delta {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
  padding: 0.8rem 0.6rem;
  min-width: 100px;
}
.rp-delta-arrow {
  font-size: 1.4rem;
  line-height: 1;
}
.rp-delta.positive .rp-delta-arrow { color: var(--accent, #cfff3d); }
.rp-delta.negative .rp-delta-arrow { color: #ff6b6b; }
.rp-delta-val {
  font-family: var(--font-mono, monospace);
  font-size: 0.82rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  text-align: center;
}
.rp-delta.positive .rp-delta-val { color: var(--accent, #cfff3d); }
.rp-delta.negative .rp-delta-val { color: #ff6b6b; }
.rp-delta-pct {
  font-family: var(--font-mono, monospace);
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0.15rem 0.5rem;
  border-radius: 6px;
}
.rp-delta.positive .rp-delta-pct { background: rgba(207,255,61,0.1); color: var(--accent, #cfff3d); }
.rp-delta.negative .rp-delta-pct { background: rgba(255,107,107,0.1); color: #ff6b6b; }
.rp-delta-label {
  font-family: var(--font-mono, monospace);
  font-size: 0.58rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-faint, #56564f);
  text-align: center;
}

/* ---------- horizontal bar chart ---------- */
.rp-chart-container {
  display: flex;
  flex-direction: column;
  gap: 1.6rem;
  background: rgba(255,255,255,0.015);
  border: 1px solid var(--border, rgba(255,255,255,0.06));
  border-radius: 14px;
  padding: 1.8rem 1.5rem;
  margin: 1.5rem 0 2rem;
}
.rp-chart-row {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 1.5rem;
  align-items: center;
}
@media (max-width: 760px) {
  .rp-chart-row {
    grid-template-columns: 1fr;
    gap: 0.6rem;
  }
}
.rp-chart-label-col {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.rp-row-badge {
  display: inline-flex;
  align-self: flex-start;
  font-family: var(--font-mono, monospace);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  padding: 0.25rem 0.55rem;
  border-radius: 4px;
  line-height: 1;
  margin-bottom: 0.15rem;
}
.rp-row-badge--agentic {
  background: rgba(207,255,61,0.1);
  color: var(--accent, #cfff3d);
  border: 1px solid rgba(207,255,61,0.25);
}
.rp-row-badge--manual {
  background: rgba(255,255,255,0.04);
  color: var(--text-muted, #95958a);
  border: 1px solid rgba(255,255,255,0.08);
}
.rp-row-title {
  font-family: var(--font-display, "Geist", sans-serif);
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text, #ecebe1);
}
.rp-row-desc {
  font-family: var(--font-mono, monospace);
  font-size: 9.5px;
  color: var(--text-faint, #56564f);
}
.rp-chart-bar-col {
  position: relative;
  height: 52px;
  display: flex;
  align-items: center;
}
.rp-bar-wrapper {
  position: relative;
  width: 100%;
  height: 28px;
  background: rgba(255,255,255,0.02);
  border-radius: 6px;
  border: 1px solid var(--border, rgba(255,255,255,0.06));
}
.rp-bar {
  height: 100%;
  border-radius: 5px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-right: 12px;
  transition: width 800ms cubic-bezier(0.16,1,0.3,1);
  position: relative;
  z-index: 2;
}
.rp-bar--agentic {
  background: linear-gradient(90deg, rgba(207,255,61,0.25) 0%, var(--accent, #cfff3d) 100%);
  border: 1px solid rgba(207,255,61,0.5);
  box-shadow: 0 0 20px rgba(207,255,61,0.15);
}

@media (prefers-reduced-motion: reduce) {
  .rp-bar { transition: none; }
}
.rp-bar--manual {
  background: linear-gradient(90deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.12) 100%);
  border: 1px solid rgba(255,255,255,0.15);
}
.rp-bar-val {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  font-weight: 700;
  color: #0e0f0c;
  white-space: nowrap;
}
.rp-bar--manual .rp-bar-val {
  color: var(--text, #ecebe1);
}
.rp-bar-whisker {
  position: absolute;
  top: 42px;
  height: 2px;
  background: rgba(255,255,255,0.25);
  z-index: 1;
}
.rp-whisker-cap {
  position: absolute;
  top: -4px;
  width: 2px;
  height: 10px;
  background: rgba(255,255,255,0.25);
}
.rp-whisker-cap--left { left: 0; }
.rp-whisker-cap--right { right: 0; }
.rp-whisker-label {
  position: absolute;
  top: 8px;
  font-family: var(--font-mono, monospace);
  font-size: 8px;
  color: var(--text-faint, #56564f);
  white-space: nowrap;
}
.rp-whisker-label--left { left: 0; transform: translateX(-50%); }
.rp-whisker-label--right { right: 0; transform: translateX(50%); }
.rp-chart-axis {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-top: 1px dashed var(--border-strong, rgba(255,255,255,0.13));
  padding-top: 0.8rem;
  margin-top: 0.4rem;
}
.rp-axis-tick-val {
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  color: var(--text-faint, #56564f);
}
.rp-axis-tick-title {
  font-family: var(--font-mono, monospace);
  font-size: 9px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-muted, #95958a);
}

/* ---------- stats ---------- */
.rp-stats {
  margin-top: 1.5rem;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.7rem;
}
.rp-stat {
  border: 1px solid var(--border, rgba(255,255,255,0.06));
  border-radius: var(--radius-md, 8px);
  background: var(--bg-card, #1a1b16);
  padding: 1.3rem 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  transition: border-color 200ms ease;
}
.rp-stat--manual {
  border-left: 3px solid rgba(255,255,255,0.1);
}
.rp-stat--agentic {
  border-left: 3px solid var(--accent, #cfff3d);
  background: linear-gradient(145deg, rgba(207,255,61,0.04) 0%, var(--bg-card, #1a1b16) 50%);
}
.rp-stat__value {
  font-family: var(--font-mono, monospace);
  font-size: clamp(1.1rem, 2.2vw, 1.5rem);
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--text, #ecebe1);
  line-height: 1;
}
.rp-stat--agentic .rp-stat__value { color: var(--accent, #cfff3d); }
.rp-stat__label {
  font-family: var(--font-mono, monospace);
  font-size: 0.68rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-faint, #56564f);
}

/* ---------- assumptions ---------- */
.rp-arows { display: flex; flex-direction: column; gap: 0.1rem; margin-top: 1.5rem; }
.rp-arow {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
}
.rp-arow:last-child { border-bottom: none; }
.rp-arow__k {
  flex-shrink: 0;
  font-family: var(--font-mono, monospace);
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint, #56564f);
}
.rp-arow__v {
  font-family: var(--font-mono, monospace);
  font-size: 0.82rem;
  color: var(--text, #ecebe1);
  text-align: right;
}
.rp-disclaimer {
  margin-top: 1.6rem;
  padding: 0.85rem 1.1rem;
  border-left: 2px solid var(--border-accent, rgba(207,255,61,0.4));
  font-family: var(--font-mono, monospace);
  font-size: 0.76rem;
  line-height: 1.6;
  color: var(--text-faint, #56564f);
  background: var(--accent-soft, rgba(207,255,61,0.08));
  border-radius: 0 var(--radius-sm, 4px) var(--radius-sm, 4px) 0;
}

/* ---------- empty / loading ---------- */
.rp-empty {
  margin-top: 1.5rem;
  border: 1px dashed var(--border-strong, rgba(255,255,255,0.13));
  border-radius: var(--radius-lg, 14px);
  padding: 2.2rem 1.5rem;
  text-align: center;
  font-family: var(--font-mono, monospace);
  font-size: 0.8rem;
  color: var(--text-faint, #56564f);
}
.rp-empty code {
  color: var(--text-muted, #95958a);
  font-family: var(--font-mono, monospace);
}

/* ---------- footer ---------- */
.rp-foot {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  margin-top: 3rem;
  padding-top: 1.8rem;
  border-top: 1px solid var(--border, rgba(255,255,255,0.06));
}
.rp-foot__mark { font-family: var(--font-mono, monospace); font-size: 0.78rem; color: var(--text-muted, #95958a); }
.rp-foot__tag { font-family: var(--font-script, "Newsreader", serif); font-style: italic; font-size: 0.95rem; color: var(--text-faint, #56564f); }

/* ---------- responsive ---------- */
@media (max-width: 760px) {
  .rp-compare { grid-template-columns: 1fr; gap: 0.5rem; }
  .rp-delta { flex-direction: row; gap: 0.6rem; padding: 0.6rem 0; }
  .rp-stats { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 420px) {
  .rp-stats { grid-template-columns: 1fr; }
  .rp-arow { flex-direction: column; align-items: flex-start; gap: 0.3rem; }
  .rp-arow__v { text-align: left; }
}
`}</style>
  )
}
