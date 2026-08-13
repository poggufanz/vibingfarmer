// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { BASE_PROXY_TRUTH, ECOSYSTEM_CARD_ORDER, createEcosystemModel } from './ecosystemModel.js'

describe('createEcosystemModel', () => {
  it('keeps the catalog in the required presentation order', () => {
    const model = createEcosystemModel()

    expect(model.cards.map((entry) => entry.name)).toEqual([
      'Stellar / Soroban',
      'Autofarm Vault',
      'Blend Capital v2',
      'Base Sepolia proxy',
      'Circle CCTP',
      'OpenZeppelin',
      'DeFiLlama',
      'ZeroDev',
    ])
    expect(model.cards.map((entry) => entry.name)).toEqual(ECOSYSTEM_CARD_ORDER)
    expect(model.cards.every((entry) => entry.source === 'catalog')).toBe(true)
    expect(model.cards.every((entry) => typeof entry.state === 'string')).toBe(true)
  })

  it('keeps the Base proxy truth adjacent and never adds a yield fact', () => {
    const model = createEcosystemModel()
    const base = model.cards.find((entry) => entry.id === 'base-sepolia-proxy')

    expect(base).toMatchObject({
      name: 'Base Sepolia proxy',
      network: 'Base Sepolia',
      state: 'current',
      status: 'Current',
      verifiedProxy: true,
      verified: true,
      truth: BASE_PROXY_TRUTH,
      apyFact: null,
    })

    const unverified = createEcosystemModel({ baseProxyVerified: false }).cards.find(
      (entry) => entry.id === 'base-sepolia-proxy'
    )
    expect(unverified).toMatchObject({
      state: 'unavailable',
      status: 'Unavailable',
      verified: false,
    })
  })

  it('marks mainnet lending as Planned with no APY fact', () => {
    const model = createEcosystemModel({ deployment: 'mainnet' })
    const lending = model.cards.filter((entry) =>
      ['Autofarm Vault', 'Blend Capital v2'].includes(entry.name)
    )

    expect(lending).toHaveLength(2)
    for (const entry of lending) {
      expect(entry.network).toBe('Mainnet')
      expect(entry.state).toBe('planned')
      expect(entry.status).toBe('Planned')
      expect(entry.apyFact).toBeNull()
      expect(entry.truth).not.toMatch(/testnet/i)
      expect(entry.truth).toMatch(/planned|no protocol yield/i)
    }
  })

  it.each(['loading', 'current', 'stale', 'empty', 'partial', 'error', 'unavailable'])(
    'projects the explicit %s route state without changing the catalog cards',
    (state) => {
      const model = createEcosystemModel({ state })

      expect(model.fact).toMatchObject({
        state,
        value: null,
        ...(state === 'unavailable'
          ? { source: null, checkedAt: null }
          : { source: 'catalog', checkedAt: 'catalog' }),
      })
      expect(model.cards).toHaveLength(8)
      expect(model.cards.every((entry) => entry.apyFact === null)).toBe(true)
    }
  )

  it('does not call browser readers, transport, persistence, or the clock', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const dateSpy = vi.spyOn(Date, 'now')
    const storageSpy = globalThis.localStorage ? vi.spyOn(globalThis.localStorage, 'getItem') : null

    try {
      createEcosystemModel()
    } finally {
      fetchSpy.mockRestore()
      dateSpy.mockRestore()
      storageSpy?.mockRestore()
    }

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(dateSpy).not.toHaveBeenCalled()
    if (storageSpy) expect(storageSpy).not.toHaveBeenCalled()
  })

  it('freezes the model and nested cards for fixture reuse', () => {
    const model = createEcosystemModel()

    expect(Object.isFrozen(model)).toBe(true)
    expect(Object.isFrozen(model.fact)).toBe(true)
    expect(Object.isFrozen(model.cards)).toBe(true)
    expect(model.cards.every((entry) => Object.isFrozen(entry))).toBe(true)
  })
})
