import { useRef, useState } from 'react'
import { CrewAmountList, CrewLanes, formatCrewAmount } from './CrewLanes.jsx'
import { CrewGuard } from './CrewGuard.jsx'
import { CrewActivity } from './CrewActivity.jsx'
import { CrewShareRail } from './CrewShareRail.jsx'
import { toneFor } from '../strategy/CrewSplit.jsx'
import { usePocketTransition } from '../../design/usePocketTransition.js'
import { toAgentIdentityView, toFactView, toLiveVenueView } from '../../core/coreRouteAdapters.js'
import './crew.css'

const EMPTY_CREW = Object.freeze({
  status: 'unavailable',
  personas: [],
  pendingAssignments: [],
  productiveAgentCount: 0,
  activeCount: 0,
  totals: [],
})

function liveYield(model) {
  const input = model?.yield
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !['stellar-live', 'base-custody-proxy'].includes(input.venueKind) ||
    !Object.prototype.hasOwnProperty.call(input, 'yield')
  ) {
    return null
  }
  const view = toLiveVenueView(input)
  return view.state === 'live' ? view : null
}

function keeperStatusLabel(keeper) {
  if (keeper?.label === 'healthy' || keeper?.label === 'running') return 'Running'
  if (keeper?.label === 'stale') return 'Stale'
  if (keeper?.label === 'configured') return 'Configured'
  return 'Unavailable'
}

function earnedFact(model) {
  const earned = model?.earned
  if (!earned || !['current', 'confirmed'].includes(earned.state) || !earned.amount) {
    return null
  }
  const fact = toFactView({
    state: earned.state,
    value: earned.amount,
    source: earned.source,
    checkedAt: earned.checkedAt,
    confirmedLedger: earned.confirmedLedger,
    confirmedBlock: earned.confirmedBlock,
  })
  const anchor = fact.confirmedLedger ?? fact.confirmedBlock
  return ['current', 'confirmed'].includes(fact.state) && fact.value != null && anchor ? fact : null
}

function earnedStateCopy(model) {
  const state = model?.earned?.state
  if (state === 'partial') return 'Partial'
  if (state === 'stale') return 'Stale'
  return 'Unavailable'
}

function assignedCount(crew) {
  return crew.personas.reduce((sum, persona) => sum + persona.children.length, 0)
}

// Accounts whose money sits in the guarded Stellar vault -- the ones the emergency guard covers.
function vaultAccountCount(crew) {
  return crew.personas
    .flatMap((persona) => persona.children)
    .filter((child) => child.workingLegs?.some((leg) => leg.location === 'stellar-vault')).length
}

const KEEPER_TONE = Object.freeze({
  Running: 'live',
  Stale: 'warn',
  Configured: 'idle',
  Unavailable: 'warn',
})

// Capped so a very large crew still reads as a strip of pips, not a wall of them.
const MAX_PIPS = 12

function WorkingPips({ active, total }) {
  if (!Number.isSafeInteger(total) || total <= 0 || total > MAX_PIPS) return null
  return (
    <span className="pc-crew-pips" aria-hidden="true">
      {Array.from({ length: total }, (_, index) => (
        <span key={index} data-lit={index < active ? 'true' : undefined} />
      ))}
    </span>
  )
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

function emptyStateCopy(crew) {
  if (crew.status === 'complete' && crew.productiveAgentCount === 0) {
    return 'No confirmed productive crew accounts are working yet. Start a new plan to put one to work.'
  }
  return 'We could not confirm your crew on this read — this may not mean you have none. Try again shortly, or start a new one below.'
}

function shortAddress(address) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`
}

function PendingAmountEvidence({ child }) {
  const identity = toAgentIdentityView(child?.identity ?? {})
  if (!identity.identityAvailable) return 'Amount unavailable'
  const countedLegs = child.workingLegs.filter((leg) => leg.counted && leg.amount != null)
  const sharedLegs = child.workingLegs.filter(
    (leg) => leg.shared && !leg.counted && leg.amount != null
  )
  if (!child.workingTotals.length && !sharedLegs.length) return 'Amount unavailable'

  return (
    <span className="pc-crew-pending-amounts">
      {child.workingTotals.map((amount) => (
        <span className="pc-crew-pending-amount" key={`counted:${amount.token}:${amount.decimals}`}>
          <span>{formatCrewAmount(amount)}</span>
          {countedLegs.some((leg) => leg.location === 'base-proxy') ? (
            <span>Base Sepolia proxy. Custody only. No protocol yield.</span>
          ) : null}
        </span>
      ))}
      {sharedLegs.map((leg, index) => (
        <span className="pc-crew-pending-amount" key={`shared:${leg.key ?? 'unknown'}:${index}`}>
          <span>{formatCrewAmount(leg.amount)}</span>
          {leg.location === 'base-proxy' ? (
            <span>Base Sepolia proxy. Custody only. No protocol yield.</span>
          ) : null}
          <span>shared, counted under another account</span>
        </span>
      ))}
    </span>
  )
}

function PendingAssignments({ pendingAssignments }) {
  if (!pendingAssignments.length) return null
  const hasUnavailableIdentity = pendingAssignments.some(
    (child) => !toAgentIdentityView(child?.identity ?? {}).identityAvailable
  )
  return (
    <section className="pc-crew-pending" aria-labelledby="crew-pending-heading" role="status">
      <div>
        <h2 id="crew-pending-heading">Crew assignment syncing</h2>
        <p>
          {hasUnavailableIdentity
            ? 'Some assignment evidence is waiting for identity confirmation. These rows remain visible until that evidence catches up.'
            : 'Productive custody is known, but indexed assignment evidence is still incomplete. These accounts are not assigned to a persona yet.'}
        </p>
      </div>
      <ul>
        {pendingAssignments.map((child, index) => {
          const identityView = toAgentIdentityView(child?.identity ?? {})
          const identity = identityView.identityAvailable ? identityView : null
          const label = identity?.address
            ? shortAddress(identity.address)
            : 'Agent identity unavailable'
          return (
            <li
              key={`${identityView.key ?? identityView.allocationId ?? identityView.runId ?? 'unavailable'}:${index}`}
            >
              <span>{label}</span>
              <span>
                <PendingAmountEvidence child={child} />
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function CrewRoute({
  crew = EMPTY_CREW,
  model,
  keeper,
  keeperEvents = [],
  decisions = [],
  onRenewMandate,
  onCancelAgent,
  onWithdrawAgent,
  onStartStrategy,
  actionPending = false,
  nowMs,
}) {
  const childCount = assignedCount(crew)
  const pendingAssignments = crew.pendingAssignments ?? []
  const yieldView = liveYield(model)
  const keeperLabel = keeperStatusLabel(keeper)
  const earned = earnedFact(model)
  const rootRef = useRef(null)
  const [focusId, setFocusId] = useState(null)
  const [previewId, setPreviewId] = useState(null)
  usePocketTransition(rootRef, childCount)

  // Pressing a persona in the rail spotlights its bay and brings it into view; pressing it again
  // clears the spotlight. Hover only previews -- it never scrolls.
  function toggleFocus(personaId) {
    const next = focusId === personaId ? null : personaId
    setFocusId(next)
    if (!next) return
    rootRef.current
      ?.querySelector(`[data-persona-id="${next}"]`)
      ?.scrollIntoView?.({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }

  if (childCount === 0) {
    return (
      <div className="pc-route pc-crew-route" ref={rootRef}>
        <header className="pc-route-header">
          <div>
            <h1 className="pc-route-title">The crew, live.</h1>
            <p className="pc-route-sub">
              {pendingAssignments.length
                ? 'Productive accounts are visible while their persistent Crew assignment catches up.'
                : emptyStateCopy(crew)}
            </p>
          </div>
        </header>
        <PendingAssignments pendingAssignments={pendingAssignments} />
        <section className="pc-crew-bench" aria-label="Your crew is off duty">
          {crew.personas.length ? (
            <ul className="pc-crew-bench-roster" aria-hidden="true">
              {crew.personas.map((persona) => (
                <li key={persona.id} data-tone={toneFor(persona)}>
                  <img src={persona.avatar} alt="" width="64" height="64" />
                  <span>{persona.name}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="pc-crew-bench-copy">
            Sprout, Clover and Mochi wait here until a plan hires them. One signature starts all of
            them.
          </p>
          <button type="button" className="pc-button pc-button--primary" onClick={onStartStrategy}>
            Put it to work
          </button>
        </section>
      </div>
    )
  }

  const spotlightId = previewId ?? focusId
  const keeperTone = KEEPER_TONE[keeperLabel] ?? 'warn'
  const earnedTone = earned ? 'live' : 'idle'

  return (
    <div className="pc-route pc-crew-route" ref={rootRef}>
      <header className="pc-route-header" data-pocket-enter>
        <div>
          <h1 className="pc-route-title">The crew, live.</h1>
          <p className="pc-route-sub">
            Each persona keeps the real child accounts working beneath it. Renewing the guard and
            account actions stay attached to each exact child address.
          </p>
        </div>
        {typeof onStartStrategy === 'function' ? (
          <button
            type="button"
            className="pc-button pc-button--secondary pc-crew-new-plan"
            onClick={onStartStrategy}
          >
            Start a new plan
          </button>
        ) : null}
      </header>

      <section className="pc-crew-deck" aria-labelledby="crew-balance-heading" data-pocket-enter>
        <div className="pc-crew-balance">
          <h2 id="crew-balance-heading" className="pc-crew-balance-label">
            Working balance
          </h2>
          <CrewAmountList
            amounts={crew.totals}
            empty="Unavailable"
            className="pc-crew-balance-value"
          />
          <CrewShareRail
            personas={crew.personas}
            focusId={focusId}
            spotlightId={spotlightId}
            onFocus={toggleFocus}
            onPreview={setPreviewId}
          />
        </div>

        <div className="pc-crew-stats" role="group" aria-label="Crew status">
          <div className="pc-crew-stat" data-tone={keeperTone}>
            <p className="pc-crew-stat-label">Status</p>
            <p
              className="pc-crew-stat-value"
              data-tone={keeperLabel === 'Running' ? 'good' : 'warn'}
            >
              {keeperLabel}
            </p>
          </div>
          <div className="pc-crew-stat" data-tone={crew.activeCount > 0 ? 'live' : 'idle'}>
            <p className="pc-crew-stat-label">Working for you</p>
            <p className="pc-crew-stat-value">
              {crew.activeCount} of {crew.productiveAgentCount}
            </p>
            <WorkingPips active={crew.activeCount} total={crew.productiveAgentCount} />
            {crew.status !== 'complete' && (
              <span className="pc-crew-coverage">Partial coverage</span>
            )}
          </div>
          <div className="pc-crew-stat" data-tone={earnedTone}>
            <p className="pc-crew-stat-label">Earned this run</p>
            <div className="pc-crew-stat-value">
              <CrewAmountList
                amounts={earned ? [earned.value] : []}
                empty={earnedStateCopy(model)}
              />
            </div>
          </div>
          <div className="pc-crew-stat" data-tone={yieldView ? 'live' : 'idle'}>
            <p className="pc-crew-stat-label">Blended rate</p>
            <p className="pc-crew-stat-value">
              {yieldView ? `${yieldView.apy.toFixed(1)}%` : 'Unavailable'}
            </p>
            {yieldView ? (
              <span className="pc-crew-rate-evidence">
                <span>Source: {yieldView.source}</span>
                <span>As of: {String(yieldView.asOf)}</span>
                <span>Checked: {String(yieldView.checkedAt)}</span>
              </span>
            ) : null}
          </div>
        </div>
      </section>

      <PendingAssignments pendingAssignments={pendingAssignments} />

      <div className="pc-crew-console">
        <CrewLanes
          personas={crew.personas}
          onCancelAgent={onCancelAgent}
          onWithdrawAgent={onWithdrawAgent}
          actionPending={actionPending}
          focusId={focusId}
          spotlightId={spotlightId}
        />
        <div className="pc-crew-side" data-pocket-enter>
          <CrewGuard
            protection={model?.protection}
            onRenew={onRenewMandate}
            pending={actionPending}
            nowMs={nowMs}
            vaultAccounts={vaultAccountCount(crew)}
          />
          <CrewActivity keeperEvents={keeperEvents} decisions={decisions} nowMs={nowMs} />
        </div>
      </div>
    </div>
  )
}
