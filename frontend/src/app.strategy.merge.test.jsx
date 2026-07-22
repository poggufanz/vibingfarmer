// @vitest-environment jsdom
// Reality check on the brief: this touches `localStorage` (via isVfWallet), which plain Node
// (no jsdom) does not provide globally — the "node env fine" note in the brief only holds for
// helpers that never touch browser globals. jsdom below, same as components.sidebar.test.jsx.
import { describe, it, expect, vi } from 'vitest'
import {
  resolveBaseAvailability,
  checkStoredBaseMandate,
  checkCircleUsdcFunding,
  readStoredBaseMandate,
  buildBaseLegContext,
} from './mergeFlowHelpers.js'

describe('merge flow helpers', () => {
  it("returns the health-check PROMISE synchronously (overlaps with the caller's own work instead of serializing before it)", () => {
    const { baseAvailable } = resolveBaseAvailability({ checkHealth: async () => true })
    expect(baseAvailable).toBeInstanceOf(Promise)
  })
  it('baseAvailable mirrors relayer health, once awaited', async () => {
    const { baseAvailable } = resolveBaseAvailability({ checkHealth: async () => true })
    expect(await baseAvailable).toBe(true)
    const { baseAvailable: baseAvailable2 } = resolveBaseAvailability({
      checkHealth: async () => false,
    })
    expect(await baseAvailable2).toBe(false)
  })
  it('no wallet -> no base leg context', () => {
    expect(buildBaseLegContext({ connectedAddress: null, kitSignTransaction: vi.fn() })).toBeNull()
  })
  it('context carries address + signer + vf flag', () => {
    localStorage.setItem('vf_wallet_contract', 'CVF')
    const ctx = buildBaseLegContext({ connectedAddress: 'CVF', kitSignTransaction: vi.fn() })
    expect(ctx).toMatchObject({ connectedAddress: 'CVF', isVf: true })
    expect(typeof ctx.signTx).toBe('function')
  })
})

describe('resolveBaseAvailability - fail-closed preflight (Task 7: mandate + funding gates)', () => {
  it('healthy relayer, no mandate/funding gates supplied -> unaffected (backward compatible)', async () => {
    const { baseAvailable } = resolveBaseAvailability({ checkHealth: async () => true })
    expect(await baseAvailable).toBe(true)
  })
  it('relayer down short-circuits before the mandate/funding checks ever run', async () => {
    const checkMandate = vi.fn(async () => true)
    const checkFunding = vi.fn(async () => true)
    const { baseAvailable } = resolveBaseAvailability({
      checkHealth: async () => false,
      checkMandate,
      checkFunding,
    })
    expect(await baseAvailable).toBe(false)
    expect(checkMandate).not.toHaveBeenCalled()
    expect(checkFunding).not.toHaveBeenCalled()
  })
  it('healthy + mandate ok + funded -> available', async () => {
    const { baseAvailable } = resolveBaseAvailability({
      checkHealth: async () => true,
      checkMandate: async () => true,
      checkFunding: async () => true,
    })
    expect(await baseAvailable).toBe(true)
  })
  it('a stored-but-invalid mandate fails closed even though the relayer is healthy', async () => {
    const { baseAvailable } = resolveBaseAvailability({
      checkHealth: async () => true,
      checkMandate: async () => false,
      checkFunding: async () => true,
    })
    expect(await baseAvailable).toBe(false)
  })
  it('no Circle USDC funding fails closed even though everything else is fine', async () => {
    const { baseAvailable } = resolveBaseAvailability({
      checkHealth: async () => true,
      checkMandate: async () => true,
      checkFunding: async () => false,
    })
    expect(await baseAvailable).toBe(false)
  })
  it('a throwing check fails closed instead of surfacing an error', async () => {
    const { baseAvailable } = resolveBaseAvailability({
      checkHealth: async () => true,
      checkMandate: async () => {
        throw new Error('relayer blip')
      },
    })
    expect(await baseAvailable).toBe(false)
  })
})

describe('checkStoredBaseMandate', () => {
  const fakeStorage = (initial = {}) => {
    const m = new Map(Object.entries(initial))
    return { getItem: (k) => (m.has(k) ? m.get(k) : null) }
  }
  it('no stored mandate -> false (mandate setup is its own per-window ceremony, never part of a run)', async () => {
    const getMandateStatus = vi.fn()
    const check = checkStoredBaseMandate({ getMandateStatus, storage: fakeStorage() })
    expect(await check()).toBe(false)
    expect(getMandateStatus).not.toHaveBeenCalled()
  })
  it('a stored mandate the relayer confirms valid -> true', async () => {
    const getMandateStatus = vi.fn(async () => ({ valid: true }))
    const storage = fakeStorage({
      vf_base_mandate: JSON.stringify({ serializedApproval: 'APPROVAL-1' }),
    })
    const check = checkStoredBaseMandate({ getMandateStatus, storage })
    expect(await check()).toBe(true)
    expect(getMandateStatus).toHaveBeenCalledWith('APPROVAL-1')
  })
  it('a stored mandate the relayer rejects -> false', async () => {
    const getMandateStatus = vi.fn(async () => ({ valid: false }))
    const storage = fakeStorage({
      vf_base_mandate: JSON.stringify({ serializedApproval: 'STALE' }),
    })
    const check = checkStoredBaseMandate({ getMandateStatus, storage })
    expect(await check()).toBe(false)
  })
  it('a corrupt stored record self-heals to null -> false, same as nothing stored', async () => {
    const getMandateStatus = vi.fn()
    const check = checkStoredBaseMandate({
      getMandateStatus,
      storage: fakeStorage({ vf_base_mandate: '{not json' }),
    })
    expect(await check()).toBe(false)
    expect(getMandateStatus).not.toHaveBeenCalled()
  })
})

describe('readStoredBaseMandate', () => {
  const fakeStorage = (initial = {}) => {
    const m = new Map(Object.entries(initial))
    return { getItem: (k) => (m.has(k) ? m.get(k) : null) }
  }
  it('parses the stored record', () => {
    const storage = fakeStorage({
      vf_base_mandate: JSON.stringify({ kernelAddress: '0xKERNEL', serializedApproval: 'A' }),
    })
    expect(readStoredBaseMandate(storage)).toEqual({
      kernelAddress: '0xKERNEL',
      serializedApproval: 'A',
    })
  })
  it('null when nothing is stored, and null (never throws) on a corrupt record', () => {
    expect(readStoredBaseMandate(fakeStorage())).toBeNull()
    expect(readStoredBaseMandate(fakeStorage({ vf_base_mandate: '{not json' }))).toBeNull()
  })
})

describe('checkCircleUsdcFunding', () => {
  it('no connected address -> false', async () => {
    const check = checkCircleUsdcFunding({
      address: null,
      readTokenBalance: vi.fn(),
      token: 'CUSDC',
    })
    expect(await check()).toBe(false)
  })
  it('a positive SAC balance -> true, reads the burn token specifically', async () => {
    const readTokenBalance = vi.fn(async () => 5_000_000n)
    const check = checkCircleUsdcFunding({ address: 'GUSER', readTokenBalance, token: 'CUSDC' })
    expect(await check()).toBe(true)
    expect(readTokenBalance).toHaveBeenCalledWith('GUSER', { token: 'CUSDC' })
  })
  it('a zero or null balance -> false (no trustline and empty-trustline read the same)', async () => {
    const check1 = checkCircleUsdcFunding({
      address: 'GUSER',
      readTokenBalance: vi.fn(async () => 0n),
      token: 'CUSDC',
    })
    expect(await check1()).toBe(false)
    const check2 = checkCircleUsdcFunding({
      address: 'GUSER',
      readTokenBalance: vi.fn(async () => null),
      token: 'CUSDC',
    })
    expect(await check2()).toBe(false)
  })
})
