// @vitest-environment jsdom
// Reality check on the brief: this touches `localStorage` (via isVfWallet), which plain Node
// (no jsdom) does not provide globally — the "node env fine" note in the brief only holds for
// helpers that never touch browser globals. jsdom below, same as components.sidebar.test.jsx.
import { describe, it, expect, vi } from 'vitest'
import { resolveBaseAvailability, buildBaseLegContext } from './mergeFlowHelpers.js'

describe('merge flow helpers', () => {
  it('baseAvailable mirrors relayer health', async () => {
    expect(await resolveBaseAvailability({ checkHealth: async () => true })).toEqual({ baseAvailable: true })
    expect(await resolveBaseAvailability({ checkHealth: async () => false })).toEqual({ baseAvailable: false })
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
