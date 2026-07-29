// User wallet connector. The app calls these three fns; nothing else imports the kit.
import { TransactionBuilder } from '@stellar/stellar-sdk'
import { NETWORK_PASSPHRASE } from './config.js'
import { loadKit } from './walletKitLoader.js'
import { assertCurrentActiveAccount, classifyActiveAccount } from './activeAccount.js'

let activeAccount = null
let epoch = 0
let unsubscribeKit = null
const accountListeners = new Set()

function publish() {
  accountListeners.forEach((listener) => listener(activeAccount))
}

function connectorIdFor(kit, fallback = 'stellar-wallet-kit') {
  const selected = kit?.getSelectedModule?.() || kit?.selectedModule || kit?.activeModule
  return selected?.productId || selected?.id || kit?.productId || kit?.id || kit?.name || fallback
}

async function networkFor(kit) {
  const network = await kit?.getNetwork?.()
  return network?.networkPassphrase || network?.passphrase || NETWORK_PASSPHRASE
}

function accountChanged() {
  const error = new Error('The active wallet account changed. Review and approve again.')
  error.code = 'ACTIVE_ACCOUNT_CHANGED'
  return error
}

function installAccount({ address, kit, connectorId, networkPassphrase = NETWORK_PASSPHRASE }) {
  epoch += 1
  activeAccount = classifyActiveAccount({
    address,
    networkPassphrase,
    connectorId: connectorId || connectorIdFor(kit),
    epoch,
  })
  publish()
  return activeAccount
}

/** Subscribe when a connector offers reliable state events; every sign still reads the address
 * fresh because connectors without events must fail closed too. */
export function subscribeActiveAccountChanges(kit, { connectorId } = {}) {
  unsubscribeKit?.()
  const changed = (event) => {
    const address = event?.address || event?.detail?.address
    if (address) installAccount({ address, kit, connectorId })
    else {
      epoch += 1
      activeAccount = null
      publish()
    }
  }
  const offs = []
  if (typeof kit?.on === 'function') {
    ;['accountChanged', 'networkChanged', 'disconnect'].forEach((name) => {
      const off = kit.on(name, changed)
      if (typeof off === 'function') offs.push(off)
    })
  }
  if (typeof window !== 'undefined' && kit?.productId === 'vf-wallet') {
    window.addEventListener('vfWallet#accountChanged', changed)
    offs.push(() => window.removeEventListener('vfWallet#accountChanged', changed))
  }
  unsubscribeKit = () => offs.forEach((off) => off())
  return unsubscribeKit
}

export function getActiveAccount() {
  return activeAccount
}

export function onActiveAccountChange(listener) {
  accountListeners.add(listener)
  return () => accountListeners.delete(listener)
}

/** Connect and capture the full capability; callers must pass this exact record through actions. */
export async function connectActiveAccount({ connectorId } = {}) {
  const kit = await loadKit()
  const { address } = await kit.authModal()
  const networkPassphrase = await networkFor(kit)
  const account = installAccount({ address, kit, connectorId, networkPassphrase })
  subscribeActiveAccountChanges(kit, { connectorId })
  return account
}

/**
 * Open the wallet-selection modal and return the chosen address.
 * @returns {Promise<string>} the connected G... address
 */
export async function connectWallet() {
  return (await connectActiveAccount()).address
}

/**
 * The currently active wallet address. Throws if none is connected.
 * @returns {Promise<string>}
 */
export async function getUserAddress() {
  const kit = await loadKit()
  const { address } = await kit.getAddress()
  return address
}

/**
 * Ask the user's wallet to sign an unsigned transaction XDR. Network passphrase is pinned —
 * a wrong one silently yields an invalid signature.
 * @param {string} xdr unsigned base64 transaction envelope
 * @returns {Promise<string>} the signed base64 XDR
 */
export async function signTxXdr(xdr) {
  const kit = await loadKit()
  const { address } = await kit.getAddress()
  const { signedTxXdr } = await kit.signTransaction(xdr, {
    networkPassphrase: NETWORK_PASSPHRASE,
    address,
  })
  return signedTxXdr
}

function hashText(hash) {
  if (typeof hash === 'string') return hash.toLowerCase()
  return Buffer.from(hash).toString('hex').toLowerCase()
}

/**
 * Sign only the reviewed classic envelope. The active account is checked both immediately before
 * opening the signer and after it resolves, preventing an account switch during a wallet popup
 * from ever reaching submission. C accounts intentionally have no classic-envelope path.
 */
export async function signReviewedTransaction({ xdr, activeAccount: captured, reviewedTxHash, kit }) {
  if (captured?.kind === 'C')
    throw new Error('A C account is a Soroban authorizer and cannot sign a classic transaction.')
  const connector = kit || (await loadKit())
  const currentAddress = (await connector.getAddress()).address
  const currentNetwork = await networkFor(connector)
  if (currentAddress !== captured?.address || currentNetwork !== captured?.networkPassphrase)
    throw accountChanged()
  if (activeAccount) assertCurrentActiveAccount({ captured, current: activeAccount })
  const signed = await connector.signTransaction(xdr, {
    networkPassphrase: captured.networkPassphrase,
    address: captured.address,
  })
  if (
    (signed?.signerAddress != null && signed.signerAddress !== captured.address) ||
    (signed?.networkPassphrase != null && signed.networkPassphrase !== captured.networkPassphrase)
  )
    throw accountChanged()
  const afterAddress = (await connector.getAddress()).address
  const afterNetwork = await networkFor(connector)
  if (
    afterAddress !== captured.address ||
    afterNetwork !== captured.networkPassphrase ||
    (activeAccount && activeAccount.epoch !== captured.epoch)
  )
    throw accountChanged()
  const tx = TransactionBuilder.fromXDR(signed.signedTxXdr, captured.networkPassphrase)
  if (hashText(tx.hash()) !== hashText(reviewedTxHash)) throw accountChanged()
  return signed.signedTxXdr
}
