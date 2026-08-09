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

const STELLAR = 'GAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCF6M'
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
function sweptLog({ burned, exited, skipped, address = BASE_EXIT_SWEEPER_ADDRESS }) {
  const topics = encodeEventTopics({
    abi: BASE_EXIT_SWEEPER_ABI,
    eventName: 'Swept',
    args: { owner: OWNER_ADDR },
  })
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    [burned, exited, skipped]
  )
  return { address, topics, data }
}

describe('signAndSubmitUnwind', () => {
  const sentCallData = []
  const deps = {
    makeGaslessClient: vi.fn(() => ({
      account: { encodeCalls: vi.fn(async (calls) => ({ encoded: calls })) },
      sendUserOperation: vi.fn(async ({ callData }) => {
        sentCallData.push(callData)
        return 'userop-hash-1'
      }),
      waitForUserOperationReceipt: vi.fn(async () => ({
        success: true,
        receipt: {
          transactionHash: '0xUNWINDTX',
          logs: [sweptLog({ burned: 5_500_000n, exited: 2n, skipped: 1n })],
        },
      })),
    })),
  }

  it('sends ONE owner-signed userOp containing the whole batch and returns its tx hash plus the decoded Swept outcome', async () => {
    sentCallData.length = 0
    const out = await signAndSubmitUnwind({
      ownerKernelAccount: { address: '0xOWNER' },
      publicClient: {},
      positions,
      stellarRecipient: STELLAR,
      idleUsdc: 0n,
      deadline: DEADLINE,
      nowSeconds: NOW,
      deps,
    })
    expect(out.unwindTxHash).toBe('0xUNWINDTX')
    expect(out.burned).toBe(5_500_000n)
    expect(out.exited).toBe(2n)
    expect(out.skipped).toBe(1n)
    expect(sentCallData).toHaveLength(1)
    expect(sentCallData[0].encoded).toHaveLength(7)
  })

  it('falls back to null outcome fields (never throws) when the receipt has no decodable Swept log', async () => {
    const noLogsDeps = {
      makeGaslessClient: vi.fn(() => ({
        account: { encodeCalls: vi.fn(async (calls) => ({ encoded: calls })) },
        sendUserOperation: vi.fn(async () => 'userop-hash-3'),
        waitForUserOperationReceipt: vi.fn(async () => ({
          success: true,
          receipt: { transactionHash: '0xUNWINDTX2', logs: [] },
        })),
      })),
    }
    const out = await signAndSubmitUnwind({
      ownerKernelAccount: { address: '0xOWNER' },
      publicClient: {},
      positions,
      stellarRecipient: STELLAR,
      idleUsdc: 0n,
      deadline: DEADLINE,
      nowSeconds: NOW,
      deps: noLogsDeps,
    })
    // A reporting miss must never turn a landed burn into a reported failure.
    expect(out.unwindTxHash).toBe('0xUNWINDTX2')
    expect(out.burned).toBeNull()
    expect(out.exited).toBeNull()
    expect(out.skipped).toBeNull()
  })

  it('throws if the userOp mines but does not succeed - never reports a fake success', async () => {
    const failing = {
      makeGaslessClient: vi.fn(() => ({
        account: { encodeCalls: vi.fn(async (calls) => ({ encoded: calls })) },
        sendUserOperation: vi.fn(async () => 'userop-hash-2'),
        waitForUserOperationReceipt: vi.fn(async () => ({
          success: false,
          receipt: { status: 'reverted', transactionHash: '0xDEAD' },
        })),
      })),
    }
    await expect(
      signAndSubmitUnwind({
        ownerKernelAccount: { address: '0xOWNER' },
        publicClient: {},
        positions,
        stellarRecipient: STELLAR,
        idleUsdc: 0n,
        deadline: DEADLINE,
        nowSeconds: NOW,
        deps: failing,
      })
    ).rejects.toThrow(/did not succeed/)
  })

  it('uses only the owner Kernel client and never invokes injected session-key paths', async () => {
    const sessionSend = vi.fn(() => {
      throw new Error('session path must remain unreachable')
    })
    await signAndSubmitUnwind({
      ownerKernelAccount: { address: '0xOWNER' },
      publicClient: {},
      positions,
      stellarRecipient: STELLAR,
      deadline: DEADLINE,
      nowSeconds: NOW,
      deps: { ...deps, sessionSend, createSessionClient: sessionSend },
    })
    expect(sessionSend).not.toHaveBeenCalled()
  })
})
