// ReplayPage.jsx
// Public historical-replay surface for Vibing Farmer. Zero wallet, zero RPC —
// fetches two static JSON files (on-chain ground truth from a pinned mainnet
// fork + a seeded Monte Carlo summary) and renders the outcome range plus the
// Assumptions panel.
//
// Statistical honesty: the manual leg is a Monte Carlo band (P5/P50/P95) over
// reaction-time variance; the agentic leg is ONE deterministic value (first
// block after signal) — no fake distribution for a near-instant action. The
// chart plots the real fork swaps on a zoomed WETH axis as dots, never as bars,
// because a bar grown from a cut baseline would overstate the gaps.
//
// Aesthetic: same instrument material as Explorer, History and Risks — grained
// plates, recessed wells, lamps for read state. Harvest lime marks the agent only.

import { useEffect, useState } from 'react'
import NavBar from '../components/NavBar.jsx'
import { toDisplay } from '../stellar/format.js'
import { toReplayPresentation } from '../secondary/secondaryRouteAdapters.js'
import { StatusNotice, TechnicalDetails } from '../components/pocket/Primitives.jsx'
import './ReplayPage.css'

const GROUND_URL = '/data/replay-usdc-depeg.json'
const MC_URL = '/data/replay-mc.json'

const WEI_PER_WETH = 1e18
const DEFAULT_BLOCKS_PER_MIN = 5
const SCALE_PAD = 0.08
const SCALE_TICKS = 5
const MINUS = '−'

const toWeth = (wei) => Number(wei) / WEI_PER_WETH
const fmtWeth = (weth) => `${weth.toFixed(2)} WETH`
const fmtUsdc = (raw) => `${toDisplay(raw).toLocaleString()} USDC`
const fmtSeed = (seed) => `${seed} (0x${Number(seed).toString(16).toUpperCase()})`
const fmtSigned = (value, digits) => `${value < 0 ? MINUS : '+'}${Math.abs(value).toFixed(digits)}`

// Same lamp vocabulary as Explorer. Stale reads "Out of date" here so the pill never repeats the
// notice's own "Stale" label inside the open drawer.
const READ_TONE = {
  loading: 'idle',
  current: 'live',
  confirmed: 'live',
  stale: 'warn',
  empty: 'idle',
  partial: 'warn',
  error: 'danger',
  unavailable: 'idle',
}
const READ_LABEL = {
  loading: 'Checking',
  current: 'Current',
  confirmed: 'Current',
  stale: 'Out of date',
  empty: 'Empty',
  partial: 'Partial',
  error: 'Failed',
  unavailable: 'Unverified',
}
const SETTLED_STATES = new Set(['current', 'confirmed'])

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

/* ----------------------------- chart model ----------------------------- */

function fmtDelay(seconds) {
  if (seconds < 60) return `${Math.round(seconds)} s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  return `${Number((seconds / 3600).toFixed(1))} h`
}

// The ground-truth file stores one real fork swap per reaction delay, keyed `delay_<blocks>`.
function forkStops(ground, blocksPerMin) {
  return Object.entries(ground ?? {})
    .map(([key, wei]) => [Number(/^delay_(\d+)$/.exec(key)?.[1]), wei])
    .filter(([blocks]) => Number.isFinite(blocks))
    .sort((a, b) => a[0] - b[0])
    .map(([blocks, wei]) => ({ blocks, seconds: (blocks * 60) / blocksPerMin, weth: toWeth(wei) }))
}

// One row per fork swap, earliest first. The agent's deterministic leg is the first-block swap;
// match it by value instead of assuming which row it is. Without fork rows, the agent stands alone.
function chartRows(ground, mc) {
  const agent = toWeth(mc.agentic.deterministic)
  const blocksPerMin = Number(mc.assumptions?.blocksPerMin) || DEFAULT_BLOCKS_PER_MIN
  const stops = forkStops(ground, blocksPerMin)
  if (stops.length === 0) {
    return {
      fromFork: false,
      rows: [
        { key: 'agent', when: 'First block', note: 'After the signal', weth: agent, isAgent: true },
      ],
    }
  }
  return {
    fromFork: true,
    rows: stops.map((stop) => ({
      key: `delay-${stop.blocks}`,
      when: fmtDelay(stop.seconds),
      note: `+${stop.blocks} blocks`,
      weth: stop.weth,
      isAgent: Math.abs(stop.weth - agent) <= agent * 1e-9,
    })),
  }
}

// Zoomed linear WETH axis with round ticks. Dots and bands only, so a cut baseline stays honest.
function niceScale(values) {
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || Math.abs(hi) || 1
  const min = lo - span * SCALE_PAD
  const max = hi + span * SCALE_PAD
  const raw = (max - min) / SCALE_TICKS
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].find((m) => m * magnitude >= raw) * magnitude
  const digits = Math.max(0, -Math.floor(Math.log10(step)))
  const ticks = []
  for (let tick = Math.ceil(min / step) * step; tick <= max + step * 1e-6; tick += step) {
    ticks.push(tick)
  }
  return { pct: (value) => ((value - min) / (max - min)) * 100, ticks, digits }
}

/* ----------------------------- header pieces ----------------------------- */

function Readout({ label, value, sub, loading }) {
  let shown = value
  if (value == null) {
    shown = loading ? <span className="rp-skeleton" aria-hidden="true" /> : 'Not available'
  }
  return (
    <div className="rp-readout">
      <dt>{label}</dt>
      <dd className="rp-readout__value">{shown}</dd>
      {sub && <dd className="rp-readout__sub">{sub}</dd>}
    </div>
  )
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
    <div className="rp-evidence" data-fact-state={state}>
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
      <TechnicalDetails summary="Technical details" fact={fact} />
    </div>
  )
}

// Provenance for the whole page. It stays open until the read settles as current, so a closed
// drawer never hides a failure; the peek pill carries the state once it closes.
function ReplaySource(props) {
  const state = props.presentation.fact.state
  return (
    <details className="rp-source" open={!SETTLED_STATES.has(state)}>
      <summary className="rp-source__summary">
        <span className="rp-source__title">Where this replay comes from</span>
        <span className="rp-source__hint">
          Two frozen files: fork swap results and a seeded simulation
        </span>
        <span className="rp-peek" data-tone={READ_TONE[state] || 'idle'}>
          <span className="rp-lamp" aria-hidden="true" />
          {READ_LABEL[state] || 'Unverified'}
        </span>
      </summary>
      <div className="rp-source__body">
        <ReplayEvidence {...props} />
      </div>
    </details>
  )
}

/* ----------------------------- outcome plate ----------------------------- */

function WethFigure({ value, signed = false }) {
  return (
    <>
      <span className="rp-figure-num">{signed ? fmtSigned(value, 2) : value.toFixed(2)}</span>
      <span className="rp-figure-unit">WETH</span>
    </>
  )
}

function Verdict({ agent, median }) {
  const delta = agent - median
  const pct = median > 0 ? (delta / median) * 100 : 0
  const side = delta < 0 ? 'less than' : delta > 0 ? 'more than' : 'level with'
  return (
    <dl className="rp-verdict">
      <div className="rp-readout">
        <dt>
          <span className="rp-key rp-key--agent" aria-hidden="true" />
          Agent, first block
        </dt>
        <dd className="rp-readout__value">
          <WethFigure value={agent} />
        </dd>
        <dd className="rp-readout__sub">One fixed result, no reaction spread</dd>
      </div>
      <div className="rp-readout">
        <dt>
          <span className="rp-key rp-key--median" aria-hidden="true" />
          Manual, median reaction
        </dt>
        <dd className="rp-readout__value">
          <WethFigure value={median} />
        </dd>
        <dd className="rp-readout__sub">Middle of the simulated reactions</dd>
      </div>
      <div className="rp-readout">
        <dt>Agent against the median</dt>
        <dd className="rp-readout__value">
          <WethFigure value={delta} signed />
        </dd>
        <dd className="rp-readout__sub">
          {fmtSigned(pct, 2)}%, {side} the median
        </dd>
      </div>
    </dl>
  )
}

function Legend({ fromFork }) {
  return (
    <ul className="rp-legend">
      <li>
        <span className="rp-key rp-key--agent" aria-hidden="true" />
        <strong>Swarm Execution</strong>
        <span>First block after the signal, one deterministic result</span>
      </li>
      <li>
        <span className="rp-key rp-key--band" aria-hidden="true" />
        <strong>Human Reaction</strong>
        <span>Band holds 90% of simulated reactions, the line marks the median</span>
      </li>
      {fromFork && (
        <li>
          <span className="rp-key rp-key--fork" aria-hidden="true" />
          <strong>Fork swap</strong>
          <span>A real swap on the pinned mainnet fork at that delay</span>
        </li>
      )}
    </ul>
  )
}

// Rows are the table view: each one reads as "delay, WETH received". The plot laid over them is a
// visual twin of the same numbers, so it stays hidden from assistive tech.
function ReactionChart({ rows, scale, band }) {
  const count = rows.length
  const rowCenter = (index) => ((index + 0.5) / count) * 100
  const points = rows.map((row, i) => `${scale.pct(row.weth)},${rowCenter(i)}`).join(' ')
  const [p5, p50, p95] = band.map(scale.pct)

  return (
    <div className="rp-clock">
      <div className="rp-clock__head" aria-hidden="true">
        <span>Reaction time</span>
        <span />
        <span>WETH received</span>
      </div>
      <ol className="rp-clock__rows" aria-label="Swap result at each reaction time">
        {rows.map((row) => (
          <li key={row.key} className="rp-clock__row" data-agent={row.isAgent || undefined}>
            <span className="rp-clock__when">
              <span className="rp-clock__delay">{row.when}</span>
              {row.isAgent && <span className="rp-clock__chip">Agent</span>}
              <span className="rp-clock__note">{row.note}</span>
            </span>
            <span className="rp-clock__track" aria-hidden="true" />
            <span className="rp-clock__got">{fmtWeth(row.weth)}</span>
          </li>
        ))}
      </ol>
      <div className="rp-clock__plot" aria-hidden="true">
        {scale.ticks.map((tick) => (
          <span
            key={tick.toFixed(6)}
            className="rp-clock__grid"
            style={{ left: `${scale.pct(tick)}%` }}
          />
        ))}
        <span className="rp-clock__band" style={{ width: `${p95 - p5}%`, left: `${p5}%` }} />
        <span className="rp-clock__median" style={{ left: `${p50}%` }} />
        {count > 1 && (
          <svg className="rp-clock__line" viewBox="0 0 100 100" preserveAspectRatio="none">
            <polyline points={points} />
          </svg>
        )}
        {rows.map((row, i) => (
          <span
            key={row.key}
            className="rp-clock__dot"
            data-agent={row.isAgent || undefined}
            style={{ left: `${scale.pct(row.weth)}%`, top: `${rowCenter(i)}%` }}
          />
        ))}
      </div>
      <div className="rp-clock__axis" aria-hidden="true">
        {scale.ticks.map((tick) => (
          <span key={tick.toFixed(6)} style={{ left: `${scale.pct(tick)}%` }}>
            {tick.toFixed(scale.digits)}
          </span>
        ))}
      </div>
    </div>
  )
}

function OutcomePlate({ ground, mc }) {
  const { rows, fromFork } = chartRows(ground, mc)
  const agent = toWeth(mc.agentic.deterministic)
  const band = [mc.manual.p5, mc.manual.p50, mc.manual.p95].map(toWeth)
  const scale = niceScale([...rows.map((row) => row.weth), ...band, agent])
  const iterations = Number(mc.assumptions?.iterations)
  const runs = Number.isFinite(iterations) ? iterations.toLocaleString() : null
  const amount = fmtUsdc(ground.amountInUsdc)

  return (
    <section className="rp-plate" aria-labelledby="rp-outcome">
      <div className="rp-plate__head">
        <h2 id="rp-outcome" className="rp-plate__title">
          Outcome Range
        </h2>
        {runs && <span className="rp-count">{runs} simulated reactions</span>}
        <p className="rp-plate__lede">
          Swapping {amount} for WETH at block {Number(mc.provenance.signalBlock).toLocaleString()}.
          Each leg shows what the same swap would have returned at a different reaction delay.
        </p>
      </div>
      <Verdict agent={agent} median={band[1]} />
      <figure className="rp-figure">
        <figcaption className="rp-figure__cap">
          <h3 className="rp-figure__title">What {amount} bought, by reaction time</h3>
          <Legend fromFork={fromFork} />
        </figcaption>
        <ReactionChart rows={rows} scale={scale} band={band} />
        <p className="rp-reading">
          The agent&apos;s result is fixed at the first block after the signal. A manual result
          depends on when someone reacts: 90% of {runs ?? 'the'} simulated reactions landed between{' '}
          {fmtWeth(band[0])} and {fmtWeth(band[2])}.
        </p>
      </figure>
    </section>
  )
}

/* ----------------------------- assumptions plate ----------------------------- */

function FactGroup({ title, rows }) {
  return (
    <div className="rp-facts">
      <h3 className="rp-facts__title">{title}</h3>
      <dl className="rp-facts__list">
        {rows.map(([label, value]) => (
          <div key={label} className="rp-fact">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function AssumptionsPlate({ ground, mc }) {
  const { assumptions, provenance } = mc
  return (
    <section className="rp-plate" aria-labelledby="rp-assumptions">
      <div className="rp-plate__head">
        <h2 id="rp-assumptions" className="rp-plate__title">
          Assumptions
        </h2>
        <p className="rp-plate__lede">
          Every input is fixed before the run. The same seed reproduces the same numbers.
        </p>
      </div>
      <div className="rp-plate__body rp-assume">
        <FactGroup
          title="Swap"
          rows={[
            ['Amount in', fmtUsdc(ground.amountInUsdc)],
            ['Signal block', `#${Number(provenance.signalBlock).toLocaleString()}`],
            ['Chain ID', provenance.chainId],
            ['Depeg date', provenance.depegDate],
          ]}
        />
        <FactGroup
          title="Simulation"
          rows={[
            ['Manual delay model', assumptions.manualDelay],
            ['Agentic delay model', assumptions.agenticDelay],
            ['Iterations', Number(assumptions.iterations).toLocaleString()],
            ['Seed', fmtSeed(mc.seed)],
          ]}
        />
        <div className="rp-sourcefile">
          <span className="rp-sourcefile__label">Ground truth source</span>
          <code className="rp-sourcefile__path">{assumptions.groundTruthSource}</code>
        </div>
      </div>
      <p className="rp-plate__foot rp-caveat" data-tone="warn">
        <span className="rp-lamp" aria-hidden="true" />
        {mc.label}. This replay does not predict future outcomes.
      </p>
    </section>
  )
}

function ChartPending({ loading }) {
  return (
    <section className="rp-plate rp-pending" aria-labelledby="rp-pending">
      <h2 id="rp-pending" className="rp-pending__title">
        {loading ? 'Reading the replay files' : 'Nothing to chart yet'}
      </h2>
      <p className="rp-pending__copy">
        {loading
          ? 'The outcome chart appears once both frozen files load.'
          : 'The outcome chart needs both frozen replay files. The source panel above shows what loaded.'}
      </p>
    </section>
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
  const loading = state === 'loading'
  const hasBothPayloads = Boolean(ground && mc)
  const canRenderPayload = ['current', 'confirmed', 'stale', 'partial'].includes(state)
  const signalBlock = mc?.provenance?.signalBlock ?? ground?.signalBlock
  const depegDate = ground?.depegDate ?? mc?.provenance?.depegDate

  return (
    <div className="rp-page">
      <NavBar />

      <main className="rp-main" aria-busy={loading ? 'true' : undefined}>
        <header className="rp-header">
          <h1 className="rp-title">Historical Replay</h1>
          <p className="rp-lede">
            Ethereum mainnet case study, predating the product's Stellar/Soroban migration: USDC
            depeg, March 11 2023, replayed on a pinned mainnet fork. Real on-chain swaps at five
            reaction delays; illustrates manual-vs-agentic execution speed, not a Stellar demo or a
            prediction.
          </p>
          <ul className="rp-scope" aria-label="Replay scope">
            <li>Static historical replay</li>
            <li>No wallet or RPC execution</li>
          </ul>

          <div className="rp-console">
            <dl className="rp-strip">
              <Readout label="Chain" value="Ethereum mainnet fork" />
              <Readout label="Event" value="USDC depeg" sub={depegDate} />
              <Readout
                label="Swap size"
                value={ground ? fmtUsdc(ground.amountInUsdc) : null}
                loading={loading}
              />
              <Readout
                label="Signal block"
                value={signalBlock != null ? Number(signalBlock).toLocaleString() : null}
                loading={loading}
              />
            </dl>
            <ReplaySource presentation={presentation} ground={ground} mc={mc} error={error} />
          </div>
        </header>

        {hasBothPayloads && canRenderPayload ? (
          <>
            <OutcomePlate ground={ground} mc={mc} />
            <AssumptionsPlate ground={ground} mc={mc} />
          </>
        ) : (
          <ChartPending loading={loading} />
        )}

        <footer className="rp-foot">
          <span className="rp-foot__mark">vibing / farmer</span>
          <span className="rp-foot__tag">Set once. Vibe forever.</span>
        </footer>
      </main>
    </div>
  )
}
