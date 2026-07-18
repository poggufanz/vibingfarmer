// @vitest-environment jsdom
// Reality check on the brief: this touches `localStorage` (via isVfWallet), which plain Node
// (no jsdom) does not provide globally — the "node env fine" note in the brief only holds for
// helpers that never touch browser globals. jsdom below, same as components.sidebar.test.jsx.
import { describe, it, expect, vi } from 'vitest'
import { resolveBaseAvailability, buildBaseLegContext } from './mergeFlowHelpers.js'

describe('merge flow helpers', () => {
  it('returns the health-check PROMISE synchronously (overlaps with the caller\'s own work instead of serializing before it)', () => {
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
