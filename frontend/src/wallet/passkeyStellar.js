// frontend/src/wallet/passkeyStellar.js
// Thin, testable wrapper around the EXISTING Passkey Kit (smart-account-kit) integration in
// wallet/account.js. Does not reimplement provisioning — `createPasskeyWallet` there already
// does `kit.createWallet(appName, userName, { autoSubmit: true, autoFund: true })`. This module
// adds the two things SP3's mandate/CCTP flows need: a stable `signBurn` ceremony wrapper and a
// fund-status read, both built on already-proven primitives (kit.signAuthEntry is the same
// ceremony wallet/submit.js's submitDeposit/submitApprove already use in production).
import {
  createPasskeyWallet,
  makeKit as defaultMakeKit,
  readBalance as defaultReadBalance,
} from './account.js'
import { toDisplay } from '../stellar/format.js'

const APP_NAME = 'Vibing Farmer'

/**
 * Provision a Stellar Passkey Kit smart wallet for `email` (used as SAK's userName — the
 * WebAuthn credential's display label, not an account identifier the app trusts for anything).
 * @param {{ email: string, deps?: { makeKit?: Function } }} p
 * @returns {Promise<{ address: string, credentialId: string, signBurn: (entry: object) => Promise<object> }>}
 */
export async function createStellarPasskeyWallet({ email, deps = {} }) {
  const { makeKit = defaultMakeKit } = deps
  const kit = await makeKit()
  const { contractId, credentialId } = await createPasskeyWallet({
    appName: APP_NAME,
    userName: email,
    kit,
  })

  return {
    address: contractId,
    credentialId,
    // One auth entry in, one signed auth entry out — mirrors wallet/submit.js's
    // `kit.signAuthEntry(entries[0])` ceremony exactly. cctpBurn.js (Task 3.4) calls this once
    // per Soroban invoke (approve, then deposit_for_burn) that needs this wallet's authorization.
    signBurn: (authEntry) => kit.signAuthEntry(authEntry),
  }
}

/**
 * Current USDC balance for a provisioned Stellar passkey wallet. Never throws on an RPC hiccup —
 * treats an unreadable balance as zero (fail-safe: the caller decides whether to block or retry,
 * not this helper).
 * @param {string} address - G... contract address
 * @param {{ deps?: { readBalance?: Function } }} [opts]
 * @returns {Promise<{ balanceUnits: bigint, balanceDisplay: number, hasUsdc: boolean }>}
 */
export async function fundStatus(address, { deps = {} } = {}) {
  const { readBalance = defaultReadBalance } = deps
  const raw = await readBalance(address)
  const balanceUnits = raw ?? 0n
  return {
    balanceUnits,
    balanceDisplay: toDisplay(balanceUnits),
    hasUsdc: balanceUnits > 0n,
  }
}
