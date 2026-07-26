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
import { RISK_PROFILES, normalizeStrategyPlan, buildStrategyViewModel } from '../../strategy/planModel.js'
import { venueYield } from '../../strategy/venueTruth.js'
import { validateAmountInput, validateExecutionAllocations } from '../../strategy/amountValidation.js'
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

function formatExpiry(expirySeconds) {
  return Number.isFinite(expirySeconds) ? new Date(expirySeconds * 1000).toISOString() : 'Unknown'
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
  const [plan, setPlan] = useState(null)
  const [instructions, setInstructions] = useState({})
  const submissionRef = useRef(null) // last validated { amountUnits, risk }, reused by retry

  const baseConnected = base?.connected === true
  const baseHealthy = base?.healthy === true
  const mandateReady = base?.mandateView?.ready === true
  // The single derived gate every generation call reads -- computed once, here, from the
  // caller's already-canonical Base view. Never re-derived per render from raw health/mandate
  // fields anywhere else in this component.
  const baseEligible = baseConnected && baseHealthy && mandateReady
  const showBaseSetup = baseConnected && needsBaseMandateSetup({ healthy: base?.healthy, mandateOk: mandateReady })
  const planInvalidated = phase === 'ready' && Boolean(base?.action?.invalidatesPlan)

  const canSubmit = amountValue.trim() !== '' && Boolean(risk) && phase !== 'generating'
  const viewModel = plan ? buildStrategyViewModel({ plan, stellarVenue }) : null
  const executionCheck = plan ? validateExecutionAllocations({ plan, vaultTotalShares }) : null
  const canAccept = phase === 'ready' && !planInvalidated && executionCheck?.ok === true
  const stellarYield = venueYield(stellarVenue)

  async function runGeneration(generate) {
    const { amountUnits, risk: submittedRisk } = submissionRef.current
    setPhase('generating')
    setGenerationError(null)
    try {
      const result = await generate({ amountUnits, risk: submittedRisk, baseEligible })
      const nextPlan = normalizeStrategyPlan({
        runId: `plan-${Date.now()}`,
        risk: submittedRisk,
        source: result.source,
        sourceState: result.sourceState,
        stellarUnits: result.stellarUnits,
        // A disconnected/ineligible Base leg is dropped here regardless of what the strategist
        // returned -- Base is never silently added after the fact.
        baseAllocations: baseEligible ? result.baseAllocations || [] : [],
      })
      setPlan(nextPlan)
      setInstructions(
        Object.fromEntries(nextPlan.agents.map((agent) => [agent.allocationId, defaultInstruction(agent)]))
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
        <h1 className="pc-strategy-question">How much do you want to put to work?</h1>

        {phase === 'input' && (
          <form onSubmit={handleSubmit}>
            <div className="pc-field">
              <input
                className="pc-strategy-amount"
                type="text"
                inputMode="decimal"
                aria-label="Amount in USDC"
                value={amountValue}
                onChange={(e) => setAmountValue(e.target.value)}
              />
              {fieldError && (
                <p className="pc-field-error" role="alert">
                  {fieldError}
                </p>
              )}
            </div>

            <div role="radiogroup" aria-label="Comfort level">
              {RISK_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={risk === id}
                  className={`pc-button ${risk === id ? 'pc-button--primary' : 'pc-button--secondary'}`}
                  onClick={() => setRisk(id)}
                >
                  {RISK_PROFILES[id].label}
                </button>
              ))}
            </div>

            <p className="pc-field-help">Nothing moves until you review and confirm.</p>

            {!baseConnected && (
              <button type="button" className="pc-button pc-button--secondary" onClick={() => onConnectForBase?.()}>
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
            <ul>
              {GENERATION_PHASES.map((label) => (
                <li key={label}>{label}</li>
              ))}
            </ul>
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
            <span className="pc-network-badge">
              {plan.sourceState === 'live-ai' ? 'Live AI + live market checks' : 'Safe default plan'}
            </span>
            {plan.sourceState !== 'live-ai' && (
              <button type="button" className="pc-button pc-button--secondary" onClick={handleRetryLive}>
                Retry live check
              </button>
            )}

            <MoneyFigure
              state="current"
              value={viewModel.total}
              currency={plan.amount.token}
              freshness={plan.sourceState === 'live-ai' ? 'Live' : 'Fallback'}
            />

            {planInvalidated && (
              <StatusNotice state="warning" title="Base testnet was just set up">
                <p>This reviewed plan was built before Base testnet was ready and no longer reflects it.</p>
                <button type="button" className="pc-button pc-button--primary" onClick={handleRebuildPlan}>
                  Rebuild plan
                </button>
              </StatusNotice>
            )}

            {!planInvalidated && !canAccept && executionCheck && (
              <StatusNotice state="danger" title="This plan can't proceed yet">
                <p>{executionCheck.message}</p>
              </StatusNotice>
            )}

            <ul className="pc-allocation-list">
              {viewModel.agents.map((agent) => {
                const isBridge = agent.kind === 'bridge'
                const planAgent = plan.agents.find((a) => a.allocationId === agent.id)
                return (
                  <li key={agent.id} className="pc-allocation-row" data-agent-kind={agent.kind}>
                    <AgentMark identity={agent.id} state="planned" label={isBridge ? 'B' : String(agent.idx)} />
                    <div>
                      {isBridge ? (
                        <NetworkRoute context={BRIDGE_NETWORK_CONTEXT} />
                      ) : (
                        <NetworkBadge networkId="stellar-testnet" />
                      )}
                      <MoneyFigure state="current" value={agent.allocation} currency={plan.amount.token} />
                      <p>
                        Cap {agent.allocation} {plan.amount.token}
                      </p>
                      <p>Expires {formatExpiry(planAgent.expiry)}</p>
                      {isBridge ? (
                        <ul>
                          {agent.children.map((child) => (
                            <li key={child.allocationId}>
                              {child.proxyTarget || child.destination}: {child.allocation} {plan.amount.token}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p>{stellarYield.state === 'live' ? `${stellarYield.apy}% APY` : 'Yield unavailable'}</p>
                      )}
                      <TechnicalDetails summary={`${agent.name} instructions`}>
                        <textarea
                          aria-label={`${agent.name} instructions`}
                          value={instructions[agent.id] ?? ''}
                          onChange={(e) => setInstructions((prev) => ({ ...prev, [agent.id]: e.target.value }))}
                        />
                      </TechnicalDetails>
                    </div>
                  </li>
                )
              })}
            </ul>

            {canAccept && (
              <button type="button" className="pc-button pc-button--primary" onClick={handleAccept}>
                Accept plan
              </button>
            )}
          </div>
        )}
      </div>

      <aside className="pc-strategy-aside">
        {plan && (
          <div className="pc-support">
            <h2>Stellar truth</h2>
            <p>{plan.truth.agentIsolationCount} isolated accounts</p>
            <p>{plan.truth.stellarVenueCount} live venue</p>
            <VenueTruth kind="live" venue={stellarVenue?.name} />
          </div>
        )}

        {plan?.truth.baseUsesProxyVaults && (
          <div className="pc-support">
            <h2>Base Sepolia bridge</h2>
            <p>Circle CCTP v2</p>
            <p>Bridged as Circle USDC.</p>
            <VenueTruth kind="base-proxy" />
            {plan.agents
              .find((a) => a.kind === 'bridge')
              ?.children.map((child) => (
                <p key={child.allocationId}>Planned mainnet target: {child.proxyTarget} (not live)</p>
              ))}
          </div>
        )}

        {showBaseSetup && !plan && (
          <StatusNotice
            state="warning"
            title="Set up Base testnet"
            action={
              <button type="button" className="pc-button pc-button--primary" onClick={() => onSetupBase?.()}>
                Set up Base testnet
              </button>
            }
          >
            <p>{base?.mandateView?.primaryCopy || 'Base testnet needs a one-time setup before it can be used.'}</p>
          </StatusNotice>
        )}
      </aside>
    </div>
  )
}
