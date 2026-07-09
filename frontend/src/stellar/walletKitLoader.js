// Isolated lazy loader for Stellar Wallets Kit. The ONLY file that imports the package, so a
// version/API change is a one-file fix and tests can mock this module cleanly.
//
// Package scope is @creit.tech (a dot, not a hyphen) — the npm org is "creit.tech".
// API verified against @creit.tech/stellar-wallets-kit@2.3.0: static StellarWalletsKit.init({
// modules, network, theme }) + authModal()/getAddress()/signTransaction(xdr, { networkPassphrase,
// address }). Networks.TESTNET === the testnet passphrase string, so NETWORK_PASSPHRASE is the
// correct value for `network`.
import { NETWORK_PASSPHRASE } from './config.js'

let _kit = null

/**
 * Initialize (once) and return the Stellar Wallets Kit handle.
 * @returns {Promise<object>} object exposing authModal/getAddress/signTransaction
 */
export async function loadKit() {
  if (_kit) return _kit
  const { StellarWalletsKit, SwkAppDarkTheme } = await import('@creit.tech/stellar-wallets-kit')
  const { FreighterModule } = await import('@creit.tech/stellar-wallets-kit/modules/freighter')
  const { xBullModule } = await import('@creit.tech/stellar-wallets-kit/modules/xbull')
  const { AlbedoModule } = await import('@creit.tech/stellar-wallets-kit/modules/albedo')
  StellarWalletsKit.init({
    theme: SwkAppDarkTheme,
    network: NETWORK_PASSPHRASE,
    modules: [new FreighterModule(), new xBullModule(), new AlbedoModule()],
  })
  _kit = StellarWalletsKit
  return _kit
}
