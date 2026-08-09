// frontend/src/base/config.test.js
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { toFunctionSelector } from 'viem'

function hardenedRecord(overrides = {}) {
  const poolA = '0x1111111111111111111111111111111111111112'
  const poolB = '0x1111111111111111111111111111111111111113'
  const poolC = '0x1111111111111111111111111111111111111114'
  const deployment = {
    generation: 'hardened-v2',
    chainId: 84532,
    adminSafe: {
      address: '0x1111111111111111111111111111111111111111',
      proxyImplementation: '0x2222222222222222222222222222222222222222',
      runtimeCodeHash: `0x${'11'.repeat(32)}`,
      threshold: 1,
      owners: ['0x7777777777777777777777777777777777777777'],
    },
    yieldRouter: {
      address: '0x1111111111111111111111111111111111111111',
      deployTxHash: `0x${'22'.repeat(32)}`,
      deployBlockNumber: '12345',
      deployBlockHash: `0x${'33'.repeat(32)}`,
      rawRuntimeCodeHash: `0x${'44'.repeat(32)}`,
      normalizedRuntimeCodeHash: `0x${'55'.repeat(32)}`,
    },
    baseExitSweeper: {
      address: '0x4444444444444444444444444444444444444444',
      deployTxHash: `0x${'66'.repeat(32)}`,
      deployBlockNumber: '12346',
      deployBlockHash: `0x${'77'.repeat(32)}`,
      rawRuntimeCodeHash: `0x${'88'.repeat(32)}`,
      normalizedRuntimeCodeHash: `0x${'99'.repeat(32)}`,
    },
    route: {
      usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      tokenMessengerAddress: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      stellarDomain: 27,
      mintRecipient: `0x${'aa'.repeat(32)}`,
      destinationCaller: `0x${'bb'.repeat(32)}`,
      finalityThreshold: 1000,
    },
    selectors: {
      exitAllAndBurn: '0x4c9d247b',
      absent: ['0x0d390c9e', '0x9abaf267'],
    },
    pools: { enabled: [poolA, poolB, poolC], known: [poolA, poolB, poolC] },
    verification: { blockNumber: '12360', blockHash: `0x${'cc'.repeat(32)}` },
    ...overrides,
  }
  return { base: { hardenedDeployment: deployment } }
}

describe('base/config', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.doUnmock('./deploymentFacts.js')
    vi.resetModules()
  })

  test('keeps the baked legacy deployment historical-only with a stable public reason', async () => {
    const mod = await import('./config.js')

    expect(mod.BASE_CROSS_CHAIN_AVAILABLE).toBe(false)
    expect(mod.BASE_CROSS_CHAIN_UNAVAILABLE_REASON).toMatch(/temporarily unavailable/i)
    expect(mod.BASE_CROSS_CHAIN_UNAVAILABLE_REASON).not.toMatch(/rpc|hash|selector|0x/i)
    expect(mod.YIELD_ROUTER_ADDRESS).toBeTruthy()
    expect(mod.BASE_EXIT_SWEEPER_ADDRESS).toBeTruthy()
  })

  test('does not let VITE generation or address overrides enable Base execution', async () => {
    vi.stubEnv('VITE_BASE_DEPLOYMENT_GENERATION', 'hardened-v2')
    vi.stubEnv('VITE_YIELD_ROUTER_ADDRESS', '0x3333333333333333333333333333333333333333')
    vi.stubEnv('VITE_BASE_EXIT_SWEEPER_ADDRESS', '0x4444444444444444444444444444444444444444')

    const mod = await import('./config.js')

    expect(mod.BASE_CROSS_CHAIN_AVAILABLE).toBe(false)
  })

  test('accepts only the complete closed hardened verification record', async () => {
    const { evaluateBaseDeploymentRecord } = await import('./config.js')

    expect(evaluateBaseDeploymentRecord(hardenedRecord())).toMatchObject({ available: true })
    expect(evaluateBaseDeploymentRecord({ ...hardenedRecord(), unexpected: true })).toMatchObject({
      available: false,
    })
    expect(
      evaluateBaseDeploymentRecord(
        hardenedRecord({ verification: { blockNumber: 12360, blockHash: `0x${'cc'.repeat(32)}` } })
      )
    ).toMatchObject({ available: false })
    expect(
      evaluateBaseDeploymentRecord(
        hardenedRecord({
          selectors: { exitAllAndBurn: '0x4c9d247b', absent: ['0x9abaf267', '0x0d390c9e'] },
        })
      )
    ).toMatchObject({ available: false })
    expect(
      evaluateBaseDeploymentRecord(
        hardenedRecord({
          pools: {
            enabled: ['0x1111111111111111111111111111111111111112'],
            known: [
              '0x1111111111111111111111111111111111111112',
              '0x1111111111111111111111111111111111111113',
              '0x1111111111111111111111111111111111111114',
            ],
          },
        })
      )
    ).toMatchObject({ available: false })
  })

  test.each([
    ['Safe', (facts) => (facts.adminSafe.address = '0x0000000000000000000000000000000000000000')],
    [
      'Safe implementation',
      (facts) =>
        (facts.adminSafe.proxyImplementation = '0x0000000000000000000000000000000000000000'),
    ],
    [
      'Safe owner',
      (facts) => (facts.adminSafe.owners[0] = '0x0000000000000000000000000000000000000000'),
    ],
    [
      'YieldRouter',
      (facts) => (facts.yieldRouter.address = '0x0000000000000000000000000000000000000000'),
    ],
    [
      'BaseExitSweeper',
      (facts) => (facts.baseExitSweeper.address = '0x0000000000000000000000000000000000000000'),
    ],
    [
      'approved pool',
      (facts) => {
        facts.pools.enabled[0] = '0x0000000000000000000000000000000000000000'
        facts.pools.known[0] = '0x0000000000000000000000000000000000000000'
      },
    ],
  ])('rejects a zero %s address placeholder', async (_label, mutate) => {
    const { evaluateBaseDeploymentRecord } = await import('./config.js')
    const record = structuredClone(hardenedRecord())
    mutate(record.base.hardenedDeployment)

    expect(evaluateBaseDeploymentRecord(record)).toMatchObject({ available: false, facts: null })
  })

  test.each([
    ['Safe runtime', (facts) => (facts.adminSafe.runtimeCodeHash = `0x${'00'.repeat(32)}`)],
    ['router deploy tx', (facts) => (facts.yieldRouter.deployTxHash = `0x${'00'.repeat(32)}`)],
    [
      'router deploy block',
      (facts) => (facts.yieldRouter.deployBlockHash = `0x${'00'.repeat(32)}`),
    ],
    [
      'router raw runtime',
      (facts) => (facts.yieldRouter.rawRuntimeCodeHash = `0x${'00'.repeat(32)}`),
    ],
    [
      'router normalized runtime',
      (facts) => (facts.yieldRouter.normalizedRuntimeCodeHash = `0x${'00'.repeat(32)}`),
    ],
    ['sweeper deploy tx', (facts) => (facts.baseExitSweeper.deployTxHash = `0x${'00'.repeat(32)}`)],
    [
      'sweeper deploy block',
      (facts) => (facts.baseExitSweeper.deployBlockHash = `0x${'00'.repeat(32)}`),
    ],
    [
      'sweeper raw runtime',
      (facts) => (facts.baseExitSweeper.rawRuntimeCodeHash = `0x${'00'.repeat(32)}`),
    ],
    [
      'sweeper normalized runtime',
      (facts) => (facts.baseExitSweeper.normalizedRuntimeCodeHash = `0x${'00'.repeat(32)}`),
    ],
    ['verification block', (facts) => (facts.verification.blockHash = `0x${'00'.repeat(32)}`)],
  ])('rejects a zero %s hash placeholder', async (_label, mutate) => {
    const { evaluateBaseDeploymentRecord } = await import('./config.js')
    const record = structuredClone(hardenedRecord())
    mutate(record.base.hardenedDeployment)

    expect(evaluateBaseDeploymentRecord(record)).toMatchObject({ available: false, facts: null })
  })

  test.each(['mintRecipient', 'destinationCaller'])(
    'rejects a zero route %s bytes32 placeholder',
    async (field) => {
      const { evaluateBaseDeploymentRecord } = await import('./config.js')
      const record = structuredClone(hardenedRecord())
      record.base.hardenedDeployment.route[field] = `0x${'00'.repeat(32)}`

      expect(evaluateBaseDeploymentRecord(record)).toMatchObject({ available: false, facts: null })
    }
  )

  test('requires the exact Circle Base Sepolia USDC and TokenMessenger addresses', async () => {
    const { evaluateBaseDeploymentRecord } = await import('./config.js')
    const wrongUsdc = structuredClone(hardenedRecord())
    wrongUsdc.base.hardenedDeployment.route.usdcAddress =
      '0x5555555555555555555555555555555555555555'
    const wrongMessenger = structuredClone(hardenedRecord())
    wrongMessenger.base.hardenedDeployment.route.tokenMessengerAddress =
      '0x6666666666666666666666666666666666666666'

    expect(evaluateBaseDeploymentRecord(wrongUsdc).available).toBe(false)
    expect(evaluateBaseDeploymentRecord(wrongMessenger).available).toBe(false)
  })

  test.each([
    [
      'zero router deployment block',
      (facts) => {
        facts.yieldRouter.deployBlockNumber = '0'
      },
    ],
    [
      'zero sweeper deployment block',
      (facts) => {
        facts.baseExitSweeper.deployBlockNumber = '0'
      },
    ],
    [
      'zero verification block',
      (facts) => {
        facts.verification.blockNumber = '0'
      },
    ],
    [
      'sweeper deployed before its router',
      (facts) => {
        facts.yieldRouter.deployBlockNumber = '12347'
        facts.baseExitSweeper.deployBlockNumber = '12346'
      },
    ],
    [
      'verification before sweeper deployment',
      (facts) => {
        facts.verification.blockNumber = '12345'
      },
    ],
  ])('rejects invalid deployment chronology: %s', async (_label, mutate) => {
    const { evaluateBaseDeploymentRecord } = await import('./config.js')
    const record = structuredClone(hardenedRecord())
    mutate(record.base.hardenedDeployment)

    expect(evaluateBaseDeploymentRecord(record)).toMatchObject({ available: false, facts: null })
  })

  test('accepts the exact positive router <= sweeper <= verification boundary', async () => {
    const { evaluateBaseDeploymentRecord } = await import('./config.js')
    const record = structuredClone(hardenedRecord())
    const facts = record.base.hardenedDeployment
    facts.yieldRouter.deployBlockNumber = '12345'
    facts.baseExitSweeper.deployBlockNumber = '12345'
    facts.verification.blockNumber = '12345'

    expect(evaluateBaseDeploymentRecord(record)).toMatchObject({ available: true })
  })

  test('requires exactly the verifier six-field YieldRouter identity', async () => {
    const { evaluateBaseDeploymentRecord } = await import('./config.js')
    const extra = structuredClone(hardenedRecord())
    extra.base.hardenedDeployment.yieldRouter.owner =
      extra.base.hardenedDeployment.adminSafe.address
    const missing = structuredClone(hardenedRecord())
    delete missing.base.hardenedDeployment.yieldRouter.normalizedRuntimeCodeHash

    expect(evaluateBaseDeploymentRecord(extra).available).toBe(false)
    expect(evaluateBaseDeploymentRecord(missing).available).toBe(false)
  })

  test('enables only when the complete record agrees with every explicit execution env', async () => {
    vi.doMock('./deploymentFacts.js', () => ({ RECORDED_BASE_DEPLOYMENT: hardenedRecord() }))
    vi.stubEnv('VITE_YIELD_ROUTER_ADDRESS', '0x1111111111111111111111111111111111111111')
    vi.stubEnv('VITE_BASE_EXIT_SWEEPER_ADDRESS', '0x4444444444444444444444444444444444444444')

    const mod = await import('./config.js')

    expect(mod.BASE_CROSS_CHAIN_AVAILABLE).toBe(true)
  })

  test.each([
    ['router', 'VITE_YIELD_ROUTER_ADDRESS', '0x3333333333333333333333333333333333333333'],
    ['sweeper', 'VITE_BASE_EXIT_SWEEPER_ADDRESS', '0x5555555555555555555555555555555555555555'],
    ['pool set', 'VITE_BASE_POOL_1_ADDRESS', '0x8888888888888888888888888888888888888888'],
  ])(
    'keeps Base unavailable when the verified record disagrees with explicit %s env',
    async (_label, envName, value) => {
      vi.doMock('./deploymentFacts.js', () => ({ RECORDED_BASE_DEPLOYMENT: hardenedRecord() }))
      vi.stubEnv(envName, value)

      const mod = await import('./config.js')

      expect(mod.BASE_CROSS_CHAIN_AVAILABLE).toBe(false)
      expect(mod.VERIFIED_BASE_DEPLOYMENT).toBeNull()
    }
  )

  test('returns an immutable copy whose nested authority cannot be changed after validation', async () => {
    const { evaluateBaseDeploymentRecord } = await import('./config.js')
    const source = hardenedRecord()
    const result = evaluateBaseDeploymentRecord(source)

    expect(Object.isFrozen(result.facts)).toBe(true)
    expect(Object.isFrozen(result.facts.selectors)).toBe(true)
    expect(Object.isFrozen(result.facts.pools.enabled)).toBe(true)
    source.base.hardenedDeployment.selectors.exitAllAndBurn = '0x0d390c9e'
    expect(result.facts.selectors.exitAllAndBurn).toBe('0x4c9d247b')
  })

  test('exports only the five-argument deadline-bound hardened exit ABI', async () => {
    const mod = await import('./config.js')
    const exit = mod.BASE_EXIT_SWEEPER_ABI.find((entry) => entry.name === 'exitAllAndBurn')

    expect(exit.inputs).toEqual([
      { name: 'pools', type: 'address[]' },
      { name: 'minAssetsPerPool', type: 'uint256[]' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'hookData', type: 'bytes' },
    ])
    expect(toFunctionSelector(exit)).toBe('0x4c9d247b')
    expect(JSON.stringify(exit.inputs)).not.toMatch(/domain|recipient|caller|finality/i)
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
