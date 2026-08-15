// frontend/src/components/money/StopAccessDialog.jsx
// My Money Task 12 (Pocket Crew redesign, Wave 5). "Stop access" (revoke) -- a kill switch, never a
// refund. Built on Foundation's Dialog (Primitives.jsx) and Task 9's PURE planRevoke
// (money/ownerActions.js). Pure component tree: no chain calls here -- the caller (Task 13) wires
// onConfirmRevoke to stellar/revoke.js's revokeAgentOnChain and onGoToWithdraw to open
// WithdrawDialog for this same agent.
//
// Three ownerActions.js outcomes this dialog must never blur together:
//   1. `reason: 'funded'`      -- known money still sits here. Revoke is BLOCKED by the plan
//                                 itself (owner_withdraw has no scope gate, so withdrawing first is
//                                 always the honest next step) -- this dialog offers ONLY "Go to
//                                 Withdraw", never a revoke button that would silently fail.
//   2. `warning` set           -- funding status could not be confirmed either way. The kill switch
//                                 is NEVER removed for this (brief: "preserves the kill switch") --
//                                 the revoke button stays enabled, with an honest warning alongside.
//   3. `baseStopAccess`        -- a Base bridge agent/kernel association exists. The relayer's
//                                 mandate-revoke route does not exist yet (planRevoke's own
//                                 comment), so this is scoped Stellar-only: an informational notice,
//                                 never a Base-labelled button with nothing behind it.
import { Dialog, StatusNotice } from '../pocket/Primitives.jsx'
import { planRevoke } from '../../money/ownerActions.js'

function shortAddr(address) {
  return typeof address === 'string' && address.length > 12
    ? `${address.slice(0, 4)}…${address.slice(-4)}`
    : (address ?? 'Unavailable')
}

function safeMoneyCopy(value) {
  return typeof value === 'string' ? value.replace(/\s*(?:--|—|–)\s*/g, '. ') : value
}

export function StopAccessDialog({
  open,
  onClose,
  agent,
  shareRead,
  idleBalanceRead,
  account,
  pending = false,
  onConfirmRevoke,
  onGoToWithdraw,
}) {
  const plan = agent ? planRevoke({ agent, shareRead, idleBalanceRead, account }) : null

  const closeIfSafe = () => {
    if (!pending) onClose?.()
  }

  const funded = plan?.ok === false && plan.reason === 'funded'

  return (
    <Dialog
      // See WithdrawDialog.jsx / my-money.css: the money dialog scope travels on this class
      // because app.jsx mounts this dialog beside <MyMoneyRoute>, not inside it.
      className="pc-money-dialog"
      open={open}
      title="Stop access for this agent"
      description="This stops the agent from acting in the future. It never returns money that is already in the vault or agent."
      onClose={closeIfSafe}
      actions={
        <>
          <button
            type="button"
            className="pc-button pc-button--secondary"
            onClick={closeIfSafe}
            disabled={pending}
          >
            Cancel
          </button>
          {funded && typeof onGoToWithdraw === 'function' && (
            <button
              type="button"
              className="pc-button pc-button--primary"
              disabled={pending}
              onClick={() => onGoToWithdraw?.(agent?.address)}
            >
              Go to Withdraw
            </button>
          )}
          {plan?.ok && typeof onConfirmRevoke === 'function' && (
            <button
              type="button"
              className="pc-button pc-button--danger"
              disabled={pending}
              onClick={() => onConfirmRevoke?.(plan)}
            >
              {pending ? 'Stopping…' : 'Stop access'}
            </button>
          )}
        </>
      }
    >
      <p>
        Stops future access for this agent. It does not move, return, or touch any money already
        there. Withdrawal is a separate action.
      </p>

      {!agent && <p>Agent details are unavailable.</p>}

      {funded && (
        <StatusNotice state="warning" title="This agent still holds money">
          <p>{safeMoneyCopy(plan.message)}</p>
        </StatusNotice>
      )}

      {plan?.ok && plan.warning && (
        <StatusNotice state="warning" title={safeMoneyCopy(plan.warning)}>
          <p>
            The kill switch still works. Stopping access does not require knowing the balance first.
          </p>
        </StatusNotice>
      )}

      {plan?.baseStopAccess && plan.baseStopAccess.available === false && (
        <StatusNotice state="info" title="Base access can't be stopped from here yet">
          <p>
            This only stops the Stellar side of {shortAddr(agent?.address)}. Stopping the Base
            bridge mandate needs a relayer route that does not exist yet. There is no working "stop
            Base access" button to offer until it does.
          </p>
        </StatusNotice>
      )}
    </Dialog>
  )
}
