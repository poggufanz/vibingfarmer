// frontend/src/components/money/PositionList.jsx
// My Money Task 11 (Pocket Crew redesign, Wave 5). "Your position": WHERE the owner's confirmed
// money physically sits right now, one row per real, non-zero location -- never a re-statement of
// "who owns it" (that's AgentTeam.jsx). A bridge agent's own contract is always Stellar-hosted
// (Step 3), so its row always carries a Stellar `NetworkBadge`; any Base-side custody it also holds
// is rendered as separate NESTED rows underneath, never merged into one ambiguous line.
//
// Consumes the RAW per-agent read rows readOwnerMoney.js's readOneAgentMoney() actually returns
// (readOwnerMoney.js:317-327): `{ address, scope, vaultShares, idleToken, amount, executionStatus,
// custody, custodyBreakdown, problems }`. This is the SAME array myMoneyModel.js documents as
// `MoneySnapshot.agents` (myMoneyModel.js:14-39) but does NOT itself forward into its own output
// (buildMyMoneyModel's finishModel, myMoneyModel.js:134-173, never copies `money.agents` through)
// -- so this component is wired directly off the caller's own raw money-read array, the same way
// StartStage.jsx takes `events`/`receipt` as their own props alongside (not merged into) the
// strategy view-model. Custody location comes ONLY from custody.js's own derivation
// (custodyForAgent/custodyBreakdownForAgent, already computed into each row above) -- never
// re-guessed here, and NEVER read off a single collapsed `custody.location` for a split agent
// (custody.js:41-43: a split Stellar+Base agent reports 'unknown' there BY DESIGN); the per-leg
// `custodyBreakdown` is checked FIRST for exactly that reason.
import { MoneyFigure, VenueTruth } from '../pocket/Primitives.jsx'
import { NetworkBadge, NetworkRoute } from '../pocket/NetworkIdentity.jsx'
import { AgentPersonaAvatar } from '../pocket/AgentPersonaAvatar.jsx'
import {
  normalizeCoreAmount,
  toBaseCustodyTruth,
  toAgentIdentityView,
  toFactView,
  toFreshnessView,
} from '../../core/coreRouteAdapters.js'
import { presentationPersonaForAddress } from '../../crew/personas.js'

// The one real Stellar execution destination this product ever has (strategy/venueTruth.js:19,
// frontend/src/config.js:37 -- identical literal, verified against both). Declared locally rather
// than imported: venueTruth.js's own `normalizeVenue` is shaped around a *venue catalog* record
// (chain/factSlug/address), not a per-agent money row, and pulling in a whole normalization layer
// for one fixed string would be the wrong tool for this file's actual job. Matches the sibling-
// surface convention StrategyReceipt.jsx already uses for its own local TOKEN_SYMBOLS constant.
const STELLAR_VAULT_DESTINATION = 'Autofarm Vault to Blend Capital v2'

function coreAmount(amount) {
  try {
    return normalizeCoreAmount(amount)
  } catch {
    return null
  }
}

function presentationAmount(amount, factView) {
  const normalized = coreAmount(amount)
  if (!normalized) return { state: 'unavailable', amount: null, freshness: null }
  if (!factView?.freshness) return { state: 'current', amount: normalized, freshness: undefined }

  const routeState = factView.freshness.state
  const state =
    routeState === 'stale'
      ? 'stale'
      : routeState === 'partial' || routeState === 'current' || routeState === 'confirmed'
        ? 'current'
        : 'unavailable'
  if (state === 'unavailable') return { state, amount: null, freshness: factView.freshness }
  try {
    const fact = toFactView({
      state,
      value: normalized,
      source: factView.freshness.source,
      checkedAt: factView.freshness.checkedAt,
      confirmedLedger: factView.freshness.confirmedLedger,
      confirmedBlock: factView.freshness.confirmedBlock,
    })
    return {
      state,
      amount: fact.value,
      // Partial discovery qualifies the evidence without making an independently-known leg
      // stale. Keep the source's Partial label while the amount itself remains Current.
      freshness: routeState === 'partial' ? factView.freshness : toFreshnessView(fact),
    }
  } catch {
    return { state: 'unavailable', amount: null, freshness: factView.freshness }
  }
}

function isKnownPositive(amount) {
  if (amount == null) return false
  try {
    return BigInt(amount.units) > 0n
  } catch {
    return false
  }
}

function shortAddress(address) {
  return typeof address === 'string' && address.length > 12
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : address
}

// Task 10: readOneAgentMoney can now report more than one Base leg for the same agent (two
// distinct Base children that landed in two different kernel/pool positions) -- each leg's real
// identity (kernelAddress + poolAddress) is threaded through so its React key can never collide
// with a sibling's, and its own honesty coverage reason (readOwnerMoney.js's per-leg
// `coverageReason`: 'stale'|'unavailable'|'dead-letter'|null) renders right next to it.
const COVERAGE_REASON_COPY = {
  stale: 'Confirmed evidence is a little older than usual. Refreshing.',
  unavailable: 'Could not reconfirm this round. Last known amount shown, not zero.',
  'dead-letter': 'Delivery report is stuck. Needs attention.',
}

// One display leg -> { networkId | routeContext, label, amount, key }. `location` values are
// custody.js's own fixed enum (custody.js:7-14): 'owner'|'agent'|'stellar-vault'|'in-transit'|
// 'base-proxy'|'unknown'. Every branch below is a real, reachable custody.js output -- nothing
// invented.
function legDisplay(location, amount, keySuffix, identity = {}) {
  const {
    kernelAddress = '',
    poolAddress = '',
    asset = '',
    poolName = null,
    coverageReason = null,
  } = identity
  // Review round 1, finding 7: `asset` joins kernelAddress/poolAddress in the key -- the grouping
  // layer (baseChildPositions.js's groupKeyFor) explicitly allows two groups to share the same
  // kernel+pool while differing only by asset (the brief's own "same vault with distinct asset"
  // case), which the OLD two-field key collided on.
  const key = `${keySuffix}:${location}:${kernelAddress}:${poolAddress}:${asset}`
  // Review round 1, finding 8: identity reaching the React key fixes React's reconciliation, not
  // the USER's ability to tell two Base positions apart -- render it too. Only meaningful for legs
  // that actually carry a real on-chain position identity (Base/in-transit legs); a Stellar leg's
  // own label is already its full identity.
  const identityLabel =
    kernelAddress && poolAddress
      ? `${poolName ?? shortAddress(poolAddress)} · ${shortAddress(kernelAddress)}`
      : null
  if (location === 'stellar-vault') {
    return {
      key,
      kind: 'stellar',
      label: STELLAR_VAULT_DESTINATION,
      amount,
      networkId: 'stellar-testnet',
      coverageReason,
      identityLabel: null,
    }
  }
  if (location === 'agent') {
    return {
      key,
      kind: 'stellar',
      label: 'Held at your agent (not yet deposited)',
      amount,
      networkId: 'stellar-testnet',
      coverageReason,
      identityLabel: null,
    }
  }
  if (location === 'base-proxy') {
    // Step 3 + the approved venueTruth.test.js:162-184 ruling (see this component's header for
    // why the sentence form, not the brief's own two-middle-dot example, is what ships): Foundation's
    // `VenueTruth` primitive already renders this exact fact -- reused verbatim rather than
    // re-typed, so this route can never drift from that single source of truth.
    return {
      key,
      kind: 'base-settled',
      label: null,
      amount,
      networkId: 'base-sepolia',
      coverageReason,
      identityLabel,
    }
  }
  if (location === 'in-transit') {
    // Genuinely between chains and we don't know which CCTP phase -- NetworkIdentity.jsx's own
    // 'unknown' transit copy ("Bridge status unknown") is the honest label; never guess a phase.
    return { key, kind: 'in-transit', label: null, amount, coverageReason, identityLabel }
  }
  // 'owner' / 'unknown': custody.js never returns these for a real, known-positive amount in
  // practice (see this file's header) but a defensive, honest fallback beats a silent drop.
  return {
    key,
    kind: 'stellar',
    label: 'Location unknown',
    amount,
    networkId: 'stellar-testnet',
    coverageReason,
    identityLabel: null,
  }
}

function positionRowFor(agent, unavailableOccurrence = 0) {
  const identity = toAgentIdentityView({
    phase: 'deployed',
    address: agent?.address,
    verified: Boolean(agent?.address),
    source: 'owner-discovery',
    state: 'confirmed',
  })
  if (!identity.identityAvailable) {
    return {
      key: `identity-unavailable-${unavailableOccurrence}`,
      address: null,
      identity,
      unavailable: true,
    }
  }

  const legs = []
  if (agent.custodyBreakdown?.length) {
    for (const leg of agent.custodyBreakdown) {
      if (isKnownPositive(leg.amount))
        legs.push(
          legDisplay(leg.location, leg.amount, agent.address, {
            kernelAddress: leg.kernelAddress,
            poolAddress: leg.poolAddress,
            asset: leg.asset,
            poolName: leg.poolName,
            coverageReason: leg.coverageReason,
          })
        )
    }
  } else if (isKnownPositive(agent.amount)) {
    legs.push(legDisplay(agent.custody?.location ?? 'unknown', agent.amount, agent.address))
  }
  if (legs.length === 0) return null

  // The parent row is always the Stellar leg when one exists (the agent contract itself is always
  // Stellar-hosted, Step 3) -- Base/in-transit legs never get promoted to the parent slot, they
  // always nest under it, even when there is no Stellar leg to show (a Base-only outcome still
  // gets a Stellar-hosted parent row, per Step 3's literal rule: "a bridge agent row itself is
  // hosted on Stellar testnet").
  const stellarLeg = legs.find((l) => l.kind === 'stellar')
  const childLegs = legs.filter((l) => l.kind !== 'stellar')
  return { address: agent.address, identity, stellarLeg: stellarLeg ?? null, childLegs }
}

function unattributedRows(unattributed) {
  return Object.entries(unattributed ?? {}).map(([kernelAddress, entry]) => ({
    kernelAddress,
    state: entry.state,
    amount: entry.amount,
  }))
}

export function PositionList({
  agents = [],
  unattributed = {},
  collectionState = null,
  factView = null,
  personaByAddress = null,
}) {
  let unavailableOccurrence = 0
  const rows = agents
    .map((agent) => {
      const row = positionRowFor(agent, unavailableOccurrence)
      if (row?.unavailable) unavailableOccurrence += 1
      return row
    })
    .filter(Boolean)
  const idleRows = unattributedRows(unattributed)
  const baseTruth = toBaseCustodyTruth()

  // 2026-08-02 polish: "No confirmed positions yet" is an AUTHORITATIVE-empty claim (spec §11:
  // empty copy only after the read truly completed). A disconnected or unconfirmed wallet must
  // never read as a proven-empty account, so the empty line follows the collection's own state.
  const emptyCopy =
    collectionState === 'disconnected'
      ? 'Connect a wallet to see where your money sits.'
      : collectionState === 'loading'
        ? 'Checking your positions…'
        : collectionState === 'unavailable'
          ? 'Positions unavailable. Nothing could be confirmed this round.'
          : 'No confirmed positions yet.'

  return (
    <section className="pc-money-section" aria-labelledby="your-position-heading" data-pocket-enter>
      <header>
        <h2 id="your-position-heading">Your position</h2>
      </header>
      <div>
        {rows.length === 0 && idleRows.length === 0 && <p>{emptyCopy}</p>}
        <ul className="pc-position-list">
          {rows.map((row) => {
            const persona = presentationPersonaForAddress(personaByAddress, row.address)
            return (
              <li
                key={row.unavailable ? row.key : row.address}
                data-row-key={row.unavailable ? row.key : undefined}
                className="pc-position-row"
              >
                {row.unavailable ? (
                  <div>
                    <AgentPersonaAvatar identity={row.identity} persona={null} state="idle" />
                  </div>
                ) : (
                  <>
                    <NetworkBadge networkId="stellar-testnet" />
                    <div className="pc-position-main">
                      <AgentPersonaAvatar
                        identity={row.identity}
                        persona={persona}
                        state="confirmed"
                      />
                      <div>
                        {row.stellarLeg ? (
                          <>
                            <p>{row.stellarLeg.label}</p>
                            {(() => {
                              const display = presentationAmount(row.stellarLeg.amount, factView)
                              return (
                                <MoneyFigure
                                  state={display.state}
                                  amount={display.amount}
                                  freshness={display.freshness}
                                />
                              )
                            })()}
                          </>
                        ) : (
                          <p>Bridging via {shortAddress(row.address)}</p>
                        )}
                      </div>
                    </div>
                    <span>{shortAddress(row.address)}</span>

                    {row.childLegs.length > 0 && (
                      <ul className="pc-position-row-children">
                        {row.childLegs.map((leg) => (
                          <li key={leg.key}>
                            {leg.kind === 'base-settled' ? (
                              <>
                                <NetworkBadge networkId="base-sepolia" />
                                <VenueTruth
                                  kind={baseTruth.yield.state === 'none' ? 'base-proxy' : 'unknown'}
                                  venue={baseTruth.destination}
                                />
                              </>
                            ) : (
                              <NetworkRoute
                                context={{
                                  hostNetworkId: 'stellar-testnet',
                                  sourceNetworkId: 'stellar-testnet',
                                  destinationNetworkId: 'base-sepolia',
                                  custodyNetworkId: 'stellar-testnet',
                                  transitState: 'unknown',
                                }}
                              />
                            )}
                            {leg.identityLabel && (
                              <p className="pc-position-leg-identity">{leg.identityLabel}</p>
                            )}
                            {(() => {
                              const display = presentationAmount(leg.amount, factView)
                              return (
                                <MoneyFigure
                                  state={display.state}
                                  amount={display.amount}
                                  freshness={display.freshness}
                                />
                              )
                            })()}
                            {leg.coverageReason && (
                              <p className="pc-money pc-money--unknown">
                                {COVERAGE_REASON_COPY[leg.coverageReason] ?? leg.coverageReason}
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </li>
            )
          })}

          {idleRows.map((row) => (
            <li key={row.kernelAddress} className="pc-position-row">
              <NetworkBadge networkId="base-sepolia" />
              <div>
                <p>Unattributed Base balance ({shortAddress(row.kernelAddress)})</p>
                {row.state === 'known' && row.amount ? (
                  (() => {
                    const display = presentationAmount(row.amount, factView)
                    return (
                      <MoneyFigure
                        state={display.state}
                        amount={display.amount}
                        freshness={display.freshness}
                      />
                    )
                  })()
                ) : (
                  <p className="pc-money pc-money--unknown">Unavailable. Needs confirming</p>
                )}
              </div>
              <span />
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
