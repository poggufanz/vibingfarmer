// frontend/src/components/strategy/PlanStage.jsx
// Strategy Task 10 (Pocket Crew redesign, Wave 5). The first-visit "Plan" surface: one dominant
// Harvest decision (amount + comfort level) asks the next question, generation is driven by the
// caller's real promise (never an artificial `speed * ...` delay -- compare app.jsx's legacy
// ThinkingCard, which this surface replaces), and the reviewed plan is composed as truthful rows
// and disclosures, never a grid of equal cards.
//
// Base availability is CONSUMED, never re-derived: the `base` prop is the caller's already
// resolved view (Task 9's `toBaseMandateView` + `mergeFlowHelpers.resolveBaseAvailability`'s
// `mandateView`/`action`, `mergeFlowHelpers.needsBaseMandateSetup`'s gate). This component only
// reads `connected`/`healthy`/`mandateView.ready`/`action` off of that -- it never reimplements
// relayer-health, mandate, or funding rules itself.
import { useRef, useState } from 'react'
import { MoneyFigure, StatusNotice, TechnicalDetails, VenueTruth } from '../pocket/Primitives.jsx'
import { NetworkBadge, NetworkRoute } from '../pocket/NetworkIdentity.jsx'
import { AgentMark } from '../pocket/AgentMark.jsx'
import {
  RISK_PROFILES,
  normalizeStrategyPlan,
  buildStrategyViewModel,
} from '../../strategy/planModel.js'
import { venueYield } from '../../strategy/venueTruth.js'
import {
  validateAmountInput,
  validateExecutionAllocations,
} from '../../strategy/amountValidation.js'
import { needsBaseMandateSetup } from '../../mergeFlowHelpers.js'
import { hashStrategy } from '../../attestation.js'

const RISK_IDS = Object.keys(RISK_PROFILES) // ['low', 'med', 'high'] -> Steady/Balanced/Adventurous

const GENERATION_PHASES = Object.freeze([
  'Checking destinations',
  'Building bounded allocations',
  'Safety review',
])

function defaultInstruction(agent) {
  return agent.kind === 'bridge'
    ? 'Bridge USDC to the allowlisted Base custody proxies via Circle CCTP v2, then stop.'
    : 'Deposit into the Autofarm vault and hold. Do not withdraw automatically.'
}

// Fix loop N -- item 4 (owner report): a raw ISO instant ("Expires 2026-07-28T02:54:50.000Z") is
// not something a non-technical user reads at a glance. Intl.RelativeTimeFormat covers the two
// single-unit cases directly (under an hour; a day or more); it has no built-in way to combine two
// units into one phrase, so the common "a few hours left" case (the owner's own example, "Expires
// in 2h 4m") is composed by hand from the same diff -- no new dependency, no invented
// duration-formatting library. Intl.DateTimeFormat renders the absolute LOCAL time (the runtime's
// own locale/timezone, never hardcoded) as the secondary/tooltip text.
function formatExpiry(expirySeconds, nowMs = Date.now()) {
  if (!Number.isFinite(expirySeconds)) return { relative: 'Unknown', absolute: null }
  const absolute = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(expirySeconds * 1000))
  const diffSeconds = expirySeconds - Math.floor(nowMs / 1000)
  if (diffSeconds <= 0) return { relative: 'Expired', absolute }
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const days = Math.floor(diffSeconds / 86400)
  if (days >= 1) return { relative: rtf.format(days, 'day'), absolute }
  const totalMinutes = Math.max(1, Math.round(diffSeconds / 60))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours < 1) return { relative: rtf.format(minutes, 'minute'), absolute }
  const relative = minutes > 0 ? `in ${hours}h ${minutes}m` : rtf.format(hours, 'hour')
  return { relative, absolute }
}

// Fix loop N -- item 3 (owner report): the old `unitsToDisplay` did `Number(units) / 10 **
// decimals` straight into the Cap line with no rounding at all -- a 100/3 split showed one
// worker's raw remainder digit (...334) beside its siblings' (...333), and neither was formatted
// to money's usual 2dp. `splitEven` (planModel.js) stays exact BigInt for the real grant scope --
// this is a DISPLAY-ONLY remainder redistribution, computed once per render and looked up per row,
// never touching the units that become a grant/burn amount (planModel.js:188's `totalUnits`
// exactness is untouched -- nothing here feeds back into the plan). Grouped by kind: only
// same-kind agents were ever split from the same total by splitEven's single call in
// expandAgentSlots, so a lone bridge cap is a group of one -- it just rounds, nothing to
// redistribute.
// Fix round 1 -- cheap fix (reviewer finding): `cap.decimals`/`allocation.decimals` are always
// `stellarDecimals` (7) for every agent expandAgentSlots creates (planModel.js:104/124) -- fewer
// than 2 is unreachable today -- but a negative BigInt exponent throws RangeError, which would
// take the whole Plan stage render down. Guarded rather than left as a latent throw on a money path.
function roundCentsBigInt(units, decimals) {
  if (decimals < 2) return BigInt(units) * 10n ** BigInt(2 - decimals)
  const denom = 10n ** BigInt(decimals - 2)
  return (BigInt(units) + denom / 2n) / denom
}

function formatCents(cents) {
  const negative = cents < 0n
  const abs = negative ? -cents : cents
  const whole = abs / 100n
  const frac = (abs % 100n).toString().padStart(2, '0')
  return `${negative ? '-' : ''}${whole}.${frac}`
}

// Fix round 1 -- I-2 (reviewer finding): generalized from a Cap-only `buildCapDisplayMap` so the
// SAME redistribute-the-remainder-onto-the-last-agent treatment applies to whichever amount field
// the caller names -- `cap` and `allocation` happen to hold equal units today
// (expandAgentSlots sets both from the same `units` value), but the I8 regression test's own
// premise is that they may diverge, so this reads whichever field it's told, never assumes.
function buildAmountDisplayMap(planAgents, amountKey) {
  const map = {}
  const byKind = new Map()
  for (const agent of planAgents) {
    const list = byKind.get(agent.kind) || []
    list.push(agent)
    byKind.set(agent.kind, list)
  }
  for (const group of byKind.values()) {
    const cents = group.map((a) => roundCentsBigInt(a[amountKey].units, a[amountKey].decimals))
    const exactUnits = group.reduce((s, a) => s + BigInt(a[amountKey].units), 0n)
    const exactCents = roundCentsBigInt(exactUnits, group[0][amountKey].decimals)
    const diff = exactCents - cents.reduce((s, c) => s + c, 0n)
    cents[cents.length - 1] += diff
    group.forEach((a, i) => {
      map[a.allocationId] = formatCents(cents[i])
    })
  }
  return map
}

// Fix loop N -- item 5 (owner report): crew character names, easily editable in one place. No
// name data exists anywhere else in the model -- planModel.js only ever produces positional
// "Worker N" labels -- so this is this fix's own addition: one obvious exported constant, not
// scattered literals. Indexed by POSITION within a plan's own agent order (0-based) -- decorative
// crew flavor only, never an identity claim (AgentMark's own crew-color fill/dedup already keys
// off the agent's real allocationId, never this list).
export const CREW_NAMES = Object.freeze(['Sprout', 'Clover', 'Mochi', 'Pepper', 'Juniper', 'Basil'])

function crewNameFor(index) {
  return CREW_NAMES[index % CREW_NAMES.length]
}

// Fix loop 1 -- I2 (review finding): the domain has three source states
// ('live-ai'|'deterministic'|'cached', see planModel.js), not two. Collapsing 'cached' into the
// same "Safe default plan"/"Fallback" label as a genuine deterministic fallback is a false
// provenance claim -- a cached LIVE result is not a fallback.
function sourceBadgeCopy(sourceState) {
  if (sourceState === 'live-ai') return 'Live AI + live market checks'
  if (sourceState === 'cached') return 'Live AI (cached)'
  return 'Safe default plan'
}

function sourceFreshness(sourceState) {
  if (sourceState === 'live-ai') return 'Live'
  if (sourceState === 'cached') return 'Cached'
  return 'Fallback'
}

const BRIDGE_NETWORK_CONTEXT = Object.freeze({
  hostNetworkId: 'stellar-testnet',
  sourceNetworkId: 'stellar-testnet',
  destinationNetworkId: 'base-sepolia',
  custodyNetworkId: 'stellar-testnet',
  transitState: 'source',
})

export function PlanStage({
  vaultTotalShares = null,
  stellarVenue,
  base = { connected: false, healthy: null, mandateView: null, action: null },
  // Fix loop 1 -- I4 (review finding): Task 2's ruling is that `runId` "means one REVIEWED
  // execution" and is "created by the caller at review time," never minted in this component.
  // Falls through to planModel.js's own 'unrun' fallback when omitted (allocationId(runId, ...)),
  // same stable behavior the tests already relied on -- just no wall clock involved.
  runId,
  onGenerate,
  onRetryLive,
  onAcceptPlan,
  onConnectForBase,
  onSetupBase,
  onRebuildPlan,
  // Injectable so a test can substitute a plain deterministic stub -- the real hashStrategy
  // shells out to @stellar/stellar-sdk's sha256, which needs a real Node/browser Uint8Array
  // realm; a jsdom test-environment render is otherwise a fine place to exercise everything
  // else in this component. Production always gets the real, canonical hashStrategy by default.
  hashPlan = hashStrategy,
}) {
  const [amountValue, setAmountValue] = useState('')
  const [risk, setRisk] = useState(null)
  const [phase, setPhase] = useState('input') // 'input' | 'generating' | 'ready' | 'error'
  const [fieldError, setFieldError] = useState(null)
  const [generationError, setGenerationError] = useState(null)
  // Fix loop 1 -- I10: index into GENERATION_PHASES once the caller has actually reported one via
  // the `reportPhase` callback runGeneration hands it; null while nothing real has been observed
  // yet, so we never claim to show progress we can't prove.
  const [generationPhase, setGenerationPhase] = useState(null)
  const [plan, setPlan] = useState(null)
  const [instructions, setInstructions] = useState({})
  const submissionRef = useRef(null) // last validated { amountUnits, risk }, reused by retry
  const radioRefs = useRef([]) // roving-tabindex focus targets, one per RISK_IDS entry

  const baseConnected = base?.connected === true
  const baseHealthy = base?.healthy === true
  const mandateReady = base?.mandateView?.ready === true
  // The single derived gate every generation call reads -- computed once, here, from the
  // caller's already-canonical Base view. Never re-derived per render from raw health/mandate
  // fields anywhere else in this component.
  const baseEligible = baseConnected && baseHealthy && mandateReady
  const showBaseSetup =
    baseConnected && needsBaseMandateSetup({ healthy: base?.healthy, mandateOk: mandateReady })
  const planInvalidated = phase === 'ready' && Boolean(base?.action?.invalidatesPlan)

  const canSubmit = amountValue.trim() !== '' && Boolean(risk) && phase !== 'generating'
  const viewModel = plan ? buildStrategyViewModel({ plan, stellarVenue }) : null
  const executionCheck = plan ? validateExecutionAllocations({ plan, vaultTotalShares }) : null
  const canAccept = phase === 'ready' && !planInvalidated && executionCheck?.ok === true
  const stellarYield = venueYield(stellarVenue)
  // Items 3/6/8 (owner report): computed once per render, looked up per row/once for the hoisted
  // summary -- never recomputed per call site. `depositAgents`/`planExpiry` back the hoisted
  // network+expiry+yield summary (every agent from one generation shares the same expiry --
  // expandAgentSlots applies a single `expiry` value to every agent it creates in one call).
  const capDisplay = plan ? buildAmountDisplayMap(plan.agents, 'cap') : null
  // I-2 (reviewer finding): the per-row MoneyFigure ("33.333 USDC") stacked its own unrounded 3dp
  // on top of Cap's now-correct 2dp, and the three allocations summed to 99.999 against the
  // header's 100 USDC -- the owner's "format every displayed amount to 2 decimals" was only half
  // applied. Same map-building treatment, keyed off `allocation` instead of `cap`.
  const allocationDisplay = plan ? buildAmountDisplayMap(plan.agents, 'allocation') : null
  const depositAgents = plan ? plan.agents.filter((a) => a.kind === 'deposit') : []
  const planExpiry = plan?.agents[0] ? formatExpiry(plan.agents[0].expiry) : null

  async function runGeneration(generate) {
    const { amountUnits, risk: submittedRisk } = submissionRef.current
    setPhase('generating')
    setGenerationError(null)
    setGenerationPhase(null)
    try {
      // Fix loop 1 -- I10: a real, caller-driven progress event, never a `speed * ...` timer. A
      // caller that never calls this (every fixture in this file today, until Task 13 wires a
      // real strategist that reports phases) leaves generationPhase null the whole time, and the
      // UI shows one honest "working on it" message instead of a fake simultaneous phase list.
      const reportPhase = (label) => {
        const index = GENERATION_PHASES.indexOf(label)
        if (index !== -1) setGenerationPhase(index)
      }
      const result = await generate({ amountUnits, risk: submittedRisk, baseEligible }, reportPhase)
      const nextPlan = normalizeStrategyPlan({
        runId,
        risk: submittedRisk,
        source: result.source,
        sourceState: result.sourceState,
        stellarUnits: result.stellarUnits,
        // A disconnected/ineligible Base leg is dropped here regardless of what the strategist
        // returned -- Base is never silently added after the fact.
        baseAllocations: baseEligible ? result.baseAllocations || [] : [],
      })
      // Fix loop 1 -- C2 (review finding): the plan the user reviews and can accept must be the
      // plan derived from the amount they typed and validated -- never a different number the
      // strategist happened to return (reviewer reproduced this with a strategist response whose
      // Stellar + Base legs summed to 150 USDC against a typed 100 USDC). Fail closed rather than
      // render/offer a plan for an amount nobody validated.
      if (BigInt(nextPlan.amount.units) !== amountUnits) {
        setGenerationError('The generated plan did not match the amount you entered. Try again.')
        setPhase('error')
        return
      }
      setPlan(nextPlan)
      setInstructions(
        Object.fromEntries(
          nextPlan.agents.map((agent) => [agent.allocationId, defaultInstruction(agent)])
        )
      )
      setPhase('ready')
    } catch (err) {
      setGenerationError(err?.message || 'Could not build a plan. Try again.')
      setPhase('error')
    }
  }

  function handleSubmit(e) {
    e?.preventDefault?.()
    if (!canSubmit) return
    const check = validateAmountInput({ value: amountValue, risk, vaultTotalShares })
    if (!check.ok) {
      setFieldError(check.message)
      return
    }
    setFieldError(null)
    submissionRef.current = { amountUnits: check.units, risk }
    runGeneration(onGenerate)
  }

  // Fix loop 1 -- I5 (review finding): real ARIA APG radiogroup keyboard behavior -- arrow keys
  // both move focus AND change the selection (single-select radiogroup pattern), Home/End jump to
  // the ends. Paired with the roving tabIndex below (exactly one stop in the group's normal tab
  // order at a time).
  function handleRadioKeyDown(e, index) {
    let nextIndex = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIndex = (index + 1) % RISK_IDS.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      nextIndex = (index - 1 + RISK_IDS.length) % RISK_IDS.length
    } else if (e.key === 'Home') nextIndex = 0
    else if (e.key === 'End') nextIndex = RISK_IDS.length - 1
    if (nextIndex === null) return
    e.preventDefault()
    setRisk(RISK_IDS[nextIndex])
    radioRefs.current[nextIndex]?.focus()
  }

  function handleRetryLive() {
    runGeneration(onRetryLive || onGenerate)
  }

  function handleRebuildPlan() {
    setPlan(null)
    setInstructions({})
    setPhase('input')
    onRebuildPlan?.()
  }

  function handleAccept() {
    if (!plan) return
    const reviewed = {
      ...plan,
      agents: plan.agents.map((agent) => ({
        ...agent,
        instructions: instructions[agent.allocationId] ?? defaultInstruction(agent),
      })),
    }
    onAcceptPlan?.({ plan: reviewed, fingerprint: hashPlan(reviewed) })
  }

  return (
    <div className="pc-strategy-layout">
      <div className="pc-strategy-decision pc-dominant pc-dominant--decision">
        <h2 className="pc-strategy-question">How much do you want to put to work?</h2>

        {phase === 'input' && (
          <form onSubmit={handleSubmit}>
            <div className="pc-field">
              <label htmlFor="plan-amount">Amount in USDC</label>
              <input
                id="plan-amount"
                className="pc-strategy-amount"
                type="text"
                inputMode="decimal"
                // The field had no placeholder, and its own styling gave it no boundary either, so
                // an empty Plan stage showed a blank area with a hairline under it and nothing to
                // say it accepted input. Not a label substitute -- the <label> above stays.
                placeholder="0.00"
                value={amountValue}
                onChange={(e) => setAmountValue(e.target.value)}
                // Wave 6 Task 14 (scoped exception, owner-authorized): role="alert" only announces
                // the error once, at the moment it appears -- a screen-reader user tabbing back to
                // this field afterwards heard the label and nothing else. aria-describedby makes
                // the error part of the field's accessible description so it is read every time the
                // field is focused, not just on the first announcement. Only present while an error
                // exists (never a dangling reference to an absent element).
                aria-describedby={fieldError ? 'plan-amount-error' : undefined}
              />
              {fieldError && (
                <p id="plan-amount-error" className="pc-field-error" role="alert">
                  {fieldError}
                </p>
              )}
            </div>

            <div className="pc-comfort-group" role="radiogroup" aria-label="Comfort level">
              {RISK_IDS.map((id, index) => (
                <button
                  key={id}
                  ref={(el) => (radioRefs.current[index] = el)}
                  type="button"
                  role="radio"
                  aria-checked={risk === id}
                  tabIndex={(risk ? risk === id : index === 0) ? 0 : -1}
                  className={`pc-button ${risk === id ? 'pc-button--primary' : 'pc-button--secondary'}`}
                  onClick={() => setRisk(id)}
                  onKeyDown={(e) => handleRadioKeyDown(e, index)}
                >
                  {RISK_PROFILES[id].label}
                </button>
              ))}
            </div>

            <p className="pc-field-help">Nothing moves until you review and confirm.</p>

            {!baseConnected && (
              <button
                type="button"
                className="pc-button pc-button--secondary"
                onClick={() => onConnectForBase?.()}
              >
                {base?.action?.label || 'Connect to check Base testnet'}
              </button>
            )}

            <button type="submit" className="pc-button pc-button--primary" disabled={!canSubmit}>
              Build my plan
            </button>
          </form>
        )}

        {phase === 'generating' && (
          <StatusNotice state="info" title="Building your plan">
            {/* Fix loop 1 -- I10: a single label that TRANSITIONS in response to the caller's own
                reportPhase events (never a static simultaneous list, never a timer). Nothing
                claims progress this component cannot actually observe. */}
            <p>
              {generationPhase === null ? 'Working on it…' : GENERATION_PHASES[generationPhase]}
            </p>
          </StatusNotice>
        )}

        {phase === 'error' && (
          <>
            <StatusNotice state="danger" title="Could not build a plan">
              <p>{generationError}</p>
            </StatusNotice>
            <button type="button" className="pc-button pc-button--primary" onClick={handleSubmit}>
              Build my plan
            </button>
          </>
        )}

        {phase === 'ready' && plan && (
          <div>
            {/* Fix loop N -- item 1 (owner report): the source badge, the optional Retry-live-check
                button, and the plan total MoneyFigure were three bare inline siblings with no
                separating container -- concatenating as "Live AI + live market checks100 USDC"
                with zero CSS gap between them. A scoped flex row (not a locked contract selector),
                consistent spacing regardless of which of the three children are present. */}
            <div className="pc-plan-summary-header">
              <span className="pc-source-badge">{sourceBadgeCopy(plan.sourceState)}</span>
              {plan.sourceState !== 'live-ai' && (
                <button
                  type="button"
                  className="pc-button pc-button--secondary"
                  onClick={handleRetryLive}
                >
                  Retry live check
                </button>
              )}

              <MoneyFigure
                state="current"
                value={viewModel.total}
                currency={plan.amount.token}
                freshness={sourceFreshness(plan.sourceState)}
              />
            </div>

            {planInvalidated && (
              <StatusNotice state="warning" title="Base testnet was just set up">
                <p>
                  This reviewed plan was built before Base testnet was ready and no longer reflects
                  it.
                </p>
                <button
                  type="button"
                  className="pc-button pc-button--primary"
                  onClick={handleRebuildPlan}
                >
                  Rebuild plan
                </button>
              </StatusNotice>
            )}

            {!planInvalidated && !canAccept && executionCheck && (
              <StatusNotice state="danger" title="This plan can't proceed yet">
                <p>{executionCheck.message}</p>
              </StatusNotice>
            )}

            {/* Fix loop N -- items 6/8 (owner report): network, expiry, and yield are PLAN-level
                facts -- every agent from one generation call shares the same expiry
                (expandAgentSlots applies a single `expiry` to every agent it creates), and every
                Stellar deposit worker shares the same network/venue. Shown once here instead of
                once per worker row, which is what "Stellar testnet / Cap / Expires / Yield
                unavailable" repeating verbatim 3x actually was. Item 8's degraded-yield state gets
                its own subtle inline (icon + muted colour) treatment, also shown once. */}
            {planExpiry && (
              <div className="pc-plan-facts">
                {depositAgents.length > 0 && <NetworkBadge networkId="stellar-testnet" />}
                <p>
                  Expires {planExpiry.relative}
                  {planExpiry.absolute && (
                    <span className="pc-field-help"> ({planExpiry.absolute})</span>
                  )}
                </p>
                {depositAgents.length > 0 &&
                  (stellarYield.state === 'live' ? (
                    <p>{stellarYield.apy}% APY</p>
                  ) : (
                    <p className="pc-field-help">
                      <span aria-hidden="true">! </span>Yield unavailable
                    </p>
                  ))}
              </div>
            )}

            <ul className="pc-allocation-list">
              {viewModel.agents.map((agent, i) => {
                const isBridge = agent.kind === 'bridge'
                return (
                  <li key={agent.id} className="pc-allocation-row" data-agent-kind={agent.kind}>
                    {/* Item 5 (owner report): at least 36px (was the AgentMark default of 32,
                        measured as reading "nearly invisible" in a real browser), pinned to the
                        row's own start (see strategy.css) so it lines up with the crew-name line
                        that now leads each row's content instead of centering against the whole,
                        much taller, multi-line row. */}
                    <AgentMark
                      identity={agent.id}
                      state="planned"
                      size={36}
                      label={isBridge ? 'B' : String(agent.idx)}
                    />
                    <div>
                      <p className="pc-worker-name">{crewNameFor(i)}</p>
                      {isBridge && <NetworkRoute context={BRIDGE_NETWORK_CONTEXT} />}
                      <MoneyFigure
                        state="current"
                        value={allocationDisplay[agent.id]}
                        currency={plan.amount.token}
                      />
                      <p>
                        {/* Fix loop 1 -- I8 (review finding): the grant scope bound the user
                            approves is `plan.agents[].cap`, never the display allocation --
                            today they happen to be equal, but the moment they diverge (a
                            headroom cap, a rounded bridge cap) this must still state the real
                            cap, not the allocation. Item 3 (owner report): capDisplay is a
                            DISPLAY-only 2dp rounding of that same real cap (buildAmountDisplayMap
                            above), never a different number. */}
                        Cap {capDisplay[agent.id]} {plan.amount.token}
                      </p>
                      {isBridge && (
                        <ul>
                          {agent.children.map((child) => (
                            <li key={child.allocationId}>
                              {child.proxyTarget || child.destination}: {child.allocation}{' '}
                              {plan.amount.token}
                            </li>
                          ))}
                        </ul>
                      )}
                      {/* Item 5 (owner report): the disclosure's own accessible name now matches
                          the crew name shown right above it, not the internal "Worker N, ..."
                          label -- a screen-reader user hears the same identity a sighted user
                          sees. Scoped to this component's own local JSX only; the shared
                          `agent.name` field from planModel.js/buildStrategyViewModel is
                          untouched, so StartStage/StrategyReceipt's own displays are unaffected. */}
                      <TechnicalDetails summary={`${crewNameFor(i)} instructions`}>
                        <textarea
                          className="pc-instruction-input"
                          aria-label={`${crewNameFor(i)} instructions`}
                          value={instructions[agent.id] ?? ''}
                          onChange={(e) =>
                            setInstructions((prev) => ({ ...prev, [agent.id]: e.target.value }))
                          }
                        />
                      </TechnicalDetails>
                    </div>
                  </li>
                )
              })}
            </ul>

            {canAccept && (
              <button
                type="button"
                className="pc-button pc-button--primary pc-accept-plan-button"
                onClick={handleAccept}
              >
                Accept plan
              </button>
            )}
          </div>
        )}
      </div>

      <aside className="pc-strategy-aside">
        {/* Fix loop 1 -- M6 (review finding): a bridge-only plan (stellarUnits: 0) has no
            Stellar deposit leg at all -- rendering "Stellar truth" / "0 live venue" beside the
            live-venue disclosure would be a false claim. */}
        {plan && plan.truth.stellarVenueCount > 0 && (
          <div className="pc-support">
            <div className="pc-support-content">
              <h2>Stellar truth</h2>
              <p>{plan.truth.agentIsolationCount} isolated accounts</p>
              <p>{plan.truth.stellarVenueCount} live venue</p>
              <VenueTruth kind="live" venue={stellarVenue?.name} />
            </div>
          </div>
        )}

        {plan?.truth.baseUsesProxyVaults && (
          <div className="pc-support">
            <div className="pc-support-content">
              <h2>Base Sepolia bridge</h2>
              <p>Circle CCTP v2</p>
              <p>Bridged as Circle USDC.</p>
              <VenueTruth kind="base-proxy" />
              {plan.agents
                .find((a) => a.kind === 'bridge')
                ?.children.map((child) => (
                  <p key={child.allocationId}>
                    Planned mainnet target: {child.proxyTarget} (not live)
                  </p>
                ))}
            </div>
          </div>
        )}

        {/* Fix loop 1 -- I3 (review finding): dropped `&& !plan` -- this notice already lives in
            the aside, outside the reviewed plan surface; gating it on "no plan yet" made the
            brief's setup -> invalidate -> Rebuild plan journey structurally unreachable from the
            UI (only reachable in tests, by hand-rerendering with a fabricated prop). */}
        {showBaseSetup && (
          <StatusNotice
            state="warning"
            title="Set up Base testnet"
            action={
              <button
                type="button"
                className="pc-button pc-button--primary"
                onClick={() => onSetupBase?.()}
              >
                Set up Base testnet
              </button>
            }
          >
            <p>
              {base?.mandateView?.primaryCopy ||
                'Base testnet needs a one-time setup before it can be used.'}
            </p>
          </StatusNotice>
        )}
      </aside>
    </div>
  )
}
