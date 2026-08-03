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
import { hash, StrKey } from '@stellar/stellar-sdk' // hash: sync sha256 (attestation.js's util);
// StrKey: encodes a raw ed25519 signer into the G... strkey `signerPub` convention (inspectAgentsV4)
import { readContract } from './client.js'
import { NETWORK_PASSPHRASE, SOROBAN_FUNDING_ROUTER_ADDRESS } from './config.js'

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

// --- inspectAgentsV4 — the V4 row supplier for permissionGrantV3.js's injected `inspectAgents` ---
// -----------------------------------------------------------------------------------------------
// Task W3b (IQ Alter remediation). DIFFERENT consumer, DIFFERENT row shape than
// `inspectReusableAgents` above — see that function's own doc for why the two are never unified.
// `inspectReusableAgents` is NOT modified by this task; a mutation check in agentCache.test.js
// proves its shape/behavior are unchanged, not just a comment claiming so.

/** Every cache-bucket entry for (owner, network), across EVERY vault it was saved under.
 * `inspectAgentsV4`'s only caller-shape (`proveReusablePermission`, permissionGrantV3.js:412) is
 * `inspectAgents({owner, network, nowSec, server, storage})` — no `vault` at all — because one
 * permission's reviewed `agentInits` can legitimately name MORE than one target/vault (the binding
 * step, 7c, buckets candidate rows by (target, token) across the whole reviewed set). A
 * single-vault signature like `inspectReusableAgents`'s could never satisfy that caller.
 * `loadCachedAgents`/`cacheKeyFor` are vault-scoped and can't answer "every vault for this owner"
 * on their own, so this scans every `${network}|${owner}|*` bucket key directly. Each row's own
 * on-chain `target`/`token` (read below, from `scope_of()`) speaks for itself regardless of which
 * vault bucket the entry happened to be cached under. */
function loadAllCachedAgentsForOwner({ owner, network = NETWORK_PASSPHRASE, storage }) {
  const all = readAll(storage)
  const prefix = `${network}|${owner}|`
  const entries = []
  for (const key of Object.keys(all)) {
    if (key.startsWith(prefix) && Array.isArray(all[key])) entries.push(...all[key])
  }
  return entries
}

/** i128 -> canonical decimal-integer STRING (Task 11's repo-wide unit convention), or `null` on
 * any non-BigInt / negative decode. Never `Number()` — an i128 can exceed
 * `Number.MAX_SAFE_INTEGER`, and `permissionGrantV3.js` compares this field with `BigInt(...)`
 * (7e, 8): a rounded value would compare cleanly and be silently WRONG. */
function i128UnitsStringOrNull(value) {
  if (typeof value !== 'bigint' || value < 0n) return null
  return value.toString()
}

/** u64 -> `Number`, matching how THIS FILE already treats `scope.expiry` elsewhere
 * (`isScopeReusable`, and `takeReusableAgent`'s local pre-filter, both `Number(scope.expiry ?? 0)`)
 * — one representation for the same field, not two. Diverges from those two call sites in one
 * deliberate way: they use the coerced value only for an internal boolean comparison and never
 * return it, while this value IS returned as row data a caller could act on — so a value that
 * cannot round-trip through `Number` losslessly is REJECTED (row dropped) rather than silently
 * truncated, which would be the exact "plausible-looking but wrong" failure mode this remediation
 * exists to remove. In practice a unix-seconds expiry can never realistically approach 2^53 (over
 * 285 million years past epoch) — this guard exists to catch a wrong-shaped decode, not a real
 * value ever hitting the boundary. */
function u64SafeNumberOrNull(value) {
  if (typeof value !== 'bigint' || value < 0n) return null
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : null
}

/** One V4 row, or `null` when ANY ingredient is missing, wrong-typed, or failed to read — never a
 * half-populated row a caller could mistake for evidence. `scope`/`signer` are `null` exactly when
 * `readAgentScope`/`readAgentSigner` swallowed an RPC/decode failure (their own contracts, this
 * file) — `null` means "the read failed", never "this agent has no scope/signer" — so both must be
 * treated identically to a structurally-invalid decode: drop the row, do not fabricate one. */
function buildAgentV4Row({ agentAddress, scope, signer, code }) {
  if (!scope || !(signer instanceof Uint8Array) || signer.length !== 32) return null

  const {
    target,
    token,
    cap_per_period: capPerPeriod,
    per_execution_max: perExecutionMax,
    expiry,
    revoked,
  } = scope
  if (typeof target !== 'string' || target.length === 0) return null
  if (typeof token !== 'string' || token.length === 0) return null
  if (typeof revoked !== 'boolean') return null

  const capPerPeriodUnits = i128UnitsStringOrNull(capPerPeriod)
  if (capPerPeriodUnits === null) return null
  const perExecutionMaxUnits = i128UnitsStringOrNull(perExecutionMax)
  if (perExecutionMaxUnits === null) return null
  const safeExpiry = u64SafeNumberOrNull(expiry)
  if (safeExpiry === null) return null

  let signerPub
  try {
    signerPub = StrKey.encodeEd25519PublicKey(signer)
  } catch {
    return null // malformed signer bytes — never fabricate a strkey from bad input
  }

  return {
    agentAddress,
    signerPub,
    code,
    target,
    token,
    capPerPeriodUnits,
    perExecutionMaxUnits,
    expiry: safeExpiry,
    revoked,
  }
}

/**
 * Read-only V4 supplier for `proveReusablePermission`'s injected `inspectAgents`
 * (permissionGrantV3.js). Row shape fixed by the Task W3b brief:
 *
 *     {agentAddress, signerPub, code, target, token, capPerPeriodUnits, perExecutionMaxUnits,
 *      expiry, revoked}
 *
 * SOURCES, verified against the Rust contracts:
 *   - agentAddress: the local cache entry (same as `inspectReusableAgents`).
 *   - signerPub: `readAgentSigner` -> the agent's own `signer()` (agent_account/src/lib.rs:267-268,
 *     `BytesN<32>`).
 *   - target / token / capPerPeriodUnits / perExecutionMaxUnits / expiry / revoked:
 *     `readAgentScope` -> the agent's own `scope_of()` (agent_account/src/lib.rs:129-131),
 *     decoding `AgentScope` (agent_account/src/types.rs:19-32).
 *   - code: the ROUTER's `config()` (funding_router/src/lib.rs:304, `BytesN<32>`, the pinned agent
 *     wasm hash) — NOT read from the agent (the agent contract has no such getter). Injected as
 *     `readRouterAgentWasmHash`, with NO production default — exactly like `readPermissionGrant` /
 *     `readRemainingBudget` (grant.js): there is nothing dormant-safe to default it to, and the
 *     real `config()` reader belongs with the deploy work, not this task. A caller that omits it
 *     gets an immediate `TypeError` on first use — the same fail-closed-by-absence shape
 *     `readLinkedPermission` already has in `proveReusablePermission`. Read ONCE per call (it is a
 *     ROUTER-WIDE value, one wasm hash for the whole router, not one per agent) — never once per
 *     row. Assumed to resolve to the SAME raw-decode shape `readContract` already gives every other
 *     `BytesN<32>` in this file — a raw 32-byte `Uint8Array` (see `readAgentSigner`'s own contract
 *     and test) — this file never asks an injected reader to pre-format hex; formatting happens at
 *     this file's own point of consumption, exactly like `computeScopeFingerprint` already does for
 *     `signer`. A malformed/wrong-shaped resolution THROWS (never silently drops every row) —
 *     mirrors `readPermissionGrant`'s "malformed decode throws" rule: a router-wide value that
 *     cannot be read cleanly is an infrastructure problem, not a per-row one to swallow.
 *
 * `code` FORMAT: `0x`-prefixed lowercase hex — the repo-wide convention for a 32-byte id crossing a
 * JS boundary (see `deriveScopeIdV3`'s own doc, permissionGrantV3.js). Confirmed by reading
 * `generationForWasmHash` (agentCreatorManifest.js): it explicitly strips an optional `0x` prefix
 * before comparing against `AGENT_WASM_GENERATIONS[].wasmHash` (bare hex), and the prover's own test
 * fixtures build `code` as `'0x' + AGENT_WASM_GENERATIONS[...].wasmHash`. Emitting bare hex here
 * would still resolve correctly through that normalization, but would make this the one place in
 * the codebase that broke the `0x`-prefix convention for no reason.
 *
 * UNITS: see `i128UnitsStringOrNull` / `u64SafeNumberOrNull` above for the exact rules and the
 * reasoning for treating `expiry` differently from the two asset-unit fields.
 *
 * `signerPub` REPRESENTATION: a `G...` ed25519 strkey, not raw bytes. The chain's `signer()`
 * returns raw `BytesN<32>` (`readAgentSigner` already returns exactly that, unconverted), but
 * `permissionGrantV3.test.js`'s own fixture (`inspectedAgent()` — the only existing evidence of
 * what a caller of THIS EXACT field name expects) sets `signerPub` to a `G...` strkey, and
 * `reusePreflight.js`'s `signerMatches` independently confirms the same convention everywhere else
 * `signerPub` appears in this codebase (it decodes a LOCAL `signerPub` strkey and compares it
 * against a raw on-chain `signer` byte array — never the reverse). Encoded here via
 * `StrKey.encodeEd25519PublicKey`, the standard lossless Stellar encoding for a raw ed25519 public
 * key — genuinely producible from a real `signer()` read, not invented.
 *
 * NO CONSUMER TODAY: `signerPub` is part of the row contract and is genuinely chain-sourced, but
 * nothing in `permissionGrantV3.js` reads it yet — that file's own header comment documents
 * `code`/`signerPub` as "an open, documented gap" the scope-id derivation does not close (and
 * `expiry`/`revoked` are in the same position: real chain-sourced fields with no reader in that file
 * today). Emitted anyway because they ARE part of the contract and ARE real chain data; no check
 * for any of them is invented here or elsewhere to manufacture a consumer.
 *
 * FAIL CLOSED, NO HALF-POPULATED ROWS — deliberate per-agent choice: a `null` scope or signer, a
 * missing field, or a wrong-typed field on ONE cached entry DROPS that entry from the result; it is
 * simply absent from the returned array, never present with a fabricated/undefined/partial value.
 *   - A per-agent failure is ROUTINE (one stale/unreachable cached agent among possibly several) —
 *     `inspectReusableAgents` and `takeReusableAgent` both already treat a single failed scope read
 *     as ordinary, not exceptional. This row contract is FLAT (unlike `inspectReusableAgents`'s
 *     `{scope: null, ...}` shape) — there is no field that could carry "read failed" without a
 *     caller mistaking it for real data, so omission is the only representation that cannot be
 *     misread as evidence.
 *   - Silently returning a short list is itself a fail-open risk in general (task brief). Corrected
 *     in fix round 1 (the original wording overclaimed this): `proveReusablePermission`'s
 *     `rows.length < agentInits.length` gate (permissionGrantV3.js:413, unmodified,
 *     `'agent-missing'`) only fires in the NON-SUPERSET case — a cache holding strictly fewer
 *     usable agents than reviewed allocations. It does NOT fire, and cannot be relied on, when the
 *     cache holds MORE agents than the run needs (permissionGrantV3.js:560-563 documents this as a
 *     legitimate case — "rows legitimately CAN supersede agentInits"): dropping some failed rows
 *     there can easily still leave `rows.length >= agentInits.length`. Safety in THAT case does not
 *     rest on :413 at all — it rests on the binding/verification steps that run on every SURVIVING
 *     row regardless of how many were dropped: 7c (an allocation only binds a row whose own
 *     target/token match), 7d (`readLinkedPermission` proves the bound row is actually linked to
 *     THIS permission on-chain), and 7e (the bound row's own `capPerPeriodUnits` must match the
 *     reviewed cap). A dropped row can therefore never be silently substituted by a wrong one; it
 *     can only ever cause the run to (correctly) fail to find a valid binding. Throwing per-agent
 *     instead of dropping would abort the WHOLE proof over one unreachable cached entry among
 *     several — too strict, and inconsistent with the "soft" contract `readAgentScope`/
 *     `readAgentSigner` already establish by swallowing to `null` instead of throwing.
 * The router-wide `code` read (above) is the opposite choice, deliberately: it is a single,
 * infrastructural read that every row depends on, not a per-item one, so it is allowed to throw
 * (like `readPermissionGrant`) rather than silently degrade every row.
 *
 * Never mutates or prunes the cache (like `inspectReusableAgents`, unlike `takeReusableAgent`) —
 * this is a pure read. When there are no cached entries for (owner, network) at all, returns `[]`
 * without touching the network — no RPC round trip for a call that could never produce a row,
 * mirroring `inspectReusableAgents`'s identical empty-cache behavior.
 *
 * DORMANT: nothing calls this function today (task brief, binding constraints) — supplying it does
 * NOT wire it into `proveReusablePermission`, which still resolves no V3 router and returns `fresh`
 * before any read.
 *
 * @param {{owner:string, network?:string, server?:object, storage?:object, readScope?:Function,
 *          readSigner?:Function, readRouterAgentWasmHash:Function, router?:string}} p `nowSec` is
 *   silently accepted-and-ignored if passed (matches the caller's own call shape,
 *   `inspectAgents({owner, network, nowSec, server, storage})`) — nothing in this row contract is
 *   time-relative, exactly like `inspectReusableAgents`'s own unused `nowSec`.
 * @returns {Promise<Array<{agentAddress:string, signerPub:string, code:string, target:string,
 *          token:string, capPerPeriodUnits:string, perExecutionMaxUnits:string, expiry:number,
 *          revoked:boolean}>>}
 */
export async function inspectAgentsV4({
  owner,
  network,
  server,
  storage,
  readScope = readAgentScope,
  readSigner = readAgentSigner,
  readRouterAgentWasmHash,
  router = SOROBAN_FUNDING_ROUTER_ADDRESS,
}) {
  const entries = loadAllCachedAgentsForOwner({ owner, network, storage })
  if (entries.length === 0) return []

  const codeHash = await readRouterAgentWasmHash({ router, server })
  if (!(codeHash instanceof Uint8Array) || codeHash.length !== 32)
    throw new Error(
      `readRouterAgentWasmHash must resolve to a 32-byte wasm hash (got ${
        codeHash instanceof Uint8Array ? `${codeHash.length} bytes` : typeof codeHash
      }).`
    )
  const code = '0x' + bytesToHex(codeHash)

  const rows = []
  for (const entry of entries) {
    const [scope, signer] = await Promise.all([
      readScope(entry.agentAddress, { server }),
      readSigner(entry.agentAddress, { server }),
    ])
    const row = buildAgentV4Row({ agentAddress: entry.agentAddress, scope, signer, code })
    if (row) rows.push(row)
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
