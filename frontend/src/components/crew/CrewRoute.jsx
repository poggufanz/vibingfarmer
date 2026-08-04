// frontend/src/components/crew/CrewRoute.jsx
// Task 9 (Pocket Crew design alignment). New user-facing surface: the crew, live -- one console
// showing every successfully working agent, the emergency guard, and the activity/decision feeds. Pure
// composition, no app state (Task 10 wires real `agents`/`model`/`keeper`/`keeperEvents`/
// `decisions` in from app.jsx); follows the `components/money/*` pattern (props in, data-*-driven
// styling) and does NOT import anything from `components/console/*` (retired, D-28.3).
//
// This is a ROUTE, so it owns the page's one <h1>; every titled child section below is its own
// <h2> sibling -- the same flat convention MyMoneyRoute.jsx already uses (each of MoneyHero/
// PositionList/AgentTeam/etc. owns one <h2>, none nested deeper).
import { useRef } from 'react'
import { CrewLanes } from './CrewLanes.jsx'
import { CrewGuard } from './CrewGuard.jsx'
import { CrewActivity } from './CrewActivity.jsx'
import { usePocketTransition } from '../../design/usePocketTransition.js'
import './crew.css'

// Same boundary math MoneyHero.jsx/PositionList.jsx/AgentTeam.jsx already declare locally for a
// canonical {token,units,decimals} amount -- division only, no multiply, so this never enters the
// BigInt(Math.round(x*N)) overflow zone that has white-screened this plan three times already.
function unitsToDisplay(units, decimals) {
  return Number(BigInt(units)) / 10 ** decimals
}

const PRODUCTIVE_CUSTODY_LOCATIONS = new Set(['stellar-vault', 'base-proxy'])

function productiveCustodyUnits(model) {
  if (!model?.custodyBreakdown || typeof model.custodyBreakdown !== 'object') return null

  let units = 0n
  try {
    for (const location of PRODUCTIVE_CUSTODY_LOCATIONS) {
      units += BigInt(model.custodyBreakdown[location] ?? 0)
    }
  } catch {
    return null
  }
  return units
}

// Mirrors AgentTeam.jsx's own `${value.toLocaleString()} USDC` string convention for a known
// amount. Prefer the owner-wide, de-duplicated custody breakdown so failed/stranded funds do not
// inflate "Total working"; a snapshot without that evidence fails closed.
function formatWorkingTotal(model) {
  const confirmedTotal = model?.confirmedTotal
  if (confirmedTotal?.state !== 'known' || !confirmedTotal.amount) return '—'

  const { decimals, token } = confirmedTotal.amount
  const units = productiveCustodyUnits(model)
  if (units == null) return '—'
  return `${unitsToDisplay(units, decimals).toLocaleString()} ${token}`
}

function liveApy(model) {
  const apy = model?.yield?.state === 'live' ? model.yield.apy : null
  return typeof apy === 'number' && Number.isFinite(apy) ? apy : null
}

// Deployment is not success: the grant creates every scoped account before any worker deposits.
// Crew membership therefore requires confirmed positive money at a productive destination.
// Failed/stranded rows stay in My Money's unfiltered owner read so recovery remains possible.
function hasPositiveAmount(amount) {
  try {
    return amount != null && BigInt(amount.units) > 0n
  } catch {
    return false
  }
}

export function selectSuccessfulCrewAgents(agents = []) {
  if (!Array.isArray(agents)) return []
  return agents.filter((agent) => {
    if (
      PRODUCTIVE_CUSTODY_LOCATIONS.has(agent?.custody?.location) &&
      hasPositiveAmount(agent?.amount)
    ) {
      return true
    }
    return (agent?.custodyBreakdown ?? []).some(
      (leg) => PRODUCTIVE_CUSTODY_LOCATIONS.has(leg?.location) && hasPositiveAmount(leg?.amount)
    )
  })
}

// Fix round 1, F4: `agents.length === 0` alone cannot tell "genuinely no crew" apart from "the
// read failed/never finished", and both produce the same empty array (readOwnerMoney.js falls
// back to `discovery?.agents ?? []`). `model.state === 'empty'` is buildMyMoneyModel's own
// authoritatively-empty verdict; a fresh `current` read with known-zero productive custody is also
// enough to prove that only failed/stranded money remains. Incomplete, stale, or malformed reads
// render an honestly uncertain line instead of manufacturing a confident claim.
function emptyStateCopy(model) {
  const freshCurrentReadProvesNoProductiveCustody =
    model?.state === 'current' &&
    model?.confirmedTotal?.state === 'known' &&
    productiveCustodyUnits(model) === 0n
  if (model?.state === 'empty' || freshCurrentReadProvesNoProductiveCustody) {
    return 'No successful crew members are working yet. Start a new plan to put one to work.'
  }
  return 'We could not confirm your crew on this read — this may not mean you have none. Try again shortly, or start a new one below.'
}

export function CrewRoute({
  agents = [],
  model,
  keeper,
  keeperEvents = [],
  decisions = [],
  onRenewMandate,
  onCancelAgent,
  onStartStrategy,
  actionPending = false,
}) {
  const crewAgents = selectSuccessfulCrewAgents(agents)
  const activeCount = crewAgents.filter(
    (a) => !a?.scope?.value?.revoked && !a?.problems?.length
  ).length
  const apy = liveApy(model)
  const running = keeper?.label === 'healthy'
  const totalText = formatWorkingTotal(model)

  // 2026-08-02 polish (motion pass): the same restrained entrance MyMoneyRoute/StartStage share,
  // keyed on the crew's real size -- it replays only when the crew genuinely gains or loses a
  // member (or first appears), never on a timer. Lanes opt in per-row in CrewLanes.jsx so they
  // arrive staggered.
  const rootRef = useRef(null)
  usePocketTransition(rootRef, crewAgents.length)

  if (!crewAgents.length) {
    return (
      <div className="pc-route pc-crew-route">
        <header className="pc-route-header">
          <div>
            <h1 className="pc-route-title">The crew, live.</h1>
            <p className="pc-route-sub">{emptyStateCopy(model)}</p>
          </div>
        </header>
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
            Everything below is read-only except two things: renewing the guard's permission, and
            cancelling a crew member.
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
          <p className="pc-crew-stat-label">Active permissions</p>
          <p className="pc-crew-stat-value">
            {activeCount} of {crewAgents.length}
          </p>
        </div>
        <div className="pc-crew-stat">
          <p className="pc-crew-stat-label">Total working</p>
          <p className="pc-crew-stat-value">{totalText}</p>
        </div>
        <div className="pc-crew-stat">
          <p className="pc-crew-stat-label">Rate</p>
          <p className="pc-crew-stat-value">{apy != null ? `${apy.toFixed(1)}%` : '—'}</p>
        </div>
      </div>

      <div className="pc-crew-console">
        <CrewLanes
          agents={crewAgents}
          onCancelAgent={onCancelAgent}
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
