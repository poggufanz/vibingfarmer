// Wallet connect + SEP-10 challenge signing for the /developers portal.
// Delegates to the app's wallet plumbing (stellar/walletKit.js) — walletKitLoader.js
// is the ONLY file allowed to import @creit.tech/stellar-wallets-kit, so kit API
// changes stay a one-file fix.
import { connectWallet as kitConnect, signTxXdr } from '../stellar/walletKit.js'

export async function connectWallet() {
  const address = await kitConnect()
  return { address, signChallenge: signTxXdr }
}
