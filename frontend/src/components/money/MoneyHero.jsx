// frontend/src/components/money/MoneyHero.jsx
// My Money Task 11 (Pocket Crew redesign, Wave 5). "Your money": the ONE Rice (confirmed-money)
// dominant surface on the /agent route -- the honest total, a state-aware primary action, and
// (only when the model says so) a "Partial discovery" notice sitting right next to the total it
// qualifies, never buried in a disclosure (brief Step 1: "adjacent to totals/actions").
//
// Consumes ONLY buildMyMoneyModel's output (MyMoneyModelV1, money/myMoneyModel.js:181-318) -- this
// component never reads discovery/money/protection sources directly and never re-derives the
// state machine or the primary-action precedence; choosePrimaryMoneyAction (same module,
// myMoneyModel.js:332-347) is called here unchanged, the same way PlanStage/StartStage consume an
// upstream view-model without re-deriving it.
//
// The hero's own rule (brief): render the known confirmed total, or the literal word
// "Unavailable" -- NEVER a coerced zero. Foundation's MoneyFigure (Primitives.jsx:20-46) already
// refuses to coerce a missing value to 0 for the numeric path, but its own placeholder vocabulary
// is 'Loading'/'No balance yet'/'Could not load'/'Unknown' -- none of which is the literal
// "Unavailable" this task's brief binds verbatim. Rather than stretch MoneyFigure's meaning (or
// edit it -- it is a Foundation primitive, off-limits here), this file renders that literal text
// itself, reusing MoneyFigure's own `.pc-money`/`.pc-money--unknown` classes (and this route's own
// Rice-contrast override in my-money.css) for the identical honest-placeholder look.
import { useMemo } from 'react'
import { MoneyFigure, StatusNotice } from '../pocket/Primitives.jsx'
import { choosePrimaryMoneyAction } from '../../money/myMoneyModel.js'

// Same boundary math PlanStage.jsx/StrategyReceipt.jsx already use for a canonical
// {token,units,decimals} amount -- display-only, never touches the underlying bigint.
function unitsToDisplay(units, decimals) {
  return Number(BigInt(units)) / 10 ** decimals
}

// Same ISO-string convention PlanStage.jsx's formatExpiry/StartStage.jsx already use for a real
// epoch -- deterministic and locale-independent (a `toLocaleString()` render would vary by CI/dev
// machine timezone and make this component's own tests flaky).
function formatCheckedAt(checkedAtMs) {
  return Number.isFinite(checkedAtMs) ? new Date(checkedAtMs).toISOString() : 'Unavailable'
}

// Maps the model's own state machine (myMoneyModel.js's documented state list) onto exactly what
// the hero figure may honestly show. Never invents a number: 'known' only when confirmedTotal
// itself says 'known' AND carries a real amount -- every other case is 'loading' (MoneyFigure's
// own honest in-flight placeholder) or 'unavailable' (this file's own literal text, see header).
function heroFigureState(model) {
  if (model.state === 'loading') return { kind: 'loading' }
  if (
    model.confirmedTotal?.state === 'known' &&
    model.confirmedTotal.amount != null &&
    (model.state === 'current' || model.state === 'stale' || model.state === 'problem' || model.state === 'partial-discovery')
  ) {
    return {
      kind: 'known',
      // MoneyFigure's own 'stale' state renders the real number PLUS its built-in "(stale)" flag
      // (Primitives.jsx:42) -- reused as-is rather than re-implemented here.
      figureState: model.state === 'stale' ? 'stale' : 'current',
      value: unitsToDisplay(model.confirmedTotal.amount.units, model.confirmedTotal.amount.decimals),
      currency: model.confirmedTotal.amount.token,
    }
  }
  if (model.state === 'empty') return { kind: 'empty' }
  return { kind: 'unavailable' }
}

// Earned/APY may only ever be shown with valid, positive evidence (brief: "earned/APY appears
// only with valid evidence") -- aggregateOwnerPositions (readOwnerMoney.js:519-525) hardcodes
// `earned: { state: 'unavailable', amount: null }` today (no principal/share-price history is
// tracked yet), so this branch is dead in production until that changes; it is still implemented
// faithfully against the documented MoneySnapshot shape (myMoneyModel.js:14-39) rather than
// dropped, and is exercised here via injected model fixtures.
function hasValidEarned(model) {
  return model.earned?.state === 'known' && model.earned.amount != null
}

function hasLiveYield(model) {
  return model.yield?.state === 'live' && typeof model.yield.apy === 'number' && Number.isFinite(model.yield.apy)
}

// "Unknown must never render as absent" (brief) applies beyond the formal 'partial-discovery'
// state too: a fully-attributed confirmedTotal of exactly zero can coexist with real doubt sitting
// in the unattributed (shared Base kernel) bucket -- see myMoneyModel.js:279-299's own
// authoritativelyEmpty gate, which requires NO unattributed doubt before ever calling a zero
// total "empty". This surfaces that doubt next to the total regardless of which top-level state
// produced it.
function unattributedUnknownCount(model) {
  return Object.values(model.unattributed ?? {}).filter((u) => u.state === 'unavailable').length
}

const PRIMARY_ACTION_PENDING_LABEL = Object.freeze({
  'review-problem': 'Reviewing…',
  'connect-wallet': 'Connecting…',
  deposit: 'Working…',
  'renew-protection': 'Renewing…',
  'add-money': 'Working…',
})

export function MoneyHero({ model, onAction, actionPending = false }) {
  const primary = useMemo(() => choosePrimaryMoneyAction(model), [model])
  const figure = heroFigureState(model)
  const unknownCount = unattributedUnknownCount(model)

  return (
    <section className="pc-dominant pc-dominant--owned" aria-labelledby="my-money-hero-heading">
      <h2 id="my-money-hero-heading">Your money</h2>

      <div className="pc-money-hero">
        <div>
          {figure.kind === 'loading' && <MoneyFigure state="loading" />}
          {figure.kind === 'empty' && <MoneyFigure state="empty" />}
          {figure.kind === 'known' && (
            <MoneyFigure state={figure.figureState} value={figure.value} currency={figure.currency} />
          )}
          {figure.kind === 'unavailable' && (
            <p className="pc-money pc-money--unknown" role="status">
              Unavailable
            </p>
          )}

          {hasLiveYield(model) && <p>Earning {model.yield.apy}% APY</p>}
          {hasValidEarned(model) && (
            <p>
              Earned {unitsToDisplay(model.earned.amount.units, model.earned.amount.decimals)}{' '}
              {model.earned.amount.token}
            </p>
          )}

          {model.state === 'problem' && (
            <StatusNotice state="danger" title="Action needed">
              <p>
                {model.problemAgents.length} agent{model.problemAgents.length === 1 ? '' : 's'} still hold
                money under a revoked or expired grant. Owner withdrawal is always allowed regardless of
                scope state.
              </p>
            </StatusNotice>
          )}

          {model.state === 'partial-discovery' && (
            <StatusNotice state="warning" title="Partial discovery">
              <p>
                We have not finished confirming every agent yet.{' '}
                {model.agentCount != null ? `${model.agentCount} agent(s) confirmed so far.` : ''}
                {model.problemAgentCount ? ` ${model.problemAgentCount} flagged for review.` : ''}
              </p>
            </StatusNotice>
          )}

          {model.state !== 'partial-discovery' && unknownCount > 0 && (
            <StatusNotice state="info" title="Some balances are still unconfirmed">
              <p>
                {unknownCount} Base balance{unknownCount === 1 ? '' : 's'} could not be confirmed this
                round -- not zero, just not yet known.
              </p>
            </StatusNotice>
          )}
        </div>

        <div className="pc-money-hero-meta">
          <p>Last checked: {formatCheckedAt(model.checkedAt)}</p>
          <p>
            {model.agentCount != null ? model.agentCount : 'Unavailable'} agent
            {model.agentCount === 1 ? '' : 's'} confirmed
          </p>
        </div>
      </div>

      {primary && (
        <div className="pc-money-actions">
          <button
            type="button"
            className="pc-button pc-button--primary"
            disabled={actionPending}
            aria-disabled={actionPending}
            onClick={() => onAction?.(primary.action)}
          >
            {actionPending ? PRIMARY_ACTION_PENDING_LABEL[primary.action] || 'Working…' : primary.label}
          </button>
        </div>
      )}
    </section>
  )
}
