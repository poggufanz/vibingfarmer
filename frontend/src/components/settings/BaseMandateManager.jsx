import { NETWORK_IDS } from '../../design/networks.js'
import { NetworkBadge } from '../pocket/NetworkIdentity.jsx'

const STATUS_LABELS = Object.freeze({
  disconnected: 'Disconnected',
  switched: 'Switched account',
  mismatched: 'Mismatched',
  'owner-mismatch': 'Mismatched',
  'kernel-mismatch': 'Mismatched',
  'relayer-mismatch': 'Mismatched',
  unavailable: 'Unavailable',
  missing: 'Missing',
  expired: 'Expired',
  revoked: 'Revoked',
  busy: 'Pending',
  ready: 'Ready',
  unknown: 'Unavailable',
  failed: 'Unavailable',
})

const FACT_STATUSES = new Set(['ready', 'expired', 'revoked'])
const REFRESH_STATUSES = new Set([
  'disconnected',
  'switched',
  'mismatched',
  'owner-mismatch',
  'kernel-mismatch',
  'relayer-mismatch',
  'unavailable',
])

const CANONICAL_CAP_UNITS = 10_000_000_000n
const CANONICAL_CAP_USDC = '10,000'
const CANONICAL_CAP_DECIMALS = 6
const CANONICAL_DURATION_DAYS = 7

function sourceStatus(mandateView) {
  const status = mandateView?.status
  return typeof status === 'string' && status.trim() ? status : 'unavailable'
}

function safeText(value) {
  return typeof value === 'string' && value.trim() ? value : null
}

function isCanonicalCap(cap) {
  return Boolean(
    cap &&
    cap.usdc === CANONICAL_CAP_USDC &&
    cap.units === CANONICAL_CAP_UNITS &&
    cap.decimals === CANONICAL_CAP_DECIMALS &&
    cap.cumulative === false &&
    cap.nonCumulative === true
  )
}

function isCanonicalExpiry(view) {
  return (
    view?.durationDays === CANONICAL_DURATION_DAYS &&
    Number.isSafeInteger(view?.validUntilSeconds) &&
    view.validUntilSeconds > 0
  )
}

function unavailableCopy(label) {
  return `${label} Unavailable — this view is read-only until an app-owned Base action is supplied.`
}

export default function BaseMandateManager({
  mandateView,
  connected,
  busy,
  error,
  onSetup,
  onRenew = null,
  onRevoke = null,
  onRefresh,
}) {
  const view = mandateView && typeof mandateView === 'object' ? mandateView : null
  const rawStatus = sourceStatus(view)
  const status = !connected ? 'disconnected' : busy ? 'busy' : rawStatus
  const actionStatus = status === 'busy' ? rawStatus : status
  const hasCurrentFacts = connected && FACT_STATUSES.has(rawStatus)
  const owner = safeText(view?.evidence?.stellarOwner)
  const kernel = safeText(view?.kernelAddress)
  const sessionKey = safeText(view?.sessionKeyAddress)
  const actions = Array.isArray(view?.allowedActions)
    ? view.allowedActions.filter((action) => typeof action === 'string' && action.trim())
    : []
  const policyAvailable =
    isCanonicalCap(view?.perCallCap) && view?.repeatedCalls === true && isCanonicalExpiry(view)
  const hasUnconfirmedResult =
    Boolean(error) ||
    view?.result === 'unknown' ||
    view?.result === 'failed' ||
    rawStatus === 'unknown' ||
    rawStatus === 'failed'
  const statusLabel = STATUS_LABELS[status] || 'Unavailable'

  return (
    <section
      id="base-mandate"
      className="pc-settings-manager"
      tabIndex={-1}
      aria-labelledby="base-mandate-heading"
      data-status={status}
    >
      <h2 id="base-mandate-heading" className="pc-settings-title">
        Base mandate
      </h2>
      <NetworkBadge networkId={NETWORK_IDS.BASE_SEPOLIA} />
      <div className="pc-settings-manager-status" role="status" aria-live="polite">
        Status: {statusLabel}
      </div>

      {hasCurrentFacts && (
        <div className="pc-settings-manager-facts">
          <p className="pc-settings-manager-copy">
            {policyAvailable &&
              (safeText(view?.primaryCopy) ||
                'Base mandate facts are available from the connected owner and source view.')}
            {!policyAvailable && 'Base mandate policy details are Unavailable.'}
          </p>

          <dl className="pc-settings-data-row">
            {owner && (
              <>
                <dt>Stellar owner</dt>
                <dd className="mono">{owner}</dd>
              </>
            )}
            {kernel && (
              <>
                <dt>Base kernel</dt>
                <dd className="mono">{kernel}</dd>
              </>
            )}
            {sessionKey && (
              <>
                <dt>Session-key custody</dt>
                <dd className="mono">{sessionKey}</dd>
              </>
            )}
          </dl>

          <p className="pc-settings-manager-disclosure">
            Custody: the relayer holds the session key. It can act only within the source-provided
            scope.
          </p>
          <p className="pc-settings-manager-disclosure">Allowed calls:</p>
          {actions.length ? (
            <ul className="pc-settings-manager-actions-list">
              {actions.map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ul>
          ) : (
            <p className="pc-settings-manager-disclosure">Unavailable.</p>
          )}
          <p className="pc-settings-manager-disclosure">
            Destination: {safeText(view?.destination) || 'Unavailable'}.
            <br />
            Base Sepolia proxy. Custody only. No protocol yield.
          </p>
          <p className="pc-settings-manager-disclosure">
            {policyAvailable
              ? `Cap: ${view.perCallCap.usdc} USDC per call, non-cumulative; repeated calls: allowed.`
              : 'Cap: Unavailable.'}
          </p>
          <p className="pc-settings-manager-disclosure">
            {policyAvailable
              ? `Expiry: ${view.durationDays} days; valid until ${view.validUntilSeconds}.`
              : 'Expiry: Unavailable.'}
          </p>
          <p className="pc-settings-manager-disclosure">
            {policyAvailable
              ? 'Balance bound: this scope is limited by funds in the smart account. It cannot withdraw.'
              : 'Balance bound: Unavailable.'}
          </p>
        </div>
      )}

      {view?.renewalCopy &&
        (hasCurrentFacts || rawStatus === 'missing' || rawStatus === 'unknown') && (
          <p className="pc-settings-manager-disclosure">{view.renewalCopy}</p>
        )}
      {view?.revokeCopy && (hasCurrentFacts || rawStatus === 'revoked') && (
        <p className="pc-settings-manager-disclosure">
          {view.revokeCopy} This affects only the relayer-held copy; it does not withdraw Base
          positions or revoke Stellar agents.
        </p>
      )}
      {view?.outageCopy && <p className="pc-settings-manager-disclosure">{view.outageCopy}</p>}

      {hasUnconfirmedResult && (
        <p className="pc-settings-manager-error" role="alert">
          <strong>Not confirmed</strong>
          {error ? `: ${error}` : ''}
        </p>
      )}
      {view?.confirmationCopy && (
        <p className="pc-settings-manager-disclosure">{view.confirmationCopy}</p>
      )}

      <div className="pc-settings-manager-actions">
        {REFRESH_STATUSES.has(status) && typeof onRefresh === 'function' && (
          <button type="button" className="pc-settings-button" onClick={onRefresh} disabled={busy}>
            Refresh Base mandate
          </button>
        )}

        {actionStatus === 'missing' &&
          (typeof onSetup === 'function' ? (
            <button type="button" className="pc-settings-button" onClick={onSetup} disabled={busy}>
              Set up Base mandate
            </button>
          ) : (
            <span className="pc-settings-manager-unavailable">{unavailableCopy('Setup')}</span>
          ))}

        {(actionStatus === 'expired' || actionStatus === 'revoked' || actionStatus === 'ready') && (
          <>
            {typeof onRenew === 'function' ? (
              <button
                type="button"
                className="pc-settings-button"
                onClick={onRenew}
                disabled={busy}
              >
                Renew Base mandate
              </button>
            ) : (
              <span className="pc-settings-manager-unavailable">{unavailableCopy('Renewal')}</span>
            )}
            {actionStatus === 'ready' &&
              (typeof onRevoke === 'function' ? (
                <button
                  type="button"
                  className="pc-settings-button pc-settings-button--danger"
                  onClick={onRevoke}
                  disabled={busy}
                >
                  Revoke Base mandate copy
                </button>
              ) : (
                <span className="pc-settings-manager-unavailable">{unavailableCopy('Revoke')}</span>
              ))}
          </>
        )}
      </div>
    </section>
  )
}
