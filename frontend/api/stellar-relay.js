// Server-side Soroban gasless relay. Wraps an agent-signed inner Soroban transaction in a
// fee-bump paid by the server's relayer keypair, submits via Soroban RPC, polls to a result.
//
// Security model (dumb fee sponsor): the relay does NOT authorize the deposit — the inner tx
// already carries the agent custom account's __check_auth ed25519 auth entry, signed client-side
// by the agent session key. The relay only pays the XLM fee. Abuse is bounded by: origin
// allowlist + per-IP rate limit (_guard.js) AND the vault-target allowlist (assertVaultDeposit,
// Task 4) — including the SOROBAN_AGENT_ALLOWLIST exact-match check AND, for dynamic per-run
// agents that can't live in a static allowlist, a fail-closed pinned-wasm-hash fallback
// (SOROBAN_AGENT_WASM_HASH, Task 3) — on F11 exit-leg-2 token transfers — so the relayer never
// sponsors an unrelated transaction. Router address(es) and agent wasm hash(es) are CSV env
// LISTS (SOROBAN_ROUTER_ADDRESSES / SOROBAN_AGENT_WASM_HASHES, each falling back to the
// single-value env) so v1 and v2/v3 contracts relay side by side during migration; the same
// wasm-hash list is the sole gate on sponsoring deposit_for_burn on the CCTP TokenMessengerMinter
// (SOROBAN_TOKEN_MESSENGER_ADDRESS — unset = that branch dead, fail closed). The relayer SECRET
// is server-held (STELLAR_RELAYER_SECRET) — never in the client bundle.
//
// Actions:
//   { action: 'wallet' }            → { address }           (relayer pubkey — fund it)
//   { action: 'submit', xdr }       → { hash, status }      (fee-bump + submit + poll)

import { applyCors, rateLimit } from './_guard.js'

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
const AGENT_ALLOWLIST = () => process.env.SOROBAN_AGENT_ALLOWLIST || ''
// Content-addressed pin of the OZ smart-account wasm SAK deploys (see wallet/config.js
// ACCOUNT_WASM_HASH — same inline-constant discipline). Env-overridable, never secret.
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
      'd61ceaaaf5a3fd9fd25987eba0f843ccb79880f3eaa137e066b5f63ab9eaa2ba'
  )
// CCTP TokenMessengerMinter (testnet) — sponsors deposit_for_burn only when its `from` arg is a
// pinned agent_account (see assertVaultDeposit). No hardcoded default: unset = messenger
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
 * Allowlist the inner tx the relay will sponsor: a single InvokeHostFunction calling
 * `vaultAddr`.deposit, `vaultAddr`.redeem (F11 exit leg 1), or — when tokenAddr is set —
 * `tokenAddr`.transfer whose `from` is an EXACT match in `agentAllowlist` (F11 exit leg 2:
 * the agent custom account's own __check_auth still gates the transfer to `to == scope.owner`
 * on-chain; this server-side check stops the relayer sponsoring transfers for any contract
 * account outside the allowlist — an attacker's always-auth custom account no longer gets
 * free fee sponsorship just by starting with 'C'). FAIL CLOSED: tokenAddr set but
 * agentAllowlist empty/unset rejects every transfer (deposit/redeem branches unaffected).
 * No-op when vaultAddr is falsy. Throws RelayError on mismatch.
 *
 * When a transfer's `from` misses the static `agentAllowlist` (dynamic per-run agents, e.g.
 * partial withdraw, can't live in an env var), `agentWasmHash` + `getWasmHash` give a second,
 * narrower path: sponsor iff the from-contract RUNS the pinned agent_account wasm (Task 3). FAIL
 * CLOSED: no pin, no lookup fn, a lookup error, or a hash mismatch all reject — this only ever
 * ADDS an allow, never widens any other branch.
 *
 * When `accountWasmHash` is set, ALSO sponsors a single createContractV2 deploy whose wasm
 * executable is EXACTLY that hash — SAK's `kit.createWallet(autoSubmit)` posts the passkey
 * smart-account deploy tx here (bare `{xdr}`, no action). The content-address pin means the
 * relayer only ever pays to deploy the audited OZ smart-account wasm, never attacker code.
 * FAIL CLOSED: no pin (default '') → every deploy rejected; V1 createContract and non-wasm
 * executables (SAC) rejected unconditionally.
 *
 * When `routerAddrs` is non-empty (SOROBAN_ROUTER_ADDRESSES/SOROBAN_ROUTER_ADDRESS — the
 * funding_router(s) of the single-signature grant flow, v1 and v2 relaying side by side during
 * migration), ALSO sponsors `.grant` / `.pull` on ANY listed router — nothing else on those
 * contracts. FAIL CLOSED: empty list → every router call rejected, byte-identical to the
 * pre-router guard.
 *
 * When `messengerAddr` is set (SOROBAN_TOKEN_MESSENGER_ADDRESS — the CCTP TokenMessengerMinter),
 * ALSO sponsors `messengerAddr`.deposit_for_burn, but ONLY when its `from` arg (args[0], same
 * address-decode as the token.transfer branch) is a contract whose wasm hash is in
 * `agentWasmHashes` — an agent burning ITS OWN funds, never an arbitrary caller. FAIL CLOSED:
 * messengerAddr unset (default '') → branch dead; any other function on the messenger, a wasm
 * lookup miss, or a hash outside the list all reject.
 */
export async function assertVaultDeposit(
  inner,
  vaultAddr,
  sdk,
  tokenAddr = '',
  agentAllowlist = '',
  accountWasmHash = '',
  routerAddrs = [],
  agentWasmHashes = [],
  getWasmHash = null,
  messengerAddr = ''
) {
  if (!vaultAddr) return
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
  if (contract === vaultAddr) {
    if (fnName !== 'deposit' && fnName !== 'redeem') {
      throw new RelayError('inner tx is not a vault deposit/redeem')
    }
    return
  }
  if (routerAddrs.length && routerAddrs.includes(contract)) {
    if (fnName !== 'grant' && fnName !== 'pull') {
      throw new RelayError('inner tx is not a router grant/pull')
    }
    return
  }
  if (messengerAddr && contract === messengerAddr) {
    if (fnName !== 'deposit_for_burn') {
      throw new RelayError('messenger: only deposit_for_burn is relayable')
    }
    const from = sdk.Address.fromScVal(ic.args()[0]).toString()
    if (!getWasmHash) throw new RelayError('messenger: wasm lookup unavailable')
    let hash = null
    try {
      hash = await getWasmHash(from)
    } catch {
      throw new RelayError('messenger: agent wasm lookup failed')
    }
    if (!hash || !agentWasmHashes.includes(hash)) {
      throw new RelayError('messenger: from is not a pinned agent')
    }
    return
  }
  if (tokenAddr && contract === tokenAddr && fnName === 'transfer') {
    const from = sdk.Address.fromScVal(ic.args()[0]).toString()
    if (parseAllowlist(agentAllowlist).includes(from)) return
    // Dynamic per-run agents can't live in a static env allowlist. Fallback: sponsor iff the
    // from-contract RUNS a pinned agent_account wasm — its own __check_auth then pins the
    // destination to scope.owner on-chain, so the worst case is an attacker deploying our wasm
    // to get free gas moving THEIR funds to THEIR owner (griefing, bounded by the rate limit).
    // FAIL CLOSED: no pins, no lookup fn, lookup error, or hash outside the list → reject.
    if (agentWasmHashes.length && getWasmHash) {
      let hash = null
      try {
        hash = await getWasmHash(from)
      } catch {
        throw new RelayError('agent wasm lookup failed')
      }
      if (agentWasmHashes.includes(hash)) return
    }
    throw new RelayError('relay sponsors allowlisted agent-account transfers only')
  }
  throw new RelayError('inner tx does not target the vault')
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
 * Fee-bump an agent-signed inner Soroban tx and submit it. Pays the fee from `secret`.
 * @param {object} p
 * @param {string} p.xdr            base64 inner-tx envelope (agent-auth signed)
 * @param {string} p.secret         relayer S... secret
 * @param {string} p.passphrase     network passphrase
 * @param {string} p.vaultAddr      allowlisted deposit target ('' = skip the guard)
 * @param {string} p.agentAllowlist comma-separated agent accounts allowed as transfer 'from'
 * @param {string[]} p.routerAddrs  funding_router(s) allowed for grant/pull ([] = router disabled)
 * @param {string[]} p.agentWasmHashes pinned agent_account wasm hashes (hex) — dynamic-agent
 *                                  transfer fallback when 'from' misses agentAllowlist, AND the
 *                                  only gate on messenger deposit_for_burn ([] = both disabled)
 * @param {Function} p.getWasmHash  async (contractId) => wasmHashHex|null — required alongside
 *                                  agentWasmHashes to use either fallback (null = disabled)
 * @param {string} p.messengerAddr  CCTP TokenMessengerMinter allowed for deposit_for_burn
 *                                  ('' = messenger sponsorship disabled)
 * @param {object} p.sdk            { TransactionBuilder, FeeBumpTransaction, Keypair, Address }
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
  agentWasmHashes = [],
  getWasmHash = null,
  messengerAddr = '',
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
  await assertVaultDeposit(
    inner,
    vaultAddr,
    sdk,
    tokenAddr,
    agentAllowlist,
    accountWasmHash,
    routerAddrs,
    agentWasmHashes,
    getWasmHash,
    messengerAddr
  )

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
    const kp = Keypair.fromSecret(secret)
    // Agent-deposit path: the inner tx's source IS the relayer (the client cannot sign as the
    // relayer), so the relay signs the inner envelope here. This is tx-level source/sequence auth
    // only — the deposit itself is still authorized by the agent custom account's __check_auth
    // Soroban auth entry (session-key signed, client-side), and the vault.deposit allowlist
    // already bounds what the relayer will sponsor. When the inner source differs (a separate
    // funded source, e.g. the relay smoke), the client already signed it — leave it untouched.
    if (inner.source === kp.publicKey()) inner.sign(kp)
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
    }

    if (body.action === 'wallet') {
      return res.end(JSON.stringify({ address: mod.Keypair.fromSecret(secret).publicKey() }))
    }

    // SAK's RelayerClient.sendXdr (kit.createWallet autoSubmit) posts a bare { xdr } with no
    // action field — treat it as a submit. The guard inside feeBumpAndSubmit still applies:
    // only the pinned smart-account deploy or the vault/token allowlist gets sponsored.
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
          agentWasmHashes: AGENT_WASM_HASHES(),
          getWasmHash,
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
