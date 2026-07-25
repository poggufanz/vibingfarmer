// frontend/src/base/dashboardPositions.js
// Read-only Base positions for the unified dashboard. No signature, no ceremony: uses the
// owner-scoped BaseOwnerRecordV2 (wallet/baseBinding.js, written by wallet/passkeyBridge.js) —
// the passkey is only touched when the user actually withdraws (see app.jsx's Withdraw wiring).
// Fail-soft end to end: no owner yet for THIS stellarOwner, or any RPC error, -> [] and the
// dashboard renders without the panel. Never throws — runs on every 15s poll tick alongside the
// Stellar reads.
//
// VF Wallet Task 6: gated on the v2 owner record, not the old global vf_base_owner/
// vf_base_owner_address keys — a pre-migration owner (or a different connected wallet) sees []
// until Base is set up again, rather than inheriting whichever wallet happened to write the old
// global keys last.
import { readPositions as defaultReadPositions } from './readPositions.js'
import { BASE_POOL_CATALOG } from '../config.js'
import { ERC20_ABI } from './config.js'
import { readBaseOwner } from '../wallet/baseBinding.js'

// Fix loop 1, Fix 6: readPositions.js's own readIdleUsdc() fails soft to 0n on ANY RPC error (a
// deliberate choice there — a balance read must never block a withdraw modal from opening). That
// contract is wrong for THIS read model, whose whole point is refusing to fabricate a zero, but
// readPositions.js/its test carry an unstaged owner diff this fix loop must not touch (see
// pocket-crew-my-money-task-7-fix1-brief.md). So the gap is closed here at the seam instead: the
// same balanceOf call, without the swallow — null (unknown), never a confident 0n, on failure.
const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' // Base Sepolia Circle USDC
async function defaultReadIdleUsdcOrUnknown({ account, publicClient }) {
  try {
    const raw = await publicClient.readContract({
      address: BASE_USDC,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account],
    })
    return BigInt(raw)
  } catch {
    return null
  }
}

export async function loadBasePositions({ stellarOwner, deps = {} } = {}) {
  const { readPositions = defaultReadPositions, makePublicClient } = deps

  // No Base owner ever created for this stellarOwner -> nothing to read. Bail BEFORE touching
  // the network (and BEFORE the dynamic import below) so a Stellar-only user's poll never fires
  // a Base RPC call OR loads the ZeroDev/viem chain.
  const owner = readBaseOwner(stellarOwner)
  if (!owner) return []
  const account = owner.kernelAddress

  try {
    // Dynamic: no top-level import of passkeyBase.js here (that pulled the whole ZeroDev/viem
    // chain into the eager main bundle for every user — proven via dist chunk grep). Reached
    // only once we already know a Base owner exists.
    const { defaultMakePublicClient } = await import('../wallet/passkeyBase.js')
    const publicClient = (makePublicClient || defaultMakePublicClient)()
    const positions = await readPositions({
      pools: BASE_POOL_CATALOG.map((p) => p.address),
      account,
      publicClient,
    })
    return positions.map((pos) => {
      const cat = BASE_POOL_CATALOG.find((p) => p.address.toLowerCase() === pos.pool.toLowerCase())
      // apy rides along so the dashboard's daily-earnings estimate can include Base pools
      // instead of silently treating cross-chain capital as idle.
      return { ...pos, poolName: cat?.name || pos.pool, apy: cat?.apy || 0 }
    })
  } catch {
    return []
  }
}

/**
 * Task 7 (Pocket Crew "My money"): live Base custody for the EXACT kernel addresses Task 5's
 * durable, relayer-attested association already proved for this owner — `indexedBaseAccounts`,
 * never a locally-scanned set. A new device with no BaseOwnerRecordV2 (no passkey ceremony ever
 * run here) can still see confirmed historical custody, because the read is keyed off proven
 * public addresses, not local storage. Additive: `loadBasePositions` above is untouched and every
 * existing caller of it is unaffected.
 *
 * Returns an explicit status rather than fail-soft `[]` — a money read model needs to tell "no
 * Base association has ever been proven for this owner" (`empty`) apart from "the read couldn't
 * run right now" (`unavailable`) apart from "we checked and every proven account is genuinely
 * empty" (`known`, accounts still present with zero positions/idle — a known zero is zero, it is
 * never dropped). `stellarOwner`'s own local kernel (if any) is compared only for its own
 * identity, never used to gate the read: a local kernel that differs from every proven account is
 * `mismatched` (this device's current Base identity is not the one that produced this custody),
 * but the proven data is still returned alongside that fact — a stale/rotated local kernel must
 * not blank out real public money.
 *
 * Fix loop 1, Fix 5: `status` alone can't say "known" AND "some address dropped out" at once —
 * the enum stays as-is (no new status added) rather than silently widening it; a per-account
 * failure instead rides along on `failedAccounts` so a consumer can still see the gap.
 * @param {{ stellarOwner?: string, indexedBaseAccounts?: string[], deps?: object }} p
 * @returns {Promise<{status: 'unavailable'|'empty'|'known'|'mismatched',
 *   accounts: Array<{kernelAddress: string, positions: Array, idleUsdc: bigint|null}>,
 *   failedAccounts: string[], localKernelAddress: string|null}>}
 */
export async function loadIndexedBasePositions({
  stellarOwner,
  indexedBaseAccounts = [],
  deps = {},
} = {}) {
  const {
    readPositions = defaultReadPositions,
    readIdleUsdc = defaultReadIdleUsdcOrUnknown,
    makePublicClient,
  } = deps

  const localKernelAddress = readBaseOwner(stellarOwner)?.kernelAddress ?? null
  const accounts = [...new Set(indexedBaseAccounts.filter(Boolean).map((a) => String(a).toLowerCase()))]
  if (accounts.length === 0) return { status: 'empty', accounts: [], failedAccounts: [], localKernelAddress }

  let publicClient
  try {
    const { defaultMakePublicClient } = await import('../wallet/passkeyBase.js')
    publicClient = (makePublicClient || defaultMakePublicClient)()
  } catch {
    return { status: 'unavailable', accounts: [], failedAccounts: accounts, localKernelAddress }
  }

  const settled = await Promise.allSettled(
    accounts.map(async (account) => {
      const [positions, idleUsdc] = await Promise.all([
        readPositions({ pools: BASE_POOL_CATALOG.map((p) => p.address), account, publicClient }),
        readIdleUsdc({ account, publicClient }),
      ])
      return { kernelAddress: account, positions, idleUsdc }
    })
  )
  const okAccounts = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value)
  const failedAccounts = accounts.filter((_, i) => settled[i].status === 'rejected')
  if (okAccounts.length === 0) return { status: 'unavailable', accounts: [], failedAccounts, localKernelAddress }

  const mismatched =
    localKernelAddress != null &&
    !accounts.includes(localKernelAddress.toLowerCase())
  return {
    status: mismatched ? 'mismatched' : 'known',
    accounts: okAccounts,
    failedAccounts,
    localKernelAddress,
  }
}
