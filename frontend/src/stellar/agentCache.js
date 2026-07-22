// frontend/src/stellar/agentCache.js
// Agent reuse cache — cuts the wallet-signature count on repeat runs. A fresh agent_account deploy
// costs one user-signed tx per worker; but an agent whose constructor-pinned session key we still
// hold is perfectly reusable while its on-chain scope allows it. We persist, per
// (network, owner, vault), the deployed agent address AND its session secret, then on the next
// run validate the scope ON-CHAIN via the contract's own `scope_of()` getter (expiry / revoked /
// cap headroom) before reusing.
//
// SECURITY TRADEOFF (deliberate, testnet demo): the ed25519 session SECRET lives in
// localStorage. That key is NOT the user's wallet key — it is an ephemeral signer whose power is
// bounded on-chain by the agent_account scope: deposit-only, one pinned vault, capped per rolling
// period, and expiring (default 1h). The worst an XSS thief can do is deposit the agent's
// remaining headroom into the user's own vault position; it can never move funds elsewhere
// (owner_withdraw requires the OWNER address auth, not the session key). Do not ship this
// pattern to mainnet without moving the secret to non-extractable storage.
import { hash } from '@stellar/stellar-sdk' // sync sha256 (same util attestation.js uses)
import { readContract } from './client.js'
import { NETWORK_PASSPHRASE } from './config.js'

// Native hex-encode (no `Buffer` global — this file is not on the browser-polyfill allowlist in
// eslint.config.js, and hash()/Uint8Array already give us everything we need without it).
function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const CACHE_KEY = 'vf.agentCache.v1'
// Don't reuse an agent that would expire mid-run: deposits ride a relay + confirmation polls.
export const EXPIRY_MARGIN_SECONDS = 120

// node test env / SSR has no localStorage — fall back to an in-memory store so callers never
// have to feature-detect. Tests may also inject their own storage.
let _memStore = null
function resolveStorage(injected) {
  if (injected) return injected
  try {
    if (globalThis.localStorage) return globalThis.localStorage
  } catch {
    /* SecurityError in some embeds — fall through */
  }
  if (!_memStore) {
    const m = new Map()
    _memStore = {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, v),
      removeItem: (k) => m.delete(k),
    }
  }
  return _memStore
}

function readAll(storage) {
  try {
    return JSON.parse(resolveStorage(storage).getItem(CACHE_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

function writeAll(all, storage) {
  try {
    resolveStorage(storage).setItem(CACHE_KEY, JSON.stringify(all))
  } catch {
    /* quota/serialization failure — cache is best-effort, never fatal */
  }
}

/** Cache bucket key: one agent list per (network, owner, vault). */
export function cacheKeyFor({ owner, vault, network = NETWORK_PASSPHRASE }) {
  return `${network}|${owner}|${vault}`
}

/**
 * @typedef {object} CachedAgent
 * @property {string} agentAddress C... agent_account address
 * @property {string} secret       S... ed25519 session secret (see tradeoff note above)
 * @property {string} signerPub    G... session public key (display/debug)
 * @property {string} cap          cap_per_period at deploy time (base units, stringified BigInt)
 * @property {number} expiry       scope expiry (unix seconds) — local pre-filter before any RPC
 * @property {number} createdAt    Date.now() at deploy
 */

/** All cached agents for this (owner, vault, network). */
export function loadCachedAgents({ owner, vault, network, storage } = {}) {
  const list = readAll(storage)[cacheKeyFor({ owner, vault, network })]
  return Array.isArray(list) ? list : []
}

/** Append (or replace by agentAddress) one cached agent. */
export function saveCachedAgent({ owner, vault, network, entry, storage }) {
  const all = readAll(storage)
  const key = cacheKeyFor({ owner, vault, network })
  const list = Array.isArray(all[key]) ? all[key] : []
  all[key] = [...list.filter((e) => e.agentAddress !== entry.agentAddress), entry]
  writeAll(all, storage)
}

/** On-chain scope read via the agent's own getter; null on any RPC/decode failure. */
export async function readAgentScope(agentAddress, { server } = {}) {
  try {
    return await readContract({ contract: agentAddress, method: 'scope_of', args: [], server })
  } catch {
    return null
  }
}

/**
 * Remaining spend headroom of a scope at `nowSec`, honoring the contract's ROLLING window:
 * enforce() resets spent_in_period once period_duration has elapsed (period_start 0 = window
 * not started yet), so an elapsed window means the full cap is available again.
 * @returns {bigint}
 */
export function scopeHeadroom(scope, nowSec) {
  const cap = BigInt(scope.cap_per_period ?? 0)
  const start = Number(scope.period_start ?? 0)
  const dur = Number(scope.period_duration ?? 0)
  const rolled = start === 0 || (dur > 0 && nowSec >= start + dur)
  const spent = rolled ? 0n : BigInt(scope.spent_in_period ?? 0)
  const headroom = cap - spent
  return headroom > 0n ? headroom : 0n
}

/**
 * Can this on-chain scope carry a deposit of `amount` for (owner, vault) right now?
 * Mirrors agent_account::enforce(): revoked, expiry, cap-per-rolling-period — plus an expiry
 * margin so the agent survives the whole run.
 */
export function isScopeReusable({ scope, owner, vault, amount, nowSec }) {
  if (!scope) return false
  if (scope.revoked) return false
  if (String(scope.owner) !== String(owner)) return false
  // agent_account v3 renamed AgentScope.vault -> target; both generations are live on testnet.
  if (String(scope.target ?? scope.vault) !== String(vault)) return false
  if (Number(scope.expiry ?? 0) <= nowSec + EXPIRY_MARGIN_SECONDS) return false
  return scopeHeadroom(scope, nowSec) >= BigInt(amount)
}

/** On-chain session-key signer read via the agent's own getter; null on any RPC/decode failure.
 * Separate from `scope_of()` — AgentScope has no `signer` field (agent_account/src/types.rs),
 * the session pubkey lives in a distinct storage slot with its own `signer()` getter. */
export async function readAgentSigner(agentAddress, { server } = {}) {
  try {
    return await readContract({ contract: agentAddress, method: 'signer', args: [], server })
  } catch {
    return null
  }
}

/**
 * Deterministic 0x-prefixed sha256 fingerprint of an on-chain agent scope, for cheap
 * change-detection (Task 5's reuse preflight: "did anything about this scope move since I last
 * looked"). Pure/sync — ingredients are already-decoded values, not raw ScVal.
 * @param {{owner, target, token, signer:Uint8Array|null, kind, cap, spentInPeriod,
 *          periodStart, periodDuration, expiry, revoked}} p
 * @returns {string}
 */
export function computeScopeFingerprint({
  owner,
  target,
  token,
  signer,
  kind,
  cap,
  spentInPeriod,
  periodStart,
  periodDuration,
  expiry,
  revoked,
}) {
  const payload = JSON.stringify({
    owner: String(owner ?? ''),
    target: String(target ?? ''),
    token: String(token ?? ''),
    signer: signer ? bytesToHex(signer) : '',
    kind: Number(kind ?? 0),
    cap: String(cap ?? 0n),
    spentInPeriod: String(spentInPeriod ?? 0n),
    periodStart: String(periodStart ?? 0n),
    periodDuration: String(periodDuration ?? 0n),
    expiry: String(expiry ?? 0n),
    revoked: Boolean(revoked),
  })
  return '0x' + hash(payload).toString('hex')
}

/**
 * Read-only cache inspection: every cached (owner, vault, network) agent, each paired with its
 * AUTHORITATIVE on-chain scope + signer (never trusts the local cache's own signerPub/expiry —
 * chain is truth). Unlike `takeReusableAgent`, this never prunes, never writes to storage, and
 * never "claims" an entry for the caller (no `exclude` bookkeeping) — Task 5's fresh/reuse
 * decision needs to see the WHOLE picture (every candidate for every reviewed allocation) before
 * deciding anything, and an all-or-nothing decision must never have side-effected the cache while
 * merely looking. Kept alongside `takeReusableAgent` for compatibility until orchestration
 * migrates to the preflight (reusePreflight.js).
 * @param {{owner, vault, network, nowSec?, server?, readScope?, readSigner?, storage?}} p
 * @returns {Promise<Array<{agentAddress:string, entry:CachedAgent, scope:object|null,
 *          signer:Uint8Array|null, scopeFingerprint:string|null}>>}
 */
export async function inspectReusableAgents({
  owner,
  vault,
  network,
  server,
  readScope = readAgentScope,
  readSigner = readAgentSigner,
  storage,
}) {
  const entries = loadCachedAgents({ owner, vault, network, storage })
  const rows = []
  for (const entry of entries) {
    const [scope, signer] = await Promise.all([
      readScope(entry.agentAddress, { server }),
      readSigner(entry.agentAddress, { server }),
    ])
    rows.push({
      agentAddress: entry.agentAddress,
      entry,
      scope,
      signer,
      scopeFingerprint: scope
        ? computeScopeFingerprint({
            owner: scope.owner,
            // agent_account v3 renamed AgentScope.vault -> target; dual-support (see isScopeReusable).
            target: scope.target ?? scope.vault,
            token: scope.token,
            signer,
            kind: scope.kind,
            cap: scope.cap_per_period,
            spentInPeriod: scope.spent_in_period,
            periodStart: scope.period_start,
            periodDuration: scope.period_duration,
            expiry: scope.expiry,
            revoked: scope.revoked,
          })
        : null,
    })
  }
  return rows
}

/**
 * Find one reusable cached agent for this run: local expiry pre-filter first (free), then the
 * authoritative on-chain scope_of() check. Invalid entries (expired / revoked / drained /
 * wrong owner-vault) are PRUNED from the cache; entries whose scope read failed are kept but
 * not reused (never trust a blind cache hit). The taken entry STAYS cached — its own on-chain
 * scope self-invalidates once this run spends the cap; `exclude` prevents two workers of the
 * SAME run from adopting one agent before any deposit has spent anything.
 * @returns {Promise<CachedAgent|null>}
 */
export async function takeReusableAgent({
  owner,
  vault,
  amount,
  network,
  nowSec = Math.floor(Date.now() / 1000),
  exclude,
  server,
  readScope = readAgentScope,
  storage,
}) {
  const entries = loadCachedAgents({ owner, vault, network, storage })
  if (entries.length === 0) return null
  const keep = []
  let taken = null
  for (const entry of entries) {
    if (taken || exclude?.has?.(entry.agentAddress)) {
      keep.push(entry)
      continue
    }
    // Local pre-filter: a locally-known-expired agent needs no RPC round-trip — drop it.
    if (Number(entry.expiry ?? 0) <= nowSec + EXPIRY_MARGIN_SECONDS) continue
    const scope = await readScope(entry.agentAddress, { server })
    if (scope === null) {
      keep.push(entry) // transient read failure — retry next run, never reuse blindly
      continue
    }
    if (isScopeReusable({ scope, owner, vault, amount, nowSec })) {
      taken = entry
      keep.push(entry)
    }
    // else: authoritatively invalid on-chain — prune (do not keep)
  }
  const all = readAll(storage)
  all[cacheKeyFor({ owner, vault, network })] = keep
  writeAll(all, storage)
  return taken
}
