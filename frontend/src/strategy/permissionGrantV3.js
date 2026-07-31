// frontend/src/strategy/permissionGrantV3.js — IQ Alter remediation Task 5. The reviewed, BOUNDED
// Router V3 permission.
//
// What "bounded" buys: V2's grant is a SEP-41 allowance whose only leash is its own budget, so a
// budget chosen larger than the run silently becomes standing spending authority. V3 splits that
// into a cumulative ceiling the user reviews explicitly and a confirmed-spend counter the router
// keeps, so the reviewed number is the ONLY exposure and it defaults to exactly what this run
// moves — a first run therefore leaves ZERO repeat headroom unless the user deliberately raises it.
//
// DORMANT UNTIL DEPLOYED. No V3 router address is registered in `ROUTER_SCHEMAS`
// (routerSchema.js:47-54 — inventing one would violate the same fail-closed rule that keeps the
// legacy router's ABI absent), so `resolveRouterSchema` resolves version 3 for nothing and
// `proveReusablePermission` returns `fresh` before reading anything. Activation needs TWO
// independent edits, BOTH required: register the actually-deployed V3 contract id in
// `ROUTER_SCHEMAS` with `ROUTER_SCHEMA_V3_SHAPE`'s fields, AND list the deployed agent generation
// in `AGENT_GENERATIONS_ELIGIBLE_FOR_PERMISSION_V3` (agentCreatorManifest.js:300-311) — this
// module enforces the second gate itself (step 7a below), so a router registered without its
// generation added still can't reuse. Until both are done the live V2 path in `reusePreflight.js`
// is the only path that can decide reuse.
//
// Like `preflightPermission`, this module NEVER calls a wallet, a provider or a transaction
// builder — every chain read is dependency-injected, so it is a pure function under test and can
// never itself move funds or request a signature.
import { hash, Address } from '@stellar/stellar-sdk'
import { canonicalizeStrategy } from './canonicalStrategy.js'
import { AGENT_KIND_BRIDGE } from '../stellar/grant.js'
import { resolveRouterSchema } from '../stellar/routerSchema.js'
import { sameActiveAccount } from '../stellar/activeAccount.js'
import { SOROBAN_FUNDING_ROUTER_ADDRESS, NETWORK_PASSPHRASE } from '../stellar/config.js'
import {
  generationForWasmHash,
  isEligibleForPermissionV3,
  AGENT_GENERATIONS_ELIGIBLE_FOR_PERMISSION_V3,
} from '../stellar/agentCreatorManifest.js'

/** The only two reusable expiry selections that exist. There is no indefinite option. */
export const REUSABLE_DURATIONS_SECONDS = Object.freeze([86_400, 604_800])

// Canonical decimal integer, bigint-safe. No sign, no exponent, no fraction, no leading zero, no
// whitespace — the exact-asset-unit convention Task 11 established across the app.
const UNITS_RE = /^(0|[1-9][0-9]*)$/

function assertUnits(value, label) {
  if (typeof value !== 'string' || !UNITS_RE.test(value))
    throw new Error(`${label} must be a canonical decimal integer string of asset units.`)
  return value
}

function sha256Hex(obj) {
  return '0x' + hash(JSON.stringify(canonicalizeStrategy(obj))).toString('hex')
}

// --- deriveScopeIdV3 — the mirror of the router's derive_scope_id (Task F2, IQ Alter remediation)
// -----------------------------------------------------------------------------------------------
// RETIRED: `buildScopeId`/`scopeFieldsFromAgents` (formerly here) hashed a JSON blob of
// app-invented fields (network/owner/agent/code/signer/targetAllowlist/caps/policyVersion) that
// shares almost nothing with what the router actually records at `PermissionGrantV3.scope_id`
// (soroban/contracts/funding_router/src/lib.rs, `derive_scope_id`) — the comparison at the bottom
// of `proveReusablePermission` could NEVER hold on a real chain. `deriveScopeIdV3` below is the
// real mirror; every test of the retired functions is gone with them (see the task report).
const SCOPE_ID_V3_DOMAIN_TAG = new TextEncoder().encode('vibing-farmer/scope-id/v3')
const U32_MAX = 0xffffffff

function assertU32(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX)
    throw new Error(`${label} must be an integer in the u32 range (0..${U32_MAX}).`)
  return value
}

// Big-endian 4-byte encoding — matches Rust's `u32::to_be_bytes()`, which `derive_scope_id` uses
// for both `kind` and `destination_domain`. Getting this backwards produces a plausible-looking
// but WRONG hash for every asymmetric value (anything other than 0) — see the mutation-table
// entry in the task report that pins this exact failure mode.
function u32BE(value) {
  const bytes = new Uint8Array(4)
  bytes[0] = (value >>> 24) & 0xff
  bytes[1] = (value >>> 16) & 0xff
  bytes[2] = (value >>> 8) & 0xff
  bytes[3] = value & 0xff
  return bytes
}

// No `Buffer` global here deliberately (this file is not on the browser-polyfill allowlist in
// eslint.config.js, matching reusePreflight.js's own convention) — plain Uint8Array concatenation.
function concatBytes(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * Mirror of the router's own `derive_scope_id` (soroban/contracts/funding_router/src/lib.rs):
 *
 *     sha256( b"vibing-farmer/scope-id/v3"
 *             || target.to_xdr() || token.to_xdr()
 *             || kind:u32 BE || mint_recipient[32] || destination_domain:u32 BE )
 *
 * `Address.fromString(a).toScVal().toXDR()` reproduces Rust's `Address::to_xdr(env)` byte-for-
 * byte. Pinned against `funding_router/src/test.rs`'s `scope_id_matches_pinned_cross_layer_vector`
 * (commit c39f9bf) — this file's own test suite reproduces BOTH of that test's vectors verbatim.
 * If this function ever stops reproducing those two constants, THIS function has drifted; the
 * fix belongs here, never in the pinned test (see the module `README`/task brief for the vectors).
 *
 * OUTPUT CONVENTION (deliberately different from the retired `buildScopeId`'s `0x`-prefixed hex):
 * lowercase hex, NO `0x` prefix, 64 characters — matching how the Rust vectors above are written
 * and how `AGENT_WASM_GENERATIONS[].wasmHash` is written (agentCreatorManifest.js). Every reader
 * that decodes the chain's `PermissionGrantV3.scope_id` (a raw `BytesN<32>`) into `grant.scopeId`
 * MUST emit THIS form — a caller comparing against the old `0x`-prefixed convention will never
 * match, silently, forever.
 *
 * Validates and fails LOUD rather than coercing: a `mintRecipient` that is not exactly 32 bytes,
 * or a `kind`/`destinationDomain` outside the u32 range, throws instead of truncating/padding. A
 * silently truncated or padded `mintRecipient` would still produce a plausible-looking 64-hex-
 * character hash — just the WRONG one — the worst possible failure mode for a value this
 * security-critical, so this never coerces.
 *
 * KNOWN, DOCUMENTED GAP (do not "fix" by inventing a reader here — see the task report): this
 * function, and therefore the `scope-drift` comparison built on it, binds ONLY the fields listed
 * above. It does NOT bind `code` (the deployed agent's wasm hash) or `signerPub` (its session
 * key) — proving either would need the router's PINNED wasm hash via a `config()` read that does
 * not exist on this contract yet. An agent whose wasm or session key drifted independently of its
 * target/token/kind/bridge-config still hashes to the identical scope id.
 *
 * @param {object} p
 * @param {string} p.target G/C strkey address (the scoped vault, or the bridge minter for kind 1)
 * @param {string} p.token G/C strkey address of the SEP-41 asset — the PERMISSION's token
 *   (`grant.token`), never a per-allocation value; see `proveReusablePermission`'s own call site.
 * @param {number} p.kind integer, u32 range (0 = Deposit, 1 = Bridge — AGENT_KIND_* in grant.js)
 * @param {Uint8Array} p.mintRecipient EXACTLY 32 bytes (all-zero for a Deposit-kind allocation, by
 *   this codebase's convention — see grant.js's `agentInitScVal`, which encodes it unconditionally
 *   regardless of kind)
 * @param {number} p.destinationDomain integer, u32 range (0 for a Deposit-kind allocation)
 * @returns {string} lowercase hex, 64 characters, no `0x` prefix
 */
export function deriveScopeIdV3({ target, token, kind, mintRecipient, destinationDomain }) {
  if (!(mintRecipient instanceof Uint8Array) || mintRecipient.length !== 32)
    throw new Error('mintRecipient must be exactly 32 bytes.')
  assertU32(kind, 'kind')
  assertU32(destinationDomain, 'destinationDomain')

  const preimage = concatBytes([
    SCOPE_ID_V3_DOMAIN_TAG,
    Address.fromString(target).toScVal().toXDR(),
    Address.fromString(token).toScVal().toXDR(),
    u32BE(kind),
    mintRecipient,
    u32BE(destinationDomain),
  ])
  return hash(preimage).toString('hex')
}

/**
 * Serialize the reviewed spending bound ONCE, from a freshly read ledger. The result is frozen:
 * nothing downstream may recompute an expiry or widen a ceiling after the user has reviewed it.
 *
 * @param {object} args
 * @param {string} args.plannedUnitsNow what this run actually moves, in exact asset units
 * @param {string} [args.mandateCeilingUnits] cumulative ceiling; defaults to `plannedUnitsNow`,
 *   i.e. no repeat headroom. Raising it is an explicit user edit and nothing else.
 * @param {number} args.currentLedger freshly read ledger sequence
 * @param {number} args.durationSeconds 86400 or 604800 — the only two choices
 * @param {number} args.secondsPerLedger network ledger cadence
 * @returns {Readonly<{plannedUnitsNow:string, mandateCeilingUnits:string, durationSeconds:number,
 *   currentLedger:number, secondsPerLedger:number, liveUntilLedger:number}>}
 */
export function buildReusableApproval({
  plannedUnitsNow,
  mandateCeilingUnits = plannedUnitsNow,
  currentLedger,
  durationSeconds,
  secondsPerLedger,
}) {
  assertUnits(plannedUnitsNow, 'plannedUnitsNow')
  assertUnits(mandateCeilingUnits, 'mandateCeilingUnits')
  if (BigInt(mandateCeilingUnits) < BigInt(plannedUnitsNow))
    throw new Error('The reviewed ceiling cannot be below what this run moves.')
  if (!REUSABLE_DURATIONS_SECONDS.includes(durationSeconds))
    throw new Error('Reusable duration must be exactly 24 hours or 7 days.')
  if (
    !Number.isFinite(secondsPerLedger) ||
    typeof secondsPerLedger !== 'number' ||
    secondsPerLedger <= 0
  )
    throw new Error('secondsPerLedger must be a positive finite ledger cadence.')
  if (!Number.isSafeInteger(currentLedger) || currentLedger < 0)
    throw new Error('currentLedger must be a freshly read non-negative ledger sequence.')

  return Object.freeze({
    plannedUnitsNow,
    mandateCeilingUnits,
    durationSeconds,
    currentLedger,
    secondsPerLedger,
    liveUntilLedger: currentLedger + Math.ceil(durationSeconds / secondsPerLedger),
  })
}

/**
 * One execution of one allocation under a permission. The id is a DETERMINISTIC hash of the four
 * identifying fields — never a nonce.
 *
 * That is a money-safety property, not a style choice. The router records `execution_id` only on a
 * SUCCESSFUL `pull_v3`, so re-submitting the SAME id after an INDETERMINATE submission (the relay
 * dropping its response) is safe by construction: the router rejects it as a duplicate if the
 * first one landed, and accepts it if it did not. A minted id would move real funds twice on
 * exactly that retry, and would make recovery's "resend the identical still-valid envelope, never
 * rebuild" action impossible to implement.
 */
export function makeAllocationExecution({ runId, allocationId, scopeId, amountUnits }) {
  if (!runId || typeof runId !== 'string') throw new Error('runId is required.')
  if (!allocationId || typeof allocationId !== 'string')
    throw new Error('allocationId is required.')
  if (!scopeId || typeof scopeId !== 'string') throw new Error('scopeId is required.')
  assertUnits(amountUnits, 'amountUnits')
  return {
    executionId: sha256Hex({ runId, allocationId, scopeId, amountUnits }),
    runId,
    allocationId,
    scopeId,
    amountUnits,
  }
}

function freshDecision(base, freshReason) {
  return {
    ...base,
    mode: 'fresh',
    freshReason,
    scopeId: null,
    mandateCeilingUnits: null,
    confirmedSpentUnits: null,
    remainingHeadroomUnits: null,
    liveUntilLedger: null,
    executions: [],
  }
}

/**
 * Prove — against canonical chain state, never against a local receipt — that an existing bounded
 * V3 permission covers this run. ALL-OR-NOTHING: any missing, drifted, expired, revoked, gapped or
 * unprovable element anywhere forces a COMPLETE fresh decision with a specific `freshReason`. A
 * Base (bridge) allocation always forces fresh and is never reused.
 *
 * Every chain read is injected. `resolveSchema` defaults to the production resolver, which knows
 * no V3 address — so in production this returns `fresh` before performing a single read.
 * `eligibleGenerations` defaults to the production `AGENT_GENERATIONS_ELIGIBLE_FOR_PERMISSION_V3`
 * allowlist, which is `[]` until a real V3-capable generation is deployed (Task 4) — so every row
 * is rejected with `'agent-generation-ineligible'` today, same as the router dormancy above but
 * one gate deeper. The injection point is the ALLOWLIST (a set), never the predicate itself — a
 * caller can only ever WIDEN which generations pass, never bypass the lookup/fail-closed behavior
 * that `isEligibleForPermissionV3`/`generationForWasmHash` enforce on every row regardless.
 *
 * `agentInits[i]` and an `inspectAgents` row share no per-allocation identity key (an `AgentInit`
 * names an allocation, a row names a deployed agent), but they DO share `target`/`token` — every
 * fixture in this file and in `reusePreflight.test.js` confirms it. So this does not DISCOVER a
 * pre-existing pairing; it ASSIGNS one, the same model V2's `selectAgents` (reusePreflight.js)
 * already uses in production: bucket candidates by (target, token), skip already-claimed
 * addresses, take one. `rows`' order is not part of any contract, so the candidate set is
 * canonicalized (sorted by `agentAddress`) before assignment — the binding is a pure function of
 * the row SET, never of whatever order the chain read happened to return it in, so a reordered
 * re-read can never flip which agent an allocation binds to. An allocation whose target/token
 * matches no remaining candidate forces fresh with `'agent-binding-unproven'` — distinct from
 * `'agent-missing'` (too few rows at all).
 *
 * IMPORTANT — corrected from an earlier, false version of this comment (Task F2): the scope-id
 * comparison above this binding step does NOT prove anything about the deployed agent ROWS. It is
 * derived from `agentInits` (the REVIEWED allocations) and `grant.token` alone — see
 * `deriveScopeIdV3`'s own doc — so it proves only that THIS RUN's allocation shape (target/token/
 * kind/bridge-config) is what the permission was originally scoped to. What a deployed row itself
 * carries (its token, its own recorded caps, its wasm/session key, and whether it is even linked
 * to this permission on-chain at all) is checked SEPARATELY, by the token-drift check just above
 * the derivation, by this binding step's own target/token match, and by the cap-drift /
 * `readLinkedPermission` checks that run right after it. `code`/`signerPub` remain an open,
 * documented gap — see `deriveScopeIdV3`'s doc and the task report.
 */
export async function proveReusablePermission({
  runId,
  owner,
  router = SOROBAN_FUNDING_ROUTER_ADDRESS,
  network = NETWORK_PASSPHRASE,
  planFingerprint,
  permissionId,
  activeAccount,
  getCurrentActiveAccount,
  approval,
  agentInits,
  currentLedger,
  nowSec = Math.floor(Date.now() / 1000),
  server,
  storage,
  resolveSchema = resolveRouterSchema,
  readPermissionGrant,
  readRemainingBudget,
  proveAllowance,
  inspectAgents,
  fetchCredential,
  // Task F2 (IQ Alter remediation): reads the router's `linked_permission(agent)` (c39f9bf) — the
  // ONLY on-chain-provable answer to "does this agent actually belong to this permission", closing
  // a fail-open where the browser could previously only trust its own local cache. No default, by
  // design, exactly like every other chain reader above: there is nothing dormant-safe to default
  // it to (the real reader belongs with the other chain readers in a later task), so a caller that
  // reaches this function with a resolved V3 router must inject it.
  readLinkedPermission,
  // Task 5 (IQ Alter remediation): defaults to the real, production allowlist (`[]` until a real
  // V3-capable generation is deployed — see agentCreatorManifest.js). Injecting the ALLOWLIST
  // (not a predicate function) means an override can only ever WIDEN the eligible set for a test —
  // it can never bypass the normalization/lookup/fail-closed-on-unknown behavior below, which runs
  // unconditionally on every path.
  eligibleGenerations = AGENT_GENERATIONS_ELIGIBLE_FOR_PERMISSION_V3,
}) {
  if (!Array.isArray(agentInits) || agentInits.length === 0)
    throw new Error('proveReusablePermission needs at least one reviewed allocation.')

  const base = { version: 3, runId, owner, router, network, permissionId }

  // 1. Dormancy. Before any read: this router generation cannot serve a bounded permission.
  if (resolveSchema(router)?.version !== 3) return freshDecision(base, 'router-not-v3')

  // 2. Base/bridge. Before any read: a cross-chain leg is never reused.
  if (agentInits.some((a) => Number(a.kind) === AGENT_KIND_BRIDGE))
    return freshDecision(base, 'base-required')

  // 3. The reviewing account must still be the acting account. Fail CLOSED, not open, mirroring
  // the `currentLedger` expiry gate below: no `activeAccount` at all, or any record that is not a
  // recognized V1 active-account shape, must force fresh rather than silently skip this check.
  if (activeAccount?.version !== 1) return freshDecision(base, 'account-stale')
  const current = typeof getCurrentActiveAccount === 'function' ? getCurrentActiveAccount() : null
  if (!sameActiveAccount(activeAccount, current)) return freshDecision(base, 'account-stale')
  if (activeAccount.address !== owner) return freshDecision(base, 'account-stale')

  // 4. The permission record itself.
  const grant = await readPermissionGrant({ router, permissionId, server })
  if (!grant) return freshDecision(base, 'permission-missing')
  if (grant.revoked) return freshDecision(base, 'permission-revoked')
  // Fail CLOSED, not open. `currentLedger` has no production source today — orchestrator.js's
  // revalidateReuse leaves it unset — and `undefined >= n` is `false`, so without this guard an
  // EXPIRED permission reads as live. No other gate substitutes for expiry (headroom/scope checks
  // pass independently of it), so an absent, non-finite or non-integer ledger must force fresh
  // itself. `grant.liveUntilLedger` gets the identical guard: it is untyped chain-read data, and
  // `Number(undefined)` is `NaN` — every comparison against `NaN` is `false`, the same fail-open
  // failure one field over. Neither side is coerced with `Number()` first: a numeric-LOOKING
  // string must still be rejected, not silently parsed.
  if (
    !Number.isInteger(currentLedger) ||
    !Number.isInteger(grant.liveUntilLedger) ||
    currentLedger >= grant.liveUntilLedger
  )
    return freshDecision(base, 'permission-expired')

  // 5. Exact remaining budget, read from the router — never inferred from a local receipt.
  const requestedUnits = agentInits.reduce((sum, a) => sum + BigInt(a.cap.units), 0n)
  const remainingUnits = BigInt(
    assertUnits(await readRemainingBudget({ router, permissionId, server }), 'remainingBudget')
  )
  if (remainingUnits < requestedUnits) return freshDecision(base, 'headroom-insufficient')

  // 6. The SEP-41 allowance behind it, with a gap-free event proof. A bounded RPC history with a
  //    hole cannot prove the absence of a later mutation, so it is not evidence.
  const allowance = await proveAllowance({ owner, router, token: grant.token, server, storage })
  if (!allowance?.proven) return freshDecision(base, 'allowance-mutated')
  if (!allowance.proof?.gapFree || !allowance.proof?.noLaterMutation)
    return freshDecision(base, 'allowance-proof-gapped')

  // 7. The deployed agents: one per reviewed allocation. See the corrected header comment above
  //    (just before this function) for what the scope-id comparison below does, and does NOT,
  //    prove about them.
  const rows = await inspectAgents({ owner, network, nowSec, server, storage })
  if (rows.length < agentInits.length) return freshDecision(base, 'agent-missing')

  // 7a. Task 4 (agentCreatorManifest.js) marks every agent generation that predates
  // `AgentScope.per_execution_max` / `PermissionGrantV3` fresh-only for reuse — an ALLOWLIST, not
  // a blocklist, so this closes fresh until a real V3-capable generation is deployed and added.
  // `row.code` is the deployed agent's wasm hash; map it to a generation and check eligibility
  // before anything else here — this runs BEFORE the scope-drift comparison below so an
  // ineligible-but-otherwise-scope-matching row reports the more specific reason. Fails closed on
  // every malformed/unmapped/unlisted case (`generationForWasmHash` and `isEligibleForPermissionV3`
  // never throw), never a positional/partial check. `eligibleGenerations` is the ONLY injectable
  // surface here — a caller can widen the allowlist for a test, but the normalization, the
  // hash→generation lookup, and the fail-closed-on-unknown behavior all still run unconditionally.
  if (
    rows.some((r) => !isEligibleForPermissionV3(generationForWasmHash(r.code), eligibleGenerations))
  )
    return freshDecision(base, 'agent-generation-ineligible')

  // A permission binds ONE token. `deriveScopeIdV3` therefore takes the permission's token
  // (`grant.token`, below), not each agent's, so a drifted per-agent token would otherwise never
  // reach the derivation at all — check it directly against every deployed row.
  if (rows.some((r) => r.token !== grant.token)) return freshDecision(base, 'scope-drift')

  // 7b. Mirror the ROUTER'S OWN invariant (`grant_v3`, lib.rs): derive `scope_id` from the first
  // reviewed allocation, then reject the WHOLE call unless every OTHER allocation derives the
  // IDENTICAL id (the `ScopeMismatchV3` loop) — never trust just the first, and never let two
  // allocations under one permission silently disagree about what it is scoped to. Sourced from
  // `agentInits` (the REVIEWED allocations), never from `rows` (the deployed agents' on-chain
  // state) — the router itself hashes its OWN `token` ARGUMENT at `grant_v3`, not each agent's, so
  // this uses `grant.token` (never `init.token`, which the check just above already covers).
  const derivedScopeIds = agentInits.map((init) =>
    deriveScopeIdV3({
      target: init.target,
      token: grant.token,
      kind: Number(init.kind),
      mintRecipient: init.mintRecipient,
      destinationDomain: Number(init.destinationDomain),
    })
  )
  if (derivedScopeIds.some((id) => id !== derivedScopeIds[0]))
    return freshDecision(base, 'scope-drift')
  const scopeId = derivedScopeIds[0]
  if (scopeId !== grant.scopeId) return freshDecision(base, 'scope-drift')

  // 7c. The set of deployed agents matching by (target, token) is an ASSIGNMENT, not a discovery
  // — the same model V2's `selectAgents` (reusePreflight.js) already uses in production: bucket by
  // (target, token), skip already-claimed addresses, take one. `rows`' order is not part of any
  // contract, so the candidate set is canonicalized first (sorted by `agentAddress`) — the
  // assignment must be a pure function of the row SET, never of whatever order the chain read
  // happened to return it in.
  // Two rows sharing an `agentAddress` is a malformed read, not evidence of anything: `.sort()`'s
  // comparator below never returns 0, so a tie would fall back to Array#sort's stability and
  // silently prefer whichever the chain read happened to list first — exactly the order-dependence
  // this whole step exists to remove. Reject outright rather than let a duplicate slip through.
  if (new Set(rows.map((r) => r.agentAddress)).size !== rows.length)
    return freshDecision(base, 'agent-binding-unproven')
  const candidates = [...rows].sort((a, b) => (a.agentAddress < b.agentAddress ? -1 : 1))
  const claimed = new Set()
  const bound = []
  for (const init of agentInits) {
    const row = candidates.find(
      (r) => !claimed.has(r.agentAddress) && r.target === init.target && r.token === init.token
    )
    if (!row) return freshDecision(base, 'agent-binding-unproven')
    claimed.add(row.agentAddress)
    bound.push(row)
  }

  // 7d. Task F2: prove, on-chain, that each bound agent is ACTUALLY linked to THIS permission —
  // closes the fail-open `linked_permission` (c39f9bf) fixed on the router: before this, an agent
  // address could only be trusted via the browser's own local cache, never proven from public
  // chain state. A missing link (`null`/`undefined`), a link to a DIFFERENT permission, or a read
  // failure (the injected reader's own contract, mirroring its siblings above) must all read
  // identically here — fail closed, never a guess at which failure it was.
  for (const row of bound) {
    const linkedPermissionId = await readLinkedPermission({
      router,
      agent: row.agentAddress,
      server,
    })
    if (linkedPermissionId !== permissionId) return freshDecision(base, 'agent-not-linked')
  }

  // 7e. Task F2: the scope id above binds ONLY target/token/kind/bridge-config (deriveScopeIdV3's
  // own doc) — it does NOT bind either cap. `mandate_ceiling`/`per_run_max` live on the PERMISSION
  // (`grant`, read above) and are recorded a second time on each agent's own on-chain scope at
  // `grant_v3` deploy time (`perRunCapUnits`/`cumulativeCapUnits` on `rows`, Task 4). If a bound
  // agent's own recorded caps ever disagree with what the permission itself records, that is real
  // drift the scope id cannot see — checked explicitly here, from data already read above, never a
  // fabricated comparison.
  for (const row of bound) {
    if (BigInt(row.perRunCapUnits) !== BigInt(grant.perRunMaxUnits))
      return freshDecision(base, 'agent-cap-drift')
    if (BigInt(row.cumulativeCapUnits) !== BigInt(grant.mandateCeilingUnits))
      return freshDecision(base, 'agent-cap-drift')
  }

  // 8. The V4 per-execution cap, which the cumulative ceiling does not imply.
  for (let i = 0; i < agentInits.length; i++) {
    const cap = bound[i].perExecutionMaxUnits
    if (cap != null && BigInt(agentInits[i].cap.units) > BigInt(cap))
      return freshDecision(base, 'per-execution-cap')
  }

  // 9. The signing credential must still be reachable, AND must belong to the SAME agent this
  //    allocation was just bound to. `rows` legitimately CAN supersede `agentInits` (a permission
  //    covering more agents than this run needs), in which case the assignment above binds to the
  //    lexicographically-first matching candidate — not necessarily the agent whose session key
  //    was originally minted for this allocation. That mismatch is not exploitable today: a wrong
  //    credential still has to authorize the BOUND agent's own on-chain scope, so it fails closed
  //    at `__check_auth` rather than misdirecting funds. But it is exactly the kind of assumption
  //    ("existence implies correctness") that turns into a real defect the day some other gate
  //    upstream is relaxed, so it's checked explicitly rather than left implicit.
  for (let i = 0; i < agentInits.length; i++) {
    const credential = fetchCredential({
      owner,
      planFingerprint,
      allocationId: agentInits[i].allocationId,
      storage,
    })
    if (!credential || credential.agentAddress !== bound[i].agentAddress)
      return freshDecision(base, 'credential-missing')
  }

  return {
    ...base,
    mode: 'reuse',
    freshReason: null,
    scopeId,
    mandateCeilingUnits: String(grant.mandateCeilingUnits),
    confirmedSpentUnits: String(grant.confirmedSpentUnits),
    remainingHeadroomUnits: remainingUnits.toString(),
    liveUntilLedger: grant.liveUntilLedger,
    executions: agentInits.map((init, i) =>
      Object.assign(
        makeAllocationExecution({
          runId,
          allocationId: init.allocationId,
          scopeId,
          amountUnits: String(init.cap.units),
        }),
        { agentAddress: bound[i].agentAddress }
      )
    ),
    approval,
  }
}
