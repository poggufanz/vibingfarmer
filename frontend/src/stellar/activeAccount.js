import { Address } from '@stellar/stellar-sdk'

function changed() {
  const error = new Error('The active wallet account changed. Review and approve again.')
  error.code = 'ACTIVE_ACCOUNT_CHANGED'
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
    a && b && a.version === b.version && a.kind === b.kind && a.address === b.address &&
      a.networkPassphrase === b.networkPassphrase && a.connectorId === b.connectorId && a.epoch === b.epoch
  )
}

export function assertCurrentActiveAccount({ captured, current }) {
  if (!sameActiveAccount(captured, current)) throw changed()
  return captured
}

export function assertActiveOwner({ owner, activeAccount }) {
  if (activeAccount?.version === 1 && activeAccount.address !== owner) throw changed()
  return activeAccount
}
