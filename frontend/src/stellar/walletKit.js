// User wallet connector. Security-sensitive actions bind the exact selected module, address,
// network and epoch into ActiveAccountV1; no configured network fallback is accepted as proof.
import { TransactionBuilder } from '@stellar/stellar-sdk'
import { loadKit } from './walletKitLoader.js'
import {
  activeAccountChanged,
  assertActiveAccountBoundary,
  classifyActiveAccount,
} from './activeAccount.js'

let activeAccount = null
let epoch = 0
let unsubscribeKit = null
const accountListeners = new Set()

function publish() {
  accountListeners.forEach((listener) => listener(activeAccount))
}

function normalizeBinding(value) {
  if (value?.client && typeof value?.getSelectedModule === 'function') return value
  const selected = () => {
    if (typeof value?.getSelectedModule === 'function') return value.getSelectedModule()
    if (value?.selectedModule) return value.selectedModule
    if (value?.activeModule) return value.activeModule
    if (value?.productId || value?.id) return value
    throw activeAccountChanged()
  }
  return {
    client: value,
    getSelectedModule: selected,
    events: {
      STATE_UPDATED: 'STATE_UPDATE',
      WALLET_SELECTED: 'WALLET_SELECTED',
      DISCONNECT: 'DISCONNECT',
    },
  }
}

function selectedModule(binding) {
  let module
  try {
    module = binding.getSelectedModule()
  } catch {
    throw activeAccountChanged()
  }
  if (!module) throw activeAccountChanged()
  return module
}

function invalidateInstalledAccount() {
  if (activeAccount) invalidate()
}

function invalidateCapturedAccount(captured) {
  if (
    activeAccount?.version === 1 &&
    captured?.version === 1 &&
    activeAccount.address === captured.address &&
    activeAccount.networkPassphrase === captured.networkPassphrase &&
    activeAccount.connectorId === captured.connectorId &&
    activeAccount.epoch === captured.epoch
  )
    invalidate()
}

function connectorIdFor(module) {
  const id = module?.productId || module?.id
  if (typeof id !== 'string' || !id) throw activeAccountChanged()
  return id
}

/** Fresh-read one stable selected module. The module must prove both address and network. */
export async function readSelectedWallet({ kit } = {}) {
  const binding = normalizeBinding(kit || (await loadKit()))
  try {
    const module = selectedModule(binding)
    const connectorId = connectorIdFor(module)
    const addressResult = await module.getAddress()
    if (selectedModule(binding) !== module) throw activeAccountChanged()
    const networkResult = await module.getNetwork()
    if (selectedModule(binding) !== module) throw activeAccountChanged()
    const address = addressResult?.address
    const networkPassphrase = networkResult?.networkPassphrase
    if (
      typeof address !== 'string' ||
      !address ||
      typeof networkPassphrase !== 'string' ||
      !networkPassphrase
    )
      throw activeAccountChanged()
    return { binding, module, connectorId, address, networkPassphrase }
  } catch (error) {
    invalidateInstalledAccount()
    if (error?.code === 'ACTIVE_ACCOUNT_CHANGED') throw error
    throw activeAccountChanged()
  }
}

export function assertSelectedWalletSnapshot({ activeAccount: captured, snapshot, module }) {
  if (
    !captured ||
    captured.version !== 1 ||
    snapshot.address !== captured.address ||
    snapshot.networkPassphrase !== captured.networkPassphrase ||
    snapshot.connectorId !== captured.connectorId ||
    (module && snapshot.module !== module)
  ) {
    invalidateCapturedAccount(captured)
    throw activeAccountChanged()
  }
  return snapshot
}

function installSnapshot(snapshot, installedEpoch = ++epoch) {
  activeAccount = classifyActiveAccount({
    address: snapshot.address,
    networkPassphrase: snapshot.networkPassphrase,
    connectorId: snapshot.connectorId,
    epoch: installedEpoch,
  })
  publish()
  return activeAccount
}

function invalidate() {
  epoch += 1
  activeAccount = null
  publish()
  return epoch
}

/** Subscribe to the installed kit event source and the selected module's own account event. */
export function subscribeActiveAccountChanges(kit) {
  unsubscribeKit?.()
  const binding = normalizeBinding(kit)
  const offs = []
  let moduleOff = null
  let subscribing = true

  const subscribeModule = (module) => {
    moduleOff?.()
    moduleOff = null
    if (typeof module?.onChange === 'function') {
      const off = module.onChange(refresh)
      if (typeof off === 'function') moduleOff = off
    } else if (typeof module?.on === 'function') {
      const off = module.on('accountChanged', refresh)
      if (typeof off === 'function') moduleOff = off
    }
  }

  const refresh = () => {
    if (subscribing) return
    const refreshEpoch = invalidate()
    Promise.resolve()
      .then(() => readSelectedWallet({ kit: binding }))
      .then((snapshot) => {
        if (epoch !== refreshEpoch) return
        installSnapshot(snapshot, refreshEpoch)
        subscribeModule(snapshot.module)
      })
      .catch(() => {
        // Invalidated synchronously above. An unreliable/disconnected replacement stays null.
      })
  }

  const disconnected = () => {
    if (subscribing) return
    invalidate()
    moduleOff?.()
    moduleOff = null
  }

  if (typeof binding.client?.on === 'function') {
    const events = binding.events || {}
    for (const [name, handler] of [
      [events.STATE_UPDATED, refresh],
      [events.WALLET_SELECTED, refresh],
      [events.DISCONNECT, disconnected],
    ]) {
      if (!name) continue
      const off = binding.client.on(name, handler)
      if (typeof off === 'function') offs.push(off)
    }
  }
  subscribeModule(selectedModule(binding))
  subscribing = false
  unsubscribeKit = () => {
    moduleOff?.()
    offs.forEach((off) => off())
  }
  return unsubscribeKit
}

export function getActiveAccount() {
  return activeAccount
}

export function onActiveAccountChange(listener) {
  accountListeners.add(listener)
  return () => accountListeners.delete(listener)
}

/** Connect and capture the full capability; callers pass this exact record through actions. */
export async function connectActiveAccount({ prompt = true } = {}) {
  const binding = normalizeBinding(await loadKit())
  const modal = prompt ? await binding.client.authModal() : null
  const snapshot = await readSelectedWallet({ kit: binding })
  if (prompt && modal?.address !== snapshot.address) throw activeAccountChanged()
  const account = installSnapshot(snapshot)
  subscribeActiveAccountChanges(binding)
  return account
}

export async function connectWallet() {
  return (await connectActiveAccount()).address
}

export async function getUserAddress() {
  return (await readSelectedWallet()).address
}

/** Legacy signer used outside reviewed browser owner actions. It still fresh-reads the selected
 * module before and after signing; callers needing custody guarantees use signReviewedTransaction. */
export async function signTxXdr(xdr) {
  const before = await readSelectedWallet()
  const signed = await before.module.signTransaction(xdr, {
    networkPassphrase: before.networkPassphrase,
    address: before.address,
  })
  const after = await readSelectedWallet({ kit: before.binding })
  if (
    after.module !== before.module ||
    after.address !== before.address ||
    after.networkPassphrase !== before.networkPassphrase
  )
    throw activeAccountChanged()
  if (signed?.signerAddress != null && signed.signerAddress !== before.address)
    throw activeAccountChanged()
  return signed?.signedTxXdr
}

function hashText(hash) {
  if (typeof hash === 'string') return hash.toLowerCase()
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Sign only the reviewed classic envelope. C accounts intentionally have no classic source. */
export async function signReviewedTransaction({
  xdr,
  activeAccount: captured,
  reviewedTxHash,
  kit,
  getCurrentActiveAccount = getActiveAccount,
  signal,
}) {
  if (captured?.kind === 'C')
    throw new Error('A C account is a Soroban authorizer and cannot sign a classic transaction.')
  const check = () =>
    assertActiveAccountBoundary({
      captured,
      getCurrent: getCurrentActiveAccount,
      signal,
      requireV1: true,
    })
  check()
  const before = await readSelectedWallet({ kit })
  check()
  assertSelectedWalletSnapshot({ activeAccount: captured, snapshot: before })
  check()
  const signed = await before.module.signTransaction(xdr, {
    networkPassphrase: captured.networkPassphrase,
    address: captured.address,
  })
  check()
  if (
    signed?.networkPassphrase != null &&
    signed.networkPassphrase !== captured.networkPassphrase
  ) {
    invalidateCapturedAccount(captured)
    throw activeAccountChanged()
  }
  if (signed?.signerAddress != null && signed.signerAddress !== captured.address) {
    invalidateCapturedAccount(captured)
    throw activeAccountChanged()
  }
  const after = await readSelectedWallet({ kit: before.binding })
  check()
  assertSelectedWalletSnapshot({ activeAccount: captured, snapshot: after, module: before.module })
  const tx = TransactionBuilder.fromXDR(signed?.signedTxXdr, captured.networkPassphrase)
  if (hashText(tx.hash()) !== hashText(reviewedTxHash)) {
    invalidateCapturedAccount(captured)
    throw activeAccountChanged()
  }
  check()
  return signed.signedTxXdr
}
