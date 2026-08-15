import { AgentMark } from '../pocket/AgentMark.jsx'
import { NetworkBadge } from '../pocket/NetworkIdentity.jsx'
import {
  formatCoreAmount,
  normalizeCoreAmount,
  toAgentIdentityView,
} from '../../core/coreRouteAdapters.js'

function shortAddress(address) {
  if (typeof address !== 'string' || address.length < 9) return address || 'Unavailable'
  return `${address.slice(0, 4)}…${address.slice(-4)}`
}

export function formatCrewAmount(amount) {
  try {
    return formatCoreAmount(normalizeCoreAmount(amount))
  } catch {
    return 'Unavailable'
  }
}

export function CrewAmountList({ amounts = [], empty = '—', className = '' }) {
  if (!amounts.length) return <span className={className}>{empty}</span>
  return (
    <ul className={`pc-crew-amount-list ${className}`.trim()}>
      {amounts.map((amount) => (
        <li key={`${amount.token}:${amount.decimals}`}>{formatCrewAmount(amount)}</li>
      ))}
    </ul>
  )
}

function identityInputForChild(child) {
  const row = child?.discoveryRow ?? {}
  const agent = child?.agent ?? {}
  const canonical = child?.identity && typeof child.identity === 'object' ? child.identity : null
  if (!canonical) {
    return {
      phase: 'unknown',
      address: null,
      verifiedAddress: null,
      verified: false,
      source: 'unknown',
    }
  }
  const canonicalAddress = canonical?.address ?? canonical?.verifiedAddress
  const rowAddress = row.address
  const agentAddress = agent.address
  const addresses = [canonicalAddress, rowAddress, agentAddress].filter(
    (value) => typeof value === 'string' && value.trim().length > 0
  )
  const mismatched = addresses.some((address) => address !== addresses[0])
  if (canonical) {
    return {
      ...canonical,
      address: mismatched ? null : canonicalAddress,
      verifiedAddress: mismatched ? null : canonicalAddress,
      verified: mismatched ? false : canonical.verified,
    }
  }
  return canonical
}

function childStatus(child, identity) {
  if (identity?.phase === 'planned') return 'Planned'
  const agent = child.agent
  if (agent?.scope?.value?.revoked) return 'Cancelled'
  if (agent?.executionStatus === 'executing') return 'Syncing'
  if (agent?.problems?.length) return 'Needs attention'
  if (
    child.workingLegs.length > 0 &&
    child.workingLegs.every((leg) => leg.location === 'base-proxy')
  ) {
    return 'Custody only'
  }
  return child.active ? 'Working' : 'Confirmed'
}

function personaStatus(persona) {
  if (persona.children.length === 0) return 'Idle'
  if (persona.children.some((child) => child.agent?.problems?.length || child.incomplete)) {
    return 'Needs attention'
  }
  if (persona.children.some((child) => child.agent?.executionStatus === 'executing')) {
    return 'Syncing'
  }
  if (
    persona.children.length > 0 &&
    persona.children.every(
      (child) =>
        child.workingLegs.length > 0 &&
        child.workingLegs.every((leg) => leg.location === 'base-proxy')
    )
  ) {
    return 'Custody only'
  }
  return 'Working'
}

function locationLabel(location) {
  if (location === 'stellar-vault') return 'Stellar vault'
  if (location === 'base-proxy') return 'Base Sepolia proxy. Custody only. No protocol yield.'
  return location || 'Unknown location'
}

function networkIdForLocation(location) {
  if (location === 'stellar-vault') return 'stellar-testnet'
  if (location === 'base-proxy') return 'base-sepolia'
  return null
}

function ChildNetworkBadges({ child }) {
  if (!child.workingLegs.length) return null
  return (
    <div className="pc-crew-child-networks">
      {child.workingLegs.map((leg, index) => (
        <NetworkBadge
          key={`network:${leg.key ?? locationLabel(leg.location)}:${index}`}
          networkId={networkIdForLocation(leg.location)}
        />
      ))}
    </div>
  )
}

function ChildTechnicalDetails({ child, identity }) {
  const { agent, discoveryRow = {} } = child
  const problems = Array.isArray(agent.problems) ? [...new Set(agent.problems)] : []
  const address = identity.address
  return (
    <details className="pc-crew-child-details">
      <summary>Technical details · {shortAddress(address)}</summary>
      <div className="pc-crew-child-details-body">
        <dl className="pc-crew-child-facts">
          <div>
            <dt>Child address</dt>
            <dd>{address}</dd>
          </div>
          <div>
            <dt>Run ID</dt>
            <dd>{discoveryRow.runId ?? 'Legacy indexed deployment'}</dd>
          </div>
          <div>
            <dt>Run ordinal</dt>
            <dd>{Number.isSafeInteger(discoveryRow.runOrdinal) ? discoveryRow.runOrdinal : '—'}</dd>
          </div>
          <div>
            <dt>Created ledger</dt>
            <dd>
              {Number.isSafeInteger(discoveryRow.createdLedger)
                ? discoveryRow.createdLedger.toLocaleString()
                : 'Unavailable'}
            </dd>
          </div>
          <div>
            <dt>Deployment transaction</dt>
            <dd>{discoveryRow.createdTxHash ?? 'Unavailable'}</dd>
          </div>
        </dl>

        <div className="pc-crew-evidence-block">
          <h4>Productive split</h4>
          <ul className="pc-crew-leg-list">
            {child.workingLegs.map((leg, index) => (
              <li key={`${leg.key ?? locationLabel(leg.location)}:${index}`}>
                <span>{locationLabel(leg.location)}</span>
                <span>
                  {leg.amount ? formatCrewAmount(leg.amount) : 'Amount unavailable'}
                  {leg.shared && !leg.counted ? ' · shared, counted elsewhere' : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="pc-crew-evidence-block">
          <h4>Idle amount</h4>
          <p>{child.idleAmount ? formatCrewAmount(child.idleAmount) : 'None confirmed'}</p>
        </div>

        <div className="pc-crew-evidence-block">
          <h4>Problems</h4>
          {problems.length ? (
            <ul className="pc-crew-problem-list">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : (
            <p>None reported</p>
          )}
        </div>
      </div>
    </details>
  )
}

function childKey(child, identity, occurrence = 0) {
  let base
  if (identity?.key) base = identity.key
  else if (identity?.allocationId) base = identity.allocationId
  else if (identity?.runId) base = identity.runId
  else base = `unavailable:${identity?.phase ?? 'unknown'}:${identity?.source ?? 'unknown'}`
  return occurrence > 0 ? `${base}:${occurrence}` : base
}

function CrewChild({ child, identityKey, onCancelAgent, onWithdrawAgent, actionPending }) {
  const identity = toAgentIdentityView(identityInputForChild(child))
  const address = identity.address || ''
  const resolvedIdentityKey = identityKey ?? childKey(child, identity)
  const revoked = Boolean(child.agent?.scope?.value?.revoked)
  const identityAvailable = identity.identityAvailable
  const boundAccount = identityAvailable && identity.phase !== 'planned'
  const status = childStatus(child, identity)
  return (
    <li
      className="pc-crew-child"
      data-child-identity={resolvedIdentityKey}
      data-child-address={boundAccount ? address : undefined}
      data-child-identity-unavailable={identityAvailable ? undefined : 'true'}
      data-revoked={revoked}
      data-pocket-enter
    >
      <div className="pc-crew-child-head">
        {identityAvailable ? (
          <AgentMark
            identity={identity}
            state={identity.phase === 'planned' ? 'planned' : 'existing'}
            label="agent"
          />
        ) : (
          <span
            className="pc-crew-child-identity-unavailable"
            role="status"
            aria-label="Agent identity unavailable"
          >
            Agent identity unavailable
          </span>
        )}
        <div>
          <p className="pc-crew-child-address">
            {identityAvailable ? (boundAccount ? shortAddress(address) : 'Planned') : 'Unavailable'}
          </p>
          {identityAvailable && <p className="pc-crew-child-state">{status}</p>}
          {boundAccount && <ChildNetworkBadges child={child} />}
        </div>
        {boundAccount && (
          <CrewAmountList amounts={child.workingTotals} className="pc-crew-child-total" />
        )}
      </div>

      {boundAccount && <ChildTechnicalDetails child={child} identity={identity} />}

      {boundAccount && (
        <div className="pc-crew-child-actions">
          {child.hasWithdrawableStellar && typeof onWithdrawAgent === 'function' && (
            <button
              type="button"
              className="pc-button pc-button--secondary"
              aria-label={`Withdraw from ${address}`}
              disabled={actionPending}
              onClick={() => onWithdrawAgent(address)}
            >
              Withdraw
            </button>
          )}
          {!revoked && (
            <button
              type="button"
              className="pc-button pc-button--secondary"
              aria-label={`Cancel ${address}`}
              disabled={actionPending}
              onClick={() => onCancelAgent?.(address)}
            >
              Cancel
            </button>
          )}
        </div>
      )}
    </li>
  )
}

export function CrewLanes({
  personas = [],
  onCancelAgent,
  onWithdrawAgent,
  actionPending = false,
}) {
  return (
    <section className="pc-crew-lanes-section" aria-labelledby="crew-lanes-heading">
      <h2 id="crew-lanes-heading" className="pc-crew-stat-label">
        Your crew
      </h2>
      <ul className="pc-crew-personas">
        {personas.map((persona) => (
          <li
            key={persona.id}
            className="pc-crew-persona"
            data-persona-id={persona.id}
            data-pocket-enter
          >
            <header className="pc-crew-persona-head">
              <img
                className="pc-crew-persona-avatar"
                src={persona.avatar}
                alt={`${persona.name} crew persona`}
                width="56"
                height="56"
              />
              <div>
                <h3>{persona.name}</h3>
                <p>
                  {persona.children.length} {persona.children.length === 1 ? 'account' : 'accounts'}
                </p>
              </div>
              <div className="pc-crew-persona-summary">
                <span className="pc-crew-persona-state">{personaStatus(persona)}</span>
                <CrewAmountList amounts={persona.totals} empty="No working balance" />
                {persona.totalState === 'partial' && (
                  <span className="pc-crew-coverage">Partial coverage</span>
                )}
              </div>
            </header>

            {persona.children.length ? (
              <ul className="pc-crew-children">
                {persona.children.map((entry, index) => {
                  const identity = toAgentIdentityView(identityInputForChild(entry))
                  const baseKey = childKey(entry, identity)
                  const occurrence = persona.children
                    .slice(0, index)
                    .filter(
                      (previous) =>
                        childKey(previous, toAgentIdentityView(identityInputForChild(previous))) ===
                        baseKey
                    ).length
                  const identityKey = childKey(entry, identity, occurrence)
                  return (
                    <CrewChild
                      key={identityKey}
                      identityKey={identityKey}
                      child={entry}
                      onCancelAgent={onCancelAgent}
                      onWithdrawAgent={onWithdrawAgent}
                      actionPending={actionPending}
                    />
                  )
                })}
              </ul>
            ) : (
              <p className="pc-crew-persona-empty">No productive accounts assigned yet.</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
