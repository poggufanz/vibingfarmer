import { describe, it, expect, vi } from 'vitest'
import { encodeEventTopics, encodeAbiParameters, decodeFunctionData } from 'viem'

vi.mock('./deploymentFacts.js', async () => {
  const { HARDENED_BASE_DEPLOYMENT_FIXTURE } = await import('./hardenedDeployment.fixture.js')
  return { RECORDED_BASE_DEPLOYMENT: HARDENED_BASE_DEPLOYMENT_FIXTURE }
})

import { buildUnwindCalls, signAndSubmitUnwind } from './withdrawBatch.js'
import {
  BASE_EXIT_SWEEPER_ADDRESS,
  BASE_EXIT_SWEEPER_ABI,
  BASE_USDC_ADDRESS,
  ERC20_ABI,
} from './config.js'

const STELLAR = 'GCXMZCDVYTAANBRASUGWS5GDKRGSQWNM5XHVB4JI7PXECZYKBG5OTTRK'
const BASE_USDC = BASE_USDC_ADDRESS
const DEADLINE = 2_000_000_600n
const NOW = 2_000_000_000n

// Test-side fix (brief verbatim used '0xAAAA'/'0xBBBB'): the sweeper's `pools: address[]` ABI
// arg means pool addresses now flow through viem's encodeFunctionData, which requires a real
// 20-byte address (see report: viem throws "Address ... is invalid" on a short placeholder).
// Full-length lowercase addresses keep the A-vs-B distinguishing intent of the original fixture.
const POOL_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const POOL_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

const positions = [
  { pool: POOL_A, shares: 100n, assets: 2_000_000n, minAssets: 1_990_000n },
  { pool: POOL_B, shares: 200n, assets: 3_000_000n, minAssets: 2_985_000n },
]

describe('buildUnwindCalls', () => {
  it('approves max on every share token and USDC, calls the sweeper once, then zeroes every approval', () => {
    const calls = buildUnwindCalls({
      positions,
      stellarRecipient: STELLAR,
      idleUsdc: 500_000n,
      deadline: DEADLINE,
      nowSeconds: NOW,
    })

    // 2 share approvals + 1 usdc approval + 1 sweeper call + 2 share revokes + 1 usdc revoke
    expect(calls).toHaveLength(7)
    expect(calls.map((c) => c.to)).toEqual([
      POOL_A,
      POOL_B,
      BASE_USDC,
      BASE_EXIT_SWEEPER_ADDRESS,
      POOL_A,
      POOL_B,
      BASE_USDC,
    ])

    const approvals = calls
      .filter((call) => call.to !== BASE_EXIT_SWEEPER_ADDRESS)
      .map((call) => decodeFunctionData({ abi: ERC20_ABI, data: call.data }))
    const max = (1n << 256n) - 1n
    expect(approvals.map((approval) => approval.functionName)).toEqual([
      'approve',
      'approve',
      'approve',
      'approve',
      'approve',
      'approve',
    ])
    expect(approvals.map((approval) => approval.args[0])).toEqual(
      Array(6).fill(BASE_EXIT_SWEEPER_ADDRESS)
    )
    expect(approvals.map((approval) => approval.args[1])).toEqual([max, max, max, 0n, 0n, 0n])
  })

  it('sends exactly ONE burn per transaction by delegating the amount to the contract', () => {
    const calls = buildUnwindCalls({
      positions,
      stellarRecipient: STELLAR,
      idleUsdc: 0n,
      deadline: DEADLINE,
      nowSeconds: NOW,
    })
    const sweeperCalls = calls.filter((c) => c.to === BASE_EXIT_SWEEPER_ADDRESS)
    expect(sweeperCalls).toHaveLength(1)
  })

  it('never encodes a burn amount - the leak was passing minAssets as the amount', () => {
    const calls = buildUnwindCalls({
      positions,
      stellarRecipient: STELLAR,
      idleUsdc: 0n,
      deadline: DEADLINE,
      nowSeconds: NOW,
    })
    const sweeperCall = calls.find((call) => call.to === BASE_EXIT_SWEEPER_ADDRESS)
    const decoded = decodeFunctionData({ abi: BASE_EXIT_SWEEPER_ABI, data: sweeperCall.data })

    expect(sweeperCall.data.slice(0, 10)).toBe('0x4c9d247b')
    expect(decoded.args[0].map((address) => address.toLowerCase())).toEqual([POOL_A, POOL_B])
    expect(decoded.args.slice(1)).toEqual([
      [1_990_000n, 2_985_000n],
      49_750n,
      DEADLINE,
      expect.stringMatching(/^0x/),
    ])
    expect(decoded.args).toHaveLength(5)
  })

  it('rejects a call with neither positions nor idle USDC', () => {
    expect(() =>
      buildUnwindCalls({
        positions: [],
        stellarRecipient: STELLAR,
        idleUsdc: 0n,
        deadline: DEADLINE,
        nowSeconds: NOW,
      })
    ).toThrow(/nothing to withdraw/i)
  })

  it('accepts idle USDC with zero positions', () => {
    const calls = buildUnwindCalls({
      positions: [],
      stellarRecipient: STELLAR,
      idleUsdc: 900_000n,
      deadline: DEADLINE,
      nowSeconds: NOW,
    })
    expect(calls.map((c) => c.to)).toEqual([BASE_USDC, BASE_EXIT_SWEEPER_ADDRESS, BASE_USDC])
  })

  it('validates hookData before emitting any call, so a bad hook never reaches a burn', () => {
    expect(() =>
      buildUnwindCalls({
        positions,
        stellarRecipient: 'NOT-A-STRKEY',
        idleUsdc: 0n,
        deadline: DEADLINE,
        nowSeconds: NOW,
      })
    ).toThrow()
  })

  it('bases maxFee on floors plus idle so it never rounds to zero on a real position', () => {
    const calls = buildUnwindCalls({
      positions,
      stellarRecipient: STELLAR,
      idleUsdc: 500_000n,
      deadline: DEADLINE,
      nowSeconds: NOW,
    })
    // (1_990_000 + 2_985_000 + 500_000) / 100 = 54_750 -> 0xD5DE, present in the calldata.
    const sweeperCall = calls.find((c) => c.to === BASE_EXIT_SWEEPER_ADDRESS)
    expect(sweeperCall.data.toLowerCase()).toContain('d5de')
  })

  it('keeps execution units lossless above Number.MAX_SAFE_INTEGER and rejects Number inputs', () => {
    const hugeFloor = (1n << 200n) + 12_345n
    const calls = buildUnwindCalls({
      positions: [{ pool: POOL_A, minAssets: hugeFloor }],
      stellarRecipient: STELLAR,
      idleUsdc: 7n,
      deadline: DEADLINE,
      nowSeconds: NOW,
    })
    const sweeperCall = calls.find((call) => call.to === BASE_EXIT_SWEEPER_ADDRESS)
    const decoded = decodeFunctionData({ abi: BASE_EXIT_SWEEPER_ABI, data: sweeperCall.data })
    expect(decoded.args[1]).toEqual([hugeFloor])
    expect(decoded.args[2]).toBe(((hugeFloor + 7n) * 100n) / 10_000n)

    expect(() =>
      buildUnwindCalls({
        positions: [{ pool: POOL_A, minAssets: Number(hugeFloor) }],
        stellarRecipient: STELLAR,
        deadline: DEADLINE,
        nowSeconds: NOW,
      })
    ).toThrow(/bigint/i)
  })

  it('rejects an expired owner-selected deadline before encoding any call', () => {
    expect(() =>
      buildUnwindCalls({
        positions,
        stellarRecipient: STELLAR,
        deadline: NOW,
        nowSeconds: NOW,
      })
    ).toThrow(/deadline.*expired/i)
  })
})

// Builds a real encoded `Swept(owner indexed, burned, exited, skipped)` log the same way the
// deployed sweeper would emit it, so the decode path in signAndSubmitUnwind is exercised for
// real rather than against a hand-shaped object.
const OWNER_ADDR = `0x${'c'.repeat(40)}`
const OTHER_OWNER = `0x${'d'.repeat(40)}`
const USER_OP_HASH = `0x${'a'.repeat(64)}`
const UNWIND_TX_HASH = `0x${'b'.repeat(64)}`
const UNWIND_JOB_ID = 'ab'.repeat(16)
// keccak256(bytes16("vf-unwind-job-v1") || bytes16(UNWIND_JOB_ID)); independently
// pinned so the browser cannot silently change the signed reservation commitment domain.
const UNWIND_JOB_COMMITMENT = '0x2a8c851ab65e5f08fe5af4d1b09eaf2bbd7156fe6561f537d30454905de12cb7'
const EXPECTED_HOOK_DATA = `0x${'00'.repeat(28)}00000038${Buffer.from(STELLAR).toString('hex')}`

function sweptLog({
  burned,
  exited,
  skipped,
  address = BASE_EXIT_SWEEPER_ADDRESS,
  owner = OWNER_ADDR,
}) {
  const topics = encodeEventTopics({
    abi: BASE_EXIT_SWEEPER_ABI,
    eventName: 'Swept',
    args: { owner },
  })
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    [burned, exited, skipped]
  )
  return { address, topics, data }
}

describe('signAndSubmitUnwind', () => {
  const verifiedReceipt = (logs = []) => ({
    success: true,
    logs,
    receipt: { status: 'success', transactionHash: UNWIND_TX_HASH, logs: [] },
  })

  function harness({ receipt = verifiedReceipt(), userOpHash = USER_OP_HASH, trace = [] } = {}) {
    const kernelClient = {
      account: { encodeCalls: vi.fn(async (calls) => ({ encoded: calls })) },
      sendUserOperation: vi.fn(async () => {
        trace.push('send')
        return userOpHash
      }),
      waitForUserOperationReceipt: vi.fn(async () => {
        trace.push('wait')
        return receipt
      }),
    }
    return {
      kernelClient,
      deps: { makeGaslessClient: vi.fn(() => kernelClient) },
    }
  }

  const invoke = (overrides = {}) =>
    signAndSubmitUnwind({
      ownerKernelAccount: { address: OWNER_ADDR },
      jobId: UNWIND_JOB_ID,
      publicClient: {},
      positions,
      stellarRecipient: STELLAR,
      idleUsdc: 0n,
      deadline: DEADLINE,
      nowSeconds: NOW,
      ...overrides,
    })

  it('checkpoints the canonical UserOperation hash after send and before receipt polling', async () => {
    const trace = []
    const { deps } = harness({
      trace,
      receipt: verifiedReceipt([sweptLog({ burned: 5_500_000n, exited: 2n, skipped: 1n })]),
    })

    await invoke({
      deps,
      onSubmitted: async (hash) => trace.push(`checkpoint:${hash}`),
    })

    expect(trace).toEqual(['send', `checkpoint:${USER_OP_HASH}`, 'wait'])
  })

  it('commits the durable unwind job into the owner-signed UserOperation data suffix', async () => {
    const { deps, kernelClient } = harness({
      receipt: verifiedReceipt([sweptLog({ burned: 5_500_000n, exited: 2n, skipped: 1n })]),
    })

    await invoke({ deps, onSubmitted: vi.fn() })

    expect(kernelClient.sendUserOperation).toHaveBeenCalledWith({
      callData: expect.anything(),
      dataSuffix: UNWIND_JOB_COMMITMENT,
    })
  })

  it('rejects a malformed unwind job before encoding, signing, or submission', async () => {
    const { deps, kernelClient } = harness()

    await expect(
      invoke({ jobId: UNWIND_JOB_ID.toUpperCase(), deps, onSubmitted: vi.fn() })
    ).rejects.toThrow(/job/i)

    expect(kernelClient.account.encodeCalls).not.toHaveBeenCalled()
    expect(kernelClient.sendUserOperation).not.toHaveBeenCalled()
    expect(kernelClient.waitForUserOperationReceipt).not.toHaveBeenCalled()
  })

  it('rejects a malformed returned UserOperation hash before callback or receipt polling', async () => {
    const onSubmitted = vi.fn()
    const { deps, kernelClient } = harness({ userOpHash: 'userop-hash-1' })

    await expect(invoke({ deps, onSubmitted })).rejects.toThrow(/user operation hash/i)
    expect(onSubmitted).not.toHaveBeenCalled()
    expect(kernelClient.waitForUserOperationReceipt).not.toHaveBeenCalled()
  })

  it('treats a rejected send after invoking the submission seam as unknown and never resends', async () => {
    const onSubmitted = vi.fn()
    const { deps, kernelClient } = harness()
    kernelClient.sendUserOperation.mockRejectedValueOnce(
      new Error('private bundler detail must not escape')
    )

    let error
    try {
      await invoke({ deps, onSubmitted })
    } catch (caught) {
      error = caught
    }

    expect(error?.code).toBe('submission_unknown')
    expect(error?.message).toMatch(/submission status is unknown/i)
    expect(error?.message).not.toMatch(/private bundler/i)
    expect(error).not.toHaveProperty('cause')
    expect(kernelClient.sendUserOperation).toHaveBeenCalledTimes(1)
    expect(onSubmitted).not.toHaveBeenCalled()
    expect(kernelClient.waitForUserOperationReceipt).not.toHaveBeenCalled()
  })

  it('stops after a rejected checkpoint without waiting or sending a second UserOperation', async () => {
    const { deps, kernelClient } = harness()
    let error
    try {
      await invoke({
        deps,
        onSubmitted: vi.fn(async () => {
          throw new Error('storage secret must not escape')
        }),
      })
    } catch (caught) {
      error = caught
    }

    expect(error?.code).toBe('submitted-but-checkpoint-failed')
    expect(error?.userOpHash).toBe(USER_OP_HASH)
    expect(error?.message).not.toMatch(/storage secret/i)
    expect(kernelClient.sendUserOperation).toHaveBeenCalledTimes(1)
    expect(kernelClient.waitForUserOperationReceipt).not.toHaveBeenCalled()
  })

  it.each([
    [
      'outer failure',
      { success: false, logs: [], receipt: { status: 'success', transactionHash: UNWIND_TX_HASH } },
    ],
    [
      'inner revert',
      { success: true, logs: [], receipt: { status: 'reverted', transactionHash: UNWIND_TX_HASH } },
    ],
  ])('rejects strict receipt disagreement: %s', async (_label, receipt) => {
    const { deps } = harness({ receipt })
    await expect(invoke({ deps, onSubmitted: vi.fn() })).rejects.toThrow()
  })

  it('returns exact verified Swept evidence from one owner-bound top-level UserOperation log', async () => {
    const { deps, kernelClient } = harness({
      receipt: verifiedReceipt([sweptLog({ burned: 5_500_000n, exited: 2n, skipped: 1n })]),
    })
    const out = await invoke({ deps, onSubmitted: vi.fn() })

    expect(out).toEqual({
      userOpHash: USER_OP_HASH,
      unwindTxHash: UNWIND_TX_HASH,
      burned: 5_500_000n,
      exited: 2n,
      skipped: 1n,
      maxFee: 49_750n,
      hookData: EXPECTED_HOOK_DATA,
      evidenceStatus: 'verified',
    })
    expect(kernelClient.account.encodeCalls.mock.calls[0][0]).toHaveLength(7)
  })

  it.each([
    ['missing Swept', [], []],
    [
      'duplicate Swept',
      [
        sweptLog({ burned: 5_500_000n, exited: 2n, skipped: 1n }),
        sweptLog({ burned: 5_500_000n, exited: 2n, skipped: 1n }),
      ],
      [],
    ],
    [
      'wrong-contract Swept',
      [sweptLog({ burned: 5_500_000n, exited: 2n, skipped: 1n, address: POOL_A })],
      [],
    ],
    [
      'wrong-owner Swept',
      [sweptLog({ burned: 5_500_000n, exited: 2n, skipped: 1n, owner: OTHER_OWNER })],
      [],
    ],
    ['zero-burn Swept', [sweptLog({ burned: 0n, exited: 0n, skipped: 0n })], []],
    [
      'one correct plus one wrong-owner Swept',
      [
        sweptLog({ burned: 5_500_000n, exited: 2n, skipped: 1n }),
        sweptLog({ burned: 1n, exited: 1n, skipped: 0n, owner: OTHER_OWNER }),
      ],
      [],
    ],
    [
      'malformed Swept',
      [{ ...sweptLog({ burned: 1n, exited: 1n, skipped: 0n }), data: '0x01' }],
      [],
    ],
    [
      'one correct plus one malformed same-sweeper Swept',
      [
        sweptLog({ burned: 5_500_000n, exited: 2n, skipped: 1n }),
        { ...sweptLog({ burned: 1n, exited: 1n, skipped: 0n }), data: '0x01' },
      ],
      [],
    ],
    ['nested-only Swept', [], [sweptLog({ burned: 5_500_000n, exited: 2n, skipped: 1n })]],
  ])(
    'returns needs_reconcile for %s without treating a landed burn as failure',
    async (_label, logs, nestedLogs) => {
      const receipt = verifiedReceipt(logs)
      receipt.receipt.logs = nestedLogs
      const { deps } = harness({ receipt })

      const out = await invoke({ deps, onSubmitted: vi.fn() })

      expect(out).toMatchObject({
        userOpHash: USER_OP_HASH,
        unwindTxHash: UNWIND_TX_HASH,
        burned: null,
        exited: null,
        skipped: null,
        evidenceStatus: 'needs_reconcile',
      })
    }
  )

  it('ignores unrelated top-level logs while verifying the one exact Swept event', async () => {
    const unrelated = { address: POOL_B, topics: [`0x${'1'.repeat(64)}`], data: '0x' }
    const { deps } = harness({
      receipt: verifiedReceipt([
        unrelated,
        sweptLog({ burned: 7_000_000n, exited: 2n, skipped: 0n }),
      ]),
    })

    await expect(invoke({ deps, onSubmitted: vi.fn() })).resolves.toMatchObject({
      burned: 7_000_000n,
      evidenceStatus: 'verified',
    })
  })

  it('uses only the owner Kernel client and never invokes injected session-key paths', async () => {
    const sessionSend = vi.fn(() => {
      throw new Error('session path must remain unreachable')
    })
    const { deps } = harness({
      receipt: verifiedReceipt([sweptLog({ burned: 1n, exited: 1n, skipped: 0n })]),
    })
    await invoke({
      deps: { ...deps, sessionSend, createSessionClient: sessionSend },
      onSubmitted: vi.fn(),
    })
    expect(sessionSend).not.toHaveBeenCalled()
  })
})
