// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createActiveAccountEpochStore } from './app.jsx'

const G = Object.freeze({
  version: 1,
  kind: 'G',
  address: 'GOWNER',
  networkPassphrase: 'testnet',
  connectorId: 'freighter',
  epoch: 1,
})
const C = Object.freeze({ ...G, kind: 'C', address: 'COWNER', connectorId: 'vf-wallet', epoch: 2 })

describe('active account application state', () => {
  it('clears old-owner review, receipt, Base and My Money state before installing a switched account', () => {
    const clear = vi.fn()
    const store = createActiveAccountEpochStore({ initial: G, clear })

    store.install(C)

    expect(clear).toHaveBeenCalledWith(G)
    expect(store.current()).toBe(C)
  })

  it('rejects stale completions after C→G and C1→C2 transitions', () => {
    const store = createActiveAccountEpochStore({ initial: C, clear: vi.fn() })
    const c1 = store.capture()
    store.install(G)
    expect(() => store.assertCurrent(c1)).toThrow(/active wallet account changed/i)

    const g = store.capture()
    const c2 = Object.freeze({ ...C, address: 'COTHER', epoch: 3 })
    store.install(c2)
    expect(() => store.assertCurrent(g)).toThrow(/active wallet account changed/i)
  })
})
