// Allowance consequence dialog. This is presentation only: the caller owns the signer, relay,
// transaction, and result state machine. A recognized verdict is the exact `{ allow, reasons }`
// shape; all other values fail closed to an unavailable, disabled approval action.
import { formatTokenUnits } from '../../design/pocket-crew-foundation.js'

function isRecognizedVerdict(verdict) {
  return (
    verdict !== null &&
    typeof verdict === 'object' &&
    typeof verdict.allow === 'boolean' &&
    Array.isArray(verdict.reasons)
  )
}

function formatSharesOut(sharesOut) {
  if (
    sharesOut === null ||
    typeof sharesOut !== 'object' ||
    typeof sharesOut.token !== 'string' ||
    typeof sharesOut.units !== 'string' ||
    !/^[0-9]+$/.test(sharesOut.units) ||
    !Number.isInteger(sharesOut.decimals) ||
    sharesOut.decimals < 0
  ) {
    return null
  }

  try {
    return `${formatTokenUnits(sharesOut.units, sharesOut.decimals)} ${sharesOut.token}`
  } catch {
    return null
  }
}

export function ApproveOverlay({ verdict, simulate, onApprove, onReject }) {
  const recognized = isRecognizedVerdict(verdict)
  const eligible = recognized && verdict.allow
  const sharesOut = recognized ? formatSharesOut(simulate?.sharesOut) : null
  const reasons = recognized ? verdict.reasons.filter((reason) => typeof reason === 'string') : []
  const consequenceCopy = !recognized
    ? 'A verified transaction consequence is unavailable.'
    : eligible
      ? 'Approving can start a transaction ceremony; the signed transaction may move funds.'
      : 'This transaction is blocked until eligibility is restored.'

  return (
    <div className="pc-wallet-consequence" role="dialog" aria-label="Approve transaction">
      <p
        className={recognized && eligible ? 'pc-field-help' : 'pc-field-error'}
        data-testid="verdict"
        data-eligible={eligible}
        data-verdict-state={recognized ? (eligible ? 'eligible' : 'rejected') : 'unavailable'}
      >
        {recognized ? (eligible ? 'Eligible' : 'Not eligible') : 'Unavailable'}
        {reasons.length > 0 ? `: ${reasons.join('; ')}` : ''}
      </p>

      {!recognized && (
        <p className="pc-field-error" role="alert">
          Allowance eligibility could not be checked. Try again after the read completes.
        </p>
      )}

      <div className="pc-row">
        <span>Allowance consequence</span>
        <span className="pc-technical" data-testid="amount">
          {sharesOut ?? (recognized ? 'Unavailable' : '—')}
        </span>
      </div>

      <p className="pc-field-help">{consequenceCopy}</p>

      <div className="pc-wallet-approval-actions">
        <button type="button" className="pc-button pc-button--secondary" onClick={onReject}>
          Cancel
        </button>
        <button
          type="button"
          className="pc-button pc-button--primary"
          disabled={!recognized || !eligible}
          onClick={onApprove}
        >
          Approve with Face ID
        </button>
      </div>
    </div>
  )
}
