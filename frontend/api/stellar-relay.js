// Server-side Soroban gasless relay. Wraps an agent-signed inner Soroban transaction in a
// fee-bump paid by the server's relayer keypair, submits via Soroban RPC, polls to a result.
//
// Security model (dumb fee sponsor): the relay does NOT authorize the deposit — the inner tx
// already carries the agent custom account's __check_auth ed25519 auth entry, signed client-side
// by the agent session key. The relay only pays the XLM fee. Abuse is bounded by: origin
// allowlist + per-IP rate limit (_guard.js) AND the vault-target allowlist (assertVaultDeposit,
// Task 4) so the relayer never sponsors an unrelated transaction. The relayer SECRET is
// server-held (STELLAR_RELAYER_SECRET) — never in the client bundle.
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

/**
 * Allowlist the inner tx the relay will sponsor: a single InvokeHostFunction calling
 * `vaultAddr`.deposit, `vaultAddr`.redeem (F11 exit leg 1), or — when tokenAddr is set —
 * `tokenAddr`.transfer whose `from` is a contract address (F11 exit leg 2: the agent custom
 * account's own __check_auth still gates the transfer to `to == scope.owner` on-chain; this
 * server-side check only stops the relayer sponsoring arbitrary G-account token moves).
 * No-op when vaultAddr is falsy. Throws RelayError on mismatch.
 */
export function assertVaultDeposit(inner, vaultAddr, sdk, tokenAddr = '') {
  if (!vaultAddr) return
  const ops = inner.operations || []
  if (ops.length !== 1 || ops[0].type !== 'invokeHostFunction') {
    throw new RelayError('relay sponsors a single contract invocation only')
  }
  const hf = ops[0].func
  if (hf.switch().name !== 'hostFunctionTypeInvokeContract') {
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
  if (tokenAddr && contract === tokenAddr && fnName === 'transfer') {
    const from = sdk.Address.fromScVal(ic.args()[0]).toString()
    if (!from.startsWith('C')) {
      throw new RelayError('relay sponsors agent-account transfers only')
    }
    return
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
  assertVaultDeposit(inner, vaultAddr, sdk, tokenAddr)

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

    if (body.action === 'submit') {
      if (typeof body.xdr !== 'string' || !body.xdr) return bad(res, 'Invalid xdr')
      const rpcServer = new mod.rpc.Server(RPC_URL())
      try {
        const out = await feeBumpAndSubmit({
          xdr: body.xdr,
          secret,
          passphrase: PASSPHRASE(),
          vaultAddr: VAULT_ADDR(),
          tokenAddr: TOKEN_ADDR(),
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
    console.error('[api/stellar-relay] error:', err?.message || err)
    res.statusCode = 502
    return res.end(JSON.stringify({ error: 'Stellar relay failed' }))
  }
}
