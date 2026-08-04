function shortAddress(address) {
  if (typeof address !== 'string' || address.length < 9) return address || 'Unavailable'
  return `${address.slice(0, 4)}…${address.slice(-4)}`
}

export function formatCrewAmount(amount) {
  if (
    !amount ||
    typeof amount.token !== 'string' ||
    typeof amount.units !== 'string' ||
    !Number.isSafeInteger(amount.decimals) ||
    amount.decimals < 0
  ) {
    return 'Unavailable'
  }

  try {
    const units = BigInt(amount.units)
    const negative = units < 0n
    const digits = (negative ? -units : units).toString().padStart(amount.decimals + 1, '0')
    const split = digits.length - amount.decimals
    const whole = digits.slice(0, split).replace(/\B(?=(\d{3})+(?!\d))/g, ',') || '0'
    const fraction = amount.decimals > 0 ? digits.slice(split).replace(/0+$/, '') : ''
    return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''} ${amount.token}`
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

function childStatus(child) {
  const agent = child.agent
  if (agent?.scope?.value?.revoked) return 'Cancelled'
  if (agent?.executionStatus === 'executing') return 'Syncing'
  if (agent?.problems?.length) return 'Needs attention'
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
  return 'Working'
}

function locationLabel(location) {
  if (location === 'stellar-vault') return 'Stellar vault'
  if (location === 'base-proxy') return 'Base proxy'
  return location || 'Unknown location'
}

function ChildTechnicalDetails({ child }) {
  const { agent, discoveryRow = {} } = child
  const problems = Array.isArray(agent.problems) ? [...new Set(agent.problems)] : []
  return (
    <details className="pc-crew-child-details">
      <summary>Technical details · {shortAddress(agent.address)}</summary>
      <div className="pc-crew-child-details-body">
        <dl className="pc-crew-child-facts">
          <div>
            <dt>Child address</dt>
            <dd>{agent.address}</dd>
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

function CrewChild({ child, onCancelAgent, onWithdrawAgent, actionPending }) {
  const address = child.agent.address
  const revoked = Boolean(child.agent?.scope?.value?.revoked)
  return (
    <li
      className="pc-crew-child"
      data-child-address={address}
      data-revoked={revoked}
      data-pocket-enter
    >
      <div className="pc-crew-child-head">
        <div>
          <p className="pc-crew-child-address">{shortAddress(address)}</p>
          <p className="pc-crew-child-state">{childStatus(child)}</p>
        </div>
        <CrewAmountList amounts={child.workingTotals} className="pc-crew-child-total" />
      </div>

      <ChildTechnicalDetails child={child} />

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
                {persona.children.map((entry) => (
                  <CrewChild
                    key={entry.agent.address}
                    child={entry}
                    onCancelAgent={onCancelAgent}
                    onWithdrawAgent={onWithdrawAgent}
                    actionPending={actionPending}
                  />
                ))}
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
