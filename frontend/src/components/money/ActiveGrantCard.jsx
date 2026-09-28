// frontend/src/components/money/ActiveGrantCard.jsx
// P1 G5 (defi-gap-analysis §4.2/§5 item 4): the persistent "Active grant" card on the My Money
// route (/home). ProtectStage states the same facts once at REVIEW time ("They can spend at
// most X ... stops on DATE"); this card keeps answering them after the user leaves that flow:
// live remaining allowance, ledger countdown with an estimated date, and the one-signature
// Revoke kill switch (grant.js::revokeGrant, approve 0, direct submit).
//
// Pure component tree, same convention as MyMoneyRoute/AgentTeam/StopAccessDialog: no chain
// reads here — `grant` is money/activeGrant.js's view-model, loaded by the app controller.
// - `grant == null` or `{ state: 'none' }` → renders NOTHING (no active grant: confirmed zero
//   allowance or ledger-proven expiry — never a displayed zero).
// - `{ state: 'unavailable' }` → honest Unavailable rows, never a fake number, never a crash;
//   the Revoke button stays enabled (StopAccessDialog's own kill-switch precedent: an unread
//   balance is a warning, never a removed kill switch).
// - `{ state: 'known' }` → exact-BigInt remaining (money/assetUnits.js, never Number()) plus
//   the countdown. The wall-clock date is ALWAYS labeled "estimasi" (activeGrant.js documents
//   why it can never be precise); a grant with no receipt says Expires: Unavailable instead.
// Copy keeps the route's own vocabulary (AgentTeam's "Cap:"/"Expires:" rows) and never uses
// em/en dashes (coreRoutes.a11y.test.jsx bans them route-wide).
import { formatAssetUnits } from '../../money/assetUnits.js'
import { describeCountdown } from '../../money/activeGrant.js'
import { formatUtcMs } from './formatUtc.js'

// Exact-BigInt remaining, same no-grouping canonical form AgentTeam's own formatCap renders
// ("500 USDC", never locale-grouped). null when even the view's own fields are malformed —
// the row then says Unavailable rather than throwing.
function formatRemaining(view) {
  try {
    return `${formatAssetUnits(view.remainingUnits, view.decimals)} ${view.tokenSymbol}`
  } catch {
    return null
  }
}

function expiryLine(view) {
  if (view.expiryLedger == null || view.ledgersLeft == null) {
    return <p>Expires: Unavailable</p>
  }
  const countdown = describeCountdown(view.ledgersLeft)
  if (!countdown) return <p>Expires: Unavailable</p>
  const when = view.estimatedExpiryMs == null ? null : formatUtcMs(view.estimatedExpiryMs)
  return (
    <p>
      Expires in {countdown}
      {when === null || when === 'Unavailable' ? null : `, estimasi ${when}`}
    </p>
  )
}

export function ActiveGrantCard({ grant, onRevoke, revokePending = false, revokeError = null }) {
  if (grant == null || grant.state === 'none') return null

  return (
    <section className="pc-money-section" aria-labelledby="active-grant-heading" data-pocket-enter>
      <header>
        <h2 id="active-grant-heading">Active grant</h2>
      </header>
      <div>
        {grant.state === 'unavailable' ? (
          <>
            <p>Remaining: Unavailable</p>
            <p>Expires: Unavailable</p>
            <p role="status">The network did not answer. No number here is a balance.</p>
          </>
        ) : (
          <>
            <p>Remaining: {formatRemaining(grant) ?? 'Unavailable'}</p>
            {expiryLine(grant)}
          </>
        )}
        <button
          type="button"
          className="pc-button pc-button--danger"
          disabled={revokePending}
          aria-disabled={revokePending}
          onClick={() => onRevoke?.()}
        >
          {revokePending ? 'Revoking…' : 'Revoke grant'}
        </button>
        {revokeError ? <p role="alert">{revokeError}</p> : null}
      </div>
    </section>
  )
}
