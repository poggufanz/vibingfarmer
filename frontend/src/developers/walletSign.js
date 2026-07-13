// Wallet connect + SEP-10 challenge signing for the /developers portal.
// Delegates to the app's wallet plumbing (stellar/walletKit.js) — walletKitLoader.js
// is the ONLY file allowed to import @creit.tech/stellar-wallets-kit, so kit API
// changes stay a one-file fix.
import { connectWallet as kitConnect, getUserAddress, signTxXdr } from '../stellar/walletKit.js'

export async function connectWallet() {
  // Reuse the wallet the app already connected — only open the picker modal when the kit
  // has no active wallet (getUserAddress rejects). Without this, the portal re-prompted
  // users who were already connected in the main app.
  let address
  try {
    address = await getUserAddress()
  } catch {
    address = await kitConnect()
  }
  // SEP-10 challenges are classic transactions with the client account as source — a passkey
  // smart account (C… contractId) can never sign one. Fail with a real explanation instead of
  // an opaque server error.
  if (address?.startsWith('C')) {
    throw new Error(
      'Portal sign-in needs a classic wallet (G... address). Passkey smart accounts cannot sign the SEP-10 challenge. Connect Freighter, xBull, Albedo, or a standard VF wallet.'
    )
  }
  return { address, signChallenge: signTxXdr }
}
