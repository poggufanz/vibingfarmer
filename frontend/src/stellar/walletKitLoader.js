// Isolated lazy loader for Stellar Wallets Kit. The ONLY file that imports the package, so a
// version/API change is a one-file fix and tests can mock this module cleanly.
//
// Package scope is @creit.tech (a dot, not a hyphen) — the npm org is "creit.tech".
// API verified against @creit.tech/stellar-wallets-kit@2.3.0: static StellarWalletsKit.init({
// modules, network, theme }) + authModal()/getAddress()/signTransaction(xdr, { networkPassphrase,
// address }). Networks.TESTNET === the testnet passphrase string, so NETWORK_PASSPHRASE is the
// correct value for `network`.
import { NETWORK_PASSPHRASE } from './config.js'
import { VfWalletModule } from './vfWalletModule.js'

let _kit = null

/**
 * Initialize (once) and return the Stellar Wallets Kit handle.
 * @returns {Promise<{client:object, getSelectedModule:Function, events:object}>} the kit event
 * source plus a live selected-module accessor. Security-sensitive callers use the module itself
 * for fresh address/network reads; the kit's cached address is display-only.
 */
export async function loadKit() {
  if (_kit) return _kit
  const { StellarWalletsKit, SwkAppDarkTheme, KitEventType } =
    await import('@creit.tech/stellar-wallets-kit')
  const { FreighterModule } = await import('@creit.tech/stellar-wallets-kit/modules/freighter')
  const { xBullModule } = await import('@creit.tech/stellar-wallets-kit/modules/xbull')
  const { AlbedoModule } = await import('@creit.tech/stellar-wallets-kit/modules/albedo')
  StellarWalletsKit.init({
    theme: SwkAppDarkTheme,
    network: NETWORK_PASSPHRASE,
    // VfWalletModule is OUR OWN plain-object ModuleInterface (frontend/src/stellar/vfWalletModule.js)
    // — it does not import the kit package, so registering it here doesn't break the "only this
    // file imports @creit.tech/stellar-wallets-kit" rule from the header comment above.
    modules: [new VfWalletModule(), new FreighterModule(), new xBullModule(), new AlbedoModule()],
  })
  _kit = Object.freeze({
    client: StellarWalletsKit,
    getSelectedModule: () => StellarWalletsKit.selectedModule,
    events: Object.freeze({
      STATE_UPDATED: KitEventType.STATE_UPDATED,
      WALLET_SELECTED: KitEventType.WALLET_SELECTED,
      DISCONNECT: KitEventType.DISCONNECT,
    }),
  })
  return _kit
}
