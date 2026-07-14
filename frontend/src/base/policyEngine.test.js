import { describe, test, expect, vi } from 'vitest'

vi.stubEnv('VITE_YIELD_ROUTER_ADDRESS', '0xF0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0')
const policyEngine = await import('./policyEngine.js')
const { buildDepositPermissions, buildFarmPermissions, evaluateCall } = policyEngine
const { ERC20_ABI, YIELD_ROUTER_ABI, YIELD_ROUTER_ADDRESS } = await import('./config.js')
const { ParamCondition } = await import('@zerodev/permissions/policies')

const POOL_A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const POOL_B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const WRONG_TARGET = '0xC0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0'

function permissionArgs(
  pools = [
    { pool: POOL_A, cap: 100_000_000n },
    { pool: POOL_B, cap: 50_000_000n },
  ]
) {
  return {
    pools,
    yieldRouterAbi: YIELD_ROUTER_ABI,
    usdcAbi: ERC20_ABI,
    yieldRouterAddress: YIELD_ROUTER_ADDRESS,
    usdcAddress: USDC_ADDRESS,
  }
}

function buildPermissions(pools) {
  return buildFarmPermissions(permissionArgs(pools))
}

describe('farm permissions', () => {
  test('exports the hardened buildFarmPermissions interface', () => {
    expect(policyEngine.buildFarmPermissions).toBeTypeOf('function')
  })

  test('keeps buildDepositPermissions as an equivalent compatibility export', () => {
    expect(buildDepositPermissions(permissionArgs())).toEqual(buildPermissions())
  })

  test('builds exactly the canonical USDC.approve + YieldRouter.deposit permissions', () => {
    const permissions = buildPermissions()

    expect(permissions).toEqual([
      {
        target: USDC_ADDRESS,
        valueLimit: 0n,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [
          { condition: ParamCondition.EQUAL, value: YIELD_ROUTER_ADDRESS },
          { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: 100_000_000n },
        ],
      },
      {
        target: YIELD_ROUTER_ADDRESS,
        valueLimit: 0n,
        abi: YIELD_ROUTER_ABI,
        functionName: 'deposit',
        args: [null, { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: 100_000_000n }, null],
      },
    ])
  })

  test('rejects an empty pool list', () => {
    expect(() => buildPermissions([])).toThrow(/at least one pool/)
  })

  test('rejects a non-positive cap', () => {
    expect(() => buildPermissions([{ pool: POOL_A, cap: 0n }])).toThrow(/invalid cap/)
  })
})

describe('evaluateCall - canonical relayer batch plus cap/expiry cases', () => {
  const permissions = buildPermissions([{ pool: POOL_A, cap: 100_000_000n }])
  const expiry = Math.floor(Date.now() / 1000) + 3600

  test('canonical USDC approval to YieldRouter within cap is allowed', () => {
    const result = evaluateCall({
      permissions,
      to: USDC_ADDRESS,
      functionName: 'approve',
      args: [YIELD_ROUTER_ADDRESS, 50_000_000n],
      expiry,
    })
    expect(result).toEqual({ allowed: true, reason: null })
  })

  test('USDC approval to any other spender is rejected', () => {
    const result = evaluateCall({
      permissions,
      to: USDC_ADDRESS,
      functionName: 'approve',
      args: [WRONG_TARGET, 1n],
      expiry,
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/EQUAL/)
  })

  test('over-cap USDC approval is rejected', () => {
    const result = evaluateCall({
      permissions,
      to: USDC_ADDRESS,
      functionName: 'approve',
      args: [YIELD_ROUTER_ADDRESS, 100_000_001n],
      expiry,
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/exceeds policy cap/)
  })

  test('in-policy deposit within cap is allowed', () => {
    const result = evaluateCall({
      permissions,
      to: YIELD_ROUTER_ADDRESS,
      functionName: 'deposit',
      args: [POOL_A, 50_000_000n, 1n],
      expiry,
    })
    expect(result).toEqual({ allowed: true, reason: null })
  })

  test('nonzero native call value is rejected by the zero value limit', () => {
    const result = evaluateCall({
      permissions,
      to: YIELD_ROUTER_ADDRESS,
      functionName: 'deposit',
      args: [POOL_A, 50_000_000n, 1n],
      value: 1n,
      expiry,
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/value.*limit/i)
  })

  test('allows native call value at a custom limit and rejects value above it', () => {
    const customPermissions = permissions.map((permission) => ({
      ...permission,
      valueLimit: 2n,
    }))
    const call = {
      permissions: customPermissions,
      to: YIELD_ROUTER_ADDRESS,
      functionName: 'deposit',
      args: [POOL_A, 50_000_000n, 1n],
      expiry,
    }

    expect(evaluateCall({ ...call, value: 2n })).toEqual({ allowed: true, reason: null })
    expect(evaluateCall({ ...call, value: 3n })).toEqual({
      allowed: false,
      reason: 'call value exceeds permission limit',
    })
  })

  test('wrong selector is rejected', () => {
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

  test('wrong target is rejected', () => {
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

  test('a pool not in the intended allocation remains gated by YieldRouter on-chain', () => {
    const result = evaluateCall({
      permissions,
      to: YIELD_ROUTER_ADDRESS,
      functionName: 'deposit',
      args: [POOL_B, 1n, 1n],
      expiry,
    })
    expect(result).toEqual({ allowed: true, reason: null })
  })

  test('over-cap deposit amount is rejected', () => {
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

  test('expired mandate rejects both canonical calls', () => {
    const expiredAt = Math.floor(Date.now() / 1000) - 10
    const calls = [
      { to: USDC_ADDRESS, functionName: 'approve', args: [YIELD_ROUTER_ADDRESS, 1n] },
      { to: YIELD_ROUTER_ADDRESS, functionName: 'deposit', args: [POOL_A, 1n, 1n] },
    ]

    for (const call of calls) {
      expect(evaluateCall({ permissions, ...call, expiry: expiredAt })).toEqual({
        allowed: false,
        reason: 'expired',
      })
    }
  })
})
