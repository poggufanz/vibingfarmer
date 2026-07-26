// frontend/src/components/money/HowMoneyWorks.jsx
// My Money Task 11 (Pocket Crew redesign, Wave 5). "How your money is working": the plain-English
// mechanism (Autofarm -> Blend) plus the automation evidence that backs "yes, this is really
// happening" -- keeper heartbeat, vault configuration, and this device's local risk-radar
// provenance. Exercised via MyMoneyRoute.test.jsx (no dedicated test per the brief's Files list).
//
// Every label rendered here is a value automationEvidence.js already classified from a POSITIVE
// observation (classifyKeeperAutomation/classifyStrategyConfiguration/describeRiskWatchProvenance,
// automationEvidence.js:20-104) -- this component never re-derives "healthy"/"configured" itself,
// it only renders whatever those functions returned. `keeper`/`strategyConfig`/`riskWatch` are all
// optional: a caller that hasn't wired the real automation reads yet (this task never wires app.jsx
// -- My Money Task 13 does) still gets an honest "Unavailable" for each, never a silent gap.
import { VenueTruth } from '../pocket/Primitives.jsx'

function formatHeartbeat(lastHeartbeatAt) {
  return Number.isFinite(lastHeartbeatAt) ? new Date(lastHeartbeatAt).toISOString() : 'Unavailable'
}

const KEEPER_LABEL = Object.freeze({
  healthy: 'Healthy',
  stale: 'Stale',
  unavailable: 'Unavailable',
})
const STRATEGY_LABEL = Object.freeze({ configured: 'Configured', unavailable: 'Unavailable' })

export function HowMoneyWorks({ keeper, strategyConfig, riskWatch, yieldInfo, venue }) {
  const keeperLabel = KEEPER_LABEL[keeper?.label] ?? 'Unavailable'
  const strategyLabel = STRATEGY_LABEL[strategyConfig?.label] ?? 'Unavailable'
  const riskWatchLabel =
    riskWatch?.label && riskWatch.label !== 'unavailable' ? riskWatch.label : 'Unavailable'

  const showApy =
    yieldInfo?.state === 'live' &&
    typeof yieldInfo.apy === 'number' &&
    Number.isFinite(yieldInfo.apy)

  return (
    <section className="pc-money-section" aria-labelledby="how-money-works-heading">
      <header>
        <h2 id="how-money-works-heading">How your money is working</h2>
      </header>
      <div>
        <VenueTruth
          kind="stellar-live"
          venue={venue || 'Autofarm Vault'}
          apy={showApy ? { state: 'live', value: yieldInfo.apy } : undefined}
        />

        <p>Keeper automation: {keeperLabel}</p>
        <p>Last keeper heartbeat: {formatHeartbeat(keeper?.lastHeartbeatAt)}</p>
        <p>Vault strategy: {strategyLabel}</p>
        <p>Risk radar: {riskWatchLabel}</p>
      </div>
    </section>
  )
}
