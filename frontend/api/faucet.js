// Server-side testnet token faucet. Dispenses a CAPPED amount of the demo SAC token
// (Blend USDC) from a funded VF treasury (VF_FAUCET_SECRET) to a target C-address, so a
// fresh passkey smart account can approve + deposit. The treasury secret is server-held —
// never in the client bundle. Abuse-bounded: origin allowlist + durable per-IP rate limit
// (api/durableRateLimit.js, convergent across isolates) + durable daily spend caps below.
// Testnet only — a mainnet build drops this.
//
//   { action: 'dispense', to: '<C-address>', amount? } → { hash, status }

import { applyCors } from './_guard.js'
import { durableRateLimit } from './durableRateLimit.js'

const PASSPHRASE = () =>
  process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015'
const RPC_URL = () => process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org'
const FAUCET_SECRET = () => process.env.VF_FAUCET_SECRET || ''
const TOKEN_ADDR = () => process.env.SOROBAN_TOKEN_ADDRESS || ''

// 7-decimal token (SOROBAN_DECIMALS = 7). Cap a single dispense at 100 tokens.
export const CAP_BASE_UNITS = 100n * 10n ** 7n
const DEFAULT_BASE_UNITS = 10n * 10n ** 7n // 10 tokens default

// Daily caps on top of the durable per-IP rate limit below. Keyed by recipient + a global
// ceiling. Caps are unchanged: 100 tokens/tx (CAP_BASE_UNITS), 300/day/recipient,
// 5000 global/day.
export const PER_RECIPIENT_DAILY_CAP = 300n * 10n ** 7n // 300 tokens / address / day
export const GLOBAL_DAILY_CAP = 5_000n * 10n ** 7n // 5000 tokens / day total
const DAY_MS = 24 * 60 * 60 * 1000

/** D1 row key holding the global daily spend (same table as per-recipient rows). */
export const FAUCET_GLOBAL_SPEND_KEY = '__global__'

// One-statement race boundary for the spend reserve. D1/SQLite both support this
// INSERT ... ON CONFLICT ... RETURNING: competing requests each receive their own
// atomically incremented total. Do not split into SELECT then UPDATE (same rule as
// durableRateLimit.js's RATE_LIMIT_UPSERT_SQL). A new aligned day replaces the previous
// total; clock rollback preserves the existing newer window (MAX on updated_at_ms).
export const FAUCET_SPEND_UPSERT_SQL = `
  INSERT INTO vf_faucet_daily_spend
    (recipient, window_start_ms, total_base_units, updated_at_ms)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(recipient) DO UPDATE SET
    window_start_ms = CASE
      WHEN excluded.window_start_ms > vf_faucet_daily_spend.window_start_ms
      THEN excluded.window_start_ms
      ELSE vf_faucet_daily_spend.window_start_ms
    END,
    total_base_units = CASE
      WHEN excluded.window_start_ms > vf_faucet_daily_spend.window_start_ms
      THEN excluded.total_base_units
      ELSE vf_faucet_daily_spend.total_base_units + excluded.total_base_units
    END,
    updated_at_ms = MAX(vf_faucet_daily_spend.updated_at_ms, excluded.updated_at_ms)
  RETURNING recipient, window_start_ms, total_base_units, updated_at_ms
`

// Blind compensation for a denied reserve: a rejected request must record nothing, or an
// attacker could burn the daily caps with denied requests. Window predicate keeps a
// midnight rollover between reserve and compensation from debiting the new window.
const FAUCET_COMPENSATE_SQL = `
  UPDATE vf_faucet_daily_spend
  SET total_base_units = MAX(0, total_base_units - ?),
      updated_at_ms = MAX(updated_at_ms, ?)
  WHERE recipient = ? AND window_start_ms = ?
`

// In-memory accounting: DEV-ONLY fallback for plain non-production Vite development
// without a D1 binding (mirrors createDurableRateLimiter's memory seam). Resets on
// serverless cold start and diverges per isolate — never the prod path. Prod/staging and
// any Pages request without VF_DB fail closed instead of using this.
const _spent = new Map() // recipient -> { total: bigint, windowStart: number }
let _globalTotal = 0n
let _globalWindowStart = 0

function faucetHasPagesEnv(req) {
  return req?.env !== undefined && req?.env !== null && typeof req.env === 'object'
}

function faucetDb(req) {
  return faucetHasPagesEnv(req) ? req.env?.VF_DB : process.env.VF_DB
}

function faucetProduction(req) {
  const env = faucetHasPagesEnv(req) ? req.env : process.env
  const nodeEnv = String(env?.NODE_ENV ?? '').toLowerCase()
  const vercelEnv = String(env?.VERCEL_ENV ?? '').toLowerCase()
  return nodeEnv === 'production' || nodeEnv === 'staging' || vercelEnv === 'production'
}

/** Seconds until the next aligned UTC-day window (Retry-After for cap denies). */
export function faucetDayRetryAfter(nowMs = Date.now()) {
  const windowStartMs = Math.floor(nowMs / DAY_MS) * DAY_MS
  return Math.max(1, Math.ceil((windowStartMs + DAY_MS - nowMs) / 1000))
}

function spendRowValid(row, expectedRecipient, windowStartMs) {
  if (!row || row.recipient !== expectedRecipient) return false
  const windowStart = Number(row.window_start_ms)
  const total = Number(row.total_base_units)
  const updatedAt = Number(row.updated_at_ms)
  if (!Number.isSafeInteger(windowStart) || windowStart < 0) return false
  if (!Number.isSafeInteger(total) || total < 0) return false
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) return false
  if (windowStart % DAY_MS !== 0) return false
  // The requested window, or an existing newer window preserved across clock rollback
  // (which the atomic upsert already incremented — never a fresh row from the future).
  if (windowStart !== windowStartMs && !(windowStart > windowStartMs && total >= 1)) return false
  return true
}

async function compensateSpend(db, recipient, windowStartMs, amountNum, nowMs) {
  try {
    await db.prepare(FAUCET_COMPENSATE_SQL).bind(amountNum, nowMs, recipient, windowStartMs).run()
  } catch {
    // Best-effort rollback: a leftover over-count fails safe toward blocking, never
    // toward overspend, and never leaks D1 details to the caller.
  }
}

/**
 * Reserve `amount` (base units, bigint) for `to` against the durable daily caps.
 * @returns {{ ok: true } | { ok: false, scope: 'recipient' | 'global', retryAfterSecs: number }}
 * @throws on missing/malformed D1 state — the caller fails closed (503, no memory fallback).
 */
export async function reserveSpendDurable(to, amount, { db, now = Date.now() } = {}) {
  if (!db) throw new Error('faucet spend store unavailable')
  const nowMs = Number(now)
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('faucet spend clock invalid')
  const amountNum = Number(amount)
  if (!Number.isSafeInteger(amountNum) || amountNum <= 0)
    throw new Error('faucet spend amount invalid')
  const windowStartMs = Math.floor(nowMs / DAY_MS) * DAY_MS
  const recipient = String(to)
  if (!recipient || recipient === FAUCET_GLOBAL_SPEND_KEY)
    throw new Error('faucet spend recipient invalid')
  const reserve = async (key) =>
    db.prepare(FAUCET_SPEND_UPSERT_SQL).bind(key, windowStartMs, amountNum, nowMs).first()
  const recRow = await reserve(recipient)
  if (!spendRowValid(recRow, recipient, windowStartMs))
    throw new Error('faucet spend row malformed')
  if (BigInt(recRow.total_base_units) > PER_RECIPIENT_DAILY_CAP) {
    await compensateSpend(db, recipient, Number(recRow.window_start_ms), amountNum, nowMs)
    return { ok: false, scope: 'recipient', retryAfterSecs: faucetDayRetryAfter(nowMs) }
  }
  const gloRow = await reserve(FAUCET_GLOBAL_SPEND_KEY)
  if (!spendRowValid(gloRow, FAUCET_GLOBAL_SPEND_KEY, windowStartMs)) {
    await compensateSpend(db, recipient, Number(recRow.window_start_ms), amountNum, nowMs)
    throw new Error('faucet spend row malformed')
  }
  if (BigInt(gloRow.total_base_units) > GLOBAL_DAILY_CAP) {
    await compensateSpend(db, recipient, Number(recRow.window_start_ms), amountNum, nowMs)
    await compensateSpend(
      db,
      FAUCET_GLOBAL_SPEND_KEY,
      Number(gloRow.window_start_ms),
      amountNum,
      nowMs
    )
    return { ok: false, scope: 'global', retryAfterSecs: faucetDayRetryAfter(nowMs) }
  }
  return { ok: true }
}

/** Effective dispensed amount: clamp to [_, CAP_BASE_UNITS], default when unset/non-positive. */
export function effectiveAmount(amount) {
  return amount && BigInt(amount) > 0n
    ? BigInt(amount) > CAP_BASE_UNITS
      ? CAP_BASE_UNITS
      : BigInt(amount)
    : DEFAULT_BASE_UNITS
}

/**
 * Reserve `amount` for `to` against daily caps. Returns false (and records nothing) if exceeded.
 * DEV-ONLY fallback: plain non-production Vite development without a D1 binding. Rolling
 * 24h windows, resets on cold start, diverges per isolate. Prod/staging and Pages requests
 * use reserveSpendDurable instead and fail closed without VF_DB.
 */
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
function retryAfterSecs(value, fallback = 60) {
  const secs = Math.ceil(Number(value))
  return Number.isSafeInteger(secs) && secs >= 1 ? secs : fallback
}
function tooMany(res, msg, retryAfter = 60) {
  res.statusCode = 429
  res.setHeader('Retry-After', String(retryAfterSecs(retryAfter)))
  return res.end(JSON.stringify({ error: msg }))
}
function faucetUnavailable(res, retryAfter = 60) {
  res.statusCode = 503
  res.setHeader('Retry-After', String(retryAfterSecs(retryAfter)))
  return res.end(JSON.stringify({ error: 'Faucet unavailable' }))
}
function ensureFaucetRetryAfter(res, fallback = 60) {
  // durableRateLimit's fail-closed 503 carries no Retry-After; every 429/503 on this
  // cost-bearing path must include one so clients back off instead of hammering.
  try {
    if (typeof res.getHeader === 'function' && res.getHeader('Retry-After') != null) return
  } catch {
    // Fall through to the plain-object header shape used by unit-test doubles.
  }
  const headers = res?.headers
  if (headers && (headers['Retry-After'] != null || headers['retry-after'] != null)) return
  res.setHeader('Retry-After', String(retryAfterSecs(fallback)))
}

/**
 * Reserve `amount` for `to`: durable D1 caps whenever a binding is available, dev-only
 * in-memory reserveDaily otherwise. Sends 429 (cap) or 503 (fail-closed without VF_DB in
 * Pages/prod/staging) with Retry-After and returns false when nothing may be dispensed.
 */
async function reserveSpend(req, res, to, amount) {
  const now = Date.now()
  const db = faucetDb(req)
  if (!db) {
    if (faucetHasPagesEnv(req) || faucetProduction(req)) {
      faucetUnavailable(res)
      return false
    }
    if (!reserveDaily(to, amount, now)) {
      tooMany(res, 'Daily faucet cap reached', faucetDayRetryAfter(now))
      return false
    }
    return true
  }
  let out
  try {
    out = await reserveSpendDurable(to, amount, { db, now })
  } catch {
    faucetUnavailable(res)
    return false
  }
  if (!out.ok) {
    tooMany(res, 'Daily faucet cap reached', out.retryAfterSecs)
    return false
  }
  return true
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405
    return res.end(JSON.stringify({ error: 'Method not allowed' }))
  }
  if (!applyCors(req, res)) return
  // max 10/min/IP, durable across isolates (one D1 counter per IP): an in-wallet
  // "get 300 USDC" top-up is 3 back-to-back 100-cap dispenses; the real abuse bound stays
  // the per-recipient (300) + global (5000) DAILY caps in reserveSpend below.
  if (!(await durableRateLimit(req, res, { max: 10, windowMs: 60_000, bucket: 'faucet' }))) {
    ensureFaucetRetryAfter(res)
    return
  }
  res.setHeader('Content-Type', 'application/json')

  const secret = FAUCET_SECRET()
  if (!secret) {
    res.statusCode = 503
    res.setHeader('Retry-After', '60')
    return res.end(JSON.stringify({ error: 'Faucet not configured', configured: false }))
  }
  try {
    const body = await readBody(req)
    if (body.action !== 'dispense') return bad(res, 'Unknown action')
    if (typeof body.to !== 'string' || !body.to) return bad(res, 'Invalid recipient')
    const token = TOKEN_ADDR()
    if (!token) {
      res.statusCode = 503
      res.setHeader('Retry-After', '60')
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
    if (!(await reserveSpend(req, res, body.to, effectiveAmount(body.amount)))) return
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
  } catch {
    console.error('[api/faucet] FAUCET_REQUEST_FAILED')
    res.statusCode = 502
    return res.end(JSON.stringify({ error: 'Faucet failed', code: 'VF_FAUCET_FAILED' }))
  }
}
