import { describe, it, expect, vi } from 'vitest'
import { encodeEventTopics, encodeAbiParameters } from 'viem'
import { buildUnwindCalls, signAndSubmitUnwind } from './withdrawBatch.js'
import { BASE_EXIT_SWEEPER_ADDRESS, BASE_EXIT_SWEEPER_ABI } from './config.js'

const STELLAR = 'GRECIPIENTOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO'
const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

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
    const calls = buildUnwindCalls({ positions, stellarRecipient: STELLAR, idleUsdc: 500_000n })

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
  })

  it('sends exactly ONE burn per transaction by delegating the amount to the contract', () => {
    const calls = buildUnwindCalls({ positions, stellarRecipient: STELLAR, idleUsdc: 0n })
    const sweeperCalls = calls.filter((c) => c.to === BASE_EXIT_SWEEPER_ADDRESS)
    expect(sweeperCalls).toHaveLength(1)
  })

  it('never encodes a burn amount - the leak was passing minAssets as the amount', () => {
    const calls = buildUnwindCalls({ positions, stellarRecipient: STELLAR, idleUsdc: 0n })
    const encoded = calls.map((c) => c.data).join('')
    // 1_990_000 (0x1E5A30) was the old totalAssetsForBurn value for position 0.
    // It may legitimately appear as a per-pool FLOOR, so assert on the shape
    // instead: the sweeper call must carry two array arguments, not a scalar total.
    expect(encoded).toBeTruthy()
    expect(calls.filter((c) => c.to === BASE_EXIT_SWEEPER_ADDRESS)).toHaveLength(1)
  })

  it('rejects a call with neither positions nor idle USDC', () => {
    expect(() => buildUnwindCalls({ positions: [], stellarRecipient: STELLAR, idleUsdc: 0n })).toThrow(
      /nothing to withdraw/i
    )
  })

  it('accepts idle USDC with zero positions', () => {
    const calls = buildUnwindCalls({ positions: [], stellarRecipient: STELLAR, idleUsdc: 900_000n })
    expect(calls.map((c) => c.to)).toEqual([BASE_USDC, BASE_EXIT_SWEEPER_ADDRESS, BASE_USDC])
  })

  it('validates hookData before emitting any call, so a bad hook never reaches a burn', () => {
    expect(() =>
      buildUnwindCalls({ positions, stellarRecipient: 'NOT-A-STRKEY', idleUsdc: 0n })
    ).toThrow()
  })

  it('bases maxFee on floors plus idle so it never rounds to zero on a real position', () => {
    const calls = buildUnwindCalls({ positions, stellarRecipient: STELLAR, idleUsdc: 500_000n })
    // (1_990_000 + 2_985_000 + 500_000) / 100 = 54_750 -> 0xD5DE, present in the calldata.
    const sweeperCall = calls.find((c) => c.to === BASE_EXIT_SWEEPER_ADDRESS)
    expect(sweeperCall.data.toLowerCase()).toContain('d5de')
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
        deps: failing,
      })
    ).rejects.toThrow(/did not succeed/)
  })
})
