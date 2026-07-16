/* ============================================
   VIBING FARMER — Agent Graph + Memory
   Graph rendering lives in src/graph/ (PixiJS "Living Current" scene);
   this file keeps strategy/exec-state UI: tiles, memory modal, cards.
   ============================================ */
import React, {
  useEffect as useEAg,
  useRef as useRAg,
  useState as useSAg,
} from 'react'
import { PixiSwarmGraph } from './graph/PixiSwarmGraph.jsx'
import { Icon } from './components.jsx'
import { shortAddr } from './screens.jsx'
import { VAULT_CATALOG } from './config.js'
import { buildStrategyState, scoreReward, riskCeiling } from './strategy/mdp.js'
import {
  STEP_IDS,
  STEP_LABELS,
  rebalancePulseKey,
  buildAutofarmGraphData,
} from './graph/topology.js'

const displayLabel = (value, fallback = '') =>
  String(value || fallback)
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())

/* ---------- Strategy data — generated per-flow ---------- */
// Derived from VAULT_CATALOG so addresses stay in sync with config automatically.
const ROLES = [
  'Conservative, lending',
  'Balanced, liquidity provision',
  'Aggressive, leveraged yield',
]
const AGENT_PROTOCOLS = VAULT_CATALOG.slice(0, 3).map((v, i) => ({
  name: v.name,
  protocol: v.protocol,
  apy: String(v.apy),
  drawdown: v.drawdown,
  risk: v.risk,
  addr: v.address,
  role: ROLES[i],
}))

const buildStrategy = (amount, risk) => {
  const total = Number(amount) || 100
  // Allocation profile per risk
  const splitMap = {
    low: [{ pct: 1.0, agents: 1 }],
    med: [
      { pct: 0.6, agents: 1 },
      { pct: 0.4, agents: 1 },
    ],
    high: [
      { pct: 0.4, agents: 1 },
      { pct: 0.35, agents: 1 },
      { pct: 0.25, agents: 1 },
    ],
  }
  const config = splitMap[risk] || splitMap.low
  const agents = config.map((c, i) => {
    const proto = AGENT_PROTOCOLS[i]
    const allocation = +(total * c.pct).toFixed(2)
    return {
      id: `worker-${i + 1}`,
      idx: String(i + 1).padStart(2, '0'),
      name: `Worker ${i + 1}, ${proto.role.split(', ')[0]}`,
      role: proto.role,
      allocation,
      skillName: 'yield_vault_deposit',
      vault: proto,
    }
  })
  const blendedApy = agents.reduce(
    (acc, a, i) => acc + Number(a.vault.apy) * (a.allocation / total),
    0
  )
  // Formal MDP reward for the offline fallback strategy (no AI / no live market).
  const mdpFullState = buildStrategyState({
    amountUsdc: total,
    riskLevel: risk,
    numVaults: agents.length,
    vaultData: VAULT_CATALOG,
    marketContext: null,
  })
  const fallbackAllocations = agents.map((a) => ({
    address: a.vault.addr || a.vault.address,
    allocation: a.allocation / total,
    apy: Number(a.vault.apy),
    risk_tier: a.vault.risk,
  }))
  const reward = scoreReward(fallbackAllocations, mdpFullState)
  return {
    agents,
    total,
    blendedApy: blendedApy.toFixed(1),
    risk,
    reward,
    mdpState: {
      turbulence: 'calm',
      signals: [],
      universeSize: VAULT_CATALOG.length,
      riskCeiling: riskCeiling(mdpFullState),
      profileRisk: mdpFullState.profile.riskLevel,
      capitalUsdc: total,
      actionViolations: [],
    },
  }
}

/* ---------- Agent execution state model ---------- */
const STEP_NOTE = { swap: 'Skipped. No swap is needed between USDC assets.' }

const makeInitialExecState = (agents) => {
  const map = {}
  agents.forEach((a) => {
    map[a.id] = {
      status: 'idle', // idle | running | confirmed | failed
      activeStep: null,
      steps: { swap: 'idle', approve: 'idle', deposit: 'idle' },
      hashes: {},
      memory: [], // run log
      metrics: {
        totalRuns: 0,
        successRate: null,
        avgGasCost: 0,
        startedAt: null,
        completedAt: null,
      },
    }
  })
  return map
}

const AgentGraph = PixiSwarmGraph

/* ============================================
   Agent execution legend + summary tiles
   ============================================ */
const AgentTiles = ({ strategy, execMap, onOpenMemory }) => {
  return (
    <div className="agent-tiles">
      {strategy.agents.map((a) => {
        const ex = execMap[a.id] || { status: 'idle', steps: {}, memory: [] }
        const doneSteps = STEP_IDS.filter(
          (sid) => ex.steps?.[sid] === 'confirmed' || ex.steps?.[sid] === 'skipped'
        ).length
        return (
          <button
            key={a.id}
            type="button"
            className={`agent-tile ${ex.status}`}
            onClick={() => onOpenMemory(a.id)}
          >
            <div className="agent-tile-head">
              <span className="idx">{a.idx}</span>
              <span className="name">{a.name}</span>
              <span className={`dot ${ex.status}`} />
            </div>
            <div className="agent-tile-meta mono">
              {a.allocation} USDC, {a.vault.protocol}, {a.vault.apy}%
            </div>
            <div className="agent-tile-steps">
              {STEP_IDS.map((sid) => (
                <span
                  key={sid}
                  className={`agent-step-pip ${ex.steps?.[sid] || 'idle'}`}
                  title={
                    ex.steps?.[sid] === 'skipped'
                      ? STEP_NOTE[sid] || STEP_LABELS[sid]
                      : STEP_LABELS[sid]
                  }
                >
                  {STEP_LABELS[sid].slice(0, 1).toUpperCase()}
                </span>
              ))}
              <span className="agent-tile-progress mono">
                {doneSteps}/{STEP_IDS.length}
              </span>
            </div>
          </button>
        )
      })}
    </div>
  )
}

/* ============================================
   Memory Modal — per-agent execution history
   ============================================ */
const MemoryModal = ({ agentId, strategy, execMap, onClose }) => {
  const agent = strategy.agents.find((a) => a.id === agentId)
  if (!agent) return null
  const ex = execMap[agentId] || { memory: [], metrics: {}, status: 'idle' }
  const stateLabel = {
    idle: 'Queued. No runs yet.',
    running: 'Running. Execution is live.',
    confirmed: 'Completed. All steps confirmed.',
    failed: 'Halted. The last run failed.',
  }[ex.status]

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="memory-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="memory-modal-head">
          <div>
            <div className="modal-eyebrow">Agent memory, {agent.id}</div>
            <h3 className="modal-title">{agent.name}</h3>
            <div className="mono memory-modal-sub">{stateLabel}</div>
          </div>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>

        <div className="memory-metrics">
          <div className="memory-metric">
            <span className="label mono">Runs</span>
            <span className="val tnum mono">{ex.metrics?.totalRuns ?? 0}</span>
          </div>
          <div className="memory-metric">
            <span className="label mono">Success rate</span>
            <span className="val tnum mono">
              {ex.metrics?.successRate == null ? '-' : `${ex.metrics.successRate}%`}
            </span>
          </div>
          <div className="memory-metric">
            <span className="label mono">Gas paid by user</span>
            <span className="val tnum mono">0 XLM, fee-bump relay</span>
          </div>
          <div className="memory-metric">
            <span className="label mono">Vault APY</span>
            <span className="val tnum mono">{agent.vault.apy}%</span>
          </div>
        </div>

        <div className="memory-section-title mono">Execution log</div>
        <div className="memory-log">
          {ex.memory.length === 0 ? (
            <div className="empty">No events yet. Agent queued.</div>
          ) : (
            ex.memory.map((m, i) => (
              <div key={i} className={`memory-row ${m.status}`}>
                <span className="memory-row-marker" />
                <div className="memory-row-body">
                  <div className="memory-row-title">
                    {m.title}
                    <span className="memory-row-tag mono">{displayLabel(m.status)}</span>
                  </div>
                  <div className="memory-row-meta mono">
                    {m.meta}
                    {m.hash && (
                      <>
                        <span className="dot-sep">, </span>
                        <span className="memory-row-hash">tx {shortAddr(m.hash)}</span>
                      </>
                    )}
                  </div>
                  {m.lesson && (
                    <div className="memory-row-lesson mono">
                      <span className="memory-row-lesson-key">Lesson</span> {m.lesson}
                    </div>
                  )}
                </div>
                <span className="memory-row-time mono tnum">{m.t}</span>
              </div>
            ))
          )}
        </div>

        <div className="memory-modal-foot">
          <div className="foot-note">
            Memory is stored on-chain in worker logs and is auditable by skill version.
          </div>
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

/* ============================================
   Strategy card (step 02 result) — multi-agent
   ============================================ */

// Alternate-futures Monte Carlo distribution for the proposed allocation.
// Pure presentational — all numbers come pre-computed from runSimulation (simulation.js).
const SCENARIO_META = {
  bull: { label: 'Bull', tone: 'var(--ok)' },
  base: { label: 'Base', tone: 'var(--text)' },
  bear: { label: 'Bear', tone: 'var(--warn, #c87)' },
}

/* ============================================
   AI Council deliberation panel (step 01)
   Three Venice AI specialists deliberate in parallel on the proposed deposit;
   each emits a compressed verdict citing role-scoped playbook rules. Synthesis
   resolves them into keep/discard. (TradingAgents adaptation — see
   planning/inspiration/TradingAgents.md)
   ============================================ */
const COUNCIL_ROLE_META = {
  yield: { label: 'Yield', glyph: 'Y' },
  risk: { label: 'Risk', glyph: 'R' },
  market: { label: 'Market', glyph: 'M' },
}
const COUNCIL_SIGNAL_TONE = {
  DEPOSIT: 'var(--ok)',
  HOLD: 'var(--warn, #c87)',
  WITHDRAW: 'var(--bad, #ff7479)',
}
const COUNCIL_SIGNAL_PLAIN = {
  DEPOSIT: 'Go',
  HOLD: 'Hold',
  WITHDRAW: 'Exit',
}
const COUNCIL_RESOLVED_LABEL = {
  veto: 'Risk veto',
  unanimous: 'Unanimous',
  weighted: 'Majority',
  'ai-conflict': 'Split, synthesized',
}

/** One short line from a specialist for L2 bullets (max 2–3 total). */
const specialistBullet = (s) => {
  const meta = COUNCIL_ROLE_META[s.role] || { label: s.role }
  const plain = COUNCIL_SIGNAL_PLAIN[s.signal] || s.signal
  const concern = (s.concerns && s.concerns[0]) || null
  if (concern) {
    const short = concern.length > 72 ? `${concern.slice(0, 70)}…` : concern
    return `${meta.label}: ${plain}, ${short}`
  }
  return `${meta.label}: ${plain} (${Math.round((s.confidence || 0) * 100)}%)`
}

const CouncilPanel = ({ council, onRetry }) => {
  if (council === undefined) return null
  const loading = council === null
  const unavailable = !loading && council.verdict === 'unavailable'
  const order = ['yield', 'risk', 'market']
  const specialists =
    loading || unavailable
      ? []
      : [...(council.specialists || [])].sort(
          (a, b) => order.indexOf(a.role) - order.indexOf(b.role)
        )
  const keep = !loading && council.verdict === 'keep'
  const confPct = !loading && !unavailable ? Math.round((council.confidence || 0) * 100) : null
  // L2: up to 3 short bullets · prefer concerns, else signal lines
  const bullets = specialists
    .filter((s) => (s.concerns && s.concerns[0]) || s.signal !== 'DEPOSIT' || !keep)
    .slice(0, 3)
    .map(specialistBullet)
  const fallbackBullets =
    bullets.length > 0 ? bullets : specialists.slice(0, 3).map(specialistBullet)

  return (
    <div className="council-panel">
      {loading ? (
        <div className="council-loading mono">
          <span className="think-spin" /> Checking yield, risk, and market…
        </div>
      ) : unavailable ? (
        <div className="council-hero">
          <div className="council-hero-main">
            <span
              className="council-hero-mark"
              style={{ color: 'var(--text-faint)' }}
              aria-hidden="true"
            >
              <span className="ui-dot" />
            </span>
            <div>
              <div className="council-hero-title">Risk check unavailable</div>
              <div className="council-hero-sub">
                Provider did not respond. You can still continue.
              </div>
            </div>
          </div>
          {onRetry && (
            <button type="button" className="btn btn-ghost council-retry" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      ) : (
        <>
          {/* L1 — verdict only */}
          <div className="council-hero">
            <div className="council-hero-main">
              <span
                className="council-hero-mark"
                style={{ color: keep ? 'var(--ok)' : 'var(--warn, #c87)' }}
                aria-hidden="true"
              >
                {keep ? <Icon name="check" size={15} /> : <span className="ui-dot" />}
              </span>
              <div>
                <div className="council-hero-title">
                  {keep ? 'Risk review passed' : 'Proceed with caution'}
                </div>
                <div className="council-hero-sub">
                  {confPct != null ? `${confPct}% confidence.` : ''}
                  {council.resolvedBy
                    ? ` Resolved by ${(COUNCIL_RESOLVED_LABEL[council.resolvedBy] || displayLabel(council.resolvedBy)).toLowerCase()}.`
                    : ''}
                  {!keep && council.reason
                    ? ` ${displayLabel(council.reason).replace(/[.!?]+$/, '')}.`
                    : ''}
                  {!keep ? ' Your approval is required.' : ''}
                </div>
              </div>
            </div>
            <div className="council-vote mono" aria-label="Specialist votes">
              {specialists.map((s) => {
                const meta = COUNCIL_ROLE_META[s.role] || { label: s.role, glyph: '' }
                return (
                  <span
                    key={s.role}
                    className="council-vote-chip"
                    style={{ color: COUNCIL_SIGNAL_TONE[s.signal] || 'var(--text)' }}
                    title={`${meta.label}: ${s.signal}`}
                  >
                    {meta.glyph ? `${meta.glyph} ` : ''}
                    {COUNCIL_SIGNAL_PLAIN[s.signal] || s.signal}
                  </span>
                )
              })}
            </div>
          </div>

          {/* L2 — short reasons (default visible, still compact) */}
          {fallbackBullets.length > 0 && (
            <ul className="council-why">
              {fallbackBullets.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}

          {/* L3 — full specialist cards */}
          <details className="yv-advanced council-details">
            <summary className="yv-advanced__sum mono">Full specialist breakdown</summary>
            <div className="yv-advanced__body">
              <div className="council-grid">
                {specialists.map((s) => {
                  const meta = COUNCIL_ROLE_META[s.role] || { label: s.role, glyph: '' }
                  return (
                    <div key={s.role} className="council-spec">
                      <div className="council-spec-head mono">
                        <span className="council-spec-role">
                          {meta.glyph ? `${meta.glyph} ` : ''}
                          {meta.label}
                        </span>
                        <span
                          className="council-spec-signal"
                          style={{ color: COUNCIL_SIGNAL_TONE[s.signal] || 'var(--text)' }}
                        >
                          {COUNCIL_SIGNAL_PLAIN[s.signal] || s.signal}
                        </span>
                      </div>
                      <div className="council-spec-conf mono">
                        <div className="council-conf-track">
                          <div
                            className="council-conf-fill"
                            style={{
                              width: `${Math.round(s.confidence * 100)}%`,
                              background: COUNCIL_SIGNAL_TONE[s.signal] || 'var(--text)',
                            }}
                          />
                        </div>
                        <span className="tnum">{Math.round(s.confidence * 100)}%</span>
                      </div>
                      {s.citedRules?.length > 0 && (
                        <div className="council-rules">
                          {s.citedRules.map((id) => (
                            <span key={id} className="council-rule-chip mono">
                              {id}
                            </span>
                          ))}
                        </div>
                      )}
                      {s.concerns?.length > 0 && (
                        <div className="council-concerns mono">{s.concerns.join(', ')}</div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </details>
        </>
      )}
    </div>
  )
}

const SimulationPanel = ({ simulation }) => {
  if (!simulation || !simulation.scenarios?.length) return null
  const { scenarios, expectedValue, probProfit, horizonDays, runs, context } = simulation
  const evTone = expectedValue >= 0 ? 'var(--ok)' : 'var(--warn, #c87)'
  const fmt = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`
  return (
    <div className="sim-panel">
      {/* L1 — headline numbers only */}
      <div className="sim-ev">
        <div className="sim-ev-fig">
          <span className="figure figure-md tnum" style={{ color: evTone }}>
            {fmt(expectedValue)}
            <span className="unit"> USDC</span>
          </span>
          <span className="label mono">Expected net yield</span>
        </div>
        <div className="sim-ev-prob mono">
          <span className="tnum" style={{ color: 'var(--text)' }}>
            {Math.round(probProfit * 100)}%
          </span>
          <span className="label">Chance of profit</span>
        </div>
      </div>

      {/* L2 — scenarios behind disclosure */}
      <details className="yv-advanced council-details">
        <summary className="yv-advanced__sum mono">
          Scenario range, {runs} runs, {horizonDays}d, {context.turbulence}
        </summary>
        <div className="yv-advanced__body">
          <div className="sim-grid">
            {scenarios.map((s) => {
              const meta = SCENARIO_META[s.name] || { label: s.name, tone: 'var(--text)' }
              return (
                <div key={s.name} className="sim-scenario">
                  <div className="sim-scenario-head mono">
                    <span style={{ color: meta.tone }}>{meta.label}</span>
                    <span
                      className="tnum"
                      style={{ color: s.mean >= 0 ? 'var(--ok)' : 'var(--warn, #c87)' }}
                    >
                      {fmt(s.mean)}
                    </span>
                  </div>
                  <div className="sim-band mono">
                    <span className="tnum">{fmt(s.p5)}</span>
                    <span className="sim-band-rule" />
                    <span className="tnum">{fmt(s.p95)}</span>
                  </div>
                  <div className="sim-scenario-foot mono">
                    Low-high range, {Math.round(s.probProfit * 100)}% profit
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </details>
    </div>
  )
}

const DebatePanel = ({ debateResult }) => {
  if (!debateResult?.debateLog?.length) return null
  const {
    debateLog,
    iterations,
    converged,
    proposer,
    riskCompliance,
    validator,
    gate,
    permissionSentence,
    verdict,
    confidence,
  } = debateResult

  const keep = verdict === 'keep'
  const confPct = Math.round((confidence || 0) * 100)
  const why = []
  if (proposer?.reasoning) {
    const r = proposer.reasoning
    why.push(r.length > 90 ? `${r.slice(0, 88)}…` : r)
  }
  if (riskCompliance?.concerns?.[0]) {
    const c = riskCompliance.concerns[0]
    why.push(c.length > 90 ? `${c.slice(0, 88)}…` : c)
  }
  if (gate && !gate.passed && gate.reason) {
    why.push(gate.detail ? `${gate.reason}: ${gate.detail}` : gate.reason)
  }
  if (validator && !validator.consistent) why.push('Validator found inconsistency')
  if (validator && validator.VaRAcceptable === false) why.push('VaR outside limit')
  const topWhy = why.slice(0, 3)

  return (
    <div className="debate-panel council-panel">
      {/* L1 — verdict */}
      <div className="council-hero">
        <div className="council-hero-main">
          <span
            className="council-hero-mark"
            style={{ color: keep ? 'var(--ok)' : 'var(--warn, #c87)' }}
            aria-hidden="true"
          >
            {keep ? <Icon name="check" size={15} /> : <span className="ui-dot" />}
          </span>
          <div>
            <div className="council-hero-title">
              {keep ? 'Risk review: proceed' : 'Risk review: caution'}
            </div>
            <div className="council-hero-sub">
              {confPct}% confidence.
              {gate ? (gate.passed ? ' Checks passed.' : ' Gate flagged.') : ''}
              {converged ? '' : ' The council did not fully converge.'}
              {!keep ? ' Your approval is required.' : ''}
            </div>
          </div>
        </div>
        <div className="council-vote mono">
          {proposer && (
            <span className="council-vote-chip" style={{ color: 'var(--warn, #c90)' }}>
              Plan {Math.round((proposer.confidence || 0) * 100)}%
            </span>
          )}
          {riskCompliance && (
            <span
              className="council-vote-chip"
              style={{
                color:
                  riskCompliance.compliancePass === false ? 'var(--bad, #ff7479)' : 'var(--ok)',
              }}
            >
              Risk {riskCompliance.compliancePass === false ? 'fail' : 'pass'}
            </span>
          )}
        </div>
      </div>

      {permissionSentence && <p className="council-permission">{permissionSentence}</p>}

      {/* L2 — max 3 reasons */}
      {topWhy.length > 0 && (
        <ul className="council-why">
          {topWhy.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

      {/* L3 — raw debate log */}
      <details className="yv-advanced council-details">
        <summary className="yv-advanced__sum">
          Debate details
          {iterations > 1 ? `, ${iterations} passes` : ''}
          {converged ? ', settled' : ''}
        </summary>
        <div className="yv-advanced__body debate-log">
          {debateLog.map((entry, i) => (
            <div key={i} className="debate-round">
              <div className="debate-round-label">
                <span className="debate-round-word">Pass</span>
                <span className="debate-round-num tnum">{entry.iteration}</span>
              </div>
              <div className="debate-round-grid">
                <div className="debate-side debate-side--plan">
                  <div className="debate-side-h">Plan</div>
                  <div className="debate-side-v">
                    <span className="tnum">
                      {entry.proposer?.action || 'Unknown'},{' '}
                      {Math.round((entry.proposer?.confidence ?? 0) * 100)}%
                    </span>
                  </div>
                  {entry.proposer?.reasoning && (
                    <div className="debate-side-body">{entry.proposer.reasoning}</div>
                  )}
                </div>
                <div className="debate-side debate-side--risk">
                  <div className="debate-side-h">Risk</div>
                  <div className="debate-side-v">
                    <span className="tnum">
                      {entry.riskCompliance?.action || 'Unknown'},{' '}
                      {Math.round((entry.riskCompliance?.confidence ?? 0) * 100)}%
                      {entry.riskCompliance?.compliancePass === false ? ', fail' : ''}
                    </span>
                  </div>
                  {entry.riskCompliance?.concerns?.[0] && (
                    <div className="debate-side-body">{entry.riskCompliance.concerns[0]}</div>
                  )}
                </div>
              </div>
            </div>
          ))}
          {(validator || gate) && (
            <div className="debate-meta mono">
              {validator && (
                <span>
                  Validator: {validator.consistent ? 'consistent' : 'inconsistent'}
                  {validator.VaRAcceptable === false ? ', VaR breach' : ''}
                  {validator.CVaRAcceptable === false ? ', CVaR breach' : ''}
                </span>
              )}
              {gate && (
                <span>{gate.passed ? 'Gate passed' : `Gate: ${gate.reason || 'blocked'}`}</span>
              )}
            </div>
          )}
        </div>
      </details>
    </div>
  )
}

const StrategyCard = ({
  strategy,
  skillSource,
  onProceed,
  onRegenerate,
  strategyHash,
  attestation,
  attesting,
  simulation,
  council,
  onCouncilRetry,
  onRunCouncil,
  debateRunning,
  showRunCouncil,
}) => {
  const customSkill = skillSource === 'user-local' || skillSource === 'user-file'
  const shortHash = (h) => (h ? `${h.slice(0, 10)}...` : '')
  const hasDebate = council?.debateLog?.length > 0
  const yearly =
    strategy.reward?.projectedAnnualUsdc ??
    ((Number(strategy.total) * Number(strategy.blendedApy || 0)) / 100).toFixed(2)
  return (
    <section className="rec-card enter">
      <p className="grant-kicker mono">
        Plan ready, {strategy.risk} risk, {strategy.agents.length} vault
        {strategy.agents.length === 1 ? '' : 's'}
        {customSkill ? ', custom' : ''}
      </p>

      <div className="rec-hgroup">
        <div>
          <div className="rec-vault-name">
            Your deposit plan
            <div className="strategy-sub mono">
              {strategy.total} USDC total, one signature next, fees covered
            </div>
          </div>
          <div className="rec-vault-addr">
            Split across {strategy.agents.length} vault
            {strategy.agents.length === 1 ? '' : 's'}. Agents only deposit within your budget.
          </div>
        </div>
        <div className="rec-hgroup-apy">
          <span className="figure figure-md tnum">
            {strategy.blendedApy}
            <span className="unit">% blended APY</span>
          </span>
          <span className="label">About {yearly} USDC/year projected</span>
        </div>
      </div>

      <div className="strategy-agents">
        {strategy.agents.map((a) => (
          <div key={a.id} className="strategy-agent-row">
            <div className="strategy-agent-id">
              <span className="idx mono">{a.idx}</span>
              <div>
                <div className="strategy-agent-name">{a.vault.name}</div>
                <div className="mono strategy-agent-meta">
                  {a.vault.protocol}
                  {a.vault.tvl && a.vault.tvl !== 'N/A' ? `, TVL ${a.vault.tvl}` : ''}
                  {a.vault.isLiveData ? ', live' : ''}
                </div>
              </div>
            </div>
            <div className="strategy-agent-cells">
              <div className="strategy-cell">
                <span className="k mono">Amount</span>
                <span className="v mono tnum">{a.allocation} USDC</span>
              </div>
              <div className="strategy-cell">
                <span className="k mono">APY</span>
                <span className="v mono tnum">{a.vault.apy}%</span>
              </div>
              <div className="strategy-cell">
                <span className="k mono">Risk</span>
                <span className="v mono tnum">{a.vault.drawdown}%</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <details className="yv-advanced">
        <summary className="yv-advanced__sum mono">How this plan was built</summary>
        <div className="yv-advanced__body">
          {strategy.reward && strategy.mdpState && (
            <div
              className="mdp-panel"
              style={{
                marginBottom: 12,
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                overflow: 'hidden',
              }}
            >
              <div
                className="mono"
                style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', fontSize: 11 }}
              >
                <div style={{ padding: '12px 14px', borderRight: '1px solid var(--border)' }}>
                  <div style={{ color: 'var(--text-faint)', marginBottom: 6 }}>Market</div>
                  <div style={{ color: 'var(--text)' }}>
                    {displayLabel(strategy.mdpState.turbulence)}
                  </div>
                  <div style={{ color: 'var(--text-muted)' }}>
                    {strategy.mdpState.universeSize} vaults screened
                  </div>
                </div>
                <div style={{ padding: '12px 14px', borderRight: '1px solid var(--border)' }}>
                  <div style={{ color: 'var(--text-faint)', marginBottom: 6 }}>Bounds</div>
                  <div style={{ color: 'var(--text)' }}>
                    Ceiling, {displayLabel(strategy.mdpState.riskCeiling)}
                  </div>
                  <div style={{ color: 'var(--text-muted)' }}>Weights sum to 1.0</div>
                </div>
                <div style={{ padding: '12px 14px' }}>
                  <div style={{ color: 'var(--text-faint)', marginBottom: 6 }}>Projection</div>
                  <div style={{ color: 'var(--text)' }}>
                    Score, {strategy.reward.riskAdjustedScore}
                  </div>
                  <div style={{ color: 'var(--text-muted)' }}>
                    About {strategy.reward.projectedAnnualUsdc} USDC/year
                  </div>
                </div>
              </div>
            </div>
          )}

          {hasDebate ? (
            <DebatePanel debateResult={council} />
          ) : showRunCouncil ? (
            <div className="risk-review-card">
              {debateRunning ? (
                <div className="risk-review-card__busy">
                  <span className="think-spin" aria-hidden="true" />
                  Review in progress…
                </div>
              ) : (
                <>
                  <div className="risk-review-card__copy">
                    Optional: run a multi-perspective risk review before you continue.
                  </div>
                  <button type="button" className="btn btn-primary" onClick={onRunCouncil}>
                    <span>Run risk review</span>
                  </button>
                </>
              )}
            </div>
          ) : (
            <CouncilPanel council={council} onRetry={onCouncilRetry} />
          )}

          <SimulationPanel simulation={simulation} VaR={simulation?.VaR} CVaR={simulation?.CVaR} />

          {(attestation || attesting || strategyHash) && (
            <div
              className="mono"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                marginTop: 12,
                padding: '9px 12px',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                fontSize: 11,
                color: 'var(--text-muted)',
              }}
            >
              {attestation ? (
                <>
                  <span className="ui-dot" style={{ color: 'var(--ok)' }} aria-hidden="true" />
                  <span>{attestation.label}</span>
                  <span style={{ color: 'var(--text-faint)' }}>, </span>
                  <span>Hash: {attestation.hash}</span>
                  {attestation.explorerUrl ? (
                    <a
                      href={attestation.explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ marginLeft: 'auto', color: 'var(--accent)' }}
                    >
                      View on-chain
                    </a>
                  ) : (
                    <span style={{ color: 'var(--text-faint)', marginLeft: 'auto' }}>
                      Reproducible from strategy JSON
                    </span>
                  )}
                </>
              ) : attesting ? (
                <>
                  <span
                    className="ui-dot"
                    style={{ color: 'var(--text-faint)' }}
                    aria-hidden="true"
                  />
                  <span>Hashing strategy…</span>
                </>
              ) : (
                <>
                  <span
                    className="ui-dot"
                    style={{ color: 'var(--text-faint)' }}
                    aria-hidden="true"
                  />
                  <span>Strategy hash: {shortHash(strategyHash)} (local only)</span>
                </>
              )}
            </div>
          )}
        </div>
      </details>

      <div className="action-row">
        <div className="foot-note">Next: connect wallet, then grant once</div>
        <div className="flex gap-2">
          <button className="btn btn-ghost" onClick={onRegenerate}>
            See alternatives
          </button>
          <button className="btn btn-primary" onClick={onProceed}>
            Continue <Icon name="arrow" size={14} />
          </button>
        </div>
      </div>
    </section>
  )
}

/* ============================================
   ExecuteCard — uses AgentGraph + AgentTiles + Memory
   ============================================ */
const ExecuteCard = ({ strategy, execMap, paletteIsLight, onOpenMemory, onDone }) => {
  const totalSteps = strategy.agents.length * STEP_IDS.length
  const doneSteps = strategy.agents.reduce((acc, a) => {
    const ex = execMap[a.id] || { steps: {} }
    return (
      acc +
      STEP_IDS.filter((sid) => ex.steps?.[sid] === 'confirmed' || ex.steps?.[sid] === 'skipped')
        .length
    )
  }, 0)
  const pct = totalSteps ? (doneSteps / totalSteps) * 100 : 0
  const allDone = doneSteps === totalSteps
  const runningCount = strategy.agents.filter(
    (a) => (execMap[a.id] || {}).status === 'running'
  ).length
  const failedCount = strategy.agents.filter(
    (a) => (execMap[a.id] || {}).status === 'failed'
  ).length
  // Nothing running + at least one failure + not everything done = the run stalled. Without
  // this the live banner says "waiting for relayer" forever (allDone never hits because failed
  // workers never confirm), which is what made the stuck screen look like it was still working.
  const stalled = runningCount === 0 && failedCount > 0 && !allDone

  // Auto-advance to "done" only when execution finishes while viewing — NOT when the user
  // navigates back to an already-completed run via the step rail (would bounce to done).
  const wasDoneOnMount = useRAg(allDone)
  useEAg(() => {
    if (allDone && !wasDoneOnMount.current) {
      const t = setTimeout(onDone, 900)
      return () => clearTimeout(t)
    }
  }, [allDone])

  // Real on-chain txs take time (relayer submit + block confirmation) — surface an
  // elapsed-time counter so the user knows the run is progressing, not stuck.
  const [elapsedMs, setElapsedMs] = useSAg(0)
  useEAg(() => {
    if (allDone) return
    const startedAt = Date.now()
    const t = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000)
    return () => clearInterval(t)
  }, [allDone])

  return (
    <section className="card enter exec-card-wrap">
      <p className="grant-kicker mono">Depositing, fees covered</p>

      <div className="exec-header">
        <div>
          <h1 className="h-display" style={{ fontSize: 28, marginTop: 4 }}>
            {allDone
              ? 'Deposits confirmed'
              : stalled
                ? 'Some deposits need attention'
                : 'Depositing your USDC'}
          </h1>
          <p className="lede" style={{ marginTop: 10, maxWidth: 520 }}>
            {allDone
              ? 'Funds are in the vaults. Monitoring continues under your grant.'
              : 'Workers deposit in parallel. You already signed the budget once; no more popups.'}
          </p>
          {!allDone && stalled && (
            <div className="exec-live-status mono" style={{ color: 'var(--danger, #e5484d)' }}>
              <span>
                {failedCount} failed, {fmtCountdown(elapsedMs)} elapsed, open a card for details
              </span>
            </div>
          )}
          {!allDone && !stalled && (
            <div className="exec-live-status mono">
              <span className="think-spin" />
              <span>
                {runningCount > 0 ? `${runningCount} confirming on-chain` : 'Waiting for network'}
                {', '}
                {fmtCountdown(elapsedMs)} elapsed
              </span>
            </div>
          )}
        </div>
        <div className="exec-progress">
          <span className="label">Progress</span>
          <span className={`value ${allDone ? 'done' : ''}`}>
            {doneSteps}/{totalSteps}
          </span>
          <div className="exec-progress-bar">
            <div className="exec-progress-bar-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>

      <AgentGraph
        strategy={strategy}
        execMap={execMap}
        onAgentClick={onOpenMemory}
        paletteIsLight={paletteIsLight}
      />

      <div className="agent-legend mono">
        <span className="legend-item">
          <span className="dot idle" /> Idle
        </span>
        <span className="legend-item">
          <span className="dot running" /> Running
        </span>
        <span className="legend-item">
          <span className="dot confirmed" /> Confirmed
        </span>
        <span className="legend-item">
          <span className="dot failed" /> Failed
        </span>
        <span className="legend-spacer" />
        <span className="legend-hint">Click a node for details</span>
      </div>

      <AgentTiles strategy={strategy} execMap={execMap} onOpenMemory={onOpenMemory} />
    </section>
  )
}

// ── Autonomous monitor-loop status — NEVER-STOP loop + AI Council made visible ──
// Live panel: a 1s internal ticker drives the heartbeat countdown so the loop
// reads as alive between cycles (default heartbeat is minutes apart). The
// pipeline rail lights the phase reported by monitorLoop's onPhase hook.
// Props: { running, cycle, summary, rows, phase, nextTickAt, heartbeatMs }
// where rows are newest-first records from cycleJournal.getCycles().
const LOOP_PHASES = ['observe', 'gate', 'simulate', 'council', 'execute', 'reflect']

const fmtCountdown = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const agoLabel = (ts, now) => {
  if (!ts) return 'Just now'
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 5) return 'Just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

const loopRowDetail = (r) => {
  const rules = (r.citedRules || []).join(', ')
  if (r.verdict === 'crash') return r.error || 'Crashed. The loop recovered.'
  if (r.verdict === 'gated')
    return `${displayLabel(r.gate, 'Gate')}: ${r.reason || 'Blocked before council'}. AI was not called.`
  if (r.verdict === 'discard')
    return `${r.reason || 'Council declined'}${rules ? `, ${rules}` : ''}`
  if (r.verdict === 'keep')
    return `Score ${r.score ?? '--'}, ${rules || '--'}, tx ${(r.txHash || '').slice(0, 10)}…`
  return `Observed market: ${displayLabel(r.turbulence, 'Calm')}. No action needed.`
}

const LoopStatusPanel = ({
  running,
  summary,
  rows,
  phase,
  nextTickAt,
  heartbeatMs,
  decisionsRows,
  decisionsSummary,
}) => {
  // Internal 1s clock — the countdown and relative timestamps tick even when
  // the loop itself sleeps, which is what makes the panel feel alive.
  const [now, setNow] = useSAg(() => Date.now())
  const [showLogsModal, setShowLogsModal] = useSAg(() => false)

  useEAg(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  useEAg(() => {
    if (!showLogsModal) return
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setShowLogsModal(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [showLogsModal])

  const cycling = Boolean(phase && phase !== 'sleep')
  const remaining = running && nextTickAt ? Math.max(0, nextTickAt - now) : null
  const pctElapsed =
    running && heartbeatMs && remaining != null
      ? Math.min(100, Math.max(0, 100 - (remaining / heartbeatMs) * 100))
      : 0
  const lastTs = rows && rows.length ? rows[0].ts : null
  const activeIdx = LOOP_PHASES.indexOf(phase)
  const latestVerdict = rows && rows.length ? rows[0].verdict : null
  const latestReason = rows && rows.length ? rows[0].reason : ''

  return (
    <div className={`loop-status embedded ${running ? 'is-running' : 'is-stopped'}`}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        {running ? (
          <div className="loop-vitals" style={{ margin: 0 }}>
            <span className={`loop-countdown ${cycling ? 'busy' : ''}`}>
              {cycling
                ? 'Cycle running now'
                : remaining != null
                  ? `Next cycle in ${fmtCountdown(remaining)}`
                  : 'Awaiting first heartbeat'}
            </span>
            <span className="loop-last">Last activity: {agoLabel(lastTs, now)}</span>
          </div>
        ) : (
          <div
            style={{ fontSize: '11px', color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}
          >
            Loop is stopped
          </div>
        )}

        <button
          className="btn btn-ghost"
          onClick={() => setShowLogsModal(true)}
          style={{
            padding: '6px 12px',
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
            borderColor: 'var(--border-strong)',
            color: 'var(--accent)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            height: '28px',
            background: 'var(--bg-elev)',
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
          Decision log
        </button>
      </div>

      {running && (
        <div
          className={`loop-heartbeat-track ${cycling ? 'cycling' : ''}`}
          style={{ marginBottom: 12 }}
        >
          <div
            className="loop-heartbeat-fill"
            style={{ width: `${cycling ? 100 : pctElapsed}%` }}
          />
        </div>
      )}
      <style>{`
        .vf-flowchart-grid {
          display: grid;
          grid-template-columns: 1fr auto 1fr auto 1fr auto 1fr auto 1fr auto 1fr;
          gap: 10px 4px;
          align-items: center;
          margin: 18px 0;
          padding: 14px 10px;
          background: rgba(255, 255, 255, 0.015);
          border: 1.5px solid var(--border);
          border-radius: var(--radius-md);
          position: relative;
        }
        .vf-flowchart-node {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 8px 4px;
          border-radius: 6px;
          border: 1px solid var(--border);
          background: var(--bg-card);
          text-align: center;
          min-height: 48px;
          transition: all 0.3s ease;
          position: relative;
        }
        .vf-flowchart-node.active {
          border-color: var(--accent);
          background: rgba(207, 255, 61, 0.03);
          box-shadow: 0 0 10px rgba(207, 255, 61, 0.1);
        }
        .vf-flowchart-node.active-done {
          border-color: var(--accent);
          background: rgba(207, 255, 61, 0.01);
          opacity: 0.8;
        }
        .vf-flowchart-node.highlighted-ok {
          border-color: var(--ok);
          background: rgba(0, 230, 115, 0.03);
        }
        .vf-flowchart-node.highlighted-warn {
          border-color: var(--warn);
          background: rgba(214, 163, 56, 0.03);
        }
        .vf-flowchart-node.highlighted-danger {
          border-color: var(--danger);
          background: rgba(230, 50, 50, 0.03);
        }
        .vf-node-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 16px;
          height: 16px;
          margin-bottom: 2px;
          color: var(--text-faint);
        }
        .active .vf-node-icon { color: var(--accent); }
        .highlighted-ok .vf-node-icon { color: var(--ok); }
        .highlighted-warn .vf-node-icon { color: var(--warn); }
        .highlighted-danger .vf-node-icon { color: var(--danger); }
        .vf-node-label {
          font-size: 9px;
          font-weight: 600;
          letter-spacing: 0.01em;
          color: var(--text-muted);
        }
        .active .vf-node-label { color: var(--text); }
        .vf-flowchart-arrow {
          font-size: 11px;
          color: var(--text-faint);
          text-align: center;
          user-select: none;
        }
        .vf-flowchart-arrow.active {
          color: var(--accent);
          text-shadow: 0 0 4px var(--accent);
          animation: pulse-arrow 1.5s ease-in-out infinite;
        }
        @keyframes pulse-arrow {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }
        .vf-flowchart-branch-line {
          display: flex;
          justify-content: center;
          color: var(--text-faint);
          height: 14px;
        }
        .vf-flowchart-branch-line.active {
          color: var(--accent);
        }
        .vf-flowchart-exit-node {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          border-radius: 6px;
          border: 1px dashed var(--border);
          background: rgba(0, 0, 0, 0.15);
          min-height: 40px;
          transition: all 0.3s ease;
        }
        .vf-flowchart-exit-node.active {
          border-style: solid;
        }
        .vf-flowchart-exit-node.gated.active {
          border-color: var(--warn);
          background: rgba(214, 163, 56, 0.05);
          box-shadow: 0 0 10px rgba(214, 163, 56, 0.1);
        }
        .vf-flowchart-exit-node.discarded.active {
          border-color: var(--danger);
          background: rgba(230, 50, 50, 0.05);
          box-shadow: 0 0 10px rgba(230, 50, 50, 0.1);
        }
        .vf-exit-title {
          font-size: 9px;
          font-weight: 700;
          color: var(--text-faint);
          text-align: left;
        }
        .active .vf-exit-title { color: var(--text); }
        .vf-exit-desc {
          font-size: 8px;
          color: var(--text-faint);
          white-space: nowrap;
          text-overflow: ellipsis;
          overflow: hidden;
          max-width: 90px;
          text-align: left;
          margin-top: 1px;
        }
        @media (max-width: 768px) {
          .vf-flowchart-grid {
            grid-template-columns: 1fr !important;
            grid-template-rows: auto !important;
            gap: 10px !important;
          }
          .vf-flowchart-arrow {
            transform: rotate(90deg);
            margin: 2px 0;
          }
          .vf-flowchart-branch-line {
            display: none !important;
          }
          .vf-flowchart-exit-node {
            grid-column: span 1 !important;
            grid-row: auto !important;
            max-width: 100% !important;
            margin: -4px 0 6px 14px;
            border-style: solid;
          }
          .vf-gate-down-line, .vf-council-down-line, .vf-gated-exit-node, .vf-discarded-exit-node {
            grid-row: auto !important;
            grid-column: auto !important;
          }
        }
        .decision-modal-grid {
          display: grid;
          grid-template-columns: 1fr 1.2fr;
          gap: 24px;
          align-items: start;
        }
        @media (max-width: 768px) {
          .decision-modal-grid {
            grid-template-columns: 1fr;
            gap: 20px;
          }
        }
        .decision-log-trigger:hover {
          border-color: var(--accent) !important;
          box-shadow: 0 0 10px rgba(207, 255, 61, 0.15) !important;
        }
      `}</style>

      {running && (
        <div className="loop-vitals">
          <span className={`loop-countdown ${cycling ? 'busy' : ''}`}>
            {cycling
              ? 'Cycle running now'
              : remaining != null
                ? `Next cycle in ${fmtCountdown(remaining)}`
                : 'Awaiting first heartbeat'}
          </span>
          <span className="loop-last">Last activity: {agoLabel(lastTs, now)}</span>
        </div>
      )}
      {running && (
        <div className={`loop-heartbeat-track ${cycling ? 'cycling' : ''}`}>
          <div
            className="loop-heartbeat-fill"
            style={{ width: `${cycling ? 100 : pctElapsed}%` }}
          />
        </div>
      )}

      {/* Visual Pipeline Flowchart */}
      <div
        className={`vf-flowchart-grid ${!running ? 'off' : cycling ? 'cycling' : 'sleeping'}`}
        style={{ opacity: running ? 1 : 0.5 }}
      >
        {/* Stage 1: Observe */}
        <div
          className={`vf-flowchart-node observe ${phase === 'observe' ? 'active' : cycling && activeIdx > 0 ? 'active-done' : ''} ${!cycling && latestVerdict === 'idle' ? 'highlighted-ok' : ''}`}
          style={{ gridRow: 1, gridColumn: 1 }}
          title="Monitors pool APY, TVL, and utilization triggers"
        >
          <span className="vf-node-icon">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </span>
          <span className="vf-node-label">Observe</span>
        </div>

        {/* Arrow 1 */}
        <div
          className={`vf-flowchart-arrow ${running && (phase === 'gate' || activeIdx > 1) ? 'active' : ''}`}
          style={{ gridRow: 1, gridColumn: 2 }}
        >
          →
        </div>

        {/* Stage 2: Gate Check */}
        <div
          className={`vf-flowchart-node gate ${phase === 'gate' ? 'active' : cycling && activeIdx > 1 ? 'active-done' : ''} ${!cycling && latestVerdict === 'gated' ? 'highlighted-warn' : ''}`}
          style={{ gridRow: 1, gridColumn: 3 }}
          title="Evaluates risk guardrails (e.g. utilization limits)"
        >
          <span className="vf-node-icon">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </span>
          <span className="vf-node-label">Gate Check</span>
        </div>

        {/* Arrow 2 */}
        <div
          className={`vf-flowchart-arrow ${running && activeIdx > 1 && latestVerdict !== 'gated' && (phase === 'simulate' || activeIdx > 2) ? 'active' : ''}`}
          style={{ gridRow: 1, gridColumn: 4 }}
        >
          →
        </div>

        {/* Stage 3: Simulate */}
        <div
          className={`vf-flowchart-node simulate ${phase === 'simulate' ? 'active' : cycling && activeIdx > 2 ? 'active-done' : ''} ${!cycling && latestVerdict === 'keep' ? 'highlighted-ok' : ''}`}
          style={{ gridRow: 1, gridColumn: 5 }}
          title="Runs allocation model and Monte Carlo simulations"
        >
          <span className="vf-node-icon">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 3v18h18" />
              <path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3" />
            </svg>
          </span>
          <span className="vf-node-label">Simulate</span>
        </div>

        {/* Arrow 3 */}
        <div
          className={`vf-flowchart-arrow ${running && activeIdx > 2 && latestVerdict !== 'gated' && (phase === 'council' || activeIdx > 3) ? 'active' : ''}`}
          style={{ gridRow: 1, gridColumn: 6 }}
        >
          →
        </div>

        {/* Stage 4: AI Council */}
        <div
          className={`vf-flowchart-node council ${phase === 'council' ? 'active' : cycling && activeIdx > 3 ? 'active-done' : ''} ${!cycling && latestVerdict === 'discard' ? 'highlighted-danger' : ''}`}
          style={{ gridRow: 1, gridColumn: 7 }}
          title="Yield, Risk, and Market agents deliberate on-chain allocation"
        >
          <span className="vf-node-icon">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </span>
          <span className="vf-node-label">AI Council</span>
        </div>

        {/* Arrow 4 */}
        <div
          className={`vf-flowchart-arrow ${running && activeIdx > 3 && !['gated', 'discard'].includes(latestVerdict) && (phase === 'execute' || activeIdx > 4) ? 'active' : ''}`}
          style={{ gridRow: 1, gridColumn: 8 }}
        >
          →
        </div>

        {/* Stage 5: Execute */}
        <div
          className={`vf-flowchart-node execute ${phase === 'execute' ? 'active' : cycling && activeIdx > 4 ? 'active-done' : ''} ${!cycling && latestVerdict === 'keep' ? 'highlighted-ok' : ''}`}
          style={{ gridRow: 1, gridColumn: 9 }}
          title="Executes on-chain rebalances and deposit swaps"
        >
          <span className="vf-node-icon">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </span>
          <span className="vf-node-label">Execute</span>
        </div>

        {/* Arrow 5 */}
        <div
          className={`vf-flowchart-arrow ${running && activeIdx > 4 && latestVerdict === 'keep' && (phase === 'reflect' || activeIdx > 5) ? 'active' : ''}`}
          style={{ gridRow: 1, gridColumn: 10 }}
        >
          →
        </div>

        {/* Stage 6: Reflect */}
        <div
          className={`vf-flowchart-node reflect ${phase === 'reflect' ? 'active' : ''} ${!cycling && latestVerdict === 'keep' ? 'highlighted-ok' : ''}`}
          style={{ gridRow: 1, gridColumn: 11 }}
          title="Saves memory logs and refines future strategy runs"
        >
          <span className="vf-node-icon">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </span>
          <span className="vf-node-label">Reflect</span>
        </div>
      </div>

      {showLogsModal && (
        <div className="modal-backdrop" onClick={() => setShowLogsModal(false)}>
          <div
            className="modal decision-modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 880, width: '92%', padding: '24px', position: 'relative' }}
          >
            <button
              onClick={() => setShowLogsModal(false)}
              aria-label="Close"
              style={{
                position: 'absolute',
                top: '20px',
                right: '20px',
                background: 'transparent',
                border: 'none',
                color: 'var(--text-faint)',
                cursor: 'pointer',
                fontSize: '12px',
                fontFamily: 'var(--font-mono)',
              }}
            >
              <Icon name="x" size={14} />
            </button>
            <div className="modal-eyebrow">Autonomous monitoring logs</div>
            <h3 className="modal-title" style={{ marginBottom: 20 }}>
              Decision log and heartbeat console
            </h3>

            <div className="modal-scroll-content" style={{ maxHeight: '68vh', overflowY: 'auto' }}>
              <div className="decision-modal-grid">
                {/* Left Column: Heartbeat Ticker */}
                <div className="decision-modal-left">
                  <div
                    style={{
                      fontSize: '11px',
                      fontWeight: '700',
                      textTransform: 'uppercase',
                      color: 'var(--text-faint)',
                      letterSpacing: '0.05em',
                      marginBottom: 12,
                    }}
                  >
                    Heartbeat ticker
                  </div>

                  <div
                    className="loop-chips"
                    style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}
                  >
                    <span className="loop-chip keep">Keep {summary.keep}</span>
                    <span className="loop-chip discard">Discard {summary.discard}</span>
                    <span className="loop-chip gated">Gated {summary.gated || 0}</span>
                    <span className="loop-chip crash">Crash {summary.crash}</span>
                    <span className="loop-chip idle">Observe {summary.idle}</span>
                  </div>

                  <div className="loop-rows" style={{ maxHeight: 380, overflowY: 'auto' }}>
                    {(rows || []).map((r, i) => (
                      <div className="loop-row" key={r.ts || i}>
                        <span className="loop-row-num">#{String(r.cycle).padStart(2, '0')}</span>
                        <span className={`loop-badge ${r.verdict}`}>
                          {r.verdict === 'idle' ? 'Observe' : displayLabel(r.verdict)}
                        </span>
                        <span className="loop-row-detail" title={loopRowDetail(r)}>
                          {loopRowDetail(r)}
                        </span>
                        <span className="loop-row-time">{agoLabel(r.ts, now)}</span>
                      </div>
                    ))}
                    {(!rows || rows.length === 0) && (
                      <div className="loop-empty">
                        {running
                          ? `No cycles journaled yet. First heartbeat ${remaining != null ? `in ${fmtCountdown(remaining)}` : 'arriving shortly'}. The loop observes, gates, simulates, asks the council, then acts only on a keep verdict.`
                          : 'Loop is stopped. It starts automatically while the agent is enabled and positions are held.'}
                      </div>
                    )}
                  </div>
                </div>

                {/* Right Column: AI Council Decision Log */}
                <div className="decision-modal-right">
                  <div
                    style={{
                      fontSize: '11px',
                      fontWeight: '700',
                      textTransform: 'uppercase',
                      color: 'var(--text-faint)',
                      letterSpacing: '0.05em',
                      marginBottom: 12,
                    }}
                  >
                    AI Council decisions
                  </div>
                  <DecisionLogPanel rows={decisionsRows} summary={decisionsSummary} />
                </div>
              </div>
            </div>

            <div className="modal-actions" style={{ marginTop: 20 }}>
              <button
                className="btn btn-ghost"
                onClick={() => setShowLogsModal(false)}
                style={{ marginLeft: 'auto' }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const SIGNAL_CLASS = { DEPOSIT: 'keep', HOLD: 'gated', WITHDRAW: 'discard' }

const DecisionLogPanel = ({ rows, summary }) => {
  const [now, setNow] = useSAg(() => Date.now())
  const [open, setOpen] = useSAg(() => null)
  useEAg(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const byAgent = summary?.byAgent || {}
  return (
    <div className="decision-log">
      <div className="decision-agents">
        {['yield', 'risk', 'market'].map((role) => {
          const t = byAgent[role] || { DEPOSIT: 0, HOLD: 0, WITHDRAW: 0 }
          return (
            <div className="decision-agent" key={role}>
              <span className="decision-agent-role mono">{displayLabel(role)}</span>
              <span className="decision-agent-tally mono">
                <span className="keep">{t.DEPOSIT}</span>, <span className="gated">{t.HOLD}</span>,{' '}
                <span className="discard">{t.WITHDRAW}</span>
              </span>
            </div>
          )
        })}
      </div>

      <div className="decision-rows">
        {(rows || []).map((r) => (
          <div className={`decision-row ${open === r.id ? 'open' : ''}`} key={r.id}>
            <button
              className="decision-row-head"
              onClick={() => setOpen(open === r.id ? null : r.id)}
            >
              <span className="decision-row-num mono">#{String(r.cycle).padStart(2, '0')}</span>
              <span className={`decision-badge ${r.finalDecision === 'keep' ? 'keep' : 'discard'}`}>
                {displayLabel(r.finalDecision)}
              </span>
              <span className="decision-row-maj mono">
                {r.majoritySignal}, {r.majorityCount} votes
              </span>
              <span className="decision-row-conf tnum mono">
                {Math.round((r.avgConfidence || 0) * 100)}%
              </span>
              <span className="decision-row-by mono">{displayLabel(r.resolvedBy)}</span>
              <span className="decision-row-time">{agoLabel(r.ts, now)}</span>
            </button>
            {open === r.id && (
              <div className="decision-verdicts">
                {(r.verdicts || []).map((v) => (
                  <div className={`decision-verdict ${SIGNAL_CLASS[v.signal] || ''}`} key={v.role}>
                    <span className="decision-verdict-role mono">{displayLabel(v.role)}</span>
                    <span className="decision-verdict-conf tnum mono">
                      {Math.round((v.confidence || 0) * 100)}%
                    </span>
                    <span className="decision-verdict-summary">{v.summary}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {(!rows || rows.length === 0) && (
          <div className="decision-empty">
            No council decisions yet. Each keep or discard verdict from the autonomous loop is
            logged here with all three specialist opinions.
          </div>
        )}
      </div>
    </div>
  )
}

export {
  LoopStatusPanel,
  DecisionLogPanel,
  AgentGraph,
  AgentTiles,
  MemoryModal,
  StrategyCard,
  ExecuteCard,
  buildStrategy,
  makeInitialExecState,
  AGENT_PROTOCOLS,
  STEP_IDS,
  STEP_LABELS,
  rebalancePulseKey,
  buildAutofarmGraphData,
}
