import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  mergePositions,
  applyChainPositions,
  reconcilePositionsFromChain,
  pickVaultAgentsForExit,
  pickDisplayAgents,
  pickRecoverableVaultAgents,
  buildBulkExitTarget,
} from './positionsStore.js'
import { SOROBAN_ACTIVE_VAULT_ADDRESS } from './stellar/config.js'

vi.mock('./stellar/agentDeposit.js', () => ({ readVaultShares: vi.fn() }))
vi.mock('./stellar/vaultReads.js', () => ({ readPricePerShare: vi.fn() }))
import { readVaultShares } from './stellar/agentDeposit.js'
import { readPricePerShare } from './stellar/vaultReads.js'

// These two mocks are shared module-level state across every describe block below (vi.mock is
// per-file, not per-describe). Without a file-level clear, one test's call count/resolved value
// can leak into the next depending on execution order — this already caused one false failure
// (a test asserting `not.toHaveBeenCalled()` only passed because it happened to manually clear
// first). Clearing before EVERY test removes the ordering dependency; mockClear() resets calls/
// results only, never the mockResolvedValue/mockImplementation a test sets up afterward.
beforeEach(() => {
  readVaultShares.mockClear()
  readPricePerShare.mockClear()
})

describe('reconcilePositionsFromChain (autofarm pps conversion)', () => {
  it('converts the share balance to asset units via price_per_share', async () => {
    readVaultShares.mockResolvedValue(100_0000000n) // 100 shares (7-dp)
    readPricePerShare.mockResolvedValue(10_500_000n) // pps = 1.05
    const out = await reconcilePositionsFromChain('GOWNER', { agents: ['CAGENT1'] })
    const pos = out[SOROBAN_ACTIVE_VAULT_ADDRESS]
    expect(pos.balance).toBe('1050000000') // 105 USDC in base units
    expect(pos.shares).toBe('1000000000')
  })

  it('returns null (keep cached snapshot) when the pps read fails', async () => {
    readVaultShares.mockResolvedValue(100_0000000n)
    readPricePerShare.mockResolvedValue(null)
    expect(await reconcilePositionsFromChain('GOWNER', { agents: ['CAGENT1'] })).toBeNull()
  })

  it('skips the pps read entirely for a zero share balance', async () => {
    readVaultShares.mockResolvedValue(0n)
    readPricePerShare.mockResolvedValue(null) // would fail — must not be consulted
    const out = await reconcilePositionsFromChain('GOWNER', { agents: ['CAGENT1'] })
    expect(out[SOROBAN_ACTIVE_VAULT_ADDRESS].balance).toBe('0')
  })
})

describe('reconcilePositionsFromChain (explicit agent list, no demo-agent default)', () => {
  it('requires an explicit agent list — no agents means null, never a demo-agent guess', async () => {
    expect(await reconcilePositionsFromChain('GOWNER')).toBeNull()
    expect(await reconcilePositionsFromChain('GOWNER', {})).toBeNull()
    expect(await reconcilePositionsFromChain('GOWNER', { agents: [] })).toBeNull()
    expect(readVaultShares).not.toHaveBeenCalled()
  })

  it('never imports SOROBAN_DEMO_AGENT (no address for reconcile to fall back on)', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./positionsStore.js', import.meta.url), 'utf8')
    )
    expect(src).not.toMatch(/import\s*\{[^}]*SOROBAN_DEMO_AGENT/)
  })

  it('reports per-agent read status alongside the position sum', async () => {
    readVaultShares.mockImplementation(async (agent) => (agent === 'CGOOD' ? 100_0000000n : null))
    readPricePerShare.mockResolvedValue(10_000_000n) // pps = 1.0
    const out = await reconcilePositionsFromChain('GOWNER', { agents: ['CGOOD', 'CFAIL'] })
    expect(out.agentStatus).toEqual([
      { agent: 'CGOOD', status: 'ok' },
      { agent: 'CFAIL', status: 'failed' },
    ])
    // The status list is a non-enumerable side channel — it must not corrupt the plain vault map
    // shape existing callers (app.jsx) iterate with Object.keys/Object.entries/spread.
    expect(Object.keys(out)).toEqual([SOROBAN_ACTIVE_VAULT_ADDRESS])
    expect(JSON.stringify(out)).not.toMatch(/agentStatus/)
  })
})

describe('pickDisplayAgents / pickRecoverableVaultAgents / buildBulkExitTarget (discovery-driven)', () => {
  const VAULT = SOROBAN_ACTIVE_VAULT_ADDRESS

  it('includes active, expired, revoked, and revoked-but-funded agents', () => {
    const discovery = {
      status: 'partial',
      agents: [
        { address: 'CACTIVE', kind: 'deposit', vault: VAULT, revoked: false, expiry: 9e9 },
        { address: 'CEXPIRED', kind: 'deposit', vault: VAULT, revoked: false, expiry: 1 },
        { address: 'CREVOKED', kind: 'deposit', vault: VAULT, revoked: true, expiry: 9e9 },
      ],
    }
    expect(pickRecoverableVaultAgents(discovery, { vault: VAULT }).sort()).toEqual(
      ['CACTIVE', 'CEXPIRED', 'CREVOKED'].sort()
    )
  })

  it('excludes bridge-kind memberships — they never hold Stellar vault shares', () => {
    const discovery = {
      status: 'partial',
      agents: [
        { address: 'CDEPOSIT', kind: 'deposit', vault: VAULT },
        { address: 'CBRIDGE', kind: 'bridge', vault: VAULT },
      ],
    }
    expect(pickRecoverableVaultAgents(discovery, { vault: VAULT })).toEqual(['CDEPOSIT'])
  })

  it('keeps a row whose vault is unknown rather than dropping a possibly-funded agent', () => {
    const discovery = {
      status: 'partial',
      agents: [{ address: 'CUNKNOWN', kind: 'deposit', vault: null }],
    }
    expect(pickRecoverableVaultAgents(discovery, { vault: VAULT })).toEqual(['CUNKNOWN'])
  })

  it('excludes a row proven scoped to a different vault', () => {
    const discovery = {
      status: 'partial',
      agents: [{ address: 'COTHER', kind: 'deposit', vault: 'COTHERVAULT' }],
    }
    expect(pickRecoverableVaultAgents(discovery, { vault: VAULT })).toEqual([])
  })

  it('never substitutes a demo/view-as address for an empty result', () => {
    expect(
      pickRecoverableVaultAgents({ status: 'complete', agents: [] }, { vault: VAULT })
    ).toEqual([])
    expect(pickRecoverableVaultAgents(null, { vault: VAULT })).toEqual([])
  })

  it('bulk exit is { kind: "all" } only when discovery is complete', () => {
    const discovery = {
      status: 'complete',
      agents: [{ address: 'CAGENT1', kind: 'deposit', vault: VAULT }],
    }
    expect(buildBulkExitTarget(discovery, { vault: VAULT })).toEqual({
      kind: 'all',
      agents: ['CAGENT1'],
    })
  })

  it('bulk exit is { kind: "known-only" } for partial or unavailable discovery, never claiming completeness', () => {
    const partial = {
      status: 'partial',
      agents: [{ address: 'CAGENT1', kind: 'deposit', vault: VAULT }],
    }
    expect(buildBulkExitTarget(partial, { vault: VAULT })).toEqual({
      kind: 'known-only',
      agents: ['CAGENT1'],
    })
    const unavailable = { status: 'unavailable', agents: [] }
    expect(buildBulkExitTarget(unavailable, { vault: VAULT })).toEqual({
      kind: 'known-only',
      agents: [],
    })
  })

  it('pickDisplayAgents returns the enriched rows (not just addresses) for the same candidate set', () => {
    const row = { address: 'CAGENT1', kind: 'deposit', vault: VAULT, association: 'unknown' }
    const discovery = { status: 'partial', agents: [row] }
    expect(pickDisplayAgents(discovery, { vault: VAULT })).toEqual([row])
  })
})

// My Money Task 13 Part B item 5: pickPositionsAgents (and its 3 tests above this line) is
// DELETED -- app.jsx's own `positionsAgents` (its one remaining caller) migrated to
// `pickRecoverableVaultAgents` below.
//
// Wave 6 carry (My Money Task 6, carried through Task 13 Part B, Item 4c): renamed to
// `pickVaultAgentsForExit` and the revoked-filter deleted (see positionsStore.js's own comment on
// why it stays scopes-shaped rather than migrating to `pickRecoverableVaultAgents`: PositionsZone.jsx
// holds `scopes`, not an OwnerDiscoveryV1 envelope). The "skips revoked agents" test below used to
// assert the identical defect `pickPositionsAgents`/`pickRecoverableVaultAgents` were both fixed
// for -- a revoked-but-funded agent is exactly the one a sweep must not skip -- so it is now a
// positive "includes" assertion instead, matching the discovery-shaped picker's own test above.
describe('pickVaultAgentsForExit (which agents an exit must sweep)', () => {
  const V = 'CVAULT1'

  it('returns every agent pinned to that vault', () => {
    const scopes = [
      { agent: 'CA_ONE', vault: V, revoked: false },
      { agent: 'CA_TWO', vault: V, revoked: false },
    ]
    expect(pickVaultAgentsForExit(scopes, V)).toEqual(['CA_ONE', 'CA_TWO'])
  })

  it('includes a revoked-but-possibly-funded agent -- the exit-enumeration rule forbids dropping it', () => {
    const scopes = [
      { agent: 'CA_ONE', vault: V, revoked: true },
      { agent: 'CA_TWO', vault: V, revoked: false },
    ]
    expect(pickVaultAgentsForExit(scopes, V).sort()).toEqual(['CA_ONE', 'CA_TWO'].sort())
  })

  it('skips agents scoped to a different vault', () => {
    const scopes = [
      { agent: 'CA_ONE', vault: 'COTHER', revoked: false },
      { agent: 'CA_TWO', vault: V, revoked: false },
    ]
    expect(pickVaultAgentsForExit(scopes, V)).toEqual(['CA_TWO'])
  })

  it('matches vault addresses case-insensitively', () => {
    expect(pickVaultAgentsForExit([{ agent: 'CA_ONE', vault: 'cvault1' }], 'CVAULT1')).toEqual([
      'CA_ONE',
    ])
  })

  it('dedupes a repeated agent so it is never swept twice', () => {
    const scopes = [
      { agent: 'CA_ONE', vault: V },
      { agent: 'CA_ONE', vault: V },
    ]
    expect(pickVaultAgentsForExit(scopes, V)).toEqual(['CA_ONE'])
  })

  it('returns [] rather than guessing — never a demo-agent fallback', () => {
    expect(pickVaultAgentsForExit([], V)).toEqual([])
    expect(pickVaultAgentsForExit(null, V)).toEqual([])
    expect(pickVaultAgentsForExit([{ agent: 'CA_ONE', vault: V }], '')).toEqual([])
  })
})

describe('mergePositions (raise-only)', () => {
  it('keeps the larger balance and ignores a lower incoming value (case-insensitive key)', () => {
    const merged = mergePositions(
      { '0xAbC': { vaultName: 'A', balance: '930000000' } },
      { '0xabc': { balance: '120000000' } }
    )
    expect(merged['0xAbC'].balance).toBe('930000000')
  })

  it('raises to the larger incoming balance and merges metadata', () => {
    const merged = mergePositions(
      { '0xabc': { balance: '120000000' } },
      { '0xabc': { vaultName: 'A', balance: '930000000' } }
    )
    expect(merged['0xabc']).toEqual({ vaultName: 'A', balance: '930000000' })
  })

  it('handles uint256-scale values without precision loss', () => {
    const big = (10n ** 30n).toString()
    expect(mergePositions({}, { '0x1': { balance: big } })['0x1'].balance).toBe(big)
  })
})

describe('applyChainPositions (authoritative)', () => {
  it('replaces balance even when lower (withdraw) and leaves untracked vaults untouched', () => {
    const next = applyChainPositions(
      { '0xA': { balance: '930000000' }, '0xB': { balance: '50000000' } },
      { '0xa': { balance: '730000000' } }
    )
    expect(next['0xA'].balance).toBe('730000000')
    expect(next['0xB'].balance).toBe('50000000')
  })

  it('PRUNES a vault the chain reports as 0 (fully withdrawn - heals stale cache)', () => {
    const next = applyChainPositions(
      { '0xA': { balance: '1000000' }, '0xB': { balance: '50000000' } },
      { '0xa': { balance: '0' } }
    )
    expect(next['0xA']).toBeUndefined()
    expect(next['0xB'].balance).toBe('50000000')
  })

  it('does NOT prune a vault absent from the chain map (read failed, not a withdrawal)', () => {
    const next = applyChainPositions({ '0xA': { balance: '1000000' } }, {})
    expect(next['0xA'].balance).toBe('1000000')
  })
})
