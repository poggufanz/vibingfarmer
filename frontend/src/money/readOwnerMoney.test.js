import { describe, it, expect, vi } from 'vitest'
import { readOwnerMoney, aggregateOwnerPositions } from './readOwnerMoney.js'
// Real catalog addresses (vite.config.js's test env overrides these away from the hardcoded
// production defaults — see dashboardPositions.test.js's own note on this pattern), needed
// because Fix 4 makes the live-read path unknown (not zero) for any pool outside this catalog.
import { BASE_POOL_CATALOG } from '../config.js'

const OWNER = 'GOWNER234567234567234567234567234567234567234567234567AB'
const NOW = 2_000_000_000_000 // ms

function agentRow(overrides = {}) {
  return {
    address: 'CAGENT',
    scopeReadStatus: 'ok',
    vault: 'CVAULT',
    revoked: false,
    expiry: 9_999_999_999,
    authorized: true,
    association: 'unknown',
    baseChildren: [],
    ...overrides,
  }
}

function discoveryOf(agents, overrides = {}) {
  return {
    status: 'complete',
    networkId: 'stellar-testnet',
    owner: OWNER,
    agents,
    coverage: null,
    hints: {},
    ...overrides,
  }
}

// `shares`/`idle` map address -> bigint | 'throw' (synchronous throw, to exercise the outer
// allSettled) | undefined (falls through to null, i.e. the real functions' own RPC-failure
// convention).
function stellarDeps({ shares = {}, idle = {}, pps = 10_000_000n, aprBps = null } = {}) {
  return {
    readVaultShares: vi.fn((addr) => {
      const v = shares[addr]
      if (v === 'throw') throw new Error('boom')
      return Promise.resolve(v === undefined ? null : v)
    }),
    readTokenBalance: vi.fn((addr) => {
      const v = idle[addr]
      if (v === 'throw') throw new Error('boom')
      return Promise.resolve(v === undefined ? null : v)
    }),
    readPricePerShare: vi.fn(async () => pps),
    readSupplyAprBps: vi.fn(async () => aprBps),
  }
}

function baseDeps(result = { status: 'empty', accounts: [] }) {
  return { loadIndexedBasePositions: vi.fn(async () => result) }
}

// Fix loop 1, Fix 1: the pre-fix fixture had these two backwards (poolAddress: 'CPOOL' [a
// Stellar-looking address], proxyTarget: '0xPOOL' [an EVM-looking slug]) — a shape no upstream
// writer can actually produce. proxyTarget is always a venue SLUG (BASE_POOL_CATALOG's
// `proxyTarget`, e.g. 'aave-v3'); poolAddress is always the EVM pool address readPositions.js
// returns as `pool`. Real catalog address so Fix 4's queried-catalog check also passes it.
const baseChild = (overrides = {}) => ({
  allocationId: 'run1:bridge:aave-v3',
  runId: 'run1',
  poolAddress: BASE_POOL_CATALOG[0].address,
  proxyTarget: BASE_POOL_CATALOG[0].proxyTarget,
  amount: { token: 'USDC', units: '400000', decimals: 6 },
  grantTxHash: '0xgrant',
  baseJobId: 'job1',
  kernelAddress: '0xKERNEL',
  mandateBindingId: 'b1',
  mandateBindingHash: '0xbh',
  executionStatus: 'deposited',
  custody: { location: 'base-proxy' },
  txHash: '0xtx',
  association: 'known',
  associationSource: 'relayer-attested',
  reportedAt: NOW - 1000,
  scopeCheckedAt: NOW - 1000,
  freshness: 'fresh',
  ...overrides,
})

describe('readOwnerMoney', () => {
  it('allSettled: one agent throwing synchronously does not blank out the others', async () => {
    const rows = [agentRow({ address: 'CBOOM' }), agentRow({ address: 'CGOOD' })]
    const stellar = stellarDeps({
      shares: { CBOOM: 'throw', CGOOD: 0n },
      idle: { CGOOD: 0n },
    })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base: baseDeps(),
      now: NOW,
    })
    expect(result.agents).toHaveLength(2)
    const good = result.agents.find((a) => a.address === 'CGOOD')
    expect(good.amount).toEqual({ token: 'USDC', units: '0', decimals: 7 })
    const boom = result.agents.find((a) => a.address === 'CBOOM')
    expect(boom.amount).toBeNull()
    expect(boom.custody).toEqual({ location: 'unknown' })
    expect(boom.problems).toContain('unexpected-error')
  })

  it('revoked and expired agents still have their money counted, flagged as problems', async () => {
    const nowSec = Math.floor(NOW / 1000)
    const rows = [
      agentRow({ address: 'CREV', revoked: true }),
      agentRow({ address: 'CEXP', expiry: nowSec - 1000 }),
    ]
    const stellar = stellarDeps({
      shares: { CREV: 5_000_000n, CEXP: 5_000_000n },
      idle: { CREV: 0n, CEXP: 0n },
    })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base: baseDeps(),
      now: NOW,
    })
    const rev = result.agents.find((a) => a.address === 'CREV')
    expect(rev.problems).toContain('scope-revoked')
    expect(rev.amount).toEqual({ token: 'USDC', units: '5000000', decimals: 7 })
    expect(rev.custody).toEqual({ location: 'stellar-vault' })
    const exp = result.agents.find((a) => a.address === 'CEXP')
    expect(exp.problems).toContain('scope-expired')
    expect(exp.amount).toEqual({ token: 'USDC', units: '5000000', decimals: 7 })
  })

  it('a stranded post-redeem token balance (0 shares, nonzero idle) reports custody agent', async () => {
    const rows = [agentRow({ address: 'CSTRANDED' })]
    const stellar = stellarDeps({
      shares: { CSTRANDED: 0n },
      idle: { CSTRANDED: 500_0000n },
    })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base: baseDeps(),
      now: NOW,
    })
    const a = result.agents[0]
    expect(a.vaultShares).toEqual({
      state: 'known',
      amount: { token: 'USDC', units: '0', decimals: 7 },
      checkedAt: NOW,
    })
    expect(a.idleToken).toEqual({
      state: 'known',
      amount: { token: 'USDC', units: '5000000', decimals: 7 },
      checkedAt: NOW,
    })
    expect(a.amount).toEqual({ token: 'USDC', units: '5000000', decimals: 7 })
    expect(a.custody).toEqual({ location: 'agent' })
  })

  it('an RPC partial failure (idle known, shares unavailable) reports amount unavailable, never a guess', async () => {
    const rows = [agentRow({ address: 'CPARTIAL' })]
    const stellar = stellarDeps({
      shares: {}, // undefined -> null (RPC failure)
      idle: { CPARTIAL: 300n },
    })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base: baseDeps(),
      now: NOW,
    })
    const a = result.agents[0]
    expect(a.vaultShares.state).toBe('unavailable')
    expect(a.idleToken.state).toBe('known')
    expect(a.amount).toBeNull()
    expect(a.problems).toContain('vault-shares-unavailable')
  })

  it('a price-per-share failure with a positive share count cannot be valued -> amount unavailable', async () => {
    const rows = [agentRow({ address: 'CPPS' })]
    const stellar = stellarDeps({
      shares: { CPPS: 1000n },
      idle: { CPPS: 0n },
      pps: null,
    })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base: baseDeps(),
      now: NOW,
    })
    const a = result.agents[0]
    expect(a.vaultShares.state).toBe('unavailable')
    expect(a.amount).toBeNull()
    expect(a.problems).toContain('vault-shares-unavailable')
  })

  it('a price-per-share failure with exactly 0 shares is still a known zero (no price needed)', async () => {
    const rows = [agentRow({ address: 'CPPSZERO' })]
    const stellar = stellarDeps({
      shares: { CPPSZERO: 0n },
      idle: { CPPSZERO: 0n },
      pps: null,
    })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base: baseDeps(),
      now: NOW,
    })
    const a = result.agents[0]
    expect(a.vaultShares).toEqual({
      state: 'known',
      amount: { token: 'USDC', units: '0', decimals: 7 },
      checkedAt: NOW,
    })
    expect(a.amount).toEqual({ token: 'USDC', units: '0', decimals: 7 })
  })

  it('a Base binding mismatch (this device is not the kernel that produced the custody) still surfaces the proven amount', async () => {
    const rows = [
      agentRow({
        address: 'CBRIDGE',
        association: 'known',
        baseChildren: [
          baseChild({ executionStatus: 'deposited', custody: { location: 'base-proxy' } }),
        ],
      }),
    ]
    const stellar = stellarDeps({ shares: { CBRIDGE: 0n }, idle: { CBRIDGE: 0n } })
    const base = baseDeps({
      status: 'mismatched',
      accounts: [
        {
          kernelAddress: '0xkernel',
          positions: [
            {
              pool: BASE_POOL_CATALOG[0].address,
              shares: 5n,
              assets: 500_000n,
              minAssets: 495_000n,
            },
          ],
          idleUsdc: 0n,
        },
      ],
    })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base,
      now: NOW,
    })
    expect(result.baseBindingStatus).toBe('mismatched')
    const a = result.agents[0]
    expect(a.executionStatus).toBe('succeeded')
    expect(a.custody).toEqual({ location: 'base-proxy' })
    // 500_000 base units at 6dp -> canonical 7dp: 5_000_000
    expect(a.amount).toEqual({ token: 'USDC', units: '5000000', decimals: 7 })
  })

  it('an in-transit job reports the durable evidence directly and never triggers a live Base read', async () => {
    const rows = [
      agentRow({
        address: 'CINFLIGHT',
        association: 'known',
        baseChildren: [
          baseChild({
            kernelAddress: '0xKERNEL2',
            executionStatus: 'burn-confirmed',
            custody: { location: 'in-transit' },
            amount: { token: 'USDC', units: '250000', decimals: 6 },
          }),
        ],
      }),
    ]
    const stellar = stellarDeps({ shares: { CINFLIGHT: 0n }, idle: { CINFLIGHT: 0n } })
    const base = baseDeps()
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base,
      now: NOW,
    })
    expect(base.loadIndexedBasePositions).not.toHaveBeenCalled()
    const a = result.agents[0]
    expect(a.executionStatus).toBe('executing')
    expect(a.custody).toEqual({ location: 'in-transit' })
    expect(a.amount).toEqual({ token: 'USDC', units: '2500000', decimals: 7 })
  })

  // Fix loop 1, Fix 3: the `if (child)` branch used to set `amount` from Base evidence only,
  // dropping a known-positive Stellar leg (vaultShares/idleToken) entirely, and overriding
  // `custody` with the Base child's location so custodyBreakdown lost the Stellar money too.
  it('an agent with both a nonzero Stellar vault balance and a Base child reports a total covering both (fix loop 1, Fix 3)', async () => {
    const rows = [
      agentRow({
        address: 'CSPLIT',
        association: 'known',
        baseChildren: [
          baseChild({ executionStatus: 'deposited', custody: { location: 'base-proxy' } }),
        ],
      }),
    ]
    const stellar = stellarDeps({ shares: { CSPLIT: 5_000_000n }, idle: { CSPLIT: 0n } })
    const base = baseDeps({
      status: 'known',
      accounts: [
        {
          kernelAddress: '0xkernel',
          positions: [
            {
              pool: BASE_POOL_CATALOG[0].address,
              shares: 5n,
              assets: 500_000n,
              minAssets: 495_000n,
            },
          ],
          idleUsdc: 0n,
        },
      ],
    })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base,
      now: NOW,
    })
    const a = result.agents[0]
    // 5_000_000 (Stellar, already 7dp) + 500_000 base units at 6dp -> canonical 5_000_000 = 10_000_000
    expect(a.amount).toEqual({ token: 'USDC', units: '10000000', decimals: 7 })
    // A genuine split (both legs known-positive) cannot honestly collapse to one location.
    expect(a.custody).toEqual({ location: 'unknown' })
  })

  it('an agent with a failed Base child but a known Stellar idle balance does not null out the known half (fix loop 1, Fix 3)', async () => {
    const rows = [
      agentRow({
        address: 'CFAILEDBASE',
        association: 'known',
        baseChildren: [
          baseChild({
            executionStatus: 'failed',
            custody: { location: 'unknown' },
          }),
        ],
      }),
    ]
    const stellar = stellarDeps({ shares: { CFAILEDBASE: 0n }, idle: { CFAILEDBASE: 500_0000n } })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base: baseDeps(),
      now: NOW,
    })
    const a = result.agents[0]
    expect(a.problems).toContain('base-execution-failed')
    // the known Stellar idle balance (5_000_000) must still surface, not be nulled by the failure
    expect(a.amount).toEqual({ token: 'USDC', units: '5000000', decimals: 7 })
  })

  // Fix loop 1, Fix 2: a stale reported figure (kept as visible evidence) must not be
  // indistinguishable from a fresh confirmed read at the aggregate — see the 'is partial when an
  // agent carries a stale...' test in the aggregateOwnerPositions block below for the downgrade.
  it('a terminal Base child whose live account cannot be found falls back to the reported figure and flags it stale (fix loop 1, Fix 2)', async () => {
    const rows = [
      agentRow({
        address: 'CSTALE',
        association: 'known',
        baseChildren: [baseChild({ executionStatus: 'held', custody: { location: 'base-proxy' } })],
      }),
    ]
    const stellar = stellarDeps({ shares: { CSTALE: 0n }, idle: { CSTALE: 0n } })
    // Base read runs but never returns THIS kernel's account (e.g. it was mid-rotation) — the map
    // built from `accounts` simply has no entry, matching the current base-read-unavailable path.
    const base = baseDeps({ status: 'known', accounts: [] })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base,
      now: NOW,
    })
    const a = result.agents[0]
    expect(a.problems).toContain('base-read-unavailable')
    // 400_000 reported base units at 6dp -> canonical 7dp: 4_000_000, kept visible as evidence
    expect(a.amount).toEqual({ token: 'USDC', units: '4000000', decimals: 7 })
  })

  // Fix loop 1, Fix 4: liveUnitsForPool used to treat "pool absent from the returned positions"
  // as a confirmed zero even when the pool was never in the queried catalog at all (a historical
  // or retired allocation) — loadIndexedBasePositions only ever queries BASE_POOL_CATALOG
  // addresses, so an uncatalogued pool is unknown, not zero.
  it('a child whose pool is absent from the queried Base catalog yields an unknown amount, never a fabricated zero (fix loop 1, Fix 4)', async () => {
    const rows = [
      agentRow({
        address: 'CUNCATALOGED',
        association: 'known',
        baseChildren: [
          baseChild({
            poolAddress: '0x000000000000000000000000000000000000dEaD', // not in BASE_POOL_CATALOG
            proxyTarget: 'retired-venue',
            executionStatus: 'deposited',
            custody: { location: 'base-proxy' },
          }),
        ],
      }),
    ]
    const stellar = stellarDeps({ shares: { CUNCATALOGED: 0n }, idle: { CUNCATALOGED: 0n } })
    const base = baseDeps({
      status: 'known',
      accounts: [{ kernelAddress: '0xkernel', positions: [], idleUsdc: 0n }],
    })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base,
      now: NOW,
    })
    const a = result.agents[0]
    expect(a.problems).toContain('base-read-unavailable')
    // falls back to the reported evidence rather than the liveUnitsForPool fabricated zero
    // pre-fix (400_000 base units at 6dp -> canonical 7dp: 4_000_000)
    expect(a.amount).toEqual({ token: 'USDC', units: '4000000', decimals: 7 })
  })

  // Fix loop 1, Fix 8 (bullet 1): a reported amount at finer precision than the canonical scale
  // used to be silently truncated via integer BigInt division — decided: reject (unavailable),
  // never truncate, since truncation is silent money loss with no signal to the caller.
  it('a reported Base amount finer than canonical precision is rejected, never silently truncated (fix loop 1, Fix 8)', async () => {
    const rows = [
      agentRow({
        address: 'CFINE',
        association: 'known',
        baseChildren: [
          baseChild({
            executionStatus: 'burn-confirmed', // in-flight: uses the reported amount directly
            amount: { token: 'USDC', units: '123456789', decimals: 9 }, // finer than canonical 7dp
          }),
        ],
      }),
    ]
    // isolate the base leg: both Stellar reads unavailable so a non-null amount can only come
    // from (mistakenly) truncating the over-precise reported figure
    const stellar = stellarDeps()
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base: baseDeps(),
      now: NOW,
    })
    const a = result.agents[0]
    expect(a.amount).toBeNull()
    // Fix loop 2, Fix 3 (bullet 2): the rejection used to fall through with no marker at all —
    // an aggregate summing this agent's (null) amount alongside a fully-known one could not tell
    // this agent's Base leg had real, discarded evidence behind it.
    expect(a.problems).toContain('base-reported-amount-rejected')
  })

  // Fix loop 2, Fix 1: the CSPLIT fixture above (same setup) shows the whole-amount half of this
  // bug is already fixed (amount sums both legs) — this covers the two remaining consequences the
  // review flagged: the owner-level custodyBreakdown must file each leg under its OWN location
  // (never both collapsing into 'unknown'), and real vault money in a split agent must still earn
  // yield rather than being shadowed by the collapsed 'unknown' custody summary.
  it('a split agent files its legs separately in the aggregate custodyBreakdown and still earns real vault yield (fix loop 2, Fix 1)', async () => {
    const rows = [
      agentRow({
        address: 'CSPLIT2',
        association: 'known',
        baseChildren: [
          baseChild({ executionStatus: 'deposited', custody: { location: 'base-proxy' } }),
        ],
      }),
    ]
    const stellar = stellarDeps({
      shares: { CSPLIT2: 5_000_000n },
      idle: { CSPLIT2: 0n },
      aprBps: 416,
    })
    const base = baseDeps({
      status: 'known',
      accounts: [
        {
          kernelAddress: '0xkernel',
          positions: [
            {
              pool: BASE_POOL_CATALOG[0].address,
              shares: 5n,
              assets: 500_000n,
              minAssets: 495_000n,
            },
          ],
          idleUsdc: 0n,
        },
      ],
    })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base,
      now: NOW,
    })
    // sanity: the single collapsed summary is still honestly 'unknown' for a genuine split
    expect(result.agents[0].custody).toEqual({ location: 'unknown' })
    const agg = aggregateOwnerPositions(result)
    expect(agg.custodyBreakdown).toEqual({ 'stellar-vault': '5000000', 'base-proxy': '5000000' })
    expect(agg.yield).not.toEqual({ state: 'none', apy: null })
    expect(agg.yield).toEqual({ state: 'live', apy: 4.16 })
  })

  it('a bridge-capable agent with no durable Base association reads as a plain Stellar-only agent', async () => {
    const rows = [agentRow({ address: 'CNOASSOC', association: 'unknown', baseChildren: [] })]
    const stellar = stellarDeps({ shares: { CNOASSOC: 0n }, idle: { CNOASSOC: 0n } })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base: baseDeps(),
      now: NOW,
    })
    const a = result.agents[0]
    expect(a.executionStatus).toBe('idle')
    expect(a.custody).toEqual({ location: 'agent' })
    expect(a.amount).toEqual({ token: 'USDC', units: '0', decimals: 7 })
    expect(a.problems).toEqual([])
  })

  it('a failed scope read (scopeReadStatus failed) never attempts a balance read and stays fully unavailable', async () => {
    const rows = [
      {
        address: 'CFAILED',
        scopeReadStatus: 'failed',
        vault: null,
        revoked: null,
        expiry: null,
        authorized: null,
        association: 'unknown',
        baseChildren: [],
      },
    ]
    const stellar = stellarDeps()
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base: baseDeps(),
      now: NOW,
    })
    expect(stellar.readVaultShares).not.toHaveBeenCalled()
    expect(stellar.readTokenBalance).not.toHaveBeenCalled()
    const a = result.agents[0]
    expect(a.scope).toEqual({ state: 'unavailable', value: null, checkedAt: NOW })
    expect(a.vaultShares).toEqual({ state: 'unavailable', amount: null, checkedAt: NOW })
    expect(a.idleToken).toEqual({ state: 'unavailable', amount: null, checkedAt: NOW })
    expect(a.amount).toBeNull()
    expect(a.executionStatus).toBe('unknown')
    expect(a.custody).toEqual({ location: 'unknown' })
    expect(a.problems).toContain('scope-read-failed')
  })

  it('passes discovery status through untouched (partial/unavailable), never upgrading it', async () => {
    const partial = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf([], { status: 'partial' }),
      stellar: stellarDeps(),
      base: baseDeps(),
      now: NOW,
    })
    expect(partial.status).toBe('partial')

    const unavailable = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf([], { status: 'unavailable' }),
      stellar: stellarDeps(),
      base: baseDeps(),
      now: NOW,
    })
    expect(unavailable.status).toBe('unavailable')
    expect(unavailable.agents).toEqual([])
  })

  // Fix loop 2, Fix 2: idle USDC left at a shared Base kernel (e.g. after a partial withdraw
  // drains the pool position back to the kernel) was read every poll via loadIndexedBasePositions
  // and then dropped — liveUnitsForPool only ever consumed `.positions`. Attributing it to one
  // agent would double-count across every agent sharing that kernel, so it surfaces on the
  // aggregate instead, keyed by kernel address, never folded into any agent's own `amount`.
  it('idle USDC stranded at a kernel after a drained Base pool position surfaces as unattributed, never folded into the agent amount (fix loop 2, Fix 2)', async () => {
    const rows = [
      agentRow({
        address: 'CDRAINED',
        association: 'known',
        baseChildren: [
          baseChild({
            executionStatus: 'deposited',
            custody: { location: 'base-proxy' },
            kernelAddress: '0xkernel',
          }),
        ],
      }),
    ]
    const stellar = stellarDeps({ shares: { CDRAINED: 0n }, idle: { CDRAINED: 0n } })
    const base = baseDeps({
      status: 'known',
      // pool position fully drained (empty positions) but 1_230_000 idle USDC (6dp) sits at the kernel
      accounts: [{ kernelAddress: '0xkernel', positions: [], idleUsdc: 1_230_000n }],
    })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base,
      now: NOW,
    })
    const a = result.agents[0]
    // the pool position is confirmed drained to zero — this agent's own amount must NOT absorb
    // the kernel's idle balance
    expect(a.amount).toEqual({ token: 'USDC', units: '0', decimals: 7 })
    const agg = aggregateOwnerPositions(result)
    expect(agg.unattributed).toEqual({
      '0xkernel': {
        state: 'known',
        amount: { token: 'USDC', units: '12300000', decimals: 7 },
        checkedAt: NOW,
      },
    })
    // and it must not have been folded into confirmedTotal either
    expect(agg.confirmedTotal.amount).toEqual({ token: 'USDC', units: '0', decimals: 7 })
  })

  it('a kernel whose idle read failed (null) appears unknown in the unattributed bucket, never a fabricated zero (fix loop 2, Fix 2)', async () => {
    const rows = [
      agentRow({
        address: 'CIDLEFAIL',
        association: 'known',
        baseChildren: [
          baseChild({
            executionStatus: 'held',
            custody: { location: 'base-proxy' },
            kernelAddress: '0xkernel',
          }),
        ],
      }),
    ]
    const stellar = stellarDeps({ shares: { CIDLEFAIL: 0n }, idle: { CIDLEFAIL: 0n } })
    const base = baseDeps({
      status: 'known',
      accounts: [
        {
          kernelAddress: '0xkernel',
          positions: [
            {
              pool: BASE_POOL_CATALOG[0].address,
              shares: 5n,
              assets: 400_000n,
              minAssets: 396_000n,
            },
          ],
          idleUsdc: null, // dashboardPositions.js's honest "the balanceOf call itself failed"
        },
      ],
    })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base,
      now: NOW,
    })
    const agg = aggregateOwnerPositions(result)
    expect(agg.unattributed).toEqual({
      '0xkernel': { state: 'unavailable', amount: null, checkedAt: NOW },
    })
  })

  it('a kernel with a genuine zero idle balance reports a known zero, not unavailable (fix loop 2, Fix 2)', async () => {
    const rows = [
      agentRow({
        address: 'CIDLEZERO',
        association: 'known',
        baseChildren: [
          baseChild({
            executionStatus: 'deposited',
            custody: { location: 'base-proxy' },
            kernelAddress: '0xkernel',
          }),
        ],
      }),
    ]
    const stellar = stellarDeps({ shares: { CIDLEZERO: 0n }, idle: { CIDLEZERO: 0n } })
    const base = baseDeps({
      status: 'known',
      accounts: [
        {
          kernelAddress: '0xkernel',
          positions: [
            {
              pool: BASE_POOL_CATALOG[0].address,
              shares: 5n,
              assets: 400_000n,
              minAssets: 396_000n,
            },
          ],
          idleUsdc: 0n,
        },
      ],
    })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base,
      now: NOW,
    })
    const agg = aggregateOwnerPositions(result)
    expect(agg.unattributed).toEqual({
      '0xkernel': {
        state: 'known',
        amount: { token: 'USDC', units: '0', decimals: 7 },
        checkedAt: NOW,
      },
    })
  })

  // Task 10: the `latestBaseChild` picker used to reduce every one of these fixtures down to a
  // single representative child, discarding any sibling's proven money. These prove every valid
  // child now survives, whether it lands in the SAME on-chain position as a sibling (must be
  // valued once, not doubled) or a genuinely different one (must survive as a distinguishable leg).
  it('two Base children on one agent sharing the same kernel+pool are valued as ONE group, not double-counted', async () => {
    const rows = [
      agentRow({
        address: 'CTWOSAME',
        association: 'known',
        baseChildren: [
          baseChild({
            allocationId: 'run1:a',
            executionStatus: 'deposited',
            reportedAt: NOW - 5000,
          }),
          baseChild({
            allocationId: 'run2:a',
            executionStatus: 'deposited',
            reportedAt: NOW - 1000,
          }),
        ],
      }),
    ]
    const stellar = stellarDeps({ shares: { CTWOSAME: 0n }, idle: { CTWOSAME: 0n } })
    const base = baseDeps({
      status: 'known',
      accounts: [
        {
          kernelAddress: '0xkernel',
          positions: [
            {
              pool: BASE_POOL_CATALOG[0].address,
              shares: 5n,
              assets: 500_000n,
              minAssets: 495_000n,
            },
          ],
          idleUsdc: 0n,
        },
      ],
    })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base,
      now: NOW,
    })
    const a = result.agents[0]
    // ONE live read for the shared group -> 500_000 base units (6dp) canonical 7dp = 5_000_000,
    // never doubled just because two allocationIds report into it.
    expect(a.amount).toEqual({ token: 'USDC', units: '5000000', decimals: 7 })
    expect(a.custody).toEqual({ location: 'base-proxy' })
    expect(a.custodyBreakdown).toEqual([
      {
        location: 'base-proxy',
        amount: { token: 'USDC', units: '5000000', decimals: 7 },
        kernelAddress: '0xkernel',
        poolAddress: BASE_POOL_CATALOG[0].address.toLowerCase(),
        coverageReason: null,
      },
    ])
  })

  it('two Base children on one agent in DIFFERENT pools both survive as distinct, identifiable legs (the latestBaseChild bug)', async () => {
    const rows = [
      agentRow({
        address: 'CTWODIFF',
        association: 'known',
        baseChildren: [
          baseChild({
            allocationId: 'run1:a',
            poolAddress: BASE_POOL_CATALOG[0].address,
            executionStatus: 'deposited',
            reportedAt: NOW - 5000,
          }),
          baseChild({
            allocationId: 'run2:b',
            poolAddress: BASE_POOL_CATALOG[1].address,
            executionStatus: 'deposited',
            reportedAt: NOW - 1000,
            amount: { token: 'USDC', units: '200000', decimals: 6 },
          }),
        ],
      }),
    ]
    const stellar = stellarDeps({ shares: { CTWODIFF: 0n }, idle: { CTWODIFF: 0n } })
    const base = baseDeps({
      status: 'known',
      accounts: [
        {
          kernelAddress: '0xkernel',
          positions: [
            {
              pool: BASE_POOL_CATALOG[0].address,
              shares: 5n,
              assets: 500_000n,
              minAssets: 495_000n,
            },
            {
              pool: BASE_POOL_CATALOG[1].address,
              shares: 2n,
              assets: 200_000n,
              minAssets: 199_000n,
            },
          ],
          idleUsdc: 0n,
        },
      ],
    })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base,
      now: NOW,
    })
    const a = result.agents[0]
    // both positions' proven money survives: 500_000 + 200_000 base units (6dp) -> canonical 7dp
    expect(a.amount).toEqual({ token: 'USDC', units: '7000000', decimals: 7 })
    // two distinct proven places can never honestly collapse to one location string
    expect(a.custody).toEqual({ location: 'unknown' })
    expect(a.custodyBreakdown).toHaveLength(2)
    const identities = a.custodyBreakdown.map((leg) => `${leg.kernelAddress}:${leg.poolAddress}`)
    expect(new Set(identities).size).toBe(2) // React-key-worthy: each leg is distinguishable
  })

  it('a Base child missing its mandate binding is excluded from the amount and flagged, never silently trusted', async () => {
    const rows = [
      agentRow({
        address: 'CNOBINDING',
        association: 'known',
        baseChildren: [baseChild({ mandateBindingId: '', executionStatus: 'deposited' })],
      }),
    ]
    const stellar = stellarDeps({ shares: { CNOBINDING: 0n }, idle: { CNOBINDING: 0n } })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base: baseDeps(),
      now: NOW,
    })
    const a = result.agents[0]
    expect(a.amount).toEqual({ token: 'USDC', units: '0', decimals: 7 })
    expect(a.problems).toContain('base-child-invalid')
  })

  it('two Base children reporting the SAME allocationId with disagreeing pools are a conflict, neither trusted', async () => {
    const rows = [
      agentRow({
        address: 'CCONFLICT',
        association: 'known',
        baseChildren: [
          baseChild({
            allocationId: 'run1:a',
            poolAddress: BASE_POOL_CATALOG[0].address,
            executionStatus: 'deposited',
          }),
          baseChild({
            allocationId: 'run1:a',
            poolAddress: BASE_POOL_CATALOG[1].address,
            executionStatus: 'deposited',
          }),
        ],
      }),
    ]
    const stellar = stellarDeps({ shares: { CCONFLICT: 0n }, idle: { CCONFLICT: 0n } })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base: baseDeps(),
      now: NOW,
    })
    const a = result.agents[0]
    expect(a.problems).toContain('base-child-conflict')
    expect(a.amount).toEqual({ token: 'USDC', units: '0', decimals: 7 })
  })
})

describe('readOwnerMoney — Task 10 owner-wide subtotals and coverage', () => {
  it('retains a known Stellar subtotal even when there is no Base evidence at all', async () => {
    const rows = [agentRow({ address: 'CSTELLARONLY' })]
    const stellar = stellarDeps({
      shares: { CSTELLARONLY: 5_000_000n },
      idle: { CSTELLARONLY: 0n },
    })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base: baseDeps(),
      now: NOW,
    })
    expect(result.stellarSubtotalUnits).toBe(5_000_000n)
    expect(result.baseSubtotalUnits).toBe(0n)
    expect(result.associationCoverage).toEqual({ state: 'complete', reasons: [] })
  })

  it("reports associationCoverage partial with reason 'stale' when a child's association record is stale", async () => {
    const rows = [
      agentRow({
        address: 'CSTALEASSOC',
        association: 'known',
        baseChildren: [baseChild({ freshness: 'stale', executionStatus: 'deposited' })],
      }),
    ]
    const stellar = stellarDeps({ shares: { CSTALEASSOC: 0n }, idle: { CSTALEASSOC: 0n } })
    const base = baseDeps({
      status: 'known',
      accounts: [
        {
          kernelAddress: '0xkernel',
          positions: [
            {
              pool: BASE_POOL_CATALOG[0].address,
              shares: 5n,
              assets: 500_000n,
              minAssets: 495_000n,
            },
          ],
          idleUsdc: 0n,
        },
      ],
    })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base,
      now: NOW,
    })
    expect(result.associationCoverage.state).toBe('partial')
    expect(result.associationCoverage.reasons).toContain('stale')
  })

  it("reports associationCoverage partial with reason 'dead-letter' when injected delivery evidence shows a dead event", async () => {
    const rows = [
      agentRow({
        address: 'CDEADLETTER',
        association: 'known',
        baseChildren: [baseChild({ allocationId: 'run1:dead', executionStatus: 'deposited' })],
      }),
    ]
    const stellar = stellarDeps({ shares: { CDEADLETTER: 0n }, idle: { CDEADLETTER: 0n } })
    const base = baseDeps({
      status: 'known',
      accounts: [
        {
          kernelAddress: '0xkernel',
          positions: [
            {
              pool: BASE_POOL_CATALOG[0].address,
              shares: 5n,
              assets: 500_000n,
              minAssets: 495_000n,
            },
          ],
          idleUsdc: 0n,
        },
      ],
    })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base,
      associationDelivery: { events: [{ allocationId: 'run1:dead', status: 'dead', attempts: 3 }] },
      now: NOW,
    })
    expect(result.associationCoverage.state).toBe('partial')
    expect(result.associationCoverage.reasons).toContain('dead-letter')
  })

  it('reports associationCoverage unknown, reason unavailable, when the base-children source itself is unreadable (missing, not an empty array)', async () => {
    const rows = [
      {
        address: 'CNOSOURCE',
        scopeReadStatus: 'ok',
        vault: 'CVAULT',
        revoked: false,
        expiry: 9_999_999_999,
        authorized: true,
        association: 'unknown',
        // deliberately no `baseChildren` key at all -- distinct from a positively-confirmed []
      },
    ]
    const stellar = stellarDeps({ shares: { CNOSOURCE: 0n }, idle: { CNOSOURCE: 0n } })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base: baseDeps(),
      now: NOW,
    })
    expect(result.baseSourceCoverage).toEqual({ state: 'unknown' })
    expect(result.associationCoverage.state).toBe('unknown')
    expect(result.associationCoverage.reasons).toContain('unavailable')
  })

  it('never upgrades coverage just because there happens to be no local/cached hint (second device, empty browser cache)', async () => {
    // readOwnerMoney takes no localStorage/browser input for this computation at all -- proven
    // structurally: the SAME discovery envelope produces byte-identical coverage every time.
    const rows = [agentRow({ address: 'CFRESHDEVICE' })]
    const stellar = stellarDeps({ shares: { CFRESHDEVICE: 0n }, idle: { CFRESHDEVICE: 0n } })
    const first = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base: baseDeps(),
      now: NOW,
    })
    const second = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base: baseDeps(),
      now: NOW,
    })
    // an owner with genuinely zero Base activity is fully known to have zero — 'complete', never
    // stuck at 'unknown' just because nothing was ever reported.
    expect(first.associationCoverage).toEqual({ state: 'complete', reasons: [] })
    expect(second.associationCoverage).toEqual(first.associationCoverage)
  })

  it('completeBaseTotalUnits and overallTotalUnits stay null while Base coverage is only partial, but the known subtotal is retained', async () => {
    const rows = [
      agentRow({
        address: 'CPARTIALBASE',
        association: 'known',
        baseChildren: [baseChild({ executionStatus: 'held' })],
      }),
    ]
    const stellar = stellarDeps({ shares: { CPARTIALBASE: 0n }, idle: { CPARTIALBASE: 0n } })
    // live read runs but never finds this kernel -> base-read-unavailable, stale reported fallback
    const base = baseDeps({ status: 'known', accounts: [] })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base,
      now: NOW,
    })
    expect(result.completeBaseTotalUnits).toBeNull()
    expect(result.overallTotalUnits).toBeNull()
    // the honest partial (stale-but-visible) subtotal is still retained, never erased to zero
    expect(result.baseSubtotalUnits).toBe(4_000_000n)
  })

  it('completeBaseTotalUnits and overallTotalUnits are populated once every base group and every stellar leg is fully known', async () => {
    const rows = [
      agentRow({
        address: 'CFULLYKNOWN',
        association: 'known',
        baseChildren: [baseChild({ executionStatus: 'deposited' })],
      }),
    ]
    const stellar = stellarDeps({ shares: { CFULLYKNOWN: 3_000_000n }, idle: { CFULLYKNOWN: 0n } })
    const base = baseDeps({
      status: 'known',
      accounts: [
        {
          kernelAddress: '0xkernel',
          positions: [
            {
              pool: BASE_POOL_CATALOG[0].address,
              shares: 5n,
              assets: 500_000n,
              minAssets: 495_000n,
            },
          ],
          idleUsdc: 0n,
        },
      ],
    })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base,
      now: NOW,
    })
    expect(result.stellarSubtotalUnits).toBe(3_000_000n)
    expect(result.baseSubtotalUnits).toBe(5_000_000n)
    expect(result.completeBaseTotalUnits).toBe(5_000_000n)
    expect(result.overallTotalUnits).toBe(8_000_000n)
    expect(result.baseValuationKind).toBe('convertToAssets-current-estimate')
  })

  it('basePositionCoverage is partial when some terminal groups get a live read and others do not', async () => {
    const rows = [
      agentRow({
        address: 'CMIXEDPOS',
        association: 'known',
        baseChildren: [
          baseChild({
            allocationId: 'run1:known',
            poolAddress: BASE_POOL_CATALOG[0].address,
            executionStatus: 'deposited',
          }),
          baseChild({
            allocationId: 'run2:unknown',
            poolAddress: BASE_POOL_CATALOG[1].address,
            kernelAddress: '0xOTHERKERNEL',
            executionStatus: 'held',
          }),
        ],
      }),
    ]
    const stellar = stellarDeps({ shares: { CMIXEDPOS: 0n }, idle: { CMIXEDPOS: 0n } })
    const base = baseDeps({
      status: 'known',
      // only the FIRST kernel's account comes back live; the second is absent entirely
      accounts: [
        {
          kernelAddress: '0xkernel',
          positions: [
            {
              pool: BASE_POOL_CATALOG[0].address,
              shares: 5n,
              assets: 500_000n,
              minAssets: 495_000n,
            },
          ],
          idleUsdc: 0n,
        },
      ],
    })
    const result = await readOwnerMoney({
      owner: OWNER,
      discovery: discoveryOf(rows),
      stellar,
      base,
      now: NOW,
    })
    expect(result.basePositionCoverage.state).toBe('partial')
  })
})

describe('aggregateOwnerPositions', () => {
  const known = (units, custody = 'stellar-vault', executionStatus = 'idle') => ({
    amount: { token: 'USDC', units, decimals: 7 },
    custody: { location: custody },
    executionStatus,
    problems: [],
  })
  const unread = (executionStatus = 'unknown') => ({
    amount: null,
    custody: { location: 'unknown' },
    executionStatus,
    problems: ['scope-read-failed'],
  })

  it('sums known amounts and reports state known when discovery is complete and every agent read', () => {
    const out = aggregateOwnerPositions({
      status: 'complete',
      agents: [known('100'), known('200')],
    })
    expect(out.confirmedTotal).toEqual({
      state: 'known',
      amount: { token: 'USDC', units: '300', decimals: 7 },
    })
  })

  it('is partial when discovery itself is incomplete, even if every enumerated agent read fine', () => {
    const out = aggregateOwnerPositions({ status: 'partial', agents: [known('100'), known('200')] })
    expect(out.confirmedTotal.state).toBe('partial')
    // the honest partial still carries the best-known sum, not a hidden number
    expect(out.confirmedTotal.amount).toEqual({ token: 'USDC', units: '300', decimals: 7 })
  })

  it('is partial when discovery is complete but one enumerated agent could not be read', () => {
    const out = aggregateOwnerPositions({ status: 'complete', agents: [known('100'), unread()] })
    expect(out.confirmedTotal.state).toBe('partial')
    expect(out.confirmedTotal.amount).toEqual({ token: 'USDC', units: '100', decimals: 7 })
  })

  it('is unavailable with a null amount (never a $0 total) when discovery itself is unavailable', () => {
    const out = aggregateOwnerPositions({ status: 'unavailable', agents: [] })
    expect(out.confirmedTotal).toEqual({ state: 'unavailable', amount: null })
  })

  // Fix loop 1, Fix 2: a non-null `amount` kept as stale evidence (a Base live read that
  // couldn't run) must not be indistinguishable from a freshly confirmed one at the aggregate.
  it('is partial when an agent carries a stale (base-read-unavailable) amount, not a freshly confirmed one', () => {
    const stale = {
      amount: { token: 'USDC', units: '400', decimals: 7 },
      custody: { location: 'base-proxy' },
      executionStatus: 'succeeded',
      problems: ['base-read-unavailable'],
    }
    const out = aggregateOwnerPositions({ status: 'complete', agents: [known('100'), stale] })
    expect(out.confirmedTotal.state).toBe('partial')
    // the honest partial still carries the best-known sum (the stale figure counts as evidence)
    expect(out.confirmedTotal.amount).toEqual({ token: 'USDC', units: '500', decimals: 7 })
  })

  // Fix loop 1, Fix 3 (aggregate half): the Stellar-only remainder of a failed Base leg is real
  // money, but the failed leg itself is a genuine unknown for the owner-level total.
  it('is partial when an agent carries a base-execution-failed marker, even though its own amount is non-null', () => {
    const partialLeg = {
      amount: { token: 'USDC', units: '500', decimals: 7 },
      custody: { location: 'unknown' },
      executionStatus: 'failed',
      problems: ['base-execution-failed'],
    }
    const out = aggregateOwnerPositions({ status: 'complete', agents: [partialLeg] })
    expect(out.confirmedTotal.state).toBe('partial')
  })

  // Fix loop 1, Fix 8 (missing test named by the review): NOT every non-empty `problems` should
  // downgrade the aggregate — a revoked/expired agent's balance is fully known (product truth:
  // revoked-but-funded agents are still enumerated with their real balance), it just can't move
  // right now. Only problem markers that mean the READ itself was incomplete should downgrade.
  it('is NOT downgraded by every problem — a revoked-but-fully-read agent stays known', () => {
    const revokedButKnown = {
      amount: { token: 'USDC', units: '100', decimals: 7 },
      custody: { location: 'stellar-vault' },
      executionStatus: 'idle',
      problems: ['scope-revoked'],
    }
    const out = aggregateOwnerPositions({ status: 'complete', agents: [revokedButKnown] })
    expect(out.confirmedTotal.state).toBe('known')
    expect(out.problemAgentCount).toBe(1)
  })

  it('breaks amounts down by custody location and tallies agents by executionStatus', () => {
    const out = aggregateOwnerPositions({
      status: 'complete',
      agents: [
        known('100', 'stellar-vault', 'idle'),
        known('50', 'base-proxy', 'succeeded'),
        unread(),
      ],
    })
    expect(out.custodyBreakdown).toEqual({ 'stellar-vault': '100', 'base-proxy': '50' })
    expect(out.executionBreakdown).toEqual({ idle: 1, succeeded: 1, unknown: 1 })
    expect(out.agentCount).toBe(3)
    expect(out.problemAgentCount).toBe(1)
  })

  it('reports live vault yield only when some confirmed money actually sits in the Stellar vault', () => {
    const out = aggregateOwnerPositions({
      status: 'complete',
      agents: [known('100', 'stellar-vault')],
      stellarYield: { state: 'live', apy: 4.16 },
    })
    expect(out.yield).toEqual({ state: 'live', apy: 4.16 })
  })

  it('reports no yield (never a guessed APY) when confirmed money is entirely Base custody-proxy', () => {
    const out = aggregateOwnerPositions({
      status: 'complete',
      agents: [known('100', 'base-proxy', 'succeeded')],
      stellarYield: { state: 'live', apy: 4.16 },
    })
    expect(out.yield).toEqual({ state: 'none', apy: null })
  })

  // Fix loop 1, Fix 7: 'no yield' is a positive claim that no vault money exists anywhere — it
  // can only be asserted once the total itself is fully known. A partial/unavailable total might
  // still be hiding a vault agent that simply couldn't be read yet.
  it('never asserts "no yield" when the total itself is not known — reports unavailable instead', () => {
    const out = aggregateOwnerPositions({
      status: 'partial',
      agents: [known('100', 'base-proxy', 'succeeded')],
      stellarYield: { state: 'live', apy: 4.16 },
    })
    expect(out.confirmedTotal.state).toBe('partial')
    expect(out.yield).toEqual({ state: 'unavailable', apy: null })
  })

  it('never fabricates earned/interest from a zero-rewards placeholder — always unavailable', () => {
    const out = aggregateOwnerPositions({ status: 'complete', agents: [known('100')] })
    expect(out.earned).toEqual({ state: 'unavailable', amount: null })
  })
})
