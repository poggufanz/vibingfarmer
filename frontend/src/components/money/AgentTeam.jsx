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
// Cap: this row intentionally never shows a per-agent budget/cap figure as a real number. Verified
// end to end that no real production interface actually carries one at this layer: readOwnerMoney.js
// (readOneAgentMoney, :317-327) emits no cap field; ownerDiscovery.js's agent rows (:209-219) only
// ever add {vault, revoked, expiry, authorized} on top of the D1 apiRow; and the D1 record itself
// (api/agent-index/models.js's parseMembershipRow, :91-107) has no cap/budget column at all -- the
// only place a per-agent cap is ever read is routerEvents.js's RouterDeployedEvent (:33,88), which
// this module never receives. Rather than invent a shape no real function emits (the exact mistake
// this wave's guard standard exists to catch), Cap renders as an honest "Unavailable" -- the same
// discipline this whole codebase applies everywhere else money can't be confirmed.
import { useState } from 'react'
import { AgentMark } from '../pocket/AgentMark.jsx'
import { NetworkBadge } from '../pocket/NetworkIdentity.jsx'
import { Dialog } from '../pocket/Primitives.jsx'
import { planFullExit } from '../../money/ownerActions.js'

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

// Human, honest state label -- never a guess beyond what this row's own evidence proves. Ordered
// most-specific-first; a needs-recovery row is labelled separately by the caller (recoveryNeeded),
// this only covers the OTHERWISE state.
function agentStateLabel(agent) {
  if (agent.scope?.state !== 'known') return 'Status unknown'
  if (agent.scope.value?.revoked) return 'Revoked'
  const expiry = Number(agent.scope.value?.expiry ?? 0)
  const nowSec = Math.floor(Date.now() / 1000)
  if (Number.isFinite(expiry) && expiry > 0 && expiry <= nowSec) return 'Expired'
  if (agent.executionStatus === 'queued') return 'Bridging queued'
  if (agent.executionStatus === 'executing') return 'Bridging in progress'
  if (agent.executionStatus === 'failed') return 'Bridge issue'
  if (agent.custody?.location === 'stellar-vault') return 'Earning in vault'
  if (agent.custody?.location === 'base-proxy') return 'Custody on Base'
  if (agent.custody?.location === 'in-transit') return 'Bridging'
  if (agent.custody?.location === 'agent' && isKnownPositive(agent.amount)) return 'Holding idle balance'
  return 'Active'
}

function markStateFor(agent, recoveryNeeded) {
  if (recoveryNeeded) return 'failed'
  if (agent.executionStatus === 'failed') return 'failed'
  if (agent.scope?.state !== 'known') return 'idle'
  if (agent.executionStatus === 'queued' || agent.executionStatus === 'executing') return 'active'
  if (isKnownPositive(agent.amount)) return 'confirmed'
  return 'idle'
}

export function AgentTeam({ agents = [], problemAgents = [], discovery = null, account = null, onRecoverAgent }) {
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
              <li key={agent.address} className="pc-crew-row" data-agent-state={recoveryNeeded ? 'needs-recovery' : 'ok'}>
                <AgentMark identity={agent.address} state={markStateFor(agent, recoveryNeeded)} />
                <div>
                  <NetworkBadge networkId="stellar-testnet" />
                  <p>
                    <a href={explorerAccountUrl(agent.address)} target="_blank" rel="noreferrer">
                      {agent.address}
                    </a>
                  </p>
                  <p>Cap: Unavailable</p>
                  <p>Expires: {formatExpiry(agent.scope?.state === 'known' ? agent.scope.value?.expiry : null)}</p>
                </div>
                <span>{label}</span>

                {recoveryNeeded && (
                  <ul className="pc-crew-row-recovery">
                    <li>
                      <button type="button" className="pc-button pc-button--danger" onClick={() => setRecoveryAddress(agent.address)}>
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
            <button type="button" className="pc-button pc-button--secondary" onClick={() => setRecoveryAddress(null)}>
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
          The balance is not lost -- a full exit can recover it. Owner withdrawal is always allowed by
          the contract, regardless of the current scope state.
        </p>
        {plan?.limitation && <p>{plan.limitation}</p>}
        {!discovery || !account ? (
          <p>Full recovery details will be available once agent discovery finishes loading.</p>
        ) : null}
      </Dialog>
    </section>
  )
}
