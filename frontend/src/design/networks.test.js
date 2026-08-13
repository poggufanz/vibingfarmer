import { describe, expect, it } from 'vitest'
import {
  NETWORK_IDS,
  NETWORK_CREDITS,
  getNetworkMeta,
  normalizeNetworkContext,
  networkContextForAllocation,
} from './networks.js'

describe('NETWORK_IDS', () => {
  it('is frozen with the two canonical ids', () => {
    expect(Object.isFrozen(NETWORK_IDS)).toBe(true)
    expect(NETWORK_IDS).toEqual({
      STELLAR_TESTNET: 'stellar-testnet',
      BASE_SEPOLIA: 'base-sepolia',
    })
  })
})

describe('getNetworkMeta', () => {
  it('returns Stellar testnet meta with mark/source/trademark fields', () => {
    const meta = getNetworkMeta(NETWORK_IDS.STELLAR_TESTNET)
    expect(meta.id).toBe('stellar-testnet')
    expect(meta.label).toBe('Stellar testnet')
    expect(meta.markPath).toBe('/brand/networks/stellar.svg')
    expect(meta.sourceUrl).toContain('stellar.org')
    expect(meta.trademarkNotice.length).toBeGreaterThan(0)
    expect(meta.independenceNotice.length).toBeGreaterThan(0)
  })

  it('returns Base Sepolia meta with mark/source/trademark fields', () => {
    const meta = getNetworkMeta(NETWORK_IDS.BASE_SEPOLIA)
    expect(meta.id).toBe('base-sepolia')
    expect(meta.label).toBe('Base Sepolia')
    expect(meta.markPath).toBe('/brand/networks/base.svg')
    expect(meta.sourceUrl).toContain('brand.base.org')
    expect(meta.trademarkNotice.length).toBeGreaterThan(0)
    expect(meta.independenceNotice.length).toBeGreaterThan(0)
  })

  it('falls back to a visible Unknown network for an unrecognized id, never an empty icon', () => {
    const meta = getNetworkMeta('polygon-mumbai')
    expect(meta.label).toBe('Unknown network')
    // markPath is intentionally null here -- NetworkBadge renders its own fallback glyph so the
    // icon is never empty, it just isn't sourced from a network-specific asset.
    expect(meta.markPath).toBeNull()
  })

  it('falls back to Unknown network for null/undefined ids', () => {
    expect(getNetworkMeta(null).label).toBe('Unknown network')
    expect(getNetworkMeta(undefined).label).toBe('Unknown network')
  })

  it('treats prototype property names as unknown networks', () => {
    for (const networkId of ['__proto__', 'constructor', 'toString']) {
      const meta = getNetworkMeta(networkId)
      expect(meta.label, networkId).toBe('Unknown network')
      expect(meta.markPath, networkId).toBeNull()
    }
  })

  it('keeps the official self-hosted mark paths for both canonical networks', () => {
    expect(getNetworkMeta(NETWORK_IDS.STELLAR_TESTNET).markPath).toBe('/brand/networks/stellar.svg')
    expect(getNetworkMeta(NETWORK_IDS.BASE_SEPOLIA).markPath).toBe('/brand/networks/base.svg')
  })
})

describe('NETWORK_CREDITS', () => {
  it('is a frozen roster of both known networks, in a fixed order', () => {
    expect(Object.isFrozen(NETWORK_CREDITS)).toBe(true)
    expect(NETWORK_CREDITS.map((m) => m.id)).toEqual(['stellar-testnet', 'base-sepolia'])
  })
})

describe('normalizeNetworkContext', () => {
  it('Stellar deposit: host/source/destination/custody all Stellar testnet, no transit', () => {
    const ctx = normalizeNetworkContext({
      hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      destinationNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      custodyNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      transitState: 'none',
    })
    expect(ctx).toEqual({
      hostNetworkId: 'stellar-testnet',
      sourceNetworkId: 'stellar-testnet',
      destinationNetworkId: 'stellar-testnet',
      custodyNetworkId: 'stellar-testnet',
      transitState: 'none',
    })
    expect(Object.isFrozen(ctx)).toBe(true)
  })

  it('defaults a missing/empty context to an all-null, no-transit shape', () => {
    expect(normalizeNetworkContext()).toEqual({
      hostNetworkId: null,
      sourceNetworkId: null,
      destinationNetworkId: null,
      custodyNetworkId: null,
      transitState: 'none',
    })
    expect(normalizeNetworkContext({})).toEqual({
      hostNetworkId: null,
      sourceNetworkId: null,
      destinationNetworkId: null,
      custodyNetworkId: null,
      transitState: 'none',
    })
  })

  it('bridge agent account row: host Stellar, destination Base, custody stays on the source mid-bridge', () => {
    const ctx = normalizeNetworkContext({
      hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      custodyNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      transitState: 'burning',
    })
    expect(ctx.hostNetworkId).toBe('stellar-testnet')
    expect(ctx.destinationNetworkId).toBe('base-sepolia')
    expect(ctx.custodyNetworkId).toBe('stellar-testnet')
    expect(ctx.transitState).toBe('burning')
  })

  it('bridge agent account row: custody only moves to Base once the job has arrived', () => {
    const ctx = normalizeNetworkContext({
      hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      custodyNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      transitState: 'arrived',
    })
    expect(ctx.custodyNetworkId).toBe('base-sepolia')
  })

  it('Base child allocation/position after mint: custody is Base Sepolia', () => {
    const ctx = normalizeNetworkContext({
      hostNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      custodyNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      transitState: 'arrived',
    })
    expect(ctx.custodyNetworkId).toBe('base-sepolia')
  })

  it('pre-arrival bridge never claims Base custody, even when the raw input lies about it', () => {
    for (const transitState of ['source', 'burning', 'attesting', 'minting', 'failed', 'unknown']) {
      const ctx = normalizeNetworkContext({
        hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
        sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
        destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
        custodyNetworkId: NETWORK_IDS.BASE_SEPOLIA, // lie: claims Base custody before arrival
        transitState,
      })
      expect(ctx.custodyNetworkId).not.toBe('base-sepolia')
      expect(ctx.custodyNetworkId).toBe('stellar-testnet')
    }
  })

  it('keeps an unrecognized network id visible rather than silently nulling it out', () => {
    const ctx = normalizeNetworkContext({ hostNetworkId: 'polygon-mumbai' })
    expect(ctx.hostNetworkId).toBe('polygon-mumbai')
  })

  it('coerces an invalid transitState to unknown rather than crashing or going silent', () => {
    const ctx = normalizeNetworkContext({ transitState: 'bogus-state' })
    expect(ctx.transitState).toBe('unknown')
  })

  it('coerces a non-object context to the default shape rather than throwing', () => {
    expect(normalizeNetworkContext('not-an-object').transitState).toBe('none')
    expect(normalizeNetworkContext(null).transitState).toBe('none')
  })

  it('ignores inherited transit and custody claims so a prototype cannot forge Base arrival', () => {
    const context = Object.create({
      transitState: 'arrived',
      custodyNetworkId: NETWORK_IDS.BASE_SEPOLIA,
    })
    Object.assign(context, {
      hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      custodyNetworkId: NETWORK_IDS.BASE_SEPOLIA,
    })

    expect(normalizeNetworkContext(context)).toEqual({
      hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      custodyNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      transitState: 'none',
    })
  })

  it('ignores inherited network fields rather than treating prototype data as context evidence', () => {
    const context = Object.create({
      hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      custodyNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      transitState: 'arrived',
    })

    expect(normalizeNetworkContext(context)).toEqual({
      hostNetworkId: null,
      sourceNetworkId: null,
      destinationNetworkId: null,
      custodyNetworkId: null,
      transitState: 'none',
    })
  })

  it('never invokes an own accessor and fails closed when transit is a throwing getter', () => {
    const context = {
      hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      custodyNetworkId: NETWORK_IDS.BASE_SEPOLIA,
    }
    Object.defineProperty(context, 'transitState', {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error('transit getter must not run')
      },
    })

    expect(() => normalizeNetworkContext(context)).not.toThrow()
    expect(normalizeNetworkContext(context)).toEqual({
      hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      custodyNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      transitState: 'unknown',
    })
  })

  it('fails closed for a revoked proxy instead of leaking the proxy error', () => {
    const { proxy, revoke } = Proxy.revocable(
      {
        hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
        sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
        destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
        custodyNetworkId: NETWORK_IDS.BASE_SEPOLIA,
        transitState: 'arrived',
      },
      {}
    )
    revoke()

    expect(() => normalizeNetworkContext(proxy)).not.toThrow()
    expect(normalizeNetworkContext(proxy)).toEqual({
      hostNetworkId: null,
      sourceNetworkId: null,
      destinationNetworkId: null,
      custodyNetworkId: null,
      transitState: 'unknown',
    })
  })

  it('fails closed when a proxy throws while exposing own descriptors', () => {
    const context = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('own keys unavailable')
        },
      }
    )

    expect(() => normalizeNetworkContext(context)).not.toThrow()
    expect(normalizeNetworkContext(context)).toEqual({
      hostNetworkId: null,
      sourceNetworkId: null,
      destinationNetworkId: null,
      custodyNetworkId: null,
      transitState: 'unknown',
    })
  })

  it('takes one own-descriptor snapshot and never performs repeated property reads', () => {
    const trapCalls = []
    const target = {
      hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      custodyNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      transitState: 'burning',
    }
    const context = new Proxy(target, {
      ownKeys(value) {
        trapCalls.push('ownKeys')
        return Reflect.ownKeys(value)
      },
      getOwnPropertyDescriptor(value, key) {
        trapCalls.push(key)
        return Reflect.getOwnPropertyDescriptor(value, key)
      },
      get() {
        throw new Error('context values must come from the descriptor snapshot')
      },
    })

    expect(normalizeNetworkContext(context).transitState).toBe('burning')
    expect(trapCalls.filter((call) => call === 'ownKeys')).toHaveLength(1)
    expect(trapCalls.filter((call) => call === 'transitState')).toHaveLength(1)
  })
})

describe('networkContextForAllocation', () => {
  it('plain Stellar allocation: single-network context, no transit', () => {
    const ctx = networkContextForAllocation({ chain: 'stellar' })
    expect(ctx).toEqual({
      hostNetworkId: 'stellar-testnet',
      sourceNetworkId: 'stellar-testnet',
      destinationNetworkId: 'stellar-testnet',
      custodyNetworkId: 'stellar-testnet',
      transitState: 'none',
    })
  })

  it('Base allocation mid-bridge: custody stays on the Stellar host until arrival', () => {
    const ctx = networkContextForAllocation({
      chain: 'base',
      hostChain: 'stellar',
      bridge: { status: 'attesting' },
    })
    expect(ctx.hostNetworkId).toBe('stellar-testnet')
    expect(ctx.destinationNetworkId).toBe('base-sepolia')
    expect(ctx.custodyNetworkId).toBe('stellar-testnet')
    expect(ctx.transitState).toBe('attesting')
  })

  it('Base allocation once arrived: custody is Base Sepolia', () => {
    const ctx = networkContextForAllocation({
      chain: 'base',
      hostChain: 'stellar',
      bridge: { status: 'arrived' },
    })
    expect(ctx.custodyNetworkId).toBe('base-sepolia')
  })

  it('a resident Base position (no bridge field) is a plain single-network context', () => {
    const ctx = networkContextForAllocation({ chain: 'base', hostChain: 'base' })
    expect(ctx).toEqual({
      hostNetworkId: 'base-sepolia',
      sourceNetworkId: 'base-sepolia',
      destinationNetworkId: 'base-sepolia',
      custodyNetworkId: 'base-sepolia',
      transitState: 'none',
    })
  })

  it('a bridging allocation with no reported status is truthfully unknown, not silently "none"', () => {
    const ctx = networkContextForAllocation({ chain: 'base', hostChain: 'stellar', bridge: {} })
    expect(ctx.transitState).toBe('unknown')
    expect(ctx.custodyNetworkId).toBe('stellar-testnet')
  })

  it('an unrecognized chain string surfaces as an unknown network, not null', () => {
    const ctx = networkContextForAllocation({ chain: 'polygon', bridge: {} })
    expect(ctx.destinationNetworkId).toBe('polygon')
    expect(getNetworkMeta(ctx.destinationNetworkId).label).toBe('Unknown network')
  })

  it('does not resolve prototype property names as chain aliases', () => {
    for (const chain of ['__proto__', 'constructor', 'toString']) {
      const ctx = networkContextForAllocation({ chain, bridge: {} })
      expect(ctx.destinationNetworkId, chain).toBe(chain)
      expect(getNetworkMeta(ctx.destinationNetworkId).label, chain).toBe('Unknown network')
    }
  })

  it('accepts the canonical network ids directly as chain/hostChain (not just the short aliases)', () => {
    const ctx = networkContextForAllocation({
      chain: NETWORK_IDS.BASE_SEPOLIA,
      hostChain: NETWORK_IDS.STELLAR_TESTNET,
      bridge: { status: 'source' },
    })
    expect(ctx.destinationNetworkId).toBe('base-sepolia')
    expect(ctx.hostNetworkId).toBe('stellar-testnet')
  })

  it('fails closed for a known cross-network allocation with no own bridge evidence', () => {
    expect(
      networkContextForAllocation({
        chain: NETWORK_IDS.BASE_SEPOLIA,
        hostChain: NETWORK_IDS.STELLAR_TESTNET,
      })
    ).toEqual({
      hostNetworkId: null,
      sourceNetworkId: null,
      destinationNetworkId: null,
      custodyNetworkId: null,
      transitState: 'unknown',
    })
  })

  it('fails closed when an inherited bridge data value supplies apparent arrival', () => {
    const allocation = Object.create({ bridge: { status: 'arrived' } })
    allocation.chain = NETWORK_IDS.BASE_SEPOLIA
    allocation.hostChain = NETWORK_IDS.STELLAR_TESTNET

    expect(networkContextForAllocation(allocation)).toEqual({
      hostNetworkId: null,
      sourceNetworkId: null,
      destinationNetworkId: null,
      custodyNetworkId: null,
      transitState: 'unknown',
    })
  })

  it('does not invoke an inherited throwing bridge accessor and fails closed', () => {
    let getterCalled = false
    const prototype = {}
    Object.defineProperty(prototype, 'bridge', {
      configurable: true,
      get() {
        getterCalled = true
        throw new Error('inherited bridge getter must not run')
      },
    })
    const allocation = Object.create(prototype)
    allocation.chain = NETWORK_IDS.BASE_SEPOLIA
    allocation.hostChain = NETWORK_IDS.STELLAR_TESTNET

    expect(() => networkContextForAllocation(allocation)).not.toThrow()
    expect(getterCalled).toBe(false)
    expect(networkContextForAllocation(allocation)).toEqual({
      hostNetworkId: null,
      sourceNetworkId: null,
      destinationNetworkId: null,
      custodyNetworkId: null,
      transitState: 'unknown',
    })
  })

  it('ignores an inherited bridge status and keeps custody on Stellar with unknown transit', () => {
    const bridge = Object.create({ status: 'arrived' })
    const ctx = networkContextForAllocation({
      chain: 'base',
      hostChain: 'stellar',
      bridge,
    })

    expect(ctx.transitState).toBe('unknown')
    expect(ctx.custodyNetworkId).toBe('stellar-testnet')
  })

  it('fails closed when an allocation bridge descriptor is an accessor', () => {
    const allocation = {
      chain: 'base',
      hostChain: 'stellar',
    }
    Object.defineProperty(allocation, 'bridge', {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error('bridge getter must not run')
      },
    })

    expect(() => networkContextForAllocation(allocation)).not.toThrow()
    expect(networkContextForAllocation(allocation)).toEqual({
      hostNetworkId: null,
      sourceNetworkId: null,
      destinationNetworkId: null,
      custodyNetworkId: null,
      transitState: 'unknown',
    })
  })

  it.each(['chain', 'hostChain'])(
    'fails closed when the allocation %s descriptor is an accessor',
    (field) => {
      const allocation = {
        chain: 'base',
        hostChain: 'stellar',
      }
      Object.defineProperty(allocation, field, {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error(`${field} getter must not run`)
        },
      })

      expect(() => networkContextForAllocation(allocation)).not.toThrow()
      expect(networkContextForAllocation(allocation).transitState).toBe('unknown')
      expect(networkContextForAllocation(allocation).custodyNetworkId).toBeNull()
    }
  )

  it('fails closed when an allocation contains a revoked bridge proxy', () => {
    const { proxy, revoke } = Proxy.revocable({ status: 'arrived' }, {})
    revoke()

    expect(
      networkContextForAllocation({ chain: 'base', hostChain: 'stellar', bridge: proxy })
    ).toEqual({
      hostNetworkId: null,
      sourceNetworkId: null,
      destinationNetworkId: null,
      custodyNetworkId: null,
      transitState: 'unknown',
    })
  })
})
