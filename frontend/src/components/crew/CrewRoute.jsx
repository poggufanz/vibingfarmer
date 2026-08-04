import { useRef } from 'react'
import { CrewAmountList, CrewLanes, formatCrewAmount } from './CrewLanes.jsx'
import { CrewGuard } from './CrewGuard.jsx'
import { CrewActivity } from './CrewActivity.jsx'
import { usePocketTransition } from '../../design/usePocketTransition.js'
import './crew.css'

const EMPTY_CREW = Object.freeze({
  status: 'unavailable',
  personas: [],
  pendingAssignments: [],
  productiveAgentCount: 0,
  activeCount: 0,
  totals: [],
})

function liveApy(model) {
  const apy = model?.yield?.state === 'live' ? model.yield.apy : null
  return typeof apy === 'number' && Number.isFinite(apy) ? apy : null
}

function assignedCount(crew) {
  return crew.personas.reduce((sum, persona) => sum + persona.children.length, 0)
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
  if (child.workingTotals.length) {
    return child.workingTotals.map(formatCrewAmount).join(' · ')
  }

  const sharedLegs = child.workingLegs.filter(
    (leg) => leg.shared && !leg.counted && leg.amount != null
  )
  if (!sharedLegs.length) return 'Amount unavailable'

  return (
    <span className="pc-crew-pending-amounts">
      {sharedLegs.map((leg) => (
        <span className="pc-crew-pending-amount" key={leg.key}>
          <span>{formatCrewAmount(leg.amount)}</span>
          <span>shared, counted under another account</span>
        </span>
      ))}
    </span>
  )
}

function PendingAssignments({ pendingAssignments }) {
  if (!pendingAssignments.length) return null
  return (
    <section className="pc-crew-pending" aria-labelledby="crew-pending-heading" role="status">
      <div>
        <h2 id="crew-pending-heading">Crew assignment syncing</h2>
        <p>
          Productive custody is known, but indexed assignment evidence is still incomplete. These
          accounts are not assigned to a persona yet.
        </p>
      </div>
      <ul>
        {pendingAssignments.map((child) => (
          <li key={child.agent.address}>
            <span>{shortAddress(child.agent.address)}</span>
            <span>
              <PendingAmountEvidence child={child} />
            </span>
          </li>
        ))}
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
}) {
  const childCount = assignedCount(crew)
  const pendingAssignments = crew.pendingAssignments ?? []
  const apy = liveApy(model)
  const running = keeper?.label === 'healthy'
  const rootRef = useRef(null)
  usePocketTransition(rootRef, childCount)

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
        <button type="button" className="pc-button pc-button--primary" onClick={onStartStrategy}>
          Put it to work
        </button>
      </div>
    )
  }

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
      </header>

      <div className="pc-crew-stats" role="group" aria-label="Crew status" data-pocket-enter>
        <div className="pc-crew-stat">
          <p className="pc-crew-stat-label">Status</p>
          <p className="pc-crew-stat-value" data-tone={running ? 'good' : 'warn'}>
            {running ? 'Running' : keeper?.label === 'stale' ? 'Quiet' : 'Unavailable'}
          </p>
        </div>
        <div className="pc-crew-stat">
          <p className="pc-crew-stat-label">Active accounts</p>
          <p className="pc-crew-stat-value">
            {crew.activeCount} of {crew.productiveAgentCount}
          </p>
        </div>
        <div className="pc-crew-stat">
          <p className="pc-crew-stat-label">Total working</p>
          <div className="pc-crew-stat-value">
            <CrewAmountList amounts={crew.totals} />
            {crew.status !== 'complete' && (
              <span className="pc-crew-coverage">Partial coverage</span>
            )}
          </div>
        </div>
        <div className="pc-crew-stat">
          <p className="pc-crew-stat-label">Rate</p>
          <p className="pc-crew-stat-value">{apy != null ? `${apy.toFixed(1)}%` : '—'}</p>
        </div>
      </div>

      <PendingAssignments pendingAssignments={pendingAssignments} />

      <div className="pc-crew-console">
        <CrewLanes
          personas={crew.personas}
          onCancelAgent={onCancelAgent}
          onWithdrawAgent={onWithdrawAgent}
          actionPending={actionPending}
        />
        <div className="pc-crew-side" data-pocket-enter>
          <CrewGuard
            protection={model?.protection}
            onRenew={onRenewMandate}
            pending={actionPending}
          />
          <CrewActivity keeperEvents={keeperEvents} decisions={decisions} />
        </div>
      </div>
    </div>
  )
}
