import { describe, it, expect, vi } from 'vitest'
import { normalizeBaseChildren, readBasePositions } from './baseChildPositions.js'
import { BASE_CHAIN } from '../base/config.js'
import { BASE_POOL_CATALOG } from '../config.js'

const KERNEL = '0xKERNEL'
const POOL_A = BASE_POOL_CATALOG[0].address
const POOL_B = BASE_POOL_CATALOG[1].address

// Mirrors readOwnerMoney.test.js's own baseChild() fixture exactly (same row.baseChildren shape
// associations.js's joinBaseAssociations produces).
function child(overrides = {}) {
  return {
    allocationId: 'run1:bridge:aave-v3',
    runId: 'run1',
    poolAddress: POOL_A,
    proxyTarget: 'aave-v3',
    amount: { token: 'USDC', units: '400000', decimals: 6 },
    grantTxHash: '0xgrant',
    baseJobId: 'job1',
    kernelAddress: KERNEL,
    mandateBindingId: 'b1',
    mandateBindingHash: '0xbh',
    executionStatus: 'deposited',
    custody: { location: 'base-proxy' },
    txHash: '0xtx',
    association: 'known',
    associationSource: 'relayer-attested',
    reportedAt: 1000,
    scopeCheckedAt: 1000,
    freshness: 'fresh',
    ...overrides,
  }
}

describe('normalizeBaseChildren', () => {
  it('keeps every distinct child -- two sharing one position, one separate -- never picks a representative', () => {
    const shared1 = child({ allocationId: 'run1:a', poolAddress: POOL_A, kernelAddress: KERNEL })
    const shared2 = child({ allocationId: 'run2:a', poolAddress: POOL_A, kernelAddress: KERNEL })
    const separate = child({ allocationId: 'run3:b', poolAddress: POOL_B, kernelAddress: KERNEL })
    const out = normalizeBaseChildren([shared1, shared2, separate])

    expect(out.children.map((c) => c.allocationId).sort()).toEqual(['run1:a', 'run2:a', 'run3:b'])
    expect(out.groups).toHaveLength(2)
    const sharedGroup = out.groups.find((g) => g.poolAddress === POOL_A.toLowerCase())
    expect(sharedGroup.childAllocationIds.sort()).toEqual(['run1:a', 'run2:a'])
    const separateGroup = out.groups.find((g) => g.poolAddress === POOL_B.toLowerCase())
    expect(separateGroup.childAllocationIds).toEqual(['run3:b'])
  })

  it('is order-independent: the same set fed in scrambled order yields byte-identical output', () => {
    const a = child({ allocationId: 'run1:a', poolAddress: POOL_A })
    const b = child({ allocationId: 'run2:b', poolAddress: POOL_B, kernelAddress: '0xOTHERKERNEL' })
    const c = child({ allocationId: 'run3:c', poolAddress: POOL_A, reportedAt: 2000 })

    const forward = normalizeBaseChildren([a, b, c])
    const scrambled = normalizeBaseChildren([c, a, b])
    expect(scrambled).toEqual(forward)
  })

  it('accepts the full concatenation of every page and never truncates it (pagination is the caller problem, R1)', () => {
    const page1 = [child({ allocationId: 'run1:a' })]
    const page2 = [child({ allocationId: 'run2:a', poolAddress: POOL_B })]
    const out = normalizeBaseChildren([...page1, ...page2])
    expect(out.children).toHaveLength(2)
  })

  it('stable-dedupes an exact duplicate (same allocationId, byte-identical fields) to one entry', () => {
    const one = child({ allocationId: 'run1:a' })
    const dupe = child({ allocationId: 'run1:a' }) // identical fields, e.g. the same row seen on two pages
    const out = normalizeBaseChildren([one, dupe])
    expect(out.children).toHaveLength(1)
    expect(out.conflicts).toEqual([])
  })

  it('reports a conflicting immutable duplicate instead of silently picking one', () => {
    const original = child({ allocationId: 'run1:a', poolAddress: POOL_A })
    const conflicting = child({ allocationId: 'run1:a', poolAddress: POOL_B }) // same ID, disagreeing vault
    const out = normalizeBaseChildren([original, conflicting])
    expect(out.children).toEqual([]) // neither is trusted
    expect(out.conflicts).toHaveLength(1)
    expect(out.conflicts[0].allocationId).toBe('run1:a')
    expect(out.conflicts[0].entries).toHaveLength(2)
  })

  it('does not treat an execution-status progression (queued -> deposited) as a conflict', () => {
    const queued = child({
      allocationId: 'run1:a',
      executionStatus: 'queued',
      reportedAt: 1000,
      custody: { location: 'in-transit' },
    })
    const deposited = child({
      allocationId: 'run1:a',
      executionStatus: 'deposited',
      reportedAt: 2000,
      custody: { location: 'base-proxy' },
    })
    const out = normalizeBaseChildren([queued, deposited])
    expect(out.conflicts).toEqual([])
    expect(out.children).toHaveLength(1)
    // the most information-bearing (latest) report survives as the representative
    expect(out.children[0].executionStatus).toBe('deposited')
  })

  it('validates owner binding: a child missing its mandateBindingId is excluded, never silently trusted', () => {
    const noBinding = child({ allocationId: 'run1:a', mandateBindingId: '' })
    const out = normalizeBaseChildren([noBinding])
    expect(out.children).toEqual([])
    expect(out.invalid).toEqual([noBinding])
  })

  it('validates owner binding: a child not relayer-attested is excluded', () => {
    const unattested = child({ allocationId: 'run1:a', associationSource: 'self-reported' })
    const out = normalizeBaseChildren([unattested])
    expect(out.children).toEqual([])
    expect(out.invalid).toEqual([unattested])
  })

  it('groups the same vault with a distinct asset as two separate groups', () => {
    const usdc = child({
      allocationId: 'run1:a',
      poolAddress: POOL_A,
      amount: { token: 'USDC', units: '1', decimals: 6 },
    })
    const otherAsset = child({
      allocationId: 'run2:a',
      poolAddress: POOL_A,
      amount: { token: 'EURC', units: '1', decimals: 6 },
    })
    const out = normalizeBaseChildren([usdc, otherAsset])
    expect(out.groups).toHaveLength(2)
    expect(out.groups.map((g) => g.asset).sort()).toEqual(['eurc', 'usdc'])
  })

  it('groups by lowercase chainId:kernel:vault:asset, case-insensitively', () => {
    const lower = child({ allocationId: 'run1:a', kernelAddress: '0xabc', poolAddress: POOL_A })
    const upper = child({ allocationId: 'run2:a', kernelAddress: '0xABC', poolAddress: POOL_A })
    const out = normalizeBaseChildren([lower, upper])
    expect(out.groups).toHaveLength(1)
    expect(out.groups[0].groupKey).toBe(`${BASE_CHAIN.id}:0xabc:${POOL_A.toLowerCase()}:usdc`)
  })

  it('handles large units without precision loss (BigInt, never Number)', () => {
    const big = child({
      allocationId: 'run1:a',
      amount: { token: 'USDC', units: '123456789012345678901234567890', decimals: 6 },
    })
    const out = normalizeBaseChildren([big])
    expect(out.children[0].amount.units).toBe('123456789012345678901234567890')
  })

  it('marks a group hasTerminal only when at least one of its children actually landed', () => {
    const inFlight = child({ allocationId: 'run1:a', executionStatus: 'queued' })
    const out = normalizeBaseChildren([inFlight])
    expect(out.groups[0].hasTerminal).toBe(false)

    const landed = child({ allocationId: 'run2:a', poolAddress: POOL_B, executionStatus: 'held' })
    const out2 = normalizeBaseChildren([landed])
    expect(out2.groups[0].hasTerminal).toBe(true)
  })

  it('a second device with an empty local/browser cache still normalizes purely from the given children (no local hint upgrades coverage)', () => {
    // normalizeBaseChildren takes no localStorage/browser input at all -- this is a structural
    // guarantee (same call, same output) rather than something that could vary with device state.
    const out1 = normalizeBaseChildren([child({ allocationId: 'run1:a' })])
    const out2 = normalizeBaseChildren([child({ allocationId: 'run1:a' })])
    expect(out2).toEqual(out1)
  })

  it('an empty input never throws and returns fully empty buckets', () => {
    expect(normalizeBaseChildren([])).toEqual({
      children: [],
      groups: [],
      conflicts: [],
      invalid: [],
    })
    expect(normalizeBaseChildren(undefined)).toEqual({
      children: [],
      groups: [],
      conflicts: [],
      invalid: [],
    })
  })
})

describe('readBasePositions', () => {
  function clientWithReads({
    balances = {},
    assets = {},
    blockNumber = 111n,
    fail = new Set(),
  } = {}) {
    const calls = []
    return {
      calls,
      getBlockNumber: vi.fn(async () => blockNumber),
      readContract: vi.fn(async ({ address, functionName, args, blockNumber: bn }) => {
        calls.push({ address, functionName, args, blockNumber: bn })
        const key = `${functionName}:${address.toLowerCase()}`
        if (fail.has(key)) throw new Error('rpc down')
        if (functionName === 'balanceOf') return balances[address.toLowerCase()] ?? 0n
        if (functionName === 'convertToAssets') return assets[address.toLowerCase()] ?? 0n
        throw new Error(`unexpected functionName ${functionName}`)
      }),
    }
  }

  it('gets one common block and applies it to both the balanceOf and convertToAssets read for one group', async () => {
    const publicClient = clientWithReads({
      balances: { [POOL_A.toLowerCase()]: 5n },
      assets: { [POOL_A.toLowerCase()]: 500_000n },
      blockNumber: 999n,
    })
    const out = await readBasePositions({
      groups: [{ kernelAddress: KERNEL, poolAddress: POOL_A }],
      publicClient,
    })
    expect(out.blockNumber).toBe(999n)
    expect(out.positions).toEqual([
      {
        kernelAddress: KERNEL.toLowerCase(),
        poolAddress: POOL_A.toLowerCase(),
        shares: 5n,
        assets: 500_000n,
        state: 'known',
      },
    ])
    const balanceCall = publicClient.calls.find((c) => c.functionName === 'balanceOf')
    const assetsCall = publicClient.calls.find((c) => c.functionName === 'convertToAssets')
    expect(balanceCall.blockNumber).toBe(999n)
    expect(assetsCall.blockNumber).toBe(999n)
  })

  it('shares the SAME block across every group in the batch, not one getBlockNumber per group', async () => {
    const publicClient = clientWithReads({
      balances: { [POOL_A.toLowerCase()]: 1n, [POOL_B.toLowerCase()]: 1n },
      assets: { [POOL_A.toLowerCase()]: 1n, [POOL_B.toLowerCase()]: 1n },
    })
    await readBasePositions({
      groups: [
        { kernelAddress: KERNEL, poolAddress: POOL_A },
        { kernelAddress: KERNEL, poolAddress: POOL_B },
      ],
      publicClient,
    })
    expect(publicClient.getBlockNumber).toHaveBeenCalledTimes(1)
  })

  it('a successful balanceOf of exactly 0 is a known zero, never conflated with a failed read', async () => {
    const publicClient = clientWithReads({ balances: { [POOL_A.toLowerCase()]: 0n } })
    const out = await readBasePositions({
      groups: [{ kernelAddress: KERNEL, poolAddress: POOL_A }],
      publicClient,
    })
    expect(out.positions[0]).toEqual({
      kernelAddress: KERNEL.toLowerCase(),
      poolAddress: POOL_A.toLowerCase(),
      shares: 0n,
      assets: 0n,
      state: 'known',
    })
    // no convertToAssets call needed for a zero balance
    expect(publicClient.calls.some((c) => c.functionName === 'convertToAssets')).toBe(false)
  })

  it('a failed balanceOf read is unavailable (null), never a fabricated zero', async () => {
    const publicClient = clientWithReads({ fail: new Set([`balanceOf:${POOL_A.toLowerCase()}`]) })
    const out = await readBasePositions({
      groups: [{ kernelAddress: KERNEL, poolAddress: POOL_A }],
      publicClient,
    })
    expect(out.positions[0]).toEqual({
      kernelAddress: KERNEL.toLowerCase(),
      poolAddress: POOL_A.toLowerCase(),
      shares: null,
      assets: null,
      state: 'unavailable',
    })
  })

  it('one group failing does not blank out a sibling group that succeeded', async () => {
    const publicClient = clientWithReads({
      balances: { [POOL_A.toLowerCase()]: 5n, [POOL_B.toLowerCase()]: 2n },
      assets: { [POOL_B.toLowerCase()]: 200_000n },
      fail: new Set([`convertToAssets:${POOL_A.toLowerCase()}`]),
    })
    const out = await readBasePositions({
      groups: [
        { kernelAddress: KERNEL, poolAddress: POOL_A },
        { kernelAddress: KERNEL, poolAddress: POOL_B },
      ],
      publicClient,
    })
    const a = out.positions.find((p) => p.poolAddress === POOL_A.toLowerCase())
    const b = out.positions.find((p) => p.poolAddress === POOL_B.toLowerCase())
    expect(a.state).toBe('unavailable')
    expect(b).toEqual({
      kernelAddress: KERNEL.toLowerCase(),
      poolAddress: POOL_B.toLowerCase(),
      shares: 2n,
      assets: 200_000n,
      state: 'known',
    })
  })

  it('dedupes the same kernel+pool pair to one read', async () => {
    const publicClient = clientWithReads({ balances: { [POOL_A.toLowerCase()]: 0n } })
    await readBasePositions({
      groups: [
        { kernelAddress: KERNEL, poolAddress: POOL_A },
        { kernelAddress: KERNEL, poolAddress: POOL_A },
      ],
      publicClient,
    })
    expect(publicClient.readContract).toHaveBeenCalledTimes(1)
  })

  it('an empty group list never touches the network', async () => {
    const publicClient = clientWithReads()
    const out = await readBasePositions({ groups: [], publicClient })
    expect(out).toEqual({ status: 'known', blockNumber: null, positions: [] })
    expect(publicClient.getBlockNumber).not.toHaveBeenCalled()
  })

  it('a missing publicClient (e.g. wallet/passkeyBase.js could not be constructed) is unavailable, never zero', async () => {
    const out = await readBasePositions({
      groups: [{ kernelAddress: KERNEL, poolAddress: POOL_A }],
      publicClient: null,
    })
    expect(out.status).toBe('unavailable')
    expect(out.positions[0].state).toBe('unavailable')
  })

  it('a getBlockNumber failure makes the whole batch unavailable, never a partial guess', async () => {
    const publicClient = {
      getBlockNumber: vi.fn(async () => {
        throw new Error('rpc down')
      }),
      readContract: vi.fn(),
    }
    const out = await readBasePositions({
      groups: [{ kernelAddress: KERNEL, poolAddress: POOL_A }],
      publicClient,
    })
    expect(out.status).toBe('unavailable')
    expect(out.blockNumber).toBeNull()
    expect(publicClient.readContract).not.toHaveBeenCalled()
  })
})
