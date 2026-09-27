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
import { formatUtcMs } from './formatUtc.js'
import { toLiveVenueView } from '../../core/coreRouteAdapters.js'

const KEEPER_LABEL = Object.freeze({
  healthy: 'Healthy',
  stale: 'Stale',
  unavailable: 'Unavailable',
})
const STRATEGY_LABEL = Object.freeze({ configured: 'Configured', unavailable: 'Unavailable' })
// Lamp colour only restates the label automationEvidence.js already classified; any other
// (free-text) label gets no lamp rather than a guessed health colour.
const LABEL_TONE = Object.freeze({
  Healthy: 'live',
  Configured: 'live',
  Stale: 'warn',
  Unavailable: 'idle',
})

export function HowMoneyWorks({ keeper, strategyConfig, riskWatch, yieldInfo, venue }) {
  const keeperLabel = KEEPER_LABEL[keeper?.label] ?? 'Unavailable'
  const heartbeat = formatUtcMs(keeper?.lastHeartbeatAt)
  const strategyLabel = STRATEGY_LABEL[strategyConfig?.label] ?? 'Unavailable'
  const riskWatchLabel =
    riskWatch?.label && riskWatch.label !== 'unavailable' ? riskWatch.label : 'Unavailable'

  // A route-provided model yield is authoritative when present. Direct callers may instead
  // supply the source-owned nested venue.yield record; flat APY fields are never consulted.
  const effectiveYield =
    yieldInfo !== undefined
      ? yieldInfo
      : venue && typeof venue === 'object'
        ? venue.yield
        : undefined
  const venueInput =
    venue && typeof venue === 'object'
      ? { ...venue, yield: effectiveYield }
      : typeof venue === 'string'
        ? { venueKind: 'stellar-live', yield: effectiveYield }
        : { venueKind: undefined, yield: effectiveYield }
  const venueView = toLiveVenueView(venueInput)
  const showApy = venueView.state === 'live'
  // A missing venue source is not evidence of the Stellar route. Preserve the existing
  // unavailable/unknown presentation for explicit `none` yield instead of inventing Base or
  // claiming Autofarm/Blend. A live, source-backed yield still uses the established Stellar copy.
  const sourceVenueKind =
    venue && typeof venue === 'object' && typeof venue.venueKind === 'string'
      ? venue.venueKind
      : null
  const isExplicitBaseVenue =
    venue &&
    typeof venue === 'object' &&
    (venue.venueKind === 'base-custody-proxy' || venue.chain === 'base')
  const isExplicitStellarVenue =
    typeof venue === 'string' ||
    (venue && typeof venue === 'object' && venue.venueKind === 'stellar-live')
  const venueKind = isExplicitBaseVenue
    ? 'base-proxy'
    : isExplicitStellarVenue
      ? 'stellar-live'
      : sourceVenueKind
        ? 'unknown'
        : venueView.state === 'none'
          ? 'base-proxy'
          : venueView.state === 'live'
            ? 'stellar-live'
            : 'unknown'

  return (
    <section
      className="pc-money-section"
      aria-labelledby="how-money-works-heading"
      data-pocket-enter
    >
      <header>
        <h2 id="how-money-works-heading">How your money is working</h2>
        <p className="pc-money-section-lede">
          The route your deposit takes and the automation on it.
        </p>
      </header>
      <div className="pc-money-panel">
        <VenueTruth
          kind={venueKind}
          venue={typeof venue === 'string' ? venue : venue?.name || 'Autofarm Vault'}
          networkContext={
            venueKind === 'stellar-live'
              ? {
                  hostNetworkId: 'stellar-testnet',
                  sourceNetworkId: 'stellar-testnet',
                  destinationNetworkId: 'stellar-testnet',
                  custodyNetworkId: 'stellar-testnet',
                  transitState: 'none',
                }
              : undefined
          }
          apy={
            showApy
              ? {
                  state: 'live',
                  value: venueView.apy,
                  source: venueView.source,
                  freshness: venueView.checkedAt,
                }
              : undefined
          }
        />

        <dl className="pc-evidence">
          <div data-tone={LABEL_TONE[keeperLabel]}>
            <dt>Keeper automation</dt>
            <dd>
              {LABEL_TONE[keeperLabel] && <span className="pc-lamp" aria-hidden="true" />}
              {keeperLabel}
            </dd>
          </div>
          <div>
            <dt>Last keeper heartbeat</dt>
            <dd className={heartbeat === 'Unavailable' ? undefined : 'pc-technical'}>
              {heartbeat}
            </dd>
          </div>
          <div data-tone={LABEL_TONE[strategyLabel]}>
            <dt>Vault strategy</dt>
            <dd>
              {LABEL_TONE[strategyLabel] && <span className="pc-lamp" aria-hidden="true" />}
              {strategyLabel}
            </dd>
          </div>
          <div data-tone={LABEL_TONE[riskWatchLabel]}>
            <dt>Risk radar</dt>
            <dd>
              {LABEL_TONE[riskWatchLabel] && <span className="pc-lamp" aria-hidden="true" />}
              {riskWatchLabel}
            </dd>
          </div>
        </dl>
      </div>
    </section>
  )
}
