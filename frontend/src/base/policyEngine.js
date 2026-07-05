// frontend/src/base/policyEngine.js
// Pure, network-free model of the ERC-7579 Smart Sessions call-policy this app's drain-proof
// claim rests on. Two jobs:
//   1. buildDepositPermissions — the REAL shape fed to @zerodev/permissions' toCallPolicy (used
//      for real by wallet/mandate.js). One entry per whitelisted pool: only
//      YieldRouter.deposit(pool_i, amount<=cap_i, minShares) is in-policy for that pool.
//   2. evaluateCall — a local pre-flight model of ZeroDev's on-chain+SDK enforcement, so the
//      orchestrator can fail fast with a clear message instead of burning a userOp on an
//      obviously out-of-policy call. This is a DEFENSIVE pre-check, not the security boundary —
//      the boundary is the on-chain module. Target+selector enforcement was proven live in SP0
//      (spikes/smart-sessions/RESULT.md-equivalent evidence in spikes/SP0-GATE.md, AA23 revert
//      0x1c49f4d1). Cap + expiry enforcement are NEW in this module (SP0's delivered spike used
//      `args: [null, null]` — no argument constraints — and never tested cap/expiry) and are
//      re-proven live for the production mandate in scripts/smoke-mandate.mjs (Task 3.7).
import { ParamCondition } from '@zerodev/permissions/policies'
import { YIELD_ROUTER_ADDRESS } from './config.js'

/**
 * @typedef {object} PoolCap
 * @property {string} pool - whitelisted Base pool (ERC-4626) address
 * @property {bigint} cap - max `amount` (base units) this pool's policy entry allows per call
 */

/**
 * Build the @zerodev/permissions `toCallPolicy` permissions array for a set of pool caps.
 * One permission per pool: target = YieldRouter, functionName = deposit, args = [pool EQUAL,
 * amount LESS_THAN_OR_EQUAL cap, minShares unconstrained]. Generalizes the ONE proven entry in
 * spikes/smart-sessions/session-test.mjs from 1 target/no-constraints to N pool-scoped,
 * cap-constrained entries.
 * @param {{pools: PoolCap[], yieldRouterAbi: object[]}} p
 * @returns {Array<object>} permissions array for toCallPolicy({ policyVersion, permissions })
 */
export function buildDepositPermissions({ pools, yieldRouterAbi }) {
  if (!Array.isArray(pools) || pools.length === 0) {
    throw new Error('buildDepositPermissions requires at least one pool')
  }
  return pools.map(({ pool, cap }) => {
    if (!pool || typeof pool !== 'string') throw new Error(`invalid pool address: ${pool}`)
    if (typeof cap !== 'bigint' || cap <= 0n) throw new Error(`invalid cap for ${pool}: ${cap}`)
    return {
      target: YIELD_ROUTER_ADDRESS,
      valueLimit: 0n,
      abi: yieldRouterAbi,
      functionName: 'deposit',
      args: [
        { condition: ParamCondition.EQUAL, value: pool },
        // ParamCondition.LESS_THAN_OR_EQUAL confirmed present in the installed
        // @zerodev/permissions/policies (registry-probed 2026-07-06).
        { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: cap },
        null, // minShares — the on-chain YieldRouter's own floor (SP1 Task 1.2) guards this
      ],
    }
  })
}

/**
 * Local, network-free model of whether `{to, functionName, args}` would pass the policy built by
 * buildDepositPermissions. NOT the security boundary (see module docstring).
 * @param {{permissions: Array<object>, to: string, functionName: string, args: Array<any>, now?: number, expiry: number}} p
 * @returns {{allowed: boolean, reason: string|null}}
 */
export function evaluateCall({
  permissions,
  to,
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

  for (let i = 0; i < match.args.length; i++) {
    const cond = match.args[i]
    if (cond == null) continue // unconstrained argument
    const actual = args[i]
    if (cond.condition === ParamCondition.EQUAL && String(actual).toLowerCase() !== String(cond.value).toLowerCase()) {
      return { allowed: false, reason: `arg ${i} not EQUAL to policy value` }
    }
    if (cond.condition === ParamCondition.LESS_THAN_OR_EQUAL && !(BigInt(actual) <= BigInt(cond.value))) {
      return { allowed: false, reason: `arg ${i} exceeds policy cap` }
    }
  }
  return { allowed: true, reason: null }
}
