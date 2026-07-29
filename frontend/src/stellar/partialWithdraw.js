// frontend/src/stellar/partialWithdraw.js
// Partial withdraw from ONE agent via the exit signer (tag-1 signature, enforce_exit policy:
// vault.redeem any shares + token.transfer ONLY to the owner). Two relayed txs — Soroban allows
// one host-function per tx: (1) redeem shares into the agent, (2) sweep the agent's ACTUAL
// token balance to the owner (retval-equivalent → zero dust, and any prior stranded balance
// rides along). Relay-only: the user holds no XLM, a relay refusal is a hard stop, never a
// user-paid fallback. The agent stays alive — no revoke, remaining shares keep compounding.
import { rpcServer } from './client.js'
import { assertActiveOwner } from './activeAccount.js'
import {
  buildAgentAuthedInvoke as _buildAgentAuthedInvoke,
  readVaultShares as _readVaultShares,
  readTokenBalance as _readTokenBalance,
} from './agentDeposit.js'
import { readAgentScope as _readAgentScopeRaw } from './agentCache.js'
import { readPricePerShare as _readPricePerShare } from './vaultReads.js'
import {
  getRelayerAddress as _getRelayerAddress,
  submitViaRelay as _submitViaRelay,
} from './relay.js'
import {
  generateExitKey as _generateExitKey,
  loadManualExitKey as _loadExitKey,
  saveManualExitKey as _saveExitKey,
  registerExitSigner as _registerExitSigner,
} from '../wallet/exitKey.js'
import { SOROBAN_ACTIVE_VAULT_ADDRESS, SOROBAN_TOKEN_ADDRESS } from './config.js'

const PPS_SCALE = 10_000_000n // price_per_share 7-dp fixed point (matches positionsStore)
const EXIT_SIG_TAG = 1 // __check_auth: 65-byte [1]+sig routes to enforce_exit (account.rs)

let _sdk = null
async function sdk() {
  if (!_sdk) _sdk = await import('@stellar/stellar-sdk')
  return _sdk
}

/** Shares to redeem for `amountUnits` assets: ceil so the user gets ≥ requested, clamped to balance. */
export function sharesForAmount(amountUnits, pps, agentShares) {
  if (amountUnits <= 0n) throw new Error('Amount must be positive.')
  if (pps <= 0n) throw new Error('Bad price per share.')
  const needed = (amountUnits * PPS_SCALE + pps - 1n) / pps
  return needed > agentShares ? agentShares : needed
}

/** scope_of(agent) → { expiry, revoked } for the Partial-mode gate, null on read failure
 *  (gate open on null: the chain still enforces, this read is UX only). Delegates to
 *  agentCache's readAgentScope (raw scope_of() result) and narrows to the two fields this
 *  module's callers need. */
export async function readAgentScope(agentAddress, { server } = {}) {
  const scope = await _readAgentScopeRaw(agentAddress, { server })
  if (scope == null) return null
  return { expiry: BigInt(scope.expiry), revoked: Boolean(scope.revoked) }
}

/**
 * Load-or-register the exit signer for this agent. Registration = ONE owner authorization
 * (set_exit_signer, owner-gated), routed through OwnerAuthorizationV1 — a classic G owner signs
 * the envelope directly, a passkey C owner signs a Soroban auth entry sourced by a funded relayer
 * G (see wallet/exitKey.js's registerExitSigner). `activeAccount` defaults to a classic G owner,
 * so every existing caller is unaffected. Only persists the key AFTER on-chain success — a saved
 * key the chain never accepted would brick every later withdraw.
 *
 * The stored key itself is a MANUAL partial-exit key: load/save go through wallet/exitKey.js's v2
 * owner-scoped namespace (`vf.manualExitKey.v2|<network>|<owner>|<agent>`), never the legacy
 * agent-only cache — a browser account switch must not hand a different owner's flow a signer
 * keypair that was never theirs (Pocket Crew "My money" Task 9).
 */
export async function ensureExitSigner({
  owner,
  agentAddress,
  activeAccount = { kind: 'G', address: owner },
  getRelayerAddress,
  kit,
  deps = {},
}) {
  assertActiveOwner({ owner, activeAccount })
  const {
    loadExitKey = _loadExitKey,
    generateExitKey = _generateExitKey,
    saveExitKey = _saveExitKey,
    registerExitSigner = _registerExitSigner,
  } = deps
  const existing = await loadExitKey({ owner, agent: agentAddress })
  if (existing) return existing
  const key = await generateExitKey()
  const res = await registerExitSigner({
    owner,
    agentAddress,
    exitPublicKey: key.publicKey,
    activeAccount,
    getRelayerAddress,
    kit,
  })
  if (res?.status !== 'SUCCESS') {
    throw new Error(`Exit-signer registration was not confirmed: ${res?.status || 'no result'}.`)
  }
  saveExitKey({ owner, agent: agentAddress, publicKey: key.publicKey, secret: key.secret })
  return key
}

/** Poll getTransaction until it leaves NOT_FOUND/PENDING (relay may return before inclusion). */
async function defaultWaitForTx(hash, server, tries = 30, intervalMs = 2000) {
  for (let i = 0; i < tries; i++) {
    const r = await server.getTransaction(hash)
    if (r.status && r.status !== 'NOT_FOUND' && r.status !== 'PENDING') return r
    await new Promise((res) => setTimeout(res, intervalMs))
  }
  return { status: 'PENDING' }
}

/**
 * Withdraw `amountUnits` (7-dp base units) from ONE agent to `owner`. Requires the exit signer
 * to already be registered (call ensureExitSigner first — kept separate so the UI can label
 * the one wallet popup honestly).
 * @returns {Promise<{redeemed: bigint, redeemHash: string, transferHash: string}>}
 */
export async function partialWithdraw({
  owner,
  agentAddress,
  amountUnits,
  vault = SOROBAN_ACTIVE_VAULT_ADDRESS,
  token = SOROBAN_TOKEN_ADDRESS,
  server,
  activeAccount,
  deps = {},
}) {
  assertActiveOwner({ owner, activeAccount })
  const {
    getRelayerAddress = _getRelayerAddress,
    readVaultShares = _readVaultShares,
    readPricePerShare = _readPricePerShare,
    readTokenBalance = _readTokenBalance,
    loadExitKey = _loadExitKey,
    buildAgentAuthedInvoke = _buildAgentAuthedInvoke,
    submitViaRelay = _submitViaRelay,
    waitForTx = defaultWaitForTx,
  } = deps

  const relayer = await getRelayerAddress()
  if (!relayer) throw new Error('The gasless relay is unreachable — partial withdraw needs it.')

  const key = await loadExitKey({ owner, agent: agentAddress })
  if (!key) throw new Error('No exit key for this agent — run ensureExitSigner first.')
  const { Keypair } = await sdk()
  const kp = Keypair.fromSecret(key.secret)
  const signer = { sign: (payload) => kp.sign(Buffer.from(payload)) }

  const [shares, pps] = await Promise.all([
    readVaultShares(agentAddress, { vault, server }),
    readPricePerShare(vault, { server }),
  ])
  if (shares == null || pps == null) throw new Error('Could not read the agent position.')
  const maxUnits = (shares * pps) / PPS_SCALE
  if (amountUnits > maxUnits) {
    throw new Error(`Amount exceeds this agent's max withdrawable.`)
  }
  const redeemShares = sharesForAmount(amountUnits, pps, shares)

  // Leg 1: redeem shares → assets land IN the agent.
  const redeemTx = await buildAgentAuthedInvoke({
    contract: vault,
    method: 'redeem',
    args: [{ addr: agentAddress }, { i128: redeemShares }],
    agentAddress,
    signer,
    sigTag: EXIT_SIG_TAG,
    relayer,
    server,
  })
  const redeemRes = await submitViaRelay({ xdr: redeemTx.xdr })
  if (!redeemRes) throw new Error('The gasless relay is unreachable — partial withdraw needs it.')
  if (redeemRes.status !== 'SUCCESS' && redeemRes.status !== 'duplicate') {
    const s = server || (await rpcServer())
    const settled = await waitForTx(redeemRes.hash, s)
    if (settled.status !== 'SUCCESS') {
      throw new Error(`The redeem was not confirmed: ${settled.status}.`)
    }
  }

  // Leg 2: sweep the agent's ACTUAL token balance to the owner (dust-free; enforce_exit
  // pins `to == owner` on-chain). A failure here strands USDC in the agent — recoverable
  // (retry, or the full sweep) — so the error must say exactly that.
  const bal = await readTokenBalance(agentAddress, { token, server })
  if (bal == null || bal <= 0n) {
    throw new Error('Redeemed, but the agent shows no balance to transfer yet — retry in a moment.')
  }
  try {
    const transferTx = await buildAgentAuthedInvoke({
      contract: token,
      method: 'transfer',
      args: [{ addr: agentAddress }, { addr: owner }, { i128: bal }],
      agentAddress,
      signer,
      sigTag: EXIT_SIG_TAG,
      relayer,
      server,
    })
    const transferRes = await submitViaRelay({ xdr: transferTx.xdr })
    if (!transferRes) throw new Error('relay unreachable')
    if (transferRes.status !== 'SUCCESS' && transferRes.status !== 'duplicate') {
      const s = server || (await rpcServer())
      const settled = await waitForTx(transferRes.hash, s)
      if (settled.status !== 'SUCCESS') throw new Error(`not confirmed: ${settled.status}`)
    }
    return { redeemed: bal, redeemHash: redeemRes.hash, transferHash: transferRes.hash }
  } catch (e) {
    throw new Error(
      `Redeemed ${bal} units into the agent but the transfer to your wallet failed ` +
        `(${e?.message || e}). The funds are safe in the agent — retry, or use the full withdraw.`
    )
  }
}
