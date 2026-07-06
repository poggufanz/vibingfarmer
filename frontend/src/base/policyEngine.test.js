// frontend/src/base/policyEngine.test.js
import { describe, test, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('VITE_YIELD_ROUTER_ADDRESS', '0xF0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0')
const { buildDepositPermissions, evaluateCall } = await import('./policyEngine.js')
const { YIELD_ROUTER_ABI, YIELD_ROUTER_ADDRESS } = await import('./config.js')

const POOL_A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const POOL_B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const WRONG_TARGET = '0xC0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0'

describe('buildDepositPermissions', () => {
  test('builds one permission entry per pool, targeting YieldRouter.deposit', () => {
    const permissions = buildDepositPermissions({
      pools: [
        { pool: POOL_A, cap: 100_000_000n },
        { pool: POOL_B, cap: 50_000_000n },
      ],
      yieldRouterAbi: YIELD_ROUTER_ABI,
    })
    expect(permissions).toHaveLength(2)
    expect(permissions[0].target).toBe(YIELD_ROUTER_ADDRESS)
    expect(permissions[0].functionName).toBe('deposit')
    expect(permissions[0].valueLimit).toBe(0n)
    expect(permissions[0].args[0]).toMatchObject({ value: POOL_A })
    expect(permissions[0].args[1]).toMatchObject({ value: 100_000_000n })
    expect(permissions[0].args[2]).toBeNull() // minShares unconstrained by the session policy
    expect(permissions[1].args[0]).toMatchObject({ value: POOL_B })
  })

  test('rejects an empty pool list', () => {
    expect(() => buildDepositPermissions({ pools: [], yieldRouterAbi: YIELD_ROUTER_ABI })).toThrow(
      /at least one pool/
    )
  })

  test('rejects a non-positive cap', () => {
    expect(() =>
      buildDepositPermissions({
        pools: [{ pool: POOL_A, cap: 0n }],
        yieldRouterAbi: YIELD_ROUTER_ABI,
      })
    ).toThrow(/invalid cap/)
  })
})

describe('evaluateCall — mirrors the SP0 session-test.mjs scenarios plus the new cap/expiry cases', () => {
  const permissions = buildDepositPermissions({
    pools: [{ pool: POOL_A, cap: 100_000_000n }],
    yieldRouterAbi: YIELD_ROUTER_ABI,
  })
  const expiry = Math.floor(Date.now() / 1000) + 3600

  test('in-policy deposit within cap is allowed (mirrors session-test.mjs Test 1)', () => {
    const result = evaluateCall({
      permissions,
      to: YIELD_ROUTER_ADDRESS,
      functionName: 'deposit',
      args: [POOL_A, 50_000_000n, 1n],
      expiry,
    })
    expect(result).toEqual({ allowed: true, reason: null })
  })

  test('wrong selector (sweep) is rejected (mirrors session-test.mjs Test 2)', () => {
    const result = evaluateCall({
      permissions,
      to: YIELD_ROUTER_ADDRESS,
      functionName: 'sweep',
      args: [WRONG_TARGET],
      expiry,
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/no permission/)
  })

  test('wrong target is rejected (mirrors session-test.mjs Test 3)', () => {
    const result = evaluateCall({
      permissions,
      to: WRONG_TARGET,
      functionName: 'deposit',
      args: [POOL_A, 1n, 1n],
      expiry,
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/no permission/)
  })

  test('a pool not in the policy is rejected even on the right target+selector', () => {
    const result = evaluateCall({
      permissions,
      to: YIELD_ROUTER_ADDRESS,
      functionName: 'deposit',
      args: [POOL_B, 1n, 1n],
      expiry,
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/EQUAL/)
  })

  test('over-cap amount is rejected (NEW — not covered by the delivered SP0 spike)', () => {
    const result = evaluateCall({
      permissions,
      to: YIELD_ROUTER_ADDRESS,
      functionName: 'deposit',
      args: [POOL_A, 100_000_001n, 1n],
      expiry,
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/exceeds policy cap/)
  })

  test('expired mandate is rejected (NEW — not covered by the delivered SP0 spike)', () => {
    const result = evaluateCall({
      permissions,
      to: YIELD_ROUTER_ADDRESS,
      functionName: 'deposit',
      args: [POOL_A, 1n, 1n],
      expiry: Math.floor(Date.now() / 1000) - 10,
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('expired')
  })
})
