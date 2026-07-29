// Server-side Soroban gasless relay. Wraps an agent- or owner-authorized inner Soroban
// transaction in a fee-bump paid by the server's relayer keypair, submits via Soroban RPC, polls
// to a result.
//
// Security model (dumb fee sponsor): the relay does NOT authorize the action — the inner tx
// already carries whatever on-chain auth entry the caller needed (the agent custom account's
// __check_auth ed25519 entry for a deposit/pull/exit, or a passkey C owner's Soroban auth entry
// for a grant/revoke/exit/registration — see frontend/src/stellar/ownerAuthorization.js). The
// relay only pays the XLM fee. Abuse is bounded entirely by `assertRelayableTransaction` (Task 5)
// — a fail-closed, versioned allowlist of the EXACT operation shapes the client can produce:
// funding_router grant/pull, exit_router sweep, pinned-agent revoke/owner_withdraw/
// set_exit_signer, the SEP-41 revoke-approve, vault deposit/redeem, pinned-agent token transfer
// (F11 exit-leg-2 / partial-withdraw leg 2), CCTP deposit_for_burn, and the pinned smart-account
// deploy. Every other shape is rejected — deny by default. Router address(es) and agent wasm
// hash(es) are CSV env LISTS (SOROBAN_ROUTER_ADDRESSES / SOROBAN_AGENT_WASM_HASHES, each falling
// back to the single-value env) so v1 and v2/v3 contracts relay side by side during migration.
// The relayer SECRET is server-held (STELLAR_RELAYER_SECRET) — never in the client bundle.
//
// Actions:
//   { action: 'wallet' }            → { address }           (relayer pubkey — fund it)
//   { action: 'submit', xdr }       → { hash, status }      (fee-bump + submit + poll)

import { applyCors, rateLimit } from './_guard.js'
import { agentCapabilityFor, TRACKED_AGENT_WASM_HASHES } from './agentCapabilities.js'
import {
  assertOwnerWithdrawAuthorization,
  OwnerWithdrawAuthorizationError,
} from './stellar-relay-auth.js'

const PASSPHRASE = () =>
  process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015'
const RPC_URL = () => process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org'
const RELAYER_SECRET = () => process.env.STELLAR_RELAYER_SECRET || ''
const VAULT_ADDR = () => process.env.SOROBAN_VAULT_ADDRESS || ''
const TOKEN_ADDR = () => process.env.SOROBAN_TOKEN_ADDRESS || ''
// funding_router(s) for the single-signature grant flow — CSV list so v1 and v2 relay side by
// side during migration (SOROBAN_ROUTER_ADDRESSES), falling back to the single-value
// SOROBAN_ROUTER_ADDRESS. Empty list = router relaying disabled (fail closed).
const ROUTER_ADDRS = () =>
  parseAllowlist(process.env.SOROBAN_ROUTER_ADDRESSES || process.env.SOROBAN_ROUTER_ADDRESS)
// exit_router (owner_authorization.js's one-popup sweep) — single value, no CSV: unlike the
// router/agent-wasm migration lists there is only ever one live exit router. Unset = sweep
// relaying disabled (fail closed) — exit.js's per-agent owner_withdraw rollback path still works.
const EXIT_ROUTER_ADDR = () => process.env.SOROBAN_EXIT_ROUTER_ADDRESS || ''
const AGENT_ALLOWLIST = () => process.env.SOROBAN_AGENT_ALLOWLIST || ''
// Content-addressed pin of the OZ smart-account wasm SAK deploys (see wallet/config.js
// ACCOUNT_WASM_HASH — same inline-constant discipline). Env-overridable, never secret. Also the
// pin for a C owner's identity on the SEP-41 revoke-approve and exit-transfer recipient checks
// (assertRelayableTransaction) — the only wasm a VF passkey wallet can run.
const ACCOUNT_WASM_HASH = () =>
  process.env.SOROBAN_ACCOUNT_WASM_HASH ||
  'a12e8fa9621efd20315753bd4007d974390e31fbcb4a7ddc4dd0a0dec728bf2e'
// Content-addressed pin(s) of the agent_account wasm the funding_router deploys
// (deployments/stellar-testnet.json agentAccountWasmHash) — CSV list so v1 and v3 wasm both
// count as "pinned" during migration (SOROBAN_AGENT_WASM_HASHES), falling back to the
// single-value SOROBAN_AGENT_WASM_HASH, then this hardcoded v3 default. Never secret.
const AGENT_WASM_HASHES = () =>
  parseAllowlist(
    process.env.SOROBAN_AGENT_WASM_HASHES ||
      process.env.SOROBAN_AGENT_WASM_HASH ||
      TRACKED_AGENT_WASM_HASHES.join(',')
  )
// CCTP TokenMessengerMinter (testnet) — sponsors deposit_for_burn only when its `from` arg is a
// pinned agent_account (see assertRelayableTransaction). No hardcoded default: unset = messenger
// sponsorship dead, fail closed — never default-allow an arbitrary burn source.
const TOKEN_MESSENGER = () => process.env.SOROBAN_TOKEN_MESSENGER_ADDRESS || ''

// Fee-bump base fee = inner fee + this margin (stroops). 0.1 XLM is generous on testnet and
// safely clears the SDK's "fee-bump fee >= inner fee" floor for our single-op deposit txs.
const FEE_MARGIN = 1_000_000n

export class RelayError extends Error {}

// ─── warm-process replay guard, keyed by inner-tx hash (hex) ───
const _seen = new Map() // innerHash → { state:'in-flight'|'done', out?, at }
const SEEN_MAX = 5000
const SEEN_TTL_MS = 30 * 60_000
export function _clearSeen() {
  _seen.clear()
}
function pruneSeen(now) {
  for (const [k, v] of _seen) if (now - v.at > SEEN_TTL_MS) _seen.delete(k)
}

// Comma-separated allowlist string → trimmed, non-empty entries (matches _guard.js's
// allowedOrigins parsing convention).
function parseAllowlist(raw) {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Allowlist the inner tx the relay will sponsor. Replaces the single-branch `assertVaultDeposit`
 * (Task 4) with a fail-closed, versioned allowlist of every operation shape the client can
 * produce (frontend/src/stellar/ownerAuthorization.js's C-owner adapter + the pre-existing agent
 * session-key paths). DENY BY DEFAULT: any contract/function/argument combination not explicitly
 * matched below falls through to the final `throw` at the bottom.
 *
 * Allowed branches, in check order:
 *   1. vault `deposit` / `redeem`               — unchanged from Task 4 (any args; the vault and
 *      the calling agent's own on-chain scope bound abuse, not the relay).
 *   2. router `grant` / `pull`                   — schema-validated: grant's (owner:address,
 *      budgets:vec, expiry:u32, agents:vec) and pull's (agent:address, amount:i128) argument
 *      SHAPES must decode to the right native JS types. Business-rule depth (cap sizes, budget
 *      contents) is the router contract's job, not the relay's.
 *   3. exit_router `sweep`                        — (owner:address, agents:vec<address>,
 *      to:address); `to` MUST equal `owner` (sweeps only reach the owner itself) and EVERY agent
 *      in the vec must run a pinned agent_account wasm (no allowlist fallback — "pinned" only).
 *   4. CCTP messenger `deposit_for_burn`           — unchanged from Task 4 (from must be a pinned
 *      agent_account wasm; no allowlist fallback).
 *   5. token `transfer` (from tokenAddr)           — unchanged agent from-check (allowlist OR
 *      wasm pin, F11 exit-leg-2 / partial-withdraw leg 2), PLUS two new checks: the amount must
 *      be positive, and `to` must be owner-shaped — a G account, or a C account running the
 *      pinned VF smart-account wasm. An agent can no longer be sponsored moving funds to an
 *      arbitrary contract.
 *   6. token `approve` (from tokenAddr)            — the SEP-41 revoke path only: amount MUST be
 *      exactly zero (never a positive/arbitrary approval), `spender` must be a listed router, and
 *      `from` must run the pinned VF smart-account wasm (a C owner's revoke is the only approve
 *      that ever reaches the relay — see ownerAuthorization.js's classicSubmission:'direct' for
 *      G, which never touches the relay for revoke).
 *   7. pinned agent `revoke` / `owner_withdraw` / `set_exit_signer` — wasm-pinned only (no
 *      allowlist fallback), with a light argument-shape check per function.
 *   8. smart-account `createContractV2` deploy      — unchanged from Task 4 (SAK createWallet).
 *
 * "Pinned" (agentWasmHashes) vs "allowlisted-or-pinned" (agentAllowlist ∪ agentWasmHashes) are
 * deliberately different gates: SOROBAN_AGENT_ALLOWLIST is documented (and was only ever wired)
 * for F11 exit-leg-2 token transfers — branches 3 and 7 do not widen its meaning to "any agent
 * action", they check the wasm pin only.
 * @param {object} inner decoded inner Transaction (TransactionBuilder.fromXDR output)
 * @param {{sdk:object, vaultAddr?:string, tokenAddr?:string, routerAddrs?:string[],
 *          exitRouterAddr?:string, agentAllowlist?:string, accountWasmHash?:string,
 *          agentWasmHashes?:string[], messengerAddr?:string,
 *          getWasmHash?:(contractId:string)=>Promise<string|null>}} opts `sdk` needs
 *          `{ Address, scValToNative }`. `getWasmHash` is required alongside `agentWasmHashes`/
 *          `accountWasmHash` to use any wasm-pin branch (null = every pin-gated branch closed).
 * @returns {Promise<void>} resolves when the tx is relayable; throws RelayError otherwise.
 */
export async function assertRelayableTransaction(
  inner,
  {
    sdk,
    vaultAddr = '',
    tokenAddr = '',
    routerAddrs = [],
    exitRouterAddr = '',
    agentAllowlist = '',
    accountWasmHash = '',
    agentWasmHashes = [],
    messengerAddr = '',
    getWasmHash = null,
    networkPassphrase = '',
    expectedNetworkPassphrase = '',
    expectedRelayer = '',
    currentLedger = 0,
    readAgentScope = null,
  } = {}
) {
  const ops = inner.operations || []
  if (ops.length !== 1 || ops[0].type !== 'invokeHostFunction') {
    throw new RelayError('relay sponsors a single contract invocation only')
  }
  const hf = ops[0].func
  const kind = hf.switch().name

  if (kind === 'hostFunctionTypeCreateContractV2') {
    const exec = hf.createContractV2().executable()
    const isPinnedWasm =
      accountWasmHash &&
      exec.switch().name === 'contractExecutableWasm' &&
      exec.wasmHash().toString('hex') === accountWasmHash
    if (!isPinnedWasm) {
      throw new RelayError('relay sponsors smart-account deploys of the pinned wasm only')
    }
    return
  }
  if (kind !== 'hostFunctionTypeInvokeContract') {
    throw new RelayError('inner op is not a contract invocation')
  }
  const ic = hf.invokeContract()
  const contract = sdk.Address.fromScAddress(ic.contractAddress()).toString()
  const fnName = ic.functionName().toString()
  const native = ic.args().map((a) => sdk.scValToNative(a))

  // Wasm-pin-only agent check (SOROBAN_AGENT_WASM_HASHES), no allowlist fallback — used by the
  // sweep, messenger, and pinned-agent-action branches (see docstring on why the allowlist stays
  // scoped to token transfers only).
  const pinnedAgent = async (addrStr, relayOperation) => {
    if (!agentWasmHashes.length || !getWasmHash) return false
    let hash = null
    try {
      hash = await getWasmHash(addrStr)
    } catch {
      return false
    }
    if (!hash || !agentWasmHashes.includes(hash)) return null
    const capability = agentCapabilityFor(hash, relayOperation)
    return capability ? { hash, capability } : null
  }
  const isPinnedAgentWasm = async (addrStr, relayOperation) => {
    return Boolean(await pinnedAgent(addrStr, relayOperation))
  }
  // Allowlist OR wasm-pin — the F11 exit-leg-2 token-transfer gate, unchanged from Task 4.
  const isAllowlistedOrPinnedAgent = async (addrStr) => {
    if (parseAllowlist(agentAllowlist).includes(addrStr)) return true
    return isPinnedAgentWasm(addrStr, 'token_transfer')
  }
  // Owner-shaped recipient: a classic G account, or a C account running the pinned VF
  // smart-account wasm. No RPC needed for the (common) G case.
  const isOwnerShaped = async (addrStr) => {
    if (typeof addrStr === 'string' && addrStr.startsWith('G')) return true
    if (!accountWasmHash || !getWasmHash) return false
    let hash = null
    try {
      hash = await getWasmHash(addrStr)
    } catch {
      return false
    }
    return hash === accountWasmHash
  }

  // 1. Vault deposit/redeem — unchanged (F11 exit leg 1 + the mainline agent deposit).
  if (vaultAddr && contract === vaultAddr) {
    if (fnName !== 'deposit' && fnName !== 'redeem') {
      throw new RelayError('inner tx is not a vault deposit/redeem')
    }
    return
  }

  // 2. funding_router grant/pull — schema-validated arguments.
  if (routerAddrs.length && routerAddrs.includes(contract)) {
    if (fnName === 'grant') {
      const ok =
        native.length === 4 &&
        typeof native[0] === 'string' &&
        Array.isArray(native[1]) &&
        typeof native[2] === 'number' &&
        Array.isArray(native[3])
      if (!ok) throw new RelayError('router.grant: argument schema mismatch')
      return
    }
    if (fnName === 'pull') {
      const ok =
        native.length === 2 && typeof native[0] === 'string' && typeof native[1] === 'bigint'
      if (!ok) throw new RelayError('router.pull: argument schema mismatch')
      return
    }
    throw new RelayError('inner tx is not a router grant/pull')
  }

  // 3. exit_router sweep — to MUST equal owner; every agent MUST be wasm-pinned.
  if (exitRouterAddr && contract === exitRouterAddr) {
    if (fnName !== 'sweep') throw new RelayError('exit router: only sweep is relayable')
    const ok =
      native.length === 3 &&
      typeof native[0] === 'string' &&
      Array.isArray(native[1]) &&
      native[1].length > 0 &&
      typeof native[2] === 'string'
    if (!ok) throw new RelayError('exit router sweep: argument schema mismatch')
    const [owner, agents, to] = native
    if (to !== owner) throw new RelayError('exit router sweep: to must equal owner')
    for (const agent of agents) {
      if (!(await isPinnedAgentWasm(agent, 'exit_router_sweep'))) {
        throw new RelayError('exit router sweep: every agent must run a pinned wasm')
      }
    }
    return
  }

  // 4. CCTP messenger deposit_for_burn — unchanged (wasm-pin only, no allowlist).
  if (messengerAddr && contract === messengerAddr) {
    if (fnName !== 'deposit_for_burn') {
      throw new RelayError('messenger: only deposit_for_burn is relayable')
    }
    if (!(await isPinnedAgentWasm(native[0], 'cctp_burn'))) {
      throw new RelayError('messenger: from is not a pinned agent')
    }
    return
  }

  // 5/6. Token contract: transfer (F11 exit-leg-2 / partial-withdraw leg 2) or the SEP-41
  // revoke-approve.
  if (tokenAddr && contract === tokenAddr) {
    if (fnName === 'transfer') {
      const ok =
        native.length === 3 &&
        typeof native[0] === 'string' &&
        typeof native[1] === 'string' &&
        typeof native[2] === 'bigint'
      if (!ok) throw new RelayError('token transfer: argument schema mismatch')
      const [from, to, amount] = native
      if (amount <= 0n) throw new RelayError('token transfer: amount must be positive')
      if (!(await isAllowlistedOrPinnedAgent(from))) {
        throw new RelayError('relay sponsors allowlisted agent-account transfers only')
      }
      if (!(await isOwnerShaped(to))) {
        throw new RelayError('token transfer: recipient must be the agent owner')
      }
      return
    }
    if (fnName === 'approve') {
      const ok =
        native.length === 4 &&
        typeof native[0] === 'string' &&
        typeof native[1] === 'string' &&
        typeof native[2] === 'bigint' &&
        typeof native[3] === 'number'
      if (!ok) throw new RelayError('token approve: argument schema mismatch')
      const [from, spender, amount] = native
      if (amount !== 0n) {
        throw new RelayError('relay sponsors a zero-amount (revoke) approval only')
      }
      if (!routerAddrs.includes(spender)) {
        throw new RelayError('token approve: spender must be an allowed router')
      }
      if (!accountWasmHash || !getWasmHash) {
        throw new RelayError('token approve: no smart-account wasm pin configured')
      }
      let hash = null
      try {
        hash = await getWasmHash(from)
      } catch {
        throw new RelayError('token approve: wasm lookup failed')
      }
      if (hash !== accountWasmHash) {
        throw new RelayError('token approve: from is not the pinned smart-account wasm')
      }
      return
    }
    throw new RelayError('inner tx is not an allowlisted token call')
  }

  // 7. Pinned agent_account: revoke / owner_withdraw / set_exit_signer.
  const agentIdentity = await pinnedAgent(contract)
  if (agentIdentity) {
    if (fnName === 'revoke') {
      if (native.length !== 0) throw new RelayError('agent revoke: unexpected arguments')
      if (!agentCapabilityFor(agentIdentity.hash, 'revoke')) {
        throw new RelayError('agent revoke: wasm capability is not proven')
      }
      return
    }
    if (fnName === 'owner_withdraw') {
      if (native.length !== 1 || typeof native[0] !== 'string') {
        throw new RelayError('agent owner_withdraw: argument schema mismatch')
      }
      try {
        await assertOwnerWithdrawAuthorization({
          transaction: inner,
          networkPassphrase,
          expectedNetworkPassphrase,
          expectedAgent: contract,
          expectedRelayer,
          expectedToken: tokenAddr,
          expectedVault: vaultAddr,
          wasmHash: agentIdentity.hash,
          currentLedger,
          readScope: readAgentScope,
        })
      } catch (error) {
        if (error instanceof OwnerWithdrawAuthorizationError) {
          throw new RelayError(error.message)
        }
        throw error
      }
      return
    }
    if (fnName === 'set_exit_signer') {
      const key = native[0]
      const isBytes32 = key && typeof key.length === 'number' && key.length === 32
      if (native.length !== 1 || !isBytes32) {
        throw new RelayError('agent set_exit_signer: argument schema mismatch')
      }
      if (!agentCapabilityFor(agentIdentity.hash, 'set_exit_signer')) {
        throw new RelayError('agent set_exit_signer: wasm capability is not proven')
      }
      return
    }
    throw new RelayError('pinned agent: function not relayable')
  }

  throw new RelayError('inner tx does not target an allowlisted contract')
}

/** Poll getTransaction until it leaves NOT_FOUND, or the budget is spent. */
async function pollResult(rpcServer, hash, tries, intervalMs) {
  for (let i = 0; i < tries; i++) {
    const r = await rpcServer.getTransaction(hash)
    if (r.status && r.status !== 'NOT_FOUND') return r
    if (intervalMs) await new Promise((res) => setTimeout(res, intervalMs))
  }
  return { status: 'PENDING' } // submitted but not yet observed — client may keep polling
}

/**
 * Fee-bump an already-authorized inner Soroban tx and submit it. Pays the fee from `secret`.
 * @param {object} p
 * @param {string} p.xdr            base64 inner-tx envelope (already auth-signed)
 * @param {string} p.secret         relayer S... secret
 * @param {string} p.passphrase     network passphrase
 * @param {string} p.vaultAddr      allowlisted deposit target ('' = skip the guard)
 * @param {string} p.agentAllowlist comma-separated agent accounts allowed as transfer 'from'
 * @param {string[]} p.routerAddrs  funding_router(s) allowed for grant/pull ([] = router disabled)
 * @param {string} p.exitRouterAddr exit_router allowed for sweep ('' = sweep relaying disabled)
 * @param {string[]} p.agentWasmHashes pinned agent_account wasm hashes (hex) — dynamic-agent
 *                                  transfer fallback, sweep/messenger/agent-action gate, AND the
 *                                  only gate on messenger deposit_for_burn ([] = all disabled)
 * @param {Function} p.getWasmHash  async (contractId) => wasmHashHex|null — required alongside
 *                                  agentWasmHashes/accountWasmHash to use any wasm-pin branch
 * @param {string} p.messengerAddr  CCTP TokenMessengerMinter allowed for deposit_for_burn
 *                                  ('' = messenger sponsorship disabled)
 * @param {object} p.sdk            { TransactionBuilder, FeeBumpTransaction, Keypair, Address,
 *                                    scValToNative }
 * @param {object} p.rpcServer      { sendTransaction, getTransaction }
 * @returns {Promise<{ hash, status, relayer }>}
 */
export async function feeBumpAndSubmit({
  xdr,
  secret,
  passphrase,
  vaultAddr,
  tokenAddr = '',
  agentAllowlist = '',
  accountWasmHash = '',
  routerAddrs = [],
  exitRouterAddr = '',
  agentWasmHashes = [],
  getWasmHash = null,
  messengerAddr = '',
  currentLedger,
  readAgentScope = null,
  sdk,
  rpcServer,
  pollTries = 10,
  pollIntervalMs = 2000,
}) {
  const { TransactionBuilder, FeeBumpTransaction, Keypair } = sdk

  const inner = TransactionBuilder.fromXDR(xdr, passphrase)
  if (inner instanceof FeeBumpTransaction) {
    throw new RelayError('inner tx is already fee-bumped')
  }
  const kp = Keypair.fromSecret(secret)
  let latestLedger = currentLedger
  if (latestLedger == null && typeof rpcServer.getLatestLedger === 'function') {
    const latest = await rpcServer.getLatestLedger()
    latestLedger = latest?.sequence ?? latest?.seq ?? 0
  }
  await assertRelayableTransaction(inner, {
    sdk,
    vaultAddr,
    tokenAddr,
    routerAddrs,
    exitRouterAddr,
    agentAllowlist,
    accountWasmHash,
    agentWasmHashes,
    messengerAddr,
    getWasmHash,
    networkPassphrase: passphrase,
    expectedNetworkPassphrase: passphrase,
    expectedRelayer: kp.publicKey(),
    currentLedger: latestLedger ?? 0,
    readAgentScope,
  })

  // Replay short-circuit (don't pay to re-broadcast a spent inner tx).
  const innerHash = inner.hash().toString('hex')
  const now = Date.now()
  if (_seen.size > SEEN_MAX) pruneSeen(now)
  const prev = _seen.get(innerHash)
  if (prev) {
    if (prev.state === 'done') return { ...prev.out, status: 'duplicate' }
    throw new RelayError('inner tx already in flight')
  }
  _seen.set(innerHash, { state: 'in-flight', at: now })

  try {
    // Agent-deposit / owner-C-auth path: the inner tx's source IS the relayer (the client cannot
    // sign as the relayer), so the relay signs the inner envelope here. This is tx-level
    // source/sequence auth only — the action itself is authorized by whichever Soroban auth entry
    // (or, for a G owner, the tx's own source-account credentials) the client already attached;
    // assertRelayableTransaction already bounds what the relayer will sponsor. When the inner
    // source differs (a separate funded source, e.g. the relay smoke), the client already signed
    // it — leave it untouched.
    if (inner.source === kp.publicKey()) inner.sign(kp)
    if (typeof rpcServer.simulateTransaction !== 'function') {
      throw new RelayError('RPC enforcing simulation is unavailable')
    }
    const simulation = await rpcServer.simulateTransaction(inner)
    if (!simulation || simulation.error || simulation.result?.error) {
      throw new RelayError('RPC enforcing simulation rejected the signed transaction')
    }
    const baseFee = (BigInt(inner.fee) + FEE_MARGIN).toString()
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(kp, baseFee, inner, passphrase)
    feeBump.sign(kp)

    const send = await rpcServer.sendTransaction(feeBump)
    if (send.status === 'ERROR') {
      throw new RelayError('RPC rejected the fee-bump submission')
    }
    const result = await pollResult(rpcServer, send.hash, pollTries, pollIntervalMs)
    const out = { hash: send.hash, status: result.status, relayer: kp.publicKey() }
    _seen.set(innerHash, { state: 'done', out, at: Date.now() })
    return out
  } catch (e) {
    _seen.delete(innerHash) // failed submit → allow a genuine retry of this inner tx
    throw e
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function bad(res, msg) {
  res.statusCode = 400
  return res.end(JSON.stringify({ error: msg }))
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405
    return res.end(JSON.stringify({ error: 'Method not allowed' }))
  }
  if (!applyCors(req, res)) return
  if (!rateLimit(req, res, { max: 15, windowMs: 60_000, bucket: 'stellar-relay' })) return
  res.setHeader('Content-Type', 'application/json')

  const secret = RELAYER_SECRET()
  if (!secret) {
    res.statusCode = 503
    return res.end(JSON.stringify({ error: 'Stellar relay not configured', configured: false }))
  }

  try {
    const body = await readBody(req)
    // Dynamic import so a missing package never breaks the vite.config load.
    const mod = await import('@stellar/stellar-sdk')
    const sdk = {
      TransactionBuilder: mod.TransactionBuilder,
      FeeBumpTransaction: mod.FeeBumpTransaction,
      Keypair: mod.Keypair,
      Address: mod.Address,
      scValToNative: mod.scValToNative,
    }

    if (body.action === 'wallet') {
      return res.end(JSON.stringify({ address: mod.Keypair.fromSecret(secret).publicKey() }))
    }

    // SAK's RelayerClient.sendXdr (kit.createWallet autoSubmit) posts a bare { xdr } with no
    // action field — treat it as a submit. The guard inside feeBumpAndSubmit still applies:
    // only an allowlisted operation shape gets sponsored (assertRelayableTransaction).
    if (body.action === 'submit' || (!body.action && typeof body.xdr === 'string')) {
      if (typeof body.xdr !== 'string' || !body.xdr) return bad(res, 'Invalid xdr')
      const rpcServer = new mod.rpc.Server(RPC_URL())
      // Contract-instance ledger read: instance → executable → wasm hash (hex), null for SACs.
      const getWasmHash = async (contractId) => {
        const entry = await rpcServer.getContractData(
          contractId,
          mod.xdr.ScVal.scvLedgerKeyContractInstance(),
          mod.rpc.Durability.Persistent
        )
        const exec = entry.val.contractData().val().instance().executable()
        if (exec.switch().name !== 'contractExecutableWasm') return null
        return exec.wasmHash().toString('hex')
      }
      const readAgentScope = async (contractId) => {
        const source = await rpcServer.getAccount(mod.Keypair.fromSecret(secret).publicKey())
        const tx = new mod.TransactionBuilder(source, {
          fee: mod.BASE_FEE,
          networkPassphrase: PASSPHRASE(),
        })
          .addOperation(new mod.Contract(contractId).call('scope_of'))
          .setTimeout(30)
          .build()
        const simulation = await rpcServer.simulateTransaction(tx)
        if (mod.rpc.Api.isSimulationError(simulation) || !simulation.result?.retval) {
          throw new RelayError('agent scope_of simulation failed')
        }
        return mod.scValToNative(simulation.result.retval)
      }
      try {
        const out = await feeBumpAndSubmit({
          xdr: body.xdr,
          secret,
          passphrase: PASSPHRASE(),
          vaultAddr: VAULT_ADDR(),
          tokenAddr: TOKEN_ADDR(),
          agentAllowlist: AGENT_ALLOWLIST(),
          accountWasmHash: ACCOUNT_WASM_HASH(),
          routerAddrs: ROUTER_ADDRS(),
          exitRouterAddr: EXIT_ROUTER_ADDR(),
          agentWasmHashes: AGENT_WASM_HASHES(),
          getWasmHash,
          readAgentScope,
          messengerAddr: TOKEN_MESSENGER(),
          sdk,
          rpcServer,
        })
        return res.end(JSON.stringify(out))
      } catch (e) {
        if (e instanceof RelayError && /in flight/.test(e.message)) {
          res.statusCode = 409
          return res.end(JSON.stringify({ error: e.message }))
        }
        throw e
      }
    }

    return bad(res, 'Unknown action')
  } catch (err) {
    const errMsg = err?.message || String(err)
    console.error('[api/stellar-relay] error:', errMsg)
    res.statusCode = 502
    return res.end(JSON.stringify({ error: `Stellar relay failed: ${errMsg}` }))
  }
}
