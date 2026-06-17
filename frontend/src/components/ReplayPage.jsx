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

const GROUND_URL = '/data/replay-usdc-depeg.json'
const MC_URL = '/data/replay-mc.json'

const fmtWeth = (wei) => `${(Number(wei) / 1e18).toFixed(2)} WETH`
const fmtUsdc = (raw) => `${(Number(raw) / 1e6).toLocaleString()} USDC`
const fmtSeed = (seed) => `${seed} (0x${Number(seed).toString(16).toUpperCase()})`

/* ----------------------------- data hook ----------------------------- */

function useReplayData() {
  const [state, setState] = useState({ ground: null, mc: null, error: null })

  useEffect(() => {
    let alive = true
    Promise.all([fetch(GROUND_URL), fetch(MC_URL)])
      .then(([g, m]) => {
        if (!g.ok || !m.ok) throw new Error('replay data not found')
        return Promise.all([g.json(), m.json()])
      })
      .then(([ground, mc]) => { if (alive) setState({ ground, mc, error: null }) })
      .catch((err) => { if (alive) setState({ ground: null, mc: null, error: err.message }) })
    return () => { alive = false }
  }, [])

  return state
}

/* ----------------------------- band chart ----------------------------- */

const CHART_X0 = 50
const CHART_X1 = 590
const CHART_W = CHART_X1 - CHART_X0

function OutcomeBand({ manual, agentic }) {
  const values = [manual.p5, manual.p50, manual.p95, agentic.deterministic].map(Number)
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const pad = (hi - lo || 1) * 0.25
  const min = lo - pad
  const max = hi + pad
  const scale = (v) => CHART_X0 + ((Number(v) - min) / (max - min)) * CHART_W

  return (
    <svg className="rp-band" viewBox="0 0 640 170" role="img" aria-label="Manual reaction-time band versus agentic deterministic outcome, in WETH received">
      <line className="rp-axis" x1={CHART_X0} x2={CHART_X1} y1="150" y2="150" />
      <text className="rp-axis-label" x={CHART_X0} y="166">{fmtWeth(min)}</text>
      <text className="rp-axis-label rp-axis-label--end" x={CHART_X1} y="166">{fmtWeth(max)}</text>

      <text className="rp-row-label" x={CHART_X0} y="28">Manual — reaction-time variance (P5–P95, P50 marked)</text>
      <rect
        className="rp-band-rect"
        x={scale(manual.p5)}
        y="40"
        width={Math.max(1, scale(manual.p95) - scale(manual.p5))}
        height="24"
        rx="3"
      />
      <line className="rp-band-p50" x1={scale(manual.p50)} x2={scale(manual.p50)} y1="34" y2="70" />

      <text className="rp-row-label" x={CHART_X0} y="100">Agentic — single deterministic outcome (no variance)</text>
      <line className="rp-agentic-drop" x1={scale(agentic.deterministic)} x2={scale(agentic.deterministic)} y1="92" y2="150" />
      <circle className="rp-agentic-marker" cx={scale(agentic.deterministic)} cy="110" r="6" />
    </svg>
  )
}

/* ----------------------------- pieces ----------------------------- */

function StatBlock({ label, value }) {
  return (
    <div className="rp-stat">
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
            <span className="rp-net"><span className="rp-net__dot" /> static JSON · no wallet · no RPC</span>
          </div>
          <p className="rp-lede">
            USDC depeg, March 11 2023 — replayed on a pinned mainnet fork. Real
            on-chain swaps at five reaction delays; never a prediction.
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
              <h2 id="rp-outcome" className="rp-section__title">Outcome Range</h2>
              <p className="rp-section__sub">
                Swapping {fmtUsdc(ground.amountInUsdc)} for WETH at block {mc.provenance.signalBlock}.
                Each leg shows what the same swap would have returned at a different reaction delay.
              </p>
              <OutcomeBand manual={mc.manual} agentic={mc.agentic} />
              <div className="rp-stats">
                <StatBlock label="Manual P5" value={fmtWeth(mc.manual.p5)} />
                <StatBlock label="Manual P50" value={fmtWeth(mc.manual.p50)} />
                <StatBlock label="Manual P95" value={fmtWeth(mc.manual.p95)} />
                <StatBlock label="Agentic (deterministic)" value={fmtWeth(mc.agentic.deterministic)} />
              </div>
            </section>

            <section className="rp-section" aria-labelledby="rp-assumptions">
              <h2 id="rp-assumptions" className="rp-section__title">Assumptions</h2>
              <div className="rp-arows">
                <AssumptionRow label="Ground truth source" value={mc.assumptions.groundTruthSource} />
                <AssumptionRow label="Amount in" value={fmtUsdc(ground.amountInUsdc)} />
                <AssumptionRow label="Manual delay model" value={mc.assumptions.manualDelay} />
                <AssumptionRow label="Agentic delay model" value={mc.assumptions.agenticDelay} />
                <AssumptionRow label="Iterations" value={mc.assumptions.iterations.toLocaleString()} />
                <AssumptionRow label="Seed" value={fmtSeed(mc.seed)} />
                <AssumptionRow label="Signal block" value={`#${mc.provenance.signalBlock.toLocaleString()}`} />
                <AssumptionRow label="Chain ID" value={mc.provenance.chainId} />
                <AssumptionRow label="Depeg date" value={mc.provenance.depegDate} />
              </div>
              <p className="rp-disclaimer">
                {mc.label}. Forward-looking scenarios are scoped to this replay — not a predictive model.
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
  background: var(--accent, #cfff3d);
  box-shadow: 0 0 0 0 rgba(207,255,61,0.6);
  animation: rp-pulse 2.4s ease-out infinite;
}
@keyframes rp-pulse {
  0% { box-shadow: 0 0 0 0 rgba(207,255,61,0.5); }
  70% { box-shadow: 0 0 0 7px rgba(207,255,61,0); }
  100% { box-shadow: 0 0 0 0 rgba(207,255,61,0); }
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

/* ---------- band chart ---------- */
.rp-band { display: block; width: 100%; height: auto; margin-top: 0.5rem; }
.rp-axis { stroke: var(--border-strong, rgba(255,255,255,0.13)); stroke-width: 1; }
.rp-axis-label {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  fill: var(--text-faint, #56564f);
  dominant-baseline: hanging;
}
.rp-axis-label--end { text-anchor: end; }
.rp-row-label {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  letter-spacing: 0.02em;
  fill: var(--text-muted, #95958a);
}
.rp-band-rect { fill: var(--bg-elev, #22231d); stroke: var(--border-strong, rgba(255,255,255,0.13)); stroke-width: 1; }
.rp-band-p50 { stroke: var(--text, #ecebe1); stroke-width: 2; }
.rp-agentic-marker { fill: var(--accent, #cfff3d); }
.rp-agentic-drop { stroke: var(--accent, #cfff3d); stroke-width: 1; stroke-dasharray: 3 3; }

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
}
.rp-stat__value {
  font-family: var(--font-mono, monospace);
  font-size: clamp(1.1rem, 2.2vw, 1.5rem);
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--text, #ecebe1);
  line-height: 1;
}
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
