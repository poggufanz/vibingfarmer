// frontend/src/components/money/AgentTeam.jsx
// My Money Task 11 (Pocket Crew redesign, Wave 5). "Your agent team": one row per deployed
// agent_account, keyed by its own stable address -- never list index (AgentMark.jsx's own hard
// rule, §6.6). A revoked/expired agent that still holds confirmed money stays VISIBLE here as
// "Needs recovery" -- myMoneyModel.js's own docs (readOwnerMoney.js: owner_withdraw has no scope
// gate on-chain) are the reason a naive "hide anything revoked" filter would be actively dangerous:
// it would hide exactly the agents the owner most needs to see.
//
// Consumes the SAME raw per-agent rows PositionList.jsx does (readOwnerMoney.js:317-327 --
// {address, scope, vaultShares, idleToken, amount, executionStatus, custody, custodyBreakdown,
// problems}), plus `problemAgents` -- the address list buildMyMoneyModel already computed via its
// own confirmed-problem predicate (myMoneyModel.js:44-48,70-80,195-208: a CONFIRMED marker
// (scope-revoked/scope-expired/base-execution-failed) AND a known-positive amount). This component
// deliberately does NOT re-derive that predicate itself -- re-implementing the same rule a second
// time here would risk drifting from the one the model already computed and tested.
//
// Cap: My Money Task 13 Part B item 6. readOwnerMoney.js's readOneAgentMoney (:317-327) emits no
// cap field -- but ownerDiscovery.js's `addCandidate` (Task 13's own commit) now carries `cap`
// (sourced from RouterDeployedEvent, the only place that ever has one -- decodeDeployedEvent,
// routerEvents.js:35-42) onto the `discovery` prop's own agent rows, serialized as a string. This
// component reads it from THERE (matching `discovery` by address, the same merge WithdrawDialog.jsx
// already does for scopeReadStatus/revoked/expiry), never from `agents` (moneyRead.agents), which
// still has no cap field at all. Do NOT reach for `PermissionDecisionV1.reviewedAgentInits[].cap`
// (Strategy's ProtectStage source) instead -- it's a pre-execution, run-scoped artifact keyed by
// `allocationId` with no persisted link to a deployed agent address; the on-chain
// RouterDeployedEvent above is. `discovery` is optional here (loads async, same as everywhere else
// in this component) -- an agent whose deploy event was never seen, or whose discovery hasn't
// resolved yet, honestly renders "Unavailable", never a coerced zero or a fabricated number.
import { useState } from 'react'
import { AgentMark } from '../pocket/AgentMark.jsx'
import { NetworkBadge } from '../pocket/NetworkIdentity.jsx'
import { Dialog } from '../pocket/Primitives.jsx'
import { planFullExit } from '../../money/ownerActions.js'
import { SOROBAN_DECIMALS } from '../../stellar/config.js'

// Same explorer convention StrategyReceipt.jsx already uses for a Stellar account
// (StrategyReceipt.jsx:97-99) -- re-declared locally per that file's own sibling-surface rationale
// (not a shared module either surface is allowed to reach into).
function explorerAccountUrl(address) {
  return `https://stellar.expert/explorer/testnet/account/${address}`
}

function formatExpiry(expirySeconds) {
  return Number.isFinite(expirySeconds) && expirySeconds > 0
    ? new Date(expirySeconds * 1000).toISOString()
    : 'Unavailable'
}

function isKnownPositive(amount) {
  if (amount == null) return false
  try {
    return BigInt(amount.units) > 0n
  } catch {
    return false
  }
}

// Fix loop 1, I1: names for custody.js's own fixed location enum (custody.js:7-14), used to
// describe each individually-known leg of a split agent below.
function locationName(location) {
  if (location === 'stellar-vault') return 'vault'
  if (location === 'agent') return 'agent balance'
  if (location === 'base-proxy') return 'Base'
  if (location === 'in-transit') return 'bridging'
  return 'unknown location'
}

// Human, honest state label -- never a guess beyond what this row's own evidence proves. Ordered
// most-specific-first; a needs-recovery row is labelled separately by the caller (recoveryNeeded),
// this only covers the OTHERWISE state.
//
// Fix loop 1, I1: reads `agent.custodyBreakdown` FIRST, exactly the precedence
// PositionList.jsx:91-99 already uses, instead of the single collapsed `agent.custody.location`.
// custody.js:41-43 sets that collapsed value to 'unknown' BY DESIGN for a genuine Stellar+Base
// split (two independently known-positive legs can't be summarized as one location), so reading
// it directly here made a split agent fall through every branch to the generic 'Active' -- the
// same agent PositionList already shows correctly with both real legs. Matching that precedence
// keeps the two components saying the same true thing about the same agent.
function agentStateLabel(agent) {
  if (agent.scope?.state !== 'known') return 'Status unknown'
  if (agent.scope.value?.revoked) return 'Revoked'
  const expiry = Number(agent.scope.value?.expiry ?? 0)
  const nowSec = Math.floor(Date.now() / 1000)
  if (Number.isFinite(expiry) && expiry > 0 && expiry <= nowSec) return 'Expired'
  if (agent.executionStatus === 'queued') return 'Bridging queued'
  if (agent.executionStatus === 'executing') return 'Bridging in progress'
  if (agent.executionStatus === 'failed') return 'Bridge issue'
  if (agent.custodyBreakdown?.length > 1) {
    return `Split: ${agent.custodyBreakdown.map((leg) => locationName(leg.location)).join(' + ')}`
  }
  const location =
    agent.custodyBreakdown?.length === 1
      ? agent.custodyBreakdown[0].location
      : agent.custody?.location
  if (location === 'stellar-vault') return 'Earning in vault'
  if (location === 'base-proxy') return 'Custody on Base'
  if (location === 'in-transit') return 'Bridging'
  if (location === 'agent' && isKnownPositive(agent.amount)) return 'Holding idle balance'
  return 'Active'
}

// Look up this agent's cap on the `discovery` envelope's own rows (never `agents` -- see this
// file's header comment on why the two arrays carry different fields for the same address).
function capFor(agent, discovery) {
  const row = (discovery?.agents ?? []).find((a) => a.address === agent.address)
  return row?.cap ?? null
}

// Fix loop 2, M6 precedent (WithdrawDialog.jsx): `BigInt('')` returns `0n` without throwing, so a
// blank/whitespace-only cap string must be rejected BEFORE the parse attempt, or an unreadable cap
// would render as a confident "0 USDC" instead of the honest "Unavailable" it actually is. `decimals`
// is the agent's OWN `amount.decimals` when a read exists (never a hardcoded 7) -- cap and amount
// are the same token, so a non-canonical decimals count (a future non-SAC token) must scale both
// identically, not silently misreport the cap by orders of magnitude.
function formatCap(cap, decimals) {
  if (typeof cap !== 'string' || !cap.trim()) return 'Unavailable'
  let units
  try {
    units = BigInt(cap)
  } catch {
    return 'Unavailable'
  }
  const value = Number(units) / 10 ** decimals
  return `${value.toLocaleString()} USDC`
}

function markStateFor(agent, recoveryNeeded) {
  if (recoveryNeeded) return 'failed'
  if (agent.executionStatus === 'failed') return 'failed'
  if (agent.scope?.state !== 'known') return 'idle'
  if (agent.executionStatus === 'queued' || agent.executionStatus === 'executing') return 'active'
  if (isKnownPositive(agent.amount)) return 'confirmed'
  return 'idle'
}

export function AgentTeam({
  agents = [],
  problemAgents = [],
  discovery = null,
  account = null,
  onRecoverAgent,
}) {
  const [recoveryAddress, setRecoveryAddress] = useState(null)
  const recoveryTarget = agents.find((a) => a.address === recoveryAddress) ?? null
  const plan =
    recoveryTarget && discovery && account
      ? planFullExit({ discovery, position: { agents }, account })
      : null

  return (
    <section className="pc-money-section" aria-labelledby="your-agent-team-heading">
      <header>
        <h2 id="your-agent-team-heading">Your agent team</h2>
      </header>
      <div>
        {agents.length === 0 && <p>No agents deployed yet.</p>}
        <ul className="pc-crew-list">
          {agents.map((agent) => {
            const recoveryNeeded = problemAgents.includes(agent.address)
            const label = recoveryNeeded ? 'Needs recovery' : agentStateLabel(agent)
            return (
              <li
                key={agent.address}
                className="pc-crew-row"
                data-agent-state={recoveryNeeded ? 'needs-recovery' : 'ok'}
              >
                <AgentMark identity={agent.address} state={markStateFor(agent, recoveryNeeded)} />
                <div>
                  <NetworkBadge networkId="stellar-testnet" />
                  <p>
                    <a href={explorerAccountUrl(agent.address)} target="_blank" rel="noreferrer">
                      {agent.address}
                    </a>
                  </p>
                  <p>
                    Cap:{' '}
                    {formatCap(
                      capFor(agent, discovery),
                      agent.amount?.decimals ?? SOROBAN_DECIMALS
                    )}
                  </p>
                  <p>
                    Expires:{' '}
                    {formatExpiry(
                      agent.scope?.state === 'known' ? agent.scope.value?.expiry : null
                    )}
                  </p>
                </div>
                <span>{label}</span>

                {recoveryNeeded && (
                  <ul className="pc-crew-row-recovery">
                    <li>
                      <button
                        type="button"
                        className="pc-button pc-button--danger"
                        onClick={() => setRecoveryAddress(agent.address)}
                      >
                        Recover funds
                      </button>
                    </li>
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      </div>

      <Dialog
        open={Boolean(recoveryTarget)}
        title="Recover this agent's funds"
        description="This agent's scope is revoked or expired, so it can no longer act automatically."
        onClose={() => setRecoveryAddress(null)}
        actions={
          <>
            <button
              type="button"
              className="pc-button pc-button--secondary"
              onClick={() => setRecoveryAddress(null)}
            >
              Close
            </button>
            <button
              type="button"
              className="pc-button pc-button--primary"
              onClick={() => {
                onRecoverAgent?.(recoveryAddress, plan)
                setRecoveryAddress(null)
              }}
            >
              {plan?.label || 'Exit all'}
            </button>
          </>
        }
      >
        <p>
          The balance is not lost -- a full exit can recover it. Owner withdrawal is always allowed
          by the contract, regardless of the current scope state.
        </p>
        {plan?.limitation && <p>{plan.limitation}</p>}
        {!discovery || !account ? (
          <p>Full recovery details will be available once agent discovery finishes loading.</p>
        ) : null}
      </Dialog>
    </section>
  )
}
