import { useEffect, useRef, useState } from 'react'
import { AgentMark } from '../pocket/AgentMark.jsx'
import { NetworkBadge } from '../pocket/NetworkIdentity.jsx'
import {
  formatCoreAmount,
  normalizeCoreAmount,
  toAgentIdentityView,
} from '../../core/coreRouteAdapters.js'
import { formatShare, toneFor } from '../strategy/CrewSplit.jsx'
import { shareOf } from './CrewShareRail.jsx'

// Child accounts are Soroban contracts on Stellar testnet, whatever leg their money sits in.
const STELLAR_CONTRACT_EXPLORER = 'https://stellar.expert/explorer/testnet/contract/'
const COPIED_MS = 1600

// Status word -> lamp. Lime is reserved for "working"; attention is amber, never red, because
// nothing here has failed until a problem list says so.
const STATUS_TONE = Object.freeze({
  Working: 'live',
  Confirmed: 'live',
  Syncing: 'busy',
  'Needs attention': 'warn',
  'Custody only': 'custody',
  Cancelled: 'idle',
  Planned: 'idle',
  Idle: 'idle',
})

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

function CopyIcon({ copied }) {
  return copied ? (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <rect
        x="5"
        y="5"
        width="8"
        height="9"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  )
}

function ExplorerIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M6 3H3v10h10v-3M9 3h4v4M13 3L7.5 8.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  )
}

// Copy + explorer for one exact child address. The copy button says what it did by renaming
// itself ("Address copied") for a moment -- no toast, no extra live region on the page.
function AddressTools({ address }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef(null)
  useEffect(() => () => clearTimeout(timerRef.current), [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), COPIED_MS)
    } catch {
      setCopied(false)
    }
  }

  return (
    <span className="pc-crew-tools">
      <button
        type="button"
        className="pc-crew-tool"
        data-done={copied ? 'true' : undefined}
        aria-label={copied ? 'Address copied' : `Copy address ${address}`}
        onClick={copy}
      >
        <CopyIcon copied={copied} />
      </button>
      <a
        className="pc-crew-tool"
        href={`${STELLAR_CONTRACT_EXPLORER}${address}`}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${address} on Stellar Expert`}
      >
        <ExplorerIcon />
      </a>
    </span>
  )
}

function CrewChild({
  child,
  identityKey,
  onCancelAgent,
  onWithdrawAgent,
  actionPending,
  shareBp = null,
  personaName = '',
}) {
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
        <div className="pc-crew-child-id">
          <div className="pc-crew-child-line">
            <p className="pc-crew-child-address">
              {identityAvailable
                ? boundAccount
                  ? shortAddress(address)
                  : 'Planned'
                : 'Unavailable'}
            </p>
            {boundAccount && <AddressTools address={address} />}
          </div>
          <div className="pc-crew-child-line">
            {identityAvailable && (
              <p className="pc-crew-child-state" data-tone={STATUS_TONE[status] ?? 'idle'}>
                {status}
              </p>
            )}
            {boundAccount && <ChildNetworkBadges child={child} />}
          </div>
        </div>
        {boundAccount && (
          <div className="pc-crew-child-money">
            <CrewAmountList amounts={child.workingTotals} className="pc-crew-child-total" />
            {shareBp != null && (
              <span className="pc-crew-child-share">
                <span className="pc-crew-meter" aria-hidden="true">
                  <svg viewBox="0 0 100 4" preserveAspectRatio="none" focusable="false">
                    <rect className="pc-crew-meter-track" x="0" y="0" width="100" height="4" />
                    <rect
                      className="pc-crew-meter-fill"
                      x="0"
                      y="0"
                      width={shareBp / 100}
                      height="4"
                    />
                  </svg>
                </span>
                <span>
                  {formatShare(shareBp)} of {personaName}
                </span>
              </span>
            )}
          </div>
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
              className="pc-button pc-button--secondary pc-crew-cancel"
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

function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

// A child's share of its persona, shown only where it tells you something: two or more accounts
// under one persona, each holding one amount of the persona's single token.
function childShares(persona) {
  const whole = persona.totals?.length === 1 ? persona.totals[0] : null
  if (!whole || persona.children.length < 2) return persona.children.map(() => null)
  return persona.children.map((child) =>
    child.workingTotals?.length === 1 ? shareOf(child.workingTotals[0], whole) : null
  )
}

export function CrewLanes({
  personas = [],
  onCancelAgent,
  onWithdrawAgent,
  actionPending = false,
  focusId = null,
  spotlightId = null,
}) {
  const [collapsed, setCollapsed] = useState(() => new Set())

  // A persona pressed in the rail always opens, so the spotlight never lands on a closed bay.
  useEffect(() => {
    if (!focusId) return
    setCollapsed((current) => {
      if (!current.has(focusId)) return current
      const next = new Set(current)
      next.delete(focusId)
      return next
    })
  }, [focusId])

  function toggleBay(personaId) {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(personaId)) next.delete(personaId)
      else next.add(personaId)
      return next
    })
  }

  return (
    <section className="pc-crew-lanes-section" aria-labelledby="crew-lanes-heading">
      <h2 id="crew-lanes-heading" className="pc-crew-section-title">
        Your crew
      </h2>
      <ul className="pc-crew-personas" data-spotlight={spotlightId ? 'true' : undefined}>
        {personas.map((persona) => {
          const status = personaStatus(persona)
          const isCollapsed = collapsed.has(persona.id)
          const listId = `crew-bay-${persona.id}-accounts`
          const shares = childShares(persona)
          return (
            <li
              key={persona.id}
              id={`crew-bay-${persona.id}`}
              className="pc-crew-persona"
              data-persona-id={persona.id}
              data-tone={toneFor(persona)}
              data-lit={spotlightId === persona.id ? 'true' : undefined}
              data-pocket-enter
            >
              <header className="pc-crew-persona-head">
                <span className="pc-crew-persona-socket">
                  <img
                    className="pc-crew-persona-avatar"
                    src={persona.avatar}
                    alt={`${persona.name} crew persona`}
                    width="56"
                    height="56"
                  />
                </span>
                <div className="pc-crew-persona-who">
                  <h3>{persona.name}</h3>
                  <p>
                    {persona.children.length}{' '}
                    {persona.children.length === 1 ? 'account' : 'accounts'}
                  </p>
                </div>
                <div className="pc-crew-persona-summary">
                  <span className="pc-crew-persona-state" data-tone={STATUS_TONE[status] ?? 'idle'}>
                    {status}
                  </span>
                  <CrewAmountList
                    amounts={persona.totals}
                    empty="No working balance"
                    className="pc-crew-persona-total"
                  />
                  {persona.totalState === 'partial' && (
                    <span className="pc-crew-coverage">Partial coverage</span>
                  )}
                </div>
                {persona.children.length ? (
                  <button
                    type="button"
                    className="pc-crew-bay-toggle"
                    aria-expanded={!isCollapsed}
                    aria-controls={listId}
                    aria-label={`${isCollapsed ? 'Show' : 'Hide'} ${persona.name} accounts`}
                    onClick={() => toggleBay(persona.id)}
                  >
                    <ChevronIcon />
                  </button>
                ) : null}
              </header>

              {persona.children.length ? (
                <ul className="pc-crew-children" id={listId} hidden={isCollapsed}>
                  {persona.children.map((entry, index) => {
                    const identity = toAgentIdentityView(identityInputForChild(entry))
                    const baseKey = childKey(entry, identity)
                    const occurrence = persona.children
                      .slice(0, index)
                      .filter(
                        (previous) =>
                          childKey(
                            previous,
                            toAgentIdentityView(identityInputForChild(previous))
                          ) === baseKey
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
                        shareBp={shares[index]}
                        personaName={persona.name}
                      />
                    )
                  })}
                </ul>
              ) : (
                <p className="pc-crew-persona-empty">No productive accounts assigned yet.</p>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
