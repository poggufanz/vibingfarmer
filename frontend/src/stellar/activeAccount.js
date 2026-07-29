import { Address } from '@stellar/stellar-sdk'
import { NETWORK_PASSPHRASE } from './config.js'

export function activeAccountChanged() {
  const error = new Error('The active wallet account changed. Review and approve again.')
  error.code = 'ACTIVE_ACCOUNT_CHANGED'
  return error
}

export function activeAccountSubmissionUnknown({ stage, cause, result, custody } = {}) {
  const error = new Error(
    `The active wallet account changed after ${stage || 'transaction'} dispatch. Check custody before retrying.`
  )
  error.name = 'ActiveAccountSubmissionUnknownError'
  error.code = 'VF_SUBMISSION_UNKNOWN'
  error.submission = 'unknown'
  error.stage = stage || 'submit'
  error.custody = custody || { location: 'unknown', confirmed: false }
  if (cause) error.cause = cause
  if (result !== undefined) error.result = result
  return error
}

export function classifyActiveAccount({ address, networkPassphrase, connectorId, epoch }) {
  if (typeof address !== 'string' || typeof networkPassphrase !== 'string' || !connectorId)
    throw new Error('Invalid active account.')
  try {
    Address.fromString(address)
  } catch {
    throw new Error('Invalid active account address.')
  }
  const kind = address.startsWith('G') ? 'G' : address.startsWith('C') ? 'C' : null
  if (!kind || !Number.isSafeInteger(epoch) || epoch < 0) throw new Error('Invalid active account.')
  return Object.freeze({
    version: 1,
    kind,
    address,
    networkPassphrase,
    connectorId: String(connectorId),
    epoch,
  })
}

export function sameActiveAccount(a, b) {
  return Boolean(
    a &&
    b &&
    a.version === b.version &&
    a.kind === b.kind &&
    a.address === b.address &&
    a.networkPassphrase === b.networkPassphrase &&
    a.connectorId === b.connectorId &&
    a.epoch === b.epoch
  )
}

export function assertCurrentActiveAccount({ captured, current }) {
  if (!sameActiveAccount(captured, current)) throw activeAccountChanged()
  return captured
}

/** Assert the captured capability at one async boundary. V1 callers must supply a current-record
 * accessor; browser entry points can additionally require V1 so a legacy address-shaped value
 * never crosses an owner-action boundary. */
export function assertActiveAccountBoundary({ captured, getCurrent, signal, requireV1 = false }) {
  if (signal?.aborted || (requireV1 && captured?.version !== 1)) throw activeAccountChanged()
  if (captured?.version === 1) {
    // Every browser-side builder/RPC client in this application is configured for this network.
    // A capability for another network is useful display state, but never execution authority.
    if (captured.networkPassphrase !== NETWORK_PASSPHRASE) throw activeAccountChanged()
    if (typeof getCurrent !== 'function') throw activeAccountChanged()
    assertCurrentActiveAccount({ captured, current: getCurrent() })
  }
  return captured
}

export function assertActiveOwner({ owner, activeAccount }) {
  if (activeAccount?.version === 1 && activeAccount.address !== owner) throw activeAccountChanged()
  return activeAccount
}
