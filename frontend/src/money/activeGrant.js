// frontend/src/money/activeGrant.js
// P1 G5 (defi-gap-analysis §4.2/§5 item 4): the persistent "Active grant" widget's data layer.
// ProtectStage/AgentTeam already prove allowance/expiry at REVIEW time; this module feeds the
// card that keeps answering "sisa budget berapa, kedaluwarsa kapan, revoke di mana" AFTER the
// user leaves that flow, from the same on-chain facts, with no contract changes.
//
// Facts:
// - Remaining budget is the LIVE SEP-41 owner→router allowance, read via `readAllowanceStrict`
//   (grant.js) — strict on purpose: `readAllowance`'s swallow-to-zero would paint an RPC outage
//   as a confident 0, the exact fake number this widget must never show. Any chain-read failure
//   resolves to `{ state: 'unavailable' }`, never a throw, never a zero.
// - The SAC `allowance()` getter exposes NO expiry, so the expiry ledger comes from the local
//   grant receipt (`loadGrantReceipt`, fingerprint-verified, null when absent — e.g. granted on
//   another device). A live allowance with no receipt still renders its remaining; only the
//   expiry row honestly reads Unavailable.
// - Ledger → wall-clock uses `SECONDS_PER_LEDGER` (grant.js, the same 5s rate the grant builder
//   converts with) and is ALWAYS an estimate: the receipt's own chain-agreed anchor
//   (confirmedAt/confirmedLedger from readConfirmedLedger) first, wall-clock fallback second.
//   The component labels it "estimasi", never a precise instant.
// - A confirmed zero allowance (revoked or fully spent) is `{ state: 'none' }` — the card hides
//   instead of displaying a zero. Same for a ledger-proven-expired grant.
//
// This module never touches React state and never signs: pure math (`toActiveGrantView`,
// `describeCountdown`, `estimateExpiryMs`) plus one injected-deps loader (`loadActiveGrant`)
// the app controller calls. Amount formatting stays exact-BigInt via money/assetUnits.js at the
// component, never Number() (AgentTeam's own M6 precedent).
import { readAllowanceStrict, SECONDS_PER_LEDGER } from '../stellar/grant.js'
import { loadGrantReceipt } from '../stellar/grantReceiptStore.js'
import { rpcServer } from '../stellar/client.js'
import {
  SOROBAN_DECIMALS,
  SOROBAN_FUNDING_ROUTER_ADDRESS,
  SOROBAN_TOKEN_ADDRESS,
} from '../stellar/config.js'

// The money route renders every amount as USDC (readOwnerMoney.js's own convention —
// `amount.token` is the literal 'USDC' throughout); the router grant is taken in that same
// token, so the widget carries the same literal rather than a second symbol source.
const GRANT_TOKEN_SYMBOL = 'USDC'

function plural(n, one, many) {
  return n === 1 ? one : many
}

/**
 * Ledgers remaining until `expiryLedger` from `currentLedger`. null when either side is not a
 * real ledger number — the caller degrades to a dateless/unknown expiry, never a guessed one.
 */
export function grantCountdown({ expiryLedger, currentLedger }) {
  if (!Number.isInteger(expiryLedger) || !Number.isInteger(currentLedger)) return null
  return expiryLedger - currentLedger
}

/**
 * Human countdown for a POSITIVE ledgers-left count. Exact ledger fact first, wall-clock
 * approximation second (both from the same SECONDS_PER_LEDGER rate the grant used). null for
 * anything non-positive/non-integer — expiry at or past zero is decided by toActiveGrantView,
 * not phrased here.
 */
export function describeCountdown(ledgersLeft) {
  if (!Number.isInteger(ledgersLeft) || ledgersLeft <= 0) return null
  const totalSeconds = ledgersLeft * SECONDS_PER_LEDGER
  let approx
  if (totalSeconds >= 86400)
    approx = `≈ ${Math.round(totalSeconds / 86400)} ${plural(Math.round(totalSeconds / 86400), 'day', 'days')}`
  else if (totalSeconds >= 3600) approx = `≈ ${Math.round(totalSeconds / 3600)} hr`
  else if (totalSeconds >= 60) approx = `≈ ${Math.round(totalSeconds / 60)} min`
  else approx = `≈ ${totalSeconds} sec`
  return `${ledgersLeft} ${plural(ledgersLeft, 'ledger', 'ledgers')} (${approx})`
}

/**
 * Estimated wall-clock expiry (epoch ms) for an expiry ledger. Prefers the receipt's own
 * chain-agreed anchor (confirmedAt/confirmedLedger, both from readConfirmedLedger — never the
 * browser clock the chain never agreed to); falls back to nowMs + remaining ledgers; null when
 * neither anchor exists. ALWAYS an estimate — the component labels it "estimasi".
 */
export function estimateExpiryMs({
  expiryLedger,
  confirmedLedger = null,
  confirmedAtSec = null,
  currentLedger = null,
  nowMs = Date.now(),
}) {
  if (
    Number.isInteger(expiryLedger) &&
    Number.isInteger(confirmedLedger) &&
    Number.isFinite(confirmedAtSec)
  ) {
    const ms = confirmedAtSec * 1000 + (expiryLedger - confirmedLedger) * SECONDS_PER_LEDGER * 1000
    if (Number.isFinite(ms)) return ms
  }
  if (Number.isInteger(expiryLedger) && Number.isInteger(currentLedger) && Number.isFinite(nowMs)) {
    return nowMs + (expiryLedger - currentLedger) * SECONDS_PER_LEDGER * 1000
  }
  return null
}

function saneDecimals(decimals) {
  return Number.isInteger(decimals) && decimals >= 0 ? decimals : SOROBAN_DECIMALS
}

/**
 * Pure view-model from already-read facts. `amount` is bigint|string units (never Number —
 * unsafe-integer allowances must stay exact). Returns exactly one of:
 * - `{ state: 'none' }` — no active grant: confirmed zero, or ledger-proven expired. Hide.
 * - `{ state: 'unavailable' }` — a fact failed to parse. Render Unavailable, never a number.
 * - `{ state: 'known', ... }` — render remaining + countdown (either may still be individually
 *   null when the receipt is absent; the component says Unavailable for that row only).
 */
export function toActiveGrantView({
  amount,
  currentLedger = null,
  expiryLedger = null,
  expiryAnchor = null,
  decimals = SOROBAN_DECIMALS,
  tokenSymbol = GRANT_TOKEN_SYMBOL,
  nowMs = Date.now(),
} = {}) {
  let remaining
  try {
    remaining = BigInt(amount ?? 0)
  } catch {
    return { state: 'unavailable' }
  }
  if (remaining < 0n) return { state: 'unavailable' }
  if (remaining === 0n) return { state: 'none' }
  const saneExpiry = Number.isInteger(expiryLedger) && expiryLedger >= 0 ? expiryLedger : null
  const saneCurrent = Number.isInteger(currentLedger) && currentLedger >= 0 ? currentLedger : null
  const ledgersLeft = saneExpiry === null || saneCurrent === null ? null : saneExpiry - saneCurrent
  if (ledgersLeft !== null && ledgersLeft <= 0) return { state: 'none' }
  const estimatedExpiryMs =
    saneExpiry === null
      ? null
      : estimateExpiryMs({
          expiryLedger: saneExpiry,
          confirmedLedger: expiryAnchor?.confirmedLedger ?? null,
          confirmedAtSec: expiryAnchor?.confirmedAtSec ?? null,
          currentLedger: saneCurrent,
          nowMs,
        })
  return {
    state: 'known',
    remainingUnits: remaining.toString(),
    decimals: saneDecimals(decimals),
    tokenSymbol,
    expiryLedger: saneExpiry,
    currentLedger: saneCurrent,
    ledgersLeft,
    estimatedExpiryMs,
  }
}

async function defaultGetLatestLedger() {
  const server = await rpcServer()
  const { sequence } = await server.getLatestLedger()
  return sequence
}

function defaultLoadReceipt({ owner, router }) {
  return loadGrantReceipt({ owner, router })
}

// loadGrantReceipt already degrades corrupt rows to null; storage itself can still throw in
// odd embeddings (private mode, SSR) — a receipt outage must degrade the expiry row, never the
// whole card.
function safeLoadReceipt(loadReceipt, { owner, router }) {
  try {
    return loadReceipt({ owner, router }) ?? null
  } catch {
    return null
  }
}

function receiptExpiry(receipt) {
  const expiry = receipt?.expiryLedger
  return Number.isInteger(expiry) && expiry >= 0 ? expiry : null
}

function receiptAnchor(receipt) {
  if (!receipt) return null
  const confirmedLedger = receipt.confirmedLedger
  const confirmedAtSec = receipt.confirmedAt
  if (!Number.isInteger(confirmedLedger) || !Number.isFinite(confirmedAtSec)) return null
  return { confirmedLedger, confirmedAtSec }
}

// Decimals ride on the receipt's own budget row for OUR token (AgentTeam's M6 precedent: a
// hardcoded 7 misreports any non-7-decimal token by orders of magnitude); a missing/mismatched
// row falls back to the canonical SOROBAN_DECIMALS, never a throw.
function receiptDecimals(receipt, token) {
  const budgets = receipt?.allowanceBudgets
  if (!Array.isArray(budgets)) return SOROBAN_DECIMALS
  const row = budgets.find((b) => b && b.token === token) ?? null
  return saneDecimals(row?.decimals)
}

/**
 * Load the widget's view-model. Fail-soft by contract: resolves `{ state: 'unavailable' }`
 * when EITHER chain read fails (strict allowance OR latest ledger — a half-fresh countdown is
 * still a fake number), `{ state: 'none' }` with no owner/router or a confirmed-zero
 * allowance. Deps are injectable for tests; defaults are the real chain + receipt store.
 * `getLatestLedger` resolves a ledger SEQUENCE number (not the `{ sequence }` envelope).
 */
export async function loadActiveGrant({
  owner,
  router = SOROBAN_FUNDING_ROUTER_ADDRESS,
  token = SOROBAN_TOKEN_ADDRESS,
  tokenSymbol = GRANT_TOKEN_SYMBOL,
  nowMs = Date.now(),
  deps = {},
} = {}) {
  if (!owner || !router) return { state: 'none' }
  const {
    readAllowance = readAllowanceStrict,
    getLatestLedger = defaultGetLatestLedger,
    loadReceipt = defaultLoadReceipt,
  } = deps
  let allowance
  let sequence
  try {
    ;[allowance, sequence] = await Promise.all([
      readAllowance({ owner, router, token }),
      getLatestLedger(),
    ])
  } catch {
    return { state: 'unavailable' }
  }
  const amount = allowance?.amount
  if (typeof amount !== 'bigint' || amount < 0n) return { state: 'unavailable' }
  if (!Number.isInteger(sequence) || sequence < 0) return { state: 'unavailable' }
  if (amount === 0n) return { state: 'none' }
  const receipt = safeLoadReceipt(loadReceipt, { owner, router })
  return toActiveGrantView({
    amount,
    currentLedger: sequence,
    expiryLedger: receiptExpiry(receipt),
    expiryAnchor: receiptAnchor(receipt),
    decimals: receiptDecimals(receipt, token),
    tokenSymbol,
    nowMs,
  })
}
