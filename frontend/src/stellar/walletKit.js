// User wallet connector. The app calls these three fns; nothing else imports the kit.
import { NETWORK_PASSPHRASE } from './config.js'
import { loadKit } from './walletKitLoader.js'

/**
 * Open the wallet-selection modal and return the chosen address.
 * @returns {Promise<string>} the connected G... address
 */
export async function connectWallet() {
  const kit = await loadKit()
  const { address } = await kit.authModal()
  return address
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
