// frontend/src/base/config.test.js
import { describe, test, expect, beforeEach, vi } from 'vitest'

describe('base/config', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  test('requireAddress throws a clear error for a malformed address override', async () => {
    vi.stubEnv('VITE_YIELD_ROUTER_ADDRESS', 'not-an-address')
    await expect(import('./config.js')).rejects.toThrow(/YIELD_ROUTER_ADDRESS/)
  })

  test('falls back to the baked Base Sepolia router when no override is set', async () => {
    vi.stubEnv('VITE_YIELD_ROUTER_ADDRESS', '')
    const mod = await import('./config.js')
    expect(mod.YIELD_ROUTER_ADDRESS).toBe('0xF80aa8F571E6d24Ea72F051Fc6F9A9C516727B6d')
  })

  test('exposes the Base Sepolia chain, ABIs, and 6dp unit helpers', async () => {
    vi.stubEnv('VITE_YIELD_ROUTER_ADDRESS', '0x1111111111111111111111111111111111111111')
    const mod = await import('./config.js')
    expect(mod.BASE_CHAIN.id).toBe(84532)
    expect(mod.BASE_USDC_DECIMALS).toBe(6)
    expect(mod.toBaseChainUnits(1)).toBe(1_000_000n)
    expect(mod.fromBaseChainUnits(1_000_000n)).toBeCloseTo(1, 6)
    expect(mod.YIELD_ROUTER_ABI.find((f) => f.name === 'deposit').inputs).toHaveLength(3)
    expect(mod.YIELD_ROUTER_ABI.find((f) => f.name === 'withdraw').inputs).toHaveLength(3)
  })

  test('zerodevRpcUrl throws without a project id, builds the v3 URL with one', async () => {
    vi.stubEnv('VITE_YIELD_ROUTER_ADDRESS', '0x1111111111111111111111111111111111111111')
    vi.stubEnv('VITE_ZERODEV_PROJECT_ID', '')
    const mod = await import('./config.js')
    expect(() => mod.zerodevRpcUrl()).toThrow(/ZERODEV_PROJECT_ID/)
  })
})
