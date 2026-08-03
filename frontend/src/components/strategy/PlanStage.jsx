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
import { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import {
  Dialog,
  MoneyFigure,
  StatusNotice,
  TechnicalDetails,
  VenueTruth,
} from '../pocket/Primitives.jsx'
import { NetworkBadge, NetworkRoute } from '../pocket/NetworkIdentity.jsx'
import {
  RISK_PROFILES,
  expandAgentSlots,
  normalizeStrategyPlan,
  buildStrategyViewModel,
  roundCentsBigInt,
  formatCents,
  buildAmountDisplayMap,
} from '../../strategy/planModel.js'
import { venueYield } from '../../strategy/venueTruth.js'
import {
  validateAmountInput,
  validateExecutionAllocations,
} from '../../strategy/amountValidation.js'
import { needsBaseMandateSetup } from '../../mergeFlowHelpers.js'
import { hashStrategy } from '../../attestation.js'
import { SOROBAN_DECIMALS, SOROBAN_TOKEN_ADDRESS, STELLAR_USDC_SAC } from '../../stellar/config.js'

gsap.registerPlugin(useGSAP)

const RISK_IDS = Object.keys(RISK_PROFILES) // ['low', 'med', 'high'] -> Steady/Balanced/Adventurous

const GENERATION_PHASES = Object.freeze([
  'Checking destinations',
  'Building bounded allocations',
  'Safety review',
])

const BUILDING_MESSAGES = Object.freeze([
  'Building your plan',
  'Making the strategy work for you',
  'Balancing risk and opportunity',
  'Preparing everything for your review',
])

function formatElapsed(seconds) {
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

// Task 3 (Pocket Crew design alignment) -- quick amount shortcuts under the amount field. Written
// into the existing amountValue state, nothing else; no new persistence/state.
const AMOUNT_PRESETS = Object.freeze(['50', '250', '1000'])

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

// Task 4 (Pocket Crew design alignment) -- adapts a plain JS dollars number (the typed amount
// before a plan exists, or a computed 30-day yield estimate) into the exact same 2dp string
// `formatCents` already produces for every other money row in this file (Cap/allocation via
// buildAmountDisplayMap below). Not a second money formatter: the rounding/sign/2dp logic stays
// 100% formatCents; this only converts a float-dollars input into the cents BigInt it expects.
//
// Fix loop 1 -- Important 1 (review finding): a `value` that is itself finite (e.g. amountNumber,
// already past PlanStage's own `Number.isFinite` collapse-to-0 guard at its call site) can still
// overflow to Infinity once multiplied by 100 here (Number.MAX_VALUE / 100 ~= 1.8e306) --
// `BigInt(Infinity)` throws, and this file's own comment documents there is no error boundary
// anywhere in the app, so that throw would blank the whole Plan stage on render. Guards the
// PRODUCT, not just the input -- fix loop 2 found `formatShare` below had the exact same class of
// gap at a LOWER threshold (its own comment used to call its input guard sufficient; it wasn't,
// see that function's own updated comment), so "mirrors an existing safe precedent" was never an
// accurate description of what existed here -- this guard and formatShare's are siblings fixed
// together, not one copying an already-correct other. An amount this large has no real
// vault/grant behind it anyway, so collapsing to the same 0 sentinel the amount field's own
// Number.isFinite guard already uses for unusable input (PlanStage's `amountNumber`, above) is
// consistent, not a second invented number.
function formatDollarNumber(value) {
  const cents = Math.round(value * 100)
  return formatCents(Number.isFinite(cents) ? BigInt(cents) : 0n)
}

// Task 4 -- sums a GROUP of real plan agents' allocation units (BigInt, exact) and rounds ONCE,
// the same order buildAmountDisplayMap already uses for a single agent's cap/allocation. Summing
// already-rounded PER-AGENT strings instead would reproduce the exact "off by one base unit"
// defect Task 3's review caught (see formatShare's doc comment above) -- this sums the real units
// first. Returns the honest '0.00' for an empty group (e.g. a bridge-only plan has no deposit
// agents) rather than a null/undefined placeholder.
function sumAllocationCents(agents) {
  if (!agents.length) return '0.00'
  const totalUnits = agents.reduce((s, a) => s + BigInt(a.allocation.units), 0n)
  return formatCents(roundCentsBigInt(totalUnits, agents[0].allocation.decimals))
}

// Task 3 (Pocket Crew design alignment), fix loop 1 -- Important 1/2 (review findings): runs the
// real expandAgentSlots split (the same one a real generation call makes) instead of a hand-rolled
// uniform division -- splitEven puts its remainder on the EARLIEST slot, so a floor-only split was
// systematically 1 base unit low on slot 0, which silently flips the rendered cents whenever
// floor(total/k) lands 1 unit under a rounding boundary. The `Number.isFinite`/`<= 0` check below
// only ever guarded the INPUT (the amount field is free text -- "1e999" parses to `Infinity`, and
// this collapses that to an empty share rather than reaching a formatter at all).
//
// Fix loop 2 (Task 4 review, carried item): that input guard was NOT sufficient on its own, and
// this comment previously implied it was -- a `amountNumber` that is itself finite still overflows
// the multiply below (`amountNumber * 10 ** SOROBAN_DECIMALS`, SOROBAN_DECIMALS = 7) once
// `amountNumber` exceeds roughly `Number.MAX_VALUE / 1e7 ~= 1.8e301` -- a LOWER threshold than
// `formatDollarNumber`'s own `1.8e306` (100x multiplier vs. 1e7x here), and reachable the same way:
// type e.g. `1e307` and pick a comfort tier, which renders this crew line and calls formatShare
// with no error boundary anywhere in the app. Guards the PRODUCT too now, same fix as
// formatDollarNumber above, returning the same empty-share fallback this function already uses for
// bad input -- not a second invented fallback shape.
function formatShare(amountNumber, risk) {
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) return ''
  const stellarUnitsNumber = Math.round(amountNumber * 10 ** SOROBAN_DECIMALS)
  if (!Number.isFinite(stellarUnitsNumber)) return ''
  const agents = expandAgentSlots({
    risk,
    stellarUnits: BigInt(stellarUnitsNumber),
    stellarDecimals: SOROBAN_DECIMALS,
  })
  return agents.length
    ? `${buildAmountDisplayMap(agents, 'allocation')[agents[0].allocationId]} USDC`
    : ''
}

function tokenSymbol(token) {
  return token === 'USDC' || token === SOROBAN_TOKEN_ADDRESS || token === STELLAR_USDC_SAC
    ? 'USDC'
    : token
}

// Fix loop N -- item 5 (owner report): crew character names, easily editable in one place. No
// name data exists anywhere else in the model -- planModel.js only ever produces positional
// "Worker N" labels -- so this is this fix's own addition: one obvious exported constant, not
// scattered literals. Indexed by POSITION within a plan's own agent order (0-based) -- decorative
// crew flavor only, never an identity claim (AgentMark's own crew-color fill/dedup already keys
// off the agent's real allocationId, never this list).
export const CREW_NAMES = Object.freeze(['Sprout', 'Clover', 'Mochi', 'Pepper', 'Juniper', 'Basil'])
const CREW_AVATARS = Object.freeze([
  '/brand/agents/sprout.svg',
  '/brand/agents/clover.svg',
  '/brand/agents/mochi.svg',
])

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
  skillSource = 'default',
  marketLive = null,
  vaultLive = null,
  onCustomizeSkill,
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
  const [generationElapsed, setGenerationElapsed] = useState(0)
  const [plan, setPlan] = useState(null)
  const [instructions, setInstructions] = useState({})
  const [revisionAction, setRevisionAction] = useState(null)
  const submissionRef = useRef(null) // last validated { amountUnits, risk }, reused by retry
  const radioRefs = useRef([]) // roving-tabindex focus targets, one per RISK_IDS entry
  const buildingRef = useRef(null)
  const buildingMessageRef = useRef(null)
  const revisionCancelRef = useRef(null)
  const revisionMenuRef = useRef(null)
  const customSkill = skillSource === 'user-local' || skillSource === 'user-file'

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
  const buildingMessage =
    BUILDING_MESSAGES[Math.floor(generationElapsed / 3) % BUILDING_MESSAGES.length]

  useEffect(() => {
    if (phase !== 'generating') return undefined
    const timer = window.setInterval(() => setGenerationElapsed((elapsed) => elapsed + 1), 1000)
    return () => window.clearInterval(timer)
  }, [phase])

  useGSAP(
    () => {
      if (
        phase !== 'generating' ||
        !buildingMessageRef.current ||
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ) {
        return
      }
      gsap.fromTo(
        buildingMessageRef.current,
        { autoAlpha: 0, y: 6 },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.36,
          ease: 'power2.out',
          clearProps: 'transform,opacity,visibility',
          overwrite: 'auto',
        }
      )
    },
    { dependencies: [phase, buildingMessage], scope: buildingRef, revertOnUpdate: true }
  )

  const canSubmit = amountValue.trim() !== '' && Boolean(risk) && phase !== 'generating'
  // Task 3 -- the crew line's own display-only number; never fed back into submissionRef/
  // validateAmountInput (the real submit path parses amountValue as an exact decimal string, see
  // handleSubmit below -- this Number() coercion never reaches a grant/burn amount). Fix loop 1 --
  // Important 2 (review finding): the amount field is free text ("1e999" parses to `Infinity`,
  // exceeding the double max) -- collapsed to 0 here, at the one place this value is derived, so
  // neither this component's own `amountNumber > 0` check below nor formatShare's guard has to
  // separately guess whether a caller already sanitized it.
  const rawAmountNumber = Number(amountValue)
  const amountNumber = Number.isFinite(rawAmountNumber) ? rawAmountNumber : 0
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

  // Task 4 -- the aside's live "plan so far" summary. Before a plan exists this reflects the
  // typed amount only; once one does, it reflects the REAL reviewed totals (never a different
  // number than what Accept plan would sign) -- same fail-closed discipline as C2's amount
  // reconciliation above.
  const bridgeAgent = plan ? plan.agents.find((a) => a.kind === 'bridge') : null
  const deployedText = plan
    ? `${sumAllocationCents(depositAgents)} ${tokenSymbol(depositAgents[0]?.allocation.token ?? plan.amount.token)}`
    : `${formatDollarNumber(amountNumber)} USDC`
  // Fix loop 1 -- Important 3 (review finding): the Blend/Stellar APY may only be applied to
  // money actually going to Blend. Before a plan exists the split isn't known yet, so the typed
  // amount is the best available estimate; once a plan DOES exist, `viewModel` (built above) has
  // the real per-agent decimal totals -- summing only the 'deposit' (Stellar) agents excludes any
  // Base-bound bridge leg, which this component has no APY claim for at all. Using the full plan
  // total here (as the brief's literal formula did) overstated the estimate by exactly the
  // bridged share every time -- the same "never invent a number" constraint that gates whether
  // this row renders at all also governs what it computes.
  const estimateAmount = viewModel
    ? viewModel.agents.filter((a) => a.kind === 'deposit').reduce((s, a) => s + a.allocation, 0)
    : amountNumber
  // Never invented: only computed when the caller's own venue object exposes a genuine numeric
  // APY (frontend/src/app.jsx's stellarVenueDisplay.apy, sourced from VAULT_CATALOG -- confirmed
  // a flat top-level number, not the nested {state,apy} shape venueYield()/stellarYield above
  // reads). Guarded here, not just at the JSX render site below, because `stellarVenue` is
  // optional and most callers/tests never pass one -- an unguarded `stellarVenue.apy` read would
  // throw on every one of them.
  const estimate30d =
    typeof stellarVenue?.apy === 'number' && estimateAmount > 0
      ? `${formatDollarNumber(estimateAmount * (stellarVenue.apy / 100) * (30 / 365))} USDC`
      : null

  async function runGeneration(generate) {
    const { amountUnits, risk: submittedRisk } = submissionRef.current
    setPhase('generating')
    setGenerationError(null)
    setGenerationPhase(null)
    setGenerationElapsed(0)
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
        token: SOROBAN_TOKEN_ADDRESS,
        bridgeToken: STELLAR_USDC_SAC,
        stellarUnits: result.stellarUnits,
        // A disconnected/ineligible Base leg is dropped here regardless of what the strategist
        // returned -- Base is never silently added after the fact.
        baseAllocations: baseEligible ? result.baseAllocations || [] : [],
        // Task 5: this is the explicit object the brief warned about -- without this line,
        // result.review (the eligibility gate's verdicts) is silently stripped here and never
        // reaches normalizeStrategyPlan, even though generateStrategyPlan computed it.
        review: result.review,
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

  function confirmRevision() {
    const reset = revisionAction === 'reset'
    setPlan(null)
    setInstructions({})
    setGenerationError(null)
    setFieldError(null)
    if (reset) {
      setAmountValue('')
      setRisk(null)
      submissionRef.current = null
    }
    setRevisionAction(null)
    setPhase('input')
    onRebuildPlan?.()
  }

  function requestRevision(action) {
    revisionMenuRef.current?.removeAttribute('open')
    setRevisionAction(action)
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
                placeholder="0"
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

            <div className="pc-amount-presets" role="group" aria-label="Quick amounts">
              {AMOUNT_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  aria-pressed={amountValue === preset}
                  className={`pc-amount-preset${amountValue === preset ? ' pc-amount-preset--active' : ''}`}
                  onClick={() => {
                    setAmountValue(preset)
                    setFieldError(null)
                  }}
                >
                  {preset}
                </button>
              ))}
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

            {/* Task 3 -- read-only, DERIVED crew count (D-28.6: never user-set -- no control lets
                the user pick this number, see the "never renders an advanced crew-count input"
                test). */}
            {risk && (
              <p className="pc-crew-line">
                {RISK_PROFILES[risk].targetSlots} crew member
                {RISK_PROFILES[risk].targetSlots > 1 ? 's' : ''}
                {amountNumber > 0 && ` · each handles about ${formatShare(amountNumber, risk)}`}
              </p>
            )}

            <p className="pc-field-help">Nothing moves until you review and confirm.</p>

            <div className="pc-plan-actions">
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
            </div>
          </form>
        )}

        {phase === 'generating' && (
          <div ref={buildingRef} className="pc-plan-building" aria-busy="true">
            <StatusNotice state="info" title="Your plan is taking shape">
              <div className="pc-plan-building-copy">
                <p
                  ref={buildingMessageRef}
                  className="pc-plan-building-message"
                  key={buildingMessage}
                >
                  {buildingMessage}
                </p>
                <time
                  className="pc-plan-building-elapsed"
                  dateTime={`PT${generationElapsed}S`}
                  aria-label={`Elapsed time ${formatElapsed(generationElapsed)}`}
                >
                  {formatElapsed(generationElapsed)}
                </time>
              </div>
              {/* Fix loop 1 -- I10: a single label that TRANSITIONS in response to the caller's own
                reportPhase events (never a static simultaneous list, never a timer). Nothing
                claims progress this component cannot actually observe. */}
              <p className="pc-plan-building-progress">
                <span className="think-spin" aria-hidden="true" />
                {generationPhase === null ? 'Working on it…' : GENERATION_PHASES[generationPhase]}
              </p>
            </StatusNotice>
          </div>
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
                currency={tokenSymbol(plan.amount.token)}
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
                {depositAgents.length > 0 && stellarYield.state === 'live' && (
                  <p>{stellarYield.apy}% APY</p>
                )}
              </div>
            )}

            {depositAgents.length > 0 && stellarYield.state !== 'live' && (
              <p className="pc-plan-yield-note">Yield unavailable</p>
            )}

            <ul className="pc-allocation-list">
              {viewModel.agents.map((agent, i) => {
                const isBridge = agent.kind === 'bridge'
                const planAgent = plan.agents[i]
                return (
                  <li key={agent.id} className="pc-allocation-row" data-agent-kind={agent.kind}>
                    {/* Item 5 (owner report): at least 36px (was the AgentMark default of 32,
                        measured as reading "nearly invisible" in a real browser), pinned to the
                        row's own start (see strategy.css) so it lines up with the crew-name line
                        that now leads each row's content instead of centering against the whole,
                        much taller, multi-line row. */}
                    <img
                      className="pc-plan-agent-avatar"
                      src={CREW_AVATARS[i % CREW_AVATARS.length]}
                      alt={`${crewNameFor(i)} agent, planned`}
                      width="44"
                      height="44"
                    />
                    <div>
                      <p className="pc-worker-name">{crewNameFor(i)}</p>
                      {isBridge && <NetworkRoute context={BRIDGE_NETWORK_CONTEXT} />}
                      <MoneyFigure
                        state="current"
                        value={allocationDisplay[agent.id]}
                        currency={tokenSymbol(planAgent.allocation.token)}
                      />
                      <p>
                        {/* Fix loop 1 -- I8 (review finding): the grant scope bound the user
                            approves is `plan.agents[].cap`, never the display allocation --
                            today they happen to be equal, but the moment they diverge (a
                            headroom cap, a rounded bridge cap) this must still state the real
                            cap, not the allocation. Item 3 (owner report): capDisplay is a
                            DISPLAY-only 2dp rounding of that same real cap (buildAmountDisplayMap
                            above), never a different number. */}
                        Cap {capDisplay[agent.id]} {tokenSymbol(planAgent.cap.token)}
                      </p>
                      {isBridge && (
                        <ul>
                          {agent.children.map((child) => (
                            <li key={child.allocationId}>
                              {child.proxyTarget || child.destination}: {child.allocation}{' '}
                              {tokenSymbol(planAgent.cap.token)}
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

            <div
              className={`pc-plan-final-actions${canAccept ? '' : ' pc-plan-final-actions--single'}`}
            >
              {canAccept && (
                <button
                  type="button"
                  className="pc-button pc-button--primary pc-accept-plan-button"
                  onClick={handleAccept}
                >
                  Accept plan
                </button>
              )}
              <details ref={revisionMenuRef} className="pc-plan-change-menu">
                <summary className="pc-button pc-button--primary">Change mind?</summary>
                <div className="pc-plan-change-options">
                  <button
                    type="button"
                    className="pc-button pc-button--secondary"
                    onClick={() => requestRevision('change')}
                  >
                    Change amount
                  </button>
                  <button
                    type="button"
                    className="pc-button pc-button--secondary pc-plan-reset-button"
                    onClick={() => requestRevision('reset')}
                  >
                    Reset plan
                  </button>
                </div>
              </details>
            </div>
          </div>
        )}
      </div>

      <aside className="pc-strategy-aside" aria-label="The plan so far">
        {/* Task 4 (Pocket Crew design alignment) -- the aside's FIRST block: a live summary of
            the plan being built, so the aside always shows something truthful even before a
            plan has been generated. The Stellar truth card and Base bridge disclosure below are
            unchanged content, just no longer the first thing rendered. */}
        <div className="pc-plan-so-far">
          <h2 className="pc-aside-title">The plan so far</h2>
          <ul className="pc-fact-rows">
            <li className="pc-fact-row">
              <span className="pc-fact-dot pc-fact-dot--harvest" aria-hidden="true" />
              <span>Deployed to Blend v2</span>
              <span className="pc-fact-value">{deployedText}</span>
            </li>
            {bridgeAgent && (
              <li className="pc-fact-row">
                <span className="pc-fact-dot" aria-hidden="true" />
                <span>Sent to Base</span>
                <span className="pc-fact-value">
                  {sumAllocationCents([bridgeAgent])} {tokenSymbol(bridgeAgent.allocation.token)}
                </span>
              </li>
            )}
            {risk && (
              <li className="pc-fact-row">
                <span className="pc-fact-dot" aria-hidden="true" />
                <span>Crew members</span>
                <span className="pc-fact-value">{RISK_PROFILES[risk].targetSlots}</span>
              </li>
            )}
            {/* Fix loop 1 -- minor (review finding): `estimate30d` above is already `null` exactly
                when this row shouldn't render (same guard, computed once) -- repeating the full
                `typeof stellarVenue?.apy === 'number' && estimateAmount > 0` condition here was a
                second copy that could silently drift out of sync with the one that actually
                gates the value. */}
            {estimate30d && (
              <li className="pc-fact-row">
                <span className="pc-fact-dot" aria-hidden="true" />
                <span>Estimated in 30 days</span>
                <span className="pc-fact-value">+{estimate30d}</span>
              </li>
            )}
            <li className="pc-fact-row">
              <span className="pc-fact-dot" aria-hidden="true" />
              <span>Network fees you pay</span>
              <span className="pc-fact-value">Zero</span>
            </li>
          </ul>
          <p className="pc-provenance">
            <span>Stellar testnet</span>
            <span aria-hidden="true">→</span>
            <span>Blend Capital v2</span>
          </p>
        </div>

        <section className="pc-vault-advisor" aria-labelledby="vault-advisor-heading">
          <div className="pc-vault-advisor-head">
            <div>
              <h2 id="vault-advisor-heading" className="pc-aside-title">
                Vault Advisor Skill
              </h2>
              <p className="pc-vault-advisor-status">
                <span aria-hidden="true" />
                {customSkill ? 'Custom strategy' : 'Default strategy'}
              </p>
            </div>
            {onCustomizeSkill && (
              <button
                type="button"
                className="pc-button pc-button--secondary pc-vault-advisor-action"
                onClick={onCustomizeSkill}
              >
                Customize
              </button>
            )}
          </div>
          <p className="pc-vault-advisor-detail">
            {customSkill ? 'Active, user-defined' : 'Default eligibility and allocation rules'}
            {marketLive != null && ` · ${marketLive ? 'Live market' : 'Static context'}`}
            {vaultLive != null && ` · ${vaultLive ? 'Live vaults' : 'Cached vaults'}`}
          </p>
        </section>

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

      <Dialog
        open={revisionAction !== null}
        title={revisionAction === 'reset' ? 'Reset this plan?' : 'Change this amount?'}
        description={
          revisionAction === 'reset'
            ? 'This clears the reviewed plan and your amount. Building again may use another AI request.'
            : 'This returns you to the amount form. Building again may use another AI request.'
        }
        onClose={() => setRevisionAction(null)}
        initialFocusRef={revisionCancelRef}
        actions={
          <>
            <button
              ref={revisionCancelRef}
              type="button"
              className="pc-button pc-button--secondary"
              onClick={() => setRevisionAction(null)}
            >
              Keep current plan
            </button>
            <button
              type="button"
              className="pc-button pc-button--primary"
              onClick={confirmRevision}
            >
              {revisionAction === 'reset' ? 'Reset plan' : 'Change amount'}
            </button>
          </>
        }
      >
        <p>No on-chain action has happened yet.</p>
      </Dialog>
    </div>
  )
}
