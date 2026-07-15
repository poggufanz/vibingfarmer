// Server-side testnet token faucet. Dispenses a CAPPED amount of the demo SAC token
// (Blend USDC) from a funded VF treasury (VF_FAUCET_SECRET) to a target C-address, so a
// fresh passkey smart account can approve + deposit. The treasury secret is server-held —
// never in the client bundle. Abuse-bounded: origin allowlist + tight per-IP rate limit
// (_guard.js) + a hard server-side amount cap. Testnet only — a mainnet build drops this.
//
//   { action: 'dispense', to: '<C-address>', amount? } → { hash, status }

import { applyCors, rateLimit } from './_guard.js'

const PASSPHRASE = () =>
  process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015'
const RPC_URL = () => process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org'
const FAUCET_SECRET = () => process.env.VF_FAUCET_SECRET || ''
const TOKEN_ADDR = () => process.env.SOROBAN_TOKEN_ADDRESS || ''

// 7-decimal token (SOROBAN_DECIMALS = 7). Cap a single dispense at 100 tokens.
export const CAP_BASE_UNITS = 100n * 10n ** 7n
const DEFAULT_BASE_UNITS = 10n * 10n ** 7n // 10 tokens default

// Daily caps on top of the per-IP rate limit (_guard). Keyed by recipient + a global ceiling.
export const PER_RECIPIENT_DAILY_CAP = 300n * 10n ** 7n // 300 tokens / address / 24h
export const GLOBAL_DAILY_CAP = 5_000n * 10n ** 7n // 5000 tokens / 24h total
const DAY_MS = 24 * 60 * 60 * 1000

// ponytail: in-memory accounting, resets on serverless cold start — a best-effort abuse bound,
// not a hard guarantee. Move to KV / Durable Object if cold-start reset becomes exploitable.
const _spent = new Map() // recipient -> { total: bigint, windowStart: number }
let _globalTotal = 0n
let _globalWindowStart = 0

/** Effective dispensed amount: clamp to [_, CAP_BASE_UNITS], default when unset/non-positive. */
export function effectiveAmount(amount) {
  return amount && BigInt(amount) > 0n
    ? BigInt(amount) > CAP_BASE_UNITS
      ? CAP_BASE_UNITS
      : BigInt(amount)
    : DEFAULT_BASE_UNITS
}

/** Reserve `amount` for `to` against daily caps. Returns false (and records nothing) if exceeded. */
export function reserveDaily(to, amount, now = Date.now()) {
  if (now - _globalWindowStart > DAY_MS) {
    _globalWindowStart = now
    _globalTotal = 0n
  }
  const rec = _spent.get(to)
  const valid = rec && now - rec.windowStart <= DAY_MS
  const prior = valid ? rec.total : 0n
  if (prior + amount > PER_RECIPIENT_DAILY_CAP) return false
  if (_globalTotal + amount > GLOBAL_DAILY_CAP) return false
  _spent.set(to, { total: prior + amount, windowStart: valid ? rec.windowStart : now })
  _globalTotal += amount
  return true
}

export class FaucetError extends Error {}

/**
 * transfer(from=treasury, to, amount) of the SAC token; treasury (secret) signs the source.
 * @returns {Promise<{ hash, status }>}
 */
export async function dispenseToken({
  secret,
  token,
  to,
  amount,
  passphrase,
  sdk,
  rpcServer,
  pollTries = 10,
  pollIntervalMs = 1500,
}) {
  const { Keypair, TransactionBuilder, Contract, Address, xdr, BASE_FEE, rpc } = sdk
  const capped = effectiveAmount(amount)
  const kp = Keypair.fromSecret(secret)
  const source = await rpcServer.getAccount(kp.publicKey())
  const op = new Contract(token).call(
    'transfer',
    Address.fromString(kp.publicKey()).toScVal(),
    Address.fromString(to).toScVal(),
    xdr.ScVal.scvI128(
      new xdr.Int128Parts({
        hi: xdr.Int64.fromString('0'),
        lo: xdr.Uint64.fromString(capped.toString()),
      })
    )
  )
  const raw = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(op)
    .setTimeout(60)
    .build()
  const sim = await rpcServer.simulateTransaction(raw)
  if (rpc.Api.isSimulationError(sim)) throw new FaucetError(`faucet sim failed: ${sim.error}`)
  const prepared = rpc.assembleTransaction(raw, sim).build()
  prepared.sign(kp)
  const sent = await rpcServer.sendTransaction(prepared)
  if (sent.status === 'ERROR') throw new FaucetError('RPC rejected the faucet transfer')
  for (let i = 0; i < pollTries; i++) {
    const r = await rpcServer.getTransaction(sent.hash)
    if (r.status && r.status !== 'NOT_FOUND') return { hash: sent.hash, status: r.status }
    if (pollIntervalMs) await new Promise((res) => setTimeout(res, pollIntervalMs))
  }
  return { hash: sent.hash, status: 'PENDING' }
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
function tooMany(res, msg) {
  res.statusCode = 429
  return res.end(JSON.stringify({ error: msg }))
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405
    return res.end(JSON.stringify({ error: 'Method not allowed' }))
  }
  if (!applyCors(req, res)) return
  // max 10/min: an in-wallet "get 300 USDC" top-up is 3 back-to-back 100-cap dispenses; the
  // real abuse bound stays the per-recipient (300) + global (5000) DAILY caps in reserveDaily.
  if (!rateLimit(req, res, { max: 10, windowMs: 60_000, bucket: 'faucet' })) return
  res.setHeader('Content-Type', 'application/json')

  const secret = FAUCET_SECRET()
  if (!secret) {
    res.statusCode = 503
    return res.end(JSON.stringify({ error: 'Faucet not configured', configured: false }))
  }
  try {
    const body = await readBody(req)
    if (body.action !== 'dispense') return bad(res, 'Unknown action')
    if (typeof body.to !== 'string' || !body.to) return bad(res, 'Invalid recipient')
    const token = TOKEN_ADDR()
    if (!token) {
      res.statusCode = 503
      return res.end(JSON.stringify({ error: 'Faucet token unset', configured: false }))
    }
    const mod = await import('@stellar/stellar-sdk')
    // Accept a Soroban smart account (C, passkey wallet) OR a classic ed25519 account (G,
    // seed-phrase wallet). The SAC `transfer` in dispenseToken is address-agnostic
    // (Address.fromString handles both); a G recipient must hold a trustline to this token's
    // issuer first (the client adds it), else the transfer fails at simulate — fail-closed.
    const isC = mod.StrKey.isValidContract(body.to)
    const isG = mod.StrKey.isValidEd25519PublicKey(body.to)
    if (!isC && !isG) return bad(res, 'Invalid recipient')
    if (!reserveDaily(body.to, effectiveAmount(body.amount)))
      return tooMany(res, 'Daily faucet cap reached')
    const sdk = {
      Keypair: mod.Keypair,
      TransactionBuilder: mod.TransactionBuilder,
      Contract: mod.Contract,
      Address: mod.Address,
      xdr: mod.xdr,
      BASE_FEE: mod.BASE_FEE,
      rpc: mod.rpc,
    }
    const rpcServer = new mod.rpc.Server(RPC_URL())
    const out = await dispenseToken({
      secret,
      token,
      to: body.to,
      amount: body.amount,
      passphrase: PASSPHRASE(),
      sdk,
      rpcServer,
    })
    return res.end(JSON.stringify(out))
  } catch (err) {
    console.error('[api/faucet] error:', err?.message || err)
    res.statusCode = 502
    return res.end(JSON.stringify({ error: 'Faucet failed' }))
  }
}
