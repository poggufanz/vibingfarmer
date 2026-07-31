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
// `proveReusablePermission` returns `fresh` before reading anything. The activation trigger is a
// single edit: register the actually-deployed V3 contract id in `ROUTER_SCHEMAS` with
// `ROUTER_SCHEMA_V3_SHAPE`'s fields, and list the deployed agent generation in
// `AGENT_GENERATIONS_ELIGIBLE_FOR_PERMISSION_V3` (agentCreatorManifest.js:300-311). Until then the
// live V2 path in `reusePreflight.js` is the only path that can decide reuse.
//
// Like `preflightPermission`, this module NEVER calls a wallet, a provider or a transaction
// builder — every chain read is dependency-injected, so it is a pure function under test and can
// never itself move funds or request a signature.
import { hash } from '@stellar/stellar-sdk'
import { canonicalizeStrategy } from './canonicalStrategy.js'
import { AGENT_KIND_BRIDGE } from '../stellar/grant.js'
import { resolveRouterSchema } from '../stellar/routerSchema.js'
import { sameActiveAccount } from '../stellar/activeAccount.js'
import { SOROBAN_FUNDING_ROUTER_ADDRESS, NETWORK_PASSPHRASE } from '../stellar/config.js'

/** The only two reusable expiry selections that exist. There is no indefinite option. */
export const REUSABLE_DURATIONS_SECONDS = Object.freeze([86_400, 604_800])

/** Policy generation this module encodes; part of the scope identity so a policy change re-scopes. */
export const PERMISSION_POLICY_VERSION = 3

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

const sorted = (v) => (Array.isArray(v) ? [...v].sort() : v)

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
 * Identity of an IMMUTABLE delegation scope. Deliberately excludes `runId`, timestamps and
 * allocation IDs so the same scope reused in a later run hashes identically — that stability is
 * what makes signature-free repeat runs provable rather than assumed. Array-valued fields (a
 * multi-agent permission, a target allowlist) are sorted first: reordering an unchanged set is not
 * a scope change, and treating it as one would void reuse for no reason.
 *
 * @returns {string} '0x' + 64 lowercase hex
 */
export function buildScopeId({
  network,
  owner,
  token,
  router,
  agent,
  code,
  signer,
  targetAllowlist,
  perRunCapUnits,
  cumulativeCapUnits,
  policyVersion,
}) {
  return sha256Hex({
    network,
    owner,
    token,
    router,
    agent: sorted(agent),
    code: sorted(code),
    signer: sorted(signer),
    targetAllowlist: sorted(targetAllowlist),
    perRunCapUnits,
    cumulativeCapUnits,
    policyVersion,
  })
}

/**
 * Project the scope-identity fields out of a set of on-chain-inspected agent rows, so a caller and
 * this module derive the SAME `scopeId` from the same chain state. Caps must be uniform across the
 * set — a permission has one ceiling, so agents carrying different caps are not one scope.
 */
export function scopeFieldsFromAgents(rows) {
  return {
    agent: rows.map((r) => r.agentAddress),
    code: rows.map((r) => r.code),
    signer: rows.map((r) => r.signerPub),
    targetAllowlist: [...new Set(rows.map((r) => r.target))],
    perRunCapUnits: rows[0]?.perRunCapUnits,
    cumulativeCapUnits: rows[0]?.cumulativeCapUnits,
  }
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
 *
 * `agentInits[i]` and an `inspectAgents` row share NO stable key today — an `AgentInit` names an
 * allocation, never an agent, and a row names an agent, never an allocation (confirmed against
 * `agentCache.js`'s `inspectReusableAgents`, the closest production candidate: its rows carry no
 * per-allocation reference at all). Binding `rows[i]` to `agentInits[i]` by array POSITION is
 * therefore unprovable the moment there is more than one allocation to disambiguate — `rows` is an
 * injected chain read with no ordering, and no SIZE, contract, so a reordered or padded result can
 * silently swap which agent an allocation's money moves to. With exactly ONE reviewed allocation,
 * position and identity coincide trivially (there is only one row to bind to); with more than one,
 * NO available data can tell a correct pairing from an incorrect one, so this forces fresh with
 * `'agent-binding-unproven'` rather than guess — the same reason a row count that doesn't match
 * `agentInits` exactly gets, since both are "the binding cannot be proven," not "the agent is
 * simply missing" (`'agent-missing'`, reserved for too few rows). Making multi-allocation V3 reuse
 * provable needs a real shared key (e.g. an on-chain agent surfacing its allocation, or the
 * orchestrator threading a previously-picked address back in) — deliberately not invented here;
 * see the task report.
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
}) {
  if (!Array.isArray(agentInits) || agentInits.length === 0)
    throw new Error('proveReusablePermission needs at least one reviewed allocation.')

  const base = { version: 3, runId, owner, router, network, permissionId }

  // 1. Dormancy. Before any read: this router generation cannot serve a bounded permission.
  if (resolveSchema(router)?.version !== 3) return freshDecision(base, 'router-not-v3')

  // 2. Base/bridge. Before any read: a cross-chain leg is never reused.
  if (agentInits.some((a) => Number(a.kind) === AGENT_KIND_BRIDGE))
    return freshDecision(base, 'base-required')

  // 3. The reviewing account must still be the acting account.
  if (activeAccount?.version === 1) {
    const current = typeof getCurrentActiveAccount === 'function' ? getCurrentActiveAccount() : null
    if (!sameActiveAccount(activeAccount, current)) return freshDecision(base, 'account-stale')
    if (activeAccount.address !== owner) return freshDecision(base, 'account-stale')
  }

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

  // 7. The deployed agents: one per reviewed allocation, and the set must hash to the permission's
  //    recorded scope. That single comparison catches code, signer, target, token and cap drift at
  //    once — anything the scope binds cannot move without changing the id.
  const rows = await inspectAgents({ owner, network, nowSec, server, storage })
  if (rows.length < agentInits.length) return freshDecision(base, 'agent-missing')
  // Binding `rows[i]` to `agentInits[i]` by array position is unprovable the moment there is more
  // than one allocation to disambiguate: `inspectAgents` is an injected chain read with no
  // ordering — and no SIZE — contract, and neither an `AgentInit` nor a row carries any field the
  // other could be matched against (see the module header). With exactly one reviewed allocation,
  // position and identity coincide trivially, so that case is left to the existing checks below.
  // An extra/missing row, or more than one allocation to place, is unprovable either way, so both
  // force fresh the same way rather than guessing.
  if (rows.length > agentInits.length || agentInits.length > 1)
    return freshDecision(base, 'agent-binding-unproven')

  // A permission binds ONE token. `buildScopeId` therefore takes the permission's token, not each
  // agent's, so a drifted per-agent token would otherwise never reach the hash — check it directly.
  if (rows.some((r) => r.token !== grant.token)) return freshDecision(base, 'scope-drift')

  const scopeId = buildScopeId({
    network,
    owner,
    token: grant.token,
    router,
    policyVersion: PERMISSION_POLICY_VERSION,
    ...scopeFieldsFromAgents(rows),
  })
  if (scopeId !== grant.scopeId) return freshDecision(base, 'scope-drift')

  // 8. The V4 per-execution cap, which the cumulative ceiling does not imply. `rows[i]` is safe to
  //    index here: the gate above guarantees exactly one allocation and one row by the time this
  //    runs, so position and identity are the same thing, not an assumption.
  for (let i = 0; i < agentInits.length; i++) {
    const cap = rows[i].perExecutionMaxUnits
    if (cap != null && BigInt(agentInits[i].cap.units) > BigInt(cap))
      return freshDecision(base, 'per-execution-cap')
  }

  // 9. The signing credential must still be reachable, or nothing can be executed.
  for (const init of agentInits) {
    if (!fetchCredential({ owner, planFingerprint, allocationId: init.allocationId, storage }))
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
    liveUntilLedger: Number(grant.liveUntilLedger),
    executions: agentInits.map((init, i) =>
      Object.assign(
        makeAllocationExecution({
          runId,
          allocationId: init.allocationId,
          scopeId,
          amountUnits: String(init.cap.units),
        }),
        { agentAddress: rows[i].agentAddress }
      )
    ),
    approval,
  }
}
