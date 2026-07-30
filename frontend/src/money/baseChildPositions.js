// frontend/src/money/baseChildPositions.js
// Task 10: the honest replacement for readOwnerMoney.js's old `latestBaseChild` picker. A bridge
// agent can carry more than one durable Base child (two separate runs/allocations that both landed
// real money -- e.g. two deposits into the same pool, or two different pools entirely) -- picking
// "the freshest one" silently discarded proven money. See task-10-interface-notes.md's Known
// Hazards table and R1/R5 for why this file's two exports are scoped the way they are.
//
// Two separate, small responsibilities live here because they're both "Base child position" math,
// not because they share code:
//   - normalizeBaseChildren: turns ONE agent's row.baseChildren[] evidence (the association-joined
//     shape associations.js's joinBaseAssociations already produces -- allocationId, kernelAddress,
//     poolAddress, amount, executionStatus, custody, mandateBindingId, association,
//     associationSource, reportedAt, freshness) into a deduped, conflict-checked, grouped set.
//     Never silently picks a representative for the caller.
//   - readBasePositions: the pinned on-chain valuation half -- one shared block for the whole
//     batch of kernel+pool pairs, so no two reads in the same render can straddle a block.
//
// R1 (task-10-interface-notes.md): no paginated D1 reader exists anywhere in this tree today --
// normalizeBaseChildren just takes "an array in" (the full concatenation of every page, whenever
// pagination exists) and is provably order-independent; it never fetches, never pages, never
// touches store.js/associations.js.
import { ERC20_ABI, ERC4626_ABI, BASE_CHAIN } from '../base/config.js'

const TERMINAL_BASE_STATUSES = new Set(['deposited', 'held'])

// Deterministic stringify (sorted keys) -- two objects that are the SAME data in a different key
// order must still compare equal for the conflict check below.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
}

// The fields an honest re-report of the SAME allocation must never disagree on -- mirrors the
// store-side immutability contract for the sibling 0006 base_child_intents table (interface notes'
// "Immutable identity + conflict representation"). executionStatus/custody/txHash are NOT in this
// fingerprint: a status progression (queued -> deposited) is expected and is not a conflict; only a
// same-ID entry whose PLACE or AMOUNT identity disagrees is.
function immutableFingerprint(child) {
  return canonicalJson({
    kernelAddress: String(child.kernelAddress ?? '').toLowerCase(),
    poolAddress: String(child.poolAddress ?? '').toLowerCase(),
    amount: child.amount ?? null,
    mandateBindingId: child.mandateBindingId ?? null,
    mandateBindingHash: child.mandateBindingHash ?? null,
  })
}

// "Owner binding" = the funding_router.grant mandate this Base execution is tied back to
// (mandateBindingId) -- the ONE signature the owner actually made (CLAUDE.md's single-signature
// grant). A child missing it, or not itself relayer-attested, cannot be trusted as belonging to
// this owner's authorized mandate -- excluded from valuation, never silently trusted.
function hasValidOwnerBinding(child) {
  return (
    child.association === 'known' &&
    child.associationSource === 'relayer-attested' &&
    typeof child.mandateBindingId === 'string' &&
    child.mandateBindingId.trim() !== ''
  )
}

function groupKeyFor(child) {
  const kernel = String(child.kernelAddress ?? '').toLowerCase()
  const vault = String(child.poolAddress ?? '').toLowerCase()
  const asset = String(child.amount?.token ?? '').toLowerCase()
  return `${BASE_CHAIN.id}:${kernel}:${vault}:${asset}`
}

const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Consumes the FULL concatenation of every page of one agent's row.baseChildren evidence (paging,
 * wherever it eventually exists, is the caller's problem -- R1). Never picks a "latest"
 * representative: every distinct, validly-bound child survives, grouped by the real on-chain
 * position it shares with any sibling (same kernel+vault+asset -- shares in an ERC-4626 vault are
 * fungible per kernel, so two allocations landing in the same vault ARE one on-chain position).
 * @param {Array<object>} children row.baseChildren-shaped records (associations.js:joinBaseAssociations)
 * @returns {{
 *   children: Array<object>,            // valid, deduped children -- order-independent
 *   groups: Array<{groupKey:string, kernelAddress:string, poolAddress:string, asset:string,
 *     childAllocationIds:string[], hasTerminal:boolean}>,
 *   conflicts: Array<{allocationId:string, entries:object[]}>,  // same ID, disagreeing immutable fields
 *   invalid: Array<object>,             // owner-binding-invalid entries, excluded from groups
 * }}
 */
export function normalizeBaseChildren(children) {
  const byAllocation = new Map()
  const invalid = []

  for (const child of children ?? []) {
    if (!child || typeof child.allocationId !== 'string' || !child.allocationId) {
      if (child) invalid.push(child)
      continue
    }
    if (!hasValidOwnerBinding(child)) {
      invalid.push(child)
      continue
    }
    const fingerprint = immutableFingerprint(child)
    const existing = byAllocation.get(child.allocationId)
    if (!existing) {
      byAllocation.set(child.allocationId, { entry: child, fingerprint, all: [child] })
      continue
    }
    existing.all.push(child)
    if (fingerprint !== existing.fingerprint) {
      existing.conflicting = true
    } else if (Number(child.reportedAt ?? 0) > Number(existing.entry.reportedAt ?? 0)) {
      // Same immutable identity, later report -- a legitimate status progression
      // (queued -> deposited), not a conflict. Keep the most information-bearing entry.
      existing.entry = child
    }
  }

  const conflicts = []
  const validChildren = []
  for (const [allocationId, rec] of byAllocation) {
    if (rec.conflicting) {
      conflicts.push({ allocationId, entries: rec.all })
    } else {
      validChildren.push(rec.entry)
    }
  }

  // Order-independence: sort once, at the very end, so the SAME set fed in any input/page order
  // produces a byte-identical result -- never a "latest wins" or "first wins" artifact of order.
  validChildren.sort((a, b) => byString(a.allocationId, b.allocationId))
  conflicts.sort((a, b) => byString(a.allocationId, b.allocationId))

  const groupsByKey = new Map()
  for (const child of validChildren) {
    const groupKey = groupKeyFor(child)
    const group = groupsByKey.get(groupKey) ?? {
      groupKey,
      kernelAddress: String(child.kernelAddress ?? '').toLowerCase(),
      poolAddress: String(child.poolAddress ?? '').toLowerCase(),
      asset: String(child.amount?.token ?? '').toLowerCase(),
      childAllocationIds: [],
      hasTerminal: false,
    }
    group.childAllocationIds.push(child.allocationId)
    if (TERMINAL_BASE_STATUSES.has(child.executionStatus)) group.hasTerminal = true
    groupsByKey.set(groupKey, group)
  }
  const groups = [...groupsByKey.values()].sort((a, b) => byString(a.groupKey, b.groupKey))

  return { children: validChildren, groups, conflicts, invalid }
}

function dedupeGroupPairs(groups) {
  const seen = new Map()
  for (const g of groups ?? []) {
    if (!g?.kernelAddress || !g?.poolAddress) continue
    const kernelAddress = String(g.kernelAddress).toLowerCase()
    const poolAddress = String(g.poolAddress).toLowerCase()
    const key = `${kernelAddress}:${poolAddress}`
    if (!seen.has(key)) seen.set(key, { kernelAddress, poolAddress })
  }
  return [...seen.values()]
}

/**
 * Pinned on-chain valuation for a batch of Base positions (kernel+pool pairs). ONE shared block
 * for the whole batch (`getBlockNumber()` once) -- a position's own `balanceOf(kernel)` and
 * `convertToAssets(shares)` reads must never straddle a block, and every group in one call shares
 * that SAME block so nothing in a single dashboard render is valued a heartbeat apart from
 * anything else. `convertToAssets` is a labeled current estimate only -- never `maxWithdraw` (no
 * ABI fragment for it exists in this codebase) and never per-child yield attribution; a group's
 * `assets` figure is the CURRENT combined worth of every child landed in it, nothing more.
 * A successful `balanceOf` of exactly 0 is a KNOWN zero (`state:'known'`, `assets: 0n`) -- never
 * conflated with a failed read (`state:'unavailable'`, `assets: null`).
 * @param {{ groups: Array<{kernelAddress:string, poolAddress:string}>, publicClient: object }} p
 * @returns {Promise<{status:'unavailable'|'known', blockNumber: bigint|null,
 *   positions: Array<{kernelAddress:string, poolAddress:string, shares:bigint|null,
 *   assets:bigint|null, state:'known'|'unavailable'}>}>}
 */
export async function readBasePositions({ groups, publicClient }) {
  const uniqueGroups = dedupeGroupPairs(groups)
  if (uniqueGroups.length === 0) return { status: 'known', blockNumber: null, positions: [] }
  if (!publicClient) {
    return {
      status: 'unavailable',
      blockNumber: null,
      positions: uniqueGroups.map((g) => ({
        ...g,
        shares: null,
        assets: null,
        state: 'unavailable',
      })),
    }
  }

  let blockNumber
  try {
    blockNumber = await publicClient.getBlockNumber()
  } catch {
    return {
      status: 'unavailable',
      blockNumber: null,
      positions: uniqueGroups.map((g) => ({
        ...g,
        shares: null,
        assets: null,
        state: 'unavailable',
      })),
    }
  }

  const settled = await Promise.allSettled(
    uniqueGroups.map(async (g) => {
      const rawShares = await publicClient.readContract({
        address: g.poolAddress,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [g.kernelAddress],
        blockNumber,
      })
      const shares = BigInt(rawShares)
      if (shares === 0n) return { ...g, shares: 0n, assets: 0n, state: 'known' }
      const rawAssets = await publicClient.readContract({
        address: g.poolAddress,
        abi: ERC4626_ABI,
        functionName: 'convertToAssets',
        args: [shares],
        blockNumber,
      })
      return { ...g, shares, assets: BigInt(rawAssets), state: 'known' }
    })
  )
  const positions = settled.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { ...uniqueGroups[i], shares: null, assets: null, state: 'unavailable' }
  )
  return { status: 'known', blockNumber, positions }
}
