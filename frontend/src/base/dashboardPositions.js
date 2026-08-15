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
import { readBasePositions as defaultReadBasePositions } from '../money/baseChildPositions.js'
import { BASE_POOL_CATALOG } from '../config.js'
import { ERC20_ABI } from './config.js'
import { readBaseOwner } from '../wallet/baseBinding.js'

// Same withdraw-floor tolerance readPositions.js used to apply per pool -- kept here now that this
// file computes minAssets itself (Task 10 moved the actual balanceOf/convertToAssets reads into
// baseChildPositions.js's readBasePositions so they can share one pinned block).
const DEFAULT_SLIPPAGE_BPS = 50 // 0.5%

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

/**
 * My Money Task 13 (Part B item 4): the retired `loadBasePositions` this function replaces gated
 * on a purely LOCAL `BaseOwnerRecordV2` and returned `[]` on a new device even when
 * `loadIndexedBasePositions` (below) — the SAME reader readOwnerMoney.js already uses for the
 * `/agent` money model — could see real, proven Base custody for that owner. Same device, two
 * readers, opposite answers: the dashboard showed an empty Base panel beside a money model
 * reporting Base custody. Collapsed into one: this is now a thin, single-account convenience over
 * `loadIndexedBasePositions`, scoped to exactly what a withdraw/recover ceremony needs — THIS
 * device's own currently-bound kernel (the passkey is bound to exactly one) — never a second,
 * independently gated read path. Same `[]` fail-soft contract the retired function made (no owner
 * record, no positions, any RPC failure); the underlying reader's own status
 * ('unavailable'|'empty'|'known'|'mismatched') is deliberately not surfaced here — a caller that
 * needs the owner-wide picture (proven cross-device custody, not just this device's own kernel)
 * should call `loadIndexedBasePositions` directly instead, the way readOwnerMoney.js already does.
 */
export async function loadDeviceBasePositions({ stellarOwner, deps = {} } = {}) {
  // No Base owner ever created for this stellarOwner -> nothing to read. Bail BEFORE touching
  // the network so a Stellar-only user's poll never fires a Base RPC call.
  const owner = readBaseOwner(stellarOwner)
  if (!owner) return []

  const result = await loadIndexedBasePositions({
    stellarOwner,
    indexedBaseAccounts: [owner.kernelAddress],
    deps,
  })
  const positions = result.accounts[0]?.positions ?? []
  return positions.map((pos) => {
    const cat = BASE_POOL_CATALOG.find((p) => p.address.toLowerCase() === pos.pool.toLowerCase())
    // apy rides along so the dashboard's daily-earnings estimate can include Base pools
    // instead of silently treating cross-chain capital as idle.
    return { ...pos, poolName: cat?.name || pos.pool, apy: cat?.apy || 0 }
  })
}

/**
 * Task 7 (Pocket Crew "My money"): live Base custody for the EXACT kernel addresses Task 5's
 * durable, relayer-attested association already proved for this owner — `indexedBaseAccounts`,
 * never a locally-scanned set. A new device with no BaseOwnerRecordV2 (no passkey ceremony ever
 * run here) can still see confirmed historical custody, because the read is keyed off proven
 * public addresses, not local storage. My Money Task 13: `loadDeviceBasePositions` above is now
 * built on top of this reader rather than duplicating its own local-record gate.
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
 *
 * Task 10: valuation itself (balanceOf + convertToAssets per pool) now runs through
 * baseChildPositions.js's `readBasePositions` instead of readPositions.js's own per-account,
 * unpinned reads -- every kernel x catalog-pool pair in this call is read against the SAME block,
 * so two positions valued a heartbeat apart can no longer straddle a block. An account is only
 * `known` when every one of its own pool reads came back `state:'known'`; any single pool read
 * failing (or the shared block read failing outright) demotes that WHOLE account into
 * `failedAccounts` rather than reporting a partial position list — this keeps the exact
 * all-or-nothing-per-account contract callers already relied on before this task.
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
    readBasePositions = defaultReadBasePositions,
    readIdleUsdc = defaultReadIdleUsdcOrUnknown,
    makePublicClient,
  } = deps

  const localKernelAddress = readBaseOwner(stellarOwner)?.kernelAddress ?? null
  const accounts = [
    ...new Set(indexedBaseAccounts.filter(Boolean).map((a) => String(a).toLowerCase())),
  ]
  if (accounts.length === 0)
    return { status: 'empty', accounts: [], failedAccounts: [], localKernelAddress }

  let publicClient
  try {
    const { defaultMakePublicClient } = await import('../wallet/passkeyBase.js')
    publicClient = (makePublicClient || defaultMakePublicClient)()
  } catch {
    return { status: 'unavailable', accounts: [], failedAccounts: accounts, localKernelAddress }
  }

  const groups = accounts.flatMap((account) =>
    BASE_POOL_CATALOG.map((pool) => ({ kernelAddress: account, poolAddress: pool.address }))
  )
  const [positionsResult, idleSettled] = await Promise.all([
    readBasePositions({ groups, publicClient }).catch(() => ({
      status: 'unavailable',
      blockNumber: null,
      positions: [],
    })),
    Promise.allSettled(accounts.map((account) => readIdleUsdc({ account, publicClient }))),
  ])

  const positionsByKernel = new Map(accounts.map((a) => [a, []]))
  const kernelFailed = new Map(accounts.map((a) => [a, positionsResult.status !== 'known']))
  for (const pos of positionsResult.positions ?? []) {
    const kernel = pos.kernelAddress.toLowerCase()
    if (!positionsByKernel.has(kernel)) continue
    if (pos.state !== 'known') {
      kernelFailed.set(kernel, true)
      continue
    }
    if (pos.shares === 0n) continue // nothing to withdraw from this pool — no assets to carry
    const minAssets = (pos.assets * BigInt(10_000 - DEFAULT_SLIPPAGE_BPS)) / 10_000n
    positionsByKernel
      .get(kernel)
      .push({ pool: pos.poolAddress, shares: pos.shares, assets: pos.assets, minAssets })
  }

  const okAccounts = []
  const failedAccounts = []
  accounts.forEach((account, i) => {
    if (kernelFailed.get(account)) {
      failedAccounts.push(account)
      return
    }
    const idleR = idleSettled[i]
    const idleUsdc = idleR.status === 'fulfilled' ? idleR.value : null
    okAccounts.push({
      kernelAddress: account,
      positions: positionsByKernel.get(account),
      idleUsdc,
    })
  })
  if (okAccounts.length === 0)
    return { status: 'unavailable', accounts: [], failedAccounts, localKernelAddress }

  const mismatched =
    localKernelAddress != null && !accounts.includes(localKernelAddress.toLowerCase())
  return {
    status: mismatched ? 'mismatched' : 'known',
    accounts: okAccounts,
    failedAccounts,
    localKernelAddress,
  }
}
