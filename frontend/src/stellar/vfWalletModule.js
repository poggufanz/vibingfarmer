// Custom @creit.tech/stellar-wallets-kit ModuleInterface for VF Wallet (frontend/extension) — a
// Soroban smart-account (passkey) wallet, not a classic G-address keypair wallet like
// Freighter/xBull/Albedo. Spec: https://stellarwalletskit.dev/wallets/create-wallet-module.html
//
// Deliberately does NOT import @creit.tech/stellar-wallets-kit — a ModuleInterface is duck-typed
// (no base class), and walletKitLoader.js's header comment says it stays the ONLY file that
// imports the kit package so an API change is a one-file fix. `moduleType` below is therefore the
// literal ModuleType.HOT_WALLET string value, not the imported enum.
//
// Talks to the extension via window.vfWallet, injected by a content script
// (frontend/extension/providerInject.js) that only runs on pages the extension is allowed to run
// on — see frontend/extension/manifest.json's content_scripts.matches (add your deployed origin
// there before shipping to production; localhost:5173 works out of the box for dev).
// isAvailable() is how the kit decides whether to list VF Wallet in its picker at all, so until
// that content script is built (npm run build:ext) and the unpacked extension is loaded, VF
// Wallet correctly stays hidden — this is what fixed "VF Wallet doesn't show up in the list".
//
// VF Wallet's account is a contractId (C...), not a G-address — it can never be a transaction's
// source account, so it cannot sign a classic tx envelope directly the way Freighter does. What
// it signs is the Soroban auth entry(ies) that require ITS contractId's authorization; the actual
// signing logic lives in frontend/src/wallet/signGeneric.js, run inside the extension's own
// ceremony page (frontend/extension/ceremony.js) — this file only relays to window.vfWallet.
export const VF_WALLET_ID = 'vf-wallet'

function provider() {
  if (typeof window === 'undefined' || !window.vfWallet) {
    throw new Error(
      'VF Wallet extension not detected (window.vfWallet is missing — install/load the extension, see frontend/extension)'
    )
  }
  return window.vfWallet
}

export class VfWalletModule {
  constructor() {
    this.moduleType = 'HOT_WALLET'
    this.productId = VF_WALLET_ID
    this.productName = 'VF Wallet'
    // TODO: point at a real listing/repo once VF Wallet is published somewhere.
    this.productUrl = '/'
    this.productIcon = '/vibing_farmer.logo.svg'
    this._cachedAddress = null
  }

  async isAvailable() {
    return typeof window !== 'undefined' && !!window.vfWallet
  }

  // Ceremony runs in the extension's own tab (WebAuthn credentials are origin-bound, so it MUST
  // run at the extension's chrome-extension:// origin, not the dApp's). Cached after the first
  // resolve so repeat calls (signTxXdr reads this before every sign — see stellar/walletKit.js)
  // don't reopen a ceremony tab each time.
  async getAddress() {
    if (this._cachedAddress) return { address: this._cachedAddress }
    const { address } = await provider().getAddress()
    this._cachedAddress = address
    return { address }
  }

  async signTransaction(xdr, opts) {
    const { signedTxXdr, signerAddress } = await provider().signTransaction(xdr, opts)
    return { signedTxXdr, signerAddress: signerAddress ?? opts?.address ?? this._cachedAddress }
  }

  async signAuthEntry(authEntry, opts) {
    const { signedAuthEntry, signerAddress } = await provider().signAuthEntry(authEntry, opts)
    return { signedAuthEntry, signerAddress: signerAddress ?? opts?.address ?? this._cachedAddress }
  }

  // Smart-account-kit (the extension's signer) only exposes signAuthEntry in this codebase —
  // there's no arbitrary-message-signing primitive to wrap, so this is a clean rejection rather
  // than a guess. Mirrors xBull's own module doing the same for functions it doesn't support.
  signMessage() {
    return Promise.reject({
      code: -3,
      message:
        'VF Wallet does not support the "signMessage" function (its passkey signer only signs Soroban auth entries)',
    })
  }

  // VF Wallet is testnet-only today (frontend/src/wallet/config.js's WALLET_CONFIG) — no round
  // trip to the extension needed for a static fact.
  async getNetwork() {
    const { NETWORK_PASSPHRASE } = await import('./config.js')
    return { network: 'TESTNET', networkPassphrase: NETWORK_PASSPHRASE }
  }

  async disconnect() {
    this._cachedAddress = null
  }
}
