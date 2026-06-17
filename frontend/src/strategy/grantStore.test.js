// frontend/src/strategy/grantStore.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { saveGrant, loadGrant, clearGrant, hasValidGrant } from './grantStore.js'

describe('grantStore', () => {
  beforeEach(() => {
    const store = {}
    vi.stubGlobal('localStorage', {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: (k) => { delete store[k] },
    })
  })

  it('round-trips a saved grant', () => {
    saveGrant({ permissionContext: '0xabc', delegationManager: '0xdm', expiresAt: 9999999999000 })
    const g = loadGrant()
    expect(g).toEqual({ permissionContext: '0xabc', delegationManager: '0xdm', expiresAt: 9999999999000 })
  })

  it('returns null when nothing stored', () => {
    expect(loadGrant()).toBeNull()
  })

  it('hasValidGrant is true only for a future, complete grant', () => {
    expect(hasValidGrant()).toBe(false)
    saveGrant({ permissionContext: '0xabc', delegationManager: '0xdm', expiresAt: Date.now() + 60_000 })
    expect(hasValidGrant()).toBe(true)
  })

  it('hasValidGrant is false for an expired grant', () => {
    saveGrant({ permissionContext: '0xabc', delegationManager: '0xdm', expiresAt: Date.now() - 1 })
    expect(hasValidGrant()).toBe(false)
  })

  it('clearGrant removes it', () => {
    saveGrant({ permissionContext: '0xabc', delegationManager: '0xdm', expiresAt: Date.now() + 60_000 })
    clearGrant()
    expect(loadGrant()).toBeNull()
  })

  it('loadGrant returns null when context is missing (corrupt)', () => {
    localStorage.setItem('yv_strategy_grant', JSON.stringify({ delegationManager: '0xdm', expiresAt: Date.now() + 60_000 }))
    expect(loadGrant()).toBeNull()
  })
})
