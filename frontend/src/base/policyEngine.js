// frontend/src/base/policyEngine.js
// Pure, network-free model of the ERC-7579 Smart Sessions call-policy this app's drain-proof
// claim rests on. Two jobs:
//   1. buildFarmPermissions — the REAL shape fed to @zerodev/permissions' toCallPolicy (used for
//      real by wallet/mandate.js). It exactly matches the relayer batch: canonical
//      USDC.approve(YieldRouter, amount<=maxCap), then
//      YieldRouter.deposit(pool, amount<=maxCap, minShares).
//   2. evaluateCall — a local pre-flight model of ZeroDev's on-chain+SDK enforcement, so the
//      orchestrator can fail fast with a clear message instead of burning a userOp on an
//      obviously out-of-policy call. This is a DEFENSIVE pre-check, not the security boundary —
//      the boundary is the on-chain module. Target+selector enforcement was proven live in SP0
//      (spikes/smart-sessions/RESULT.md-equivalent evidence in spikes/SP0-GATE.md, AA23 revert
//      0x1c49f4d1). Cap + expiry enforcement are NEW in this module (SP0's delivered spike used
//      `args: [null, null]` — no argument constraints — and never tested cap/expiry) and are
//      re-proven live for the production mandate in scripts/smoke-mandate.mjs (Task 3.7).
//
// WHY ONE permission PER SELECTOR, not one-per-pool (2026-07-09): @zerodev CallPolicy keys each
// permission by (callType, target, selector) ONLY — the arg `rules` are NOT part of the key.
// Installing N entries that all read (YieldRouter, deposit) — differing only in their pool/cap
// rules — reverts on-chain as `duplicate permissionHash` (AA23), so any farm of >=2 pools failed.
// The approve and deposit entries below do not collide because target+selector differ. Confirmed by the
// deployed CallPolicy V0_0_4 bytecode + ZeroDev maintainer (zerodevapp/sdk#147: "OR condition for
// the same contract function ... is not supported"). ParamCondition.ONE_OF over the pool address
// is undocumented in the official policy contract, so we do NOT rely on it. Instead:
//   - The POOL ALLOWLIST is enforced by YieldRouter.deposit itself (SP1 `allowedPool`) on-chain —
//     the session key can only ever move funds into whitelisted pools regardless of this policy.
//   - The session policy applies ONE aggregate per-call cap = max(pool caps): a single deposit
//     call can move at most the largest allocation. Per-pool differing caps are NOT expressible in
//     @zerodev CallPolicy; the honest bound is (allowlisted pools) x (deposit-only) x (<=maxCap
//     per call) x (expiry) x (bounded by the session account's balance = only the bridged total).
//     A misallocation within the user-approved, owner-withdrawable pools is possible; a drain is
//     not. (Preserving exact per-pool caps would require Rhinestone Smart Sessions — a full
//     ERC-7579 module swap — deferred.)
import { ParamCondition } from '@zerodev/permissions/policies'

/**
 * @typedef {object} PoolCap
 * @property {string} pool - whitelisted Base pool (ERC-4626) address
 * @property {bigint} cap - this pool's intended max `amount` (base units); the session policy
 *   enforces the max across all pools as one aggregate per-call cap (see module note)
 */

/**
 * Build the exact two @zerodev/permissions entries needed by the relayer's farm batch.
 * Approval is restricted to the canonical USDC contract, the deployed YieldRouter spender, and
 * the same aggregate per-call cap as deposit. The pool and minShares deposit arguments remain
 * unconstrained here because YieldRouter enforces its pool allowlist and min-shares floor on-chain.
 * @param {{pools: PoolCap[], yieldRouterAbi: object[], usdcAbi: object[], yieldRouterAddress: string, usdcAddress: string}} p
 * @returns {Array<object>} two-element permissions array for toCallPolicy({ policyVersion, permissions })
 */
export function buildFarmPermissions({
  pools,
  yieldRouterAbi,
  usdcAbi,
  yieldRouterAddress,
  usdcAddress,
}) {
  if (!Array.isArray(pools) || pools.length === 0) {
    throw new Error('buildFarmPermissions requires at least one pool')
  }
  let maxCap = 0n
  for (const { pool, cap } of pools) {
    if (!pool || typeof pool !== 'string') throw new Error(`invalid pool address: ${pool}`)
    if (typeof cap !== 'bigint' || cap <= 0n) throw new Error(`invalid cap for ${pool}: ${cap}`)
    if (cap > maxCap) maxCap = cap
  }
  return [
    {
      target: usdcAddress,
      valueLimit: 0n,
      abi: usdcAbi,
      functionName: 'approve',
      args: [
        { condition: ParamCondition.EQUAL, value: yieldRouterAddress },
        { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: maxCap },
      ],
    },
    {
      target: yieldRouterAddress,
      valueLimit: 0n,
      abi: yieldRouterAbi,
      functionName: 'deposit',
      args: [
        null, // pool — unconstrained by the session policy; YieldRouter's allowedPool is the gate
        // ParamCondition.LESS_THAN_OR_EQUAL confirmed present in the installed
        // @zerodev/permissions/policies (registry-probed 2026-07-06) and documented by ZeroDev.
        { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: maxCap },
        null, // minShares — the on-chain YieldRouter's own floor (SP1 Task 1.2) guards this
      ],
    },
  ]
}

// Compatibility for existing imports while callers migrate to the more accurate farm name.
export function buildDepositPermissions(params) {
  return buildFarmPermissions(params)
}

/**
 * Local, network-free model of whether `{to, value, functionName, args}` would pass the policy built by
 * buildFarmPermissions. NOT the security boundary (see module docstring).
 * @param {{permissions: Array<object>, to: string, value?: bigint, functionName: string, args: Array<any>, now?: number, expiry: number}} p
 * @returns {{allowed: boolean, reason: string|null}}
 */
export function evaluateCall({
  permissions,
  to,
  value = 0n,
  functionName,
  args,
  now = Math.floor(Date.now() / 1000),
  expiry,
}) {
  if (expiry != null && now >= expiry) return { allowed: false, reason: 'expired' }

  const match = permissions.find(
    (p) => p.target.toLowerCase() === String(to).toLowerCase() && p.functionName === functionName
  )
  if (!match) return { allowed: false, reason: 'no permission for this target+selector' }

  if (BigInt(value) > BigInt(match.valueLimit ?? 0n)) {
    return { allowed: false, reason: 'call value exceeds permission limit' }
  }

  for (let i = 0; i < match.args.length; i++) {
    const cond = match.args[i]
    if (cond == null) continue // unconstrained argument
    const actual = args[i]
    if (
      cond.condition === ParamCondition.EQUAL &&
      String(actual).toLowerCase() !== String(cond.value).toLowerCase()
    ) {
      return { allowed: false, reason: `arg ${i} not EQUAL to policy value` }
    }
    if (
      cond.condition === ParamCondition.LESS_THAN_OR_EQUAL &&
      !(BigInt(actual) <= BigInt(cond.value))
    ) {
      return { allowed: false, reason: `arg ${i} exceeds policy cap` }
    }
  }
  return { allowed: true, reason: null }
}
