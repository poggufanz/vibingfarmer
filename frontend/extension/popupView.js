// frontend/extension/popupView.js
// Pure presentation for the popup's internal ceremony screens. This module only consumes the
// result payload already produced by the ceremony/background path; it never reads storage, calls a
// controller, signs, submits, relays, or performs a balance/share read.
import React from 'react'
import { WalletShell } from '../src/wallet/ui/WalletShell.jsx'
import { NetworkBadge } from '../src/components/pocket/NetworkIdentity.jsx'
import { NETWORK_IDS, getNetworkMeta } from '../src/design/networks.js'
import { statusNoticeModel } from '../src/design/pocket-crew-foundation.js'

export const POPUP_RESULT_STATE = Object.freeze({
  NOT_SUBMITTED: 'not-submitted',
  SUBMITTED: 'submitted',
  CONFIRMED: 'confirmed',
  UNKNOWN: 'unknown',
  FAILED: 'failed',
})

const STELLAR_TESTNET_LABEL = getNetworkMeta(NETWORK_IDS.STELLAR_TESTNET).label
const DEFAULT_ORIGIN = 'VF Wallet (this extension)'

const presentText = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)

function parseNonNegativeBigInt(value) {
  if (typeof value === 'bigint') return value >= 0n ? value : null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null
    try {
      const parsed = BigInt(value)
      return parsed >= 0n ? parsed : null
    } catch {
      return null
    }
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null
  try {
    return BigInt(value.trim())
  } catch {
    return null
  }
}

function sharesDelta(result, state) {
  if (state !== POPUP_RESULT_STATE.CONFIRMED) return null
  const before = parseNonNegativeBigInt(result?.sharesBefore)
  const after = parseNonNegativeBigInt(result?.sharesAfter)
  if (before === null || after === null || after < before) return null
  return (after - before).toString()
}

function foundationConsequence(state) {
  const foundationState =
    state === POPUP_RESULT_STATE.NOT_SUBMITTED
      ? 'cancelled'
      : state === POPUP_RESULT_STATE.FAILED
        ? 'rejected'
        : 'unknown'
  return statusNoticeModel({ state: foundationState }).consequence
}

function actionMessage(result, state, shares) {
  const detail = presentText(result?.error)
  if (result?.accountSnapshotStale === true) {
    return 'Active account changed while this request was running. Verify the transaction before relying on it.'
  }
  if (state === POPUP_RESULT_STATE.NOT_SUBMITTED) {
    return detail ? `Nothing moved. ${detail}` : 'Nothing moved — the request was not submitted.'
  }
  if (state === POPUP_RESULT_STATE.SUBMITTED) return 'Submitted — awaiting confirmation.'
  if (state === POPUP_RESULT_STATE.CONFIRMED) {
    if (result?.action === 'deposit' && shares !== null) {
      return `Confirmed — ${shares} shares received.`
    }
    if (result?.action === 'approve') return 'Confirmed — deposits enabled.'
    return 'Confirmed.'
  }
  if (state === POPUP_RESULT_STATE.FAILED) {
    return detail ? `Failed — ${detail}` : foundationConsequence(state) || 'The request failed.'
  }
  return 'Status unknown — verify the transaction before relying on it.'
}

function resultState(result) {
  const status = result?.status
  const hash = presentText(result?.hash)
  if (status === 'NOT_SUBMITTED') return POPUP_RESULT_STATE.NOT_SUBMITTED
  if (result?.accountSnapshotStale === true) return POPUP_RESULT_STATE.UNKNOWN
  if (result?.ok !== false && status === 'SUCCESS' && hash) {
    return POPUP_RESULT_STATE.CONFIRMED
  }
  if (result?.ok !== false && status === 'PENDING' && hash) {
    return POPUP_RESULT_STATE.SUBMITTED
  }
  if (['FAILED', 'REJECTED', 'CANCELLED', 'ERROR'].includes(status)) {
    return POPUP_RESULT_STATE.FAILED
  }
  if (result?.ok === false) return POPUP_RESULT_STATE.FAILED
  return POPUP_RESULT_STATE.UNKNOWN
}

function labelForState(state) {
  switch (state) {
    case POPUP_RESULT_STATE.NOT_SUBMITTED:
      return 'Not submitted'
    case POPUP_RESULT_STATE.SUBMITTED:
      return 'Submitted'
    case POPUP_RESULT_STATE.CONFIRMED:
      return 'Confirmed'
    case POPUP_RESULT_STATE.FAILED:
      return 'Failed'
    default:
      return 'Unavailable'
  }
}

/**
 * Project the existing ceremony result into copy and link data only.
 *
 * @param {{ok?: boolean, action?: string, status?: string, hash?: string,
 *   sharesBefore?: string|number|bigint, sharesAfter?: string|number|bigint,
 *   accountSnapshotStale?: boolean, error?: string}} result
 * @param {{origin?: string}} options
 */
export function toPopupResultModel(result = {}, { origin } = {}) {
  const state = resultState(result)
  const hash = presentText(result?.hash)
  const shares = sharesDelta(result, state)
  // Read the option so callers can pass the verified extension origin without making it part of
  // the result contract; origin is presentation context, not transaction evidence.
  presentText(origin)
  return Object.freeze({
    state,
    label: result?.accountSnapshotStale === true ? 'Account changed' : labelForState(state),
    message: actionMessage(result, state, shares),
    hash,
    explorerHref: hash
      ? `https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(hash)}`
      : null,
    shares,
  })
}

function shellAccount(account) {
  if (!account) return null
  if (account.kind && account.address) return account
  if (account.contractId) return { kind: 'C', address: account.contractId }
  return null
}

function originCopy(origin) {
  return `Origin: ${presentText(origin) || DEFAULT_ORIGIN}`
}

function statusTone(state) {
  return [POPUP_RESULT_STATE.FAILED, POPUP_RESULT_STATE.NOT_SUBMITTED].includes(state)
    ? 'error'
    : 'info'
}

export function PopupSigningPending({ account, origin, onBack, status = 'Waiting for Face ID' }) {
  return React.createElement(
    WalletShell,
    {
      heading: 'Approve in the ceremony tab',
      account: shellAccount(account),
      onBack,
      backLabel: 'Cancel',
      status: { tone: 'info', message: status },
    },
    React.createElement(
      'div',
      { className: 'pc-wallet-state', 'data-network': NETWORK_IDS.STELLAR_TESTNET },
      React.createElement(NetworkBadge, {
        networkId: NETWORK_IDS.STELLAR_TESTNET,
        compact: true,
        className: 'pc-network-badge',
      }),
      React.createElement('p', { className: 'pc-route-intro' }, originCopy(origin)),
      React.createElement(
        'p',
        { className: 'pc-field-help' },
        `Face ID opens in a new tab. This popup may close, so reopen it to see the result on ${STELLAR_TESTNET_LABEL}.`
      )
    )
  )
}

export function PopupResult({ account, origin, result, onDone }) {
  const model = toPopupResultModel(result, { origin })
  const children = [
    React.createElement(NetworkBadge, {
      networkId: NETWORK_IDS.STELLAR_TESTNET,
      compact: true,
      className: 'pc-network-badge',
    }),
    React.createElement('p', { className: 'pc-route-intro' }, originCopy(origin)),
  ]
  if (model.shares !== null) {
    children.push(
      React.createElement(
        'p',
        { className: 'pc-field-help', 'data-testid': 'result-shares', key: 'shares' },
        'Shares received: ',
        React.createElement('span', { className: 'pc-technical' }, model.shares)
      )
    )
  }
  if (model.explorerHref) {
    children.push(
      React.createElement(
        'a',
        {
          className: 'pc-field-help',
          href: model.explorerHref,
          target: '_blank',
          rel: 'noreferrer',
          key: 'explorer',
        },
        'View on Stellar Expert'
      )
    )
  }
  children.push(
    React.createElement(
      'button',
      { type: 'button', className: 'pc-button pc-button--primary', onClick: onDone, key: 'done' },
      'Done'
    )
  )
  return React.createElement(
    WalletShell,
    {
      heading: model.label,
      account: shellAccount(account),
      status: { tone: statusTone(model.state), message: model.message },
    },
    React.createElement(
      'div',
      { className: 'pc-wallet-state', 'data-result-state': model.state },
      ...children
    )
  )
}
