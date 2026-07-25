import { describe, it, expect, vi } from 'vitest'
import { readOwnerMoney, aggregateOwnerPositions } from './readOwnerMoney.js'

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

const baseChild = (overrides = {}) => ({
  allocationId: 'run1:bridge:aave-v3',
  runId: 'run1',
  poolAddress: 'CPOOL',
  proxyTarget: '0xPOOL',
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
    const rows = [
      agentRow({ address: 'CBOOM' }),
      agentRow({ address: 'CGOOD' }),
    ]
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
    expect(a.vaultShares).toEqual({ state: 'known', amount: { token: 'USDC', units: '0', decimals: 7 }, checkedAt: NOW })
    expect(a.idleToken).toEqual({ state: 'known', amount: { token: 'USDC', units: '5000000', decimals: 7 }, checkedAt: NOW })
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
    expect(a.vaultShares).toEqual({ state: 'known', amount: { token: 'USDC', units: '0', decimals: 7 }, checkedAt: NOW })
    expect(a.amount).toEqual({ token: 'USDC', units: '0', decimals: 7 })
  })

  it('a Base binding mismatch (this device is not the kernel that produced the custody) still surfaces the proven amount', async () => {
    const rows = [
      agentRow({
        address: 'CBRIDGE',
        association: 'known',
        baseChildren: [baseChild({ executionStatus: 'deposited', custody: { location: 'base-proxy' } })],
      }),
    ]
    const stellar = stellarDeps({ shares: { CBRIDGE: 0n }, idle: { CBRIDGE: 0n } })
    const base = baseDeps({
      status: 'mismatched',
      accounts: [
        {
          kernelAddress: '0xkernel',
          positions: [{ pool: '0xPOOL', shares: 5n, assets: 500_000n, minAssets: 495_000n }],
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
      { address: 'CFAILED', scopeReadStatus: 'failed', vault: null, revoked: null, expiry: null, authorized: null, association: 'unknown', baseChildren: [] },
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
    const out = aggregateOwnerPositions({ status: 'complete', agents: [known('100'), known('200')] })
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

  it('breaks amounts down by custody location and tallies agents by executionStatus', () => {
    const out = aggregateOwnerPositions({
      status: 'complete',
      agents: [known('100', 'stellar-vault', 'idle'), known('50', 'base-proxy', 'succeeded'), unread()],
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

  it('never fabricates earned/interest from a zero-rewards placeholder — always unavailable', () => {
    const out = aggregateOwnerPositions({ status: 'complete', agents: [known('100')] })
    expect(out.earned).toEqual({ state: 'unavailable', amount: null })
  })
})
