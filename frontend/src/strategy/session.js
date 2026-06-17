// frontend/src/strategy/session.js
// ERC-7710 session redemption — the "execute many, sign once" core.
// After the user grants ONE ERC-7715 permission, every later on-chain action
// (grantAgentPermission, executeAgentDeposit) is redeemed by an ephemeral session
// account via sendTransactionWithDelegation. The DelegationManager executes the
// inner call FROM the user's smart account (msg.sender == user), so the deployed
// AgentVaultDepositor checks pass with no redeploy and no MetaMask popup.
//
// SECURITY: the session private key is generated in memory per page-load and is
// NEVER persisted or bundled. It only holds redemption authority scoped under the
// user's freshly-signed root grant, and is discarded on reload. Same rationale as
// the orchestrator key in redelegation.js.
//
// TRANSPORT: a local-account wallet client signs locally then broadcasts via
// `eth_sendRawTransaction` — MetaMask's injected provider does NOT expose that
// method to dapps (wallets gate raw broadcast to avoid nonce conflicts), so
// `custom(window.ethereum)` makes every redemption fail and silently fall back
// to the user-signed on-chain path (a popup, every time — worse than before).
// Broadcast straight to the chain RPC instead, exactly like redelegation.js.
import { createWalletClient, http } from 'viem'
import { baseSepolia as chain } from 'viem/chains'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { erc7710WalletActions } from '@metamask/smart-accounts-kit/actions'

let sessionClient = null
let sessionAccount = null
let activeContext = null
let activeManager = null

/**
 * Generate (or reuse) the ephemeral session account WITHOUT booting a client.
 *
 * MUST be called BEFORE requesting the ERC-7715 grant, and its address passed
 * as the grant's `redeemer`. Redemption authority is bound at grant time —
 * MetaMask only lets the address(es) named as `redeemer` redeem the resulting
 * delegation. Generating the key AFTER the grant (the original chicken-and-egg
 * bug here) means the grant names no one in particular, so when this account
 * later tries to redeem, the DelegationManager reverts with `msg.sender !=
 * delegate` — silently, because relayCall wraps it in a try/catch and falls
 * back to the popup-per-call path. That's why every agent kept prompting.
 *
 * @returns {string} the session account address to pass as `redeemer`
 */
export function prepareSessionAccount() {
  if (!sessionAccount) sessionAccount = privateKeyToAccount(generatePrivateKey())
  return sessionAccount.address
}

/**
 * Boot the ERC-7710 session from a granted permission. Idempotent per grant.
 * Reuses the account from prepareSessionAccount() — the SAME address that was
 * named as `redeemer` when the grant was requested, so redemption succeeds.
 * @param {{permissionContext: string, delegationManager: string}} grant
 */
export function initSession({ permissionContext, delegationManager }) {
  if (!permissionContext || !delegationManager)
    throw new Error('initSession: missing context/manager')
  if (!window?.ethereum) throw new Error('initSession: no wallet provider')

  if (!sessionAccount) sessionAccount = privateKeyToAccount(generatePrivateKey())
  sessionClient = createWalletClient({
    account: sessionAccount,
    chain,
    transport: http(import.meta.env.VITE_RPC_URL || 'https://sepolia.base.org'),
  }).extend(erc7710WalletActions())

  activeContext = permissionContext
  activeManager = delegationManager
  return sessionAccount.address
}

/** @returns {string|null} session account address, or null if not booted */
export function getSessionAddress() {
  return sessionAccount?.address || null
}

/** True when a session is booted and can redeem. */
export function hasSession() {
  return !!sessionClient && !!activeContext && !!activeManager
}

/**
 * Redeem ONE contract call through the granted permission. Zero popup.
 * @param {{to: string, data: string, value?: bigint}} call
 * @returns {Promise<string>} tx hash
 */
export async function redeemCall({ to, data, value = 0n }) {
  if (!hasSession()) throw new Error('redeemCall: no active session')
  return sessionClient.sendTransactionWithDelegation({
    to,
    data,
    value,
    permissionContext: activeContext,
    delegationManager: activeManager,
  })
}

/** Tear down the session (on revoke / disconnect / new strategy). */
export function clearSession() {
  sessionClient = null
  sessionAccount = null
  activeContext = null
  activeManager = null
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('vibing_session_grant')
  }
}

/**
 * Save the session grant to localStorage so it can be reused without re-prompting.
 * @param {{permissionContext: string, delegationManager: string, grantedPermissions: Array}} grantData
 */
export function saveSessionGrant(grantData) {
  if (grantData && typeof localStorage !== 'undefined') {
    // grantedPermissions echoed by SAK carries BigInt fields (periodAmount/expiry) that
    // JSON.stringify can't serialize → it throws "Do not know how to serialize a BigInt"
    // and the grant looks like it failed. Coerce any BigInt to its decimal string.
    localStorage.setItem(
      'vibing_session_grant',
      JSON.stringify(grantData, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    )
  }
}

/**
 * Retrieve the active session grant from localStorage.
 * @returns {{permissionContext: string, delegationManager: string, grantedPermissions: Array}|null}
 */
export function getActiveSessionGrant() {
  if (typeof localStorage === 'undefined') return null
  const data = localStorage.getItem('vibing_session_grant')
  if (!data) return null
  try {
    return JSON.parse(data)
  } catch {
    // Corrupt/partial value — drop it and behave as "no grant" rather than throwing.
    localStorage.removeItem('vibing_session_grant')
    return null
  }
}
