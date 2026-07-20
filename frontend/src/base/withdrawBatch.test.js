// frontend/src/base/withdrawBatch.test.js
import { describe, test, expect, vi } from 'vitest'
import { buildUnwindCalls, signAndSubmitUnwind } from './withdrawBatch.js'
import { YIELD_ROUTER_ADDRESS } from './config.js'

const STELLAR_RECIPIENT = 'GRECIPIENTOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO'

describe('buildUnwindCalls', () => {
  test('one withdraw call per pool, then one approve, then one depositForBurnWithHook - in that order', () => {
    const calls = buildUnwindCalls({
      withdrawals: [
        { pool: '0x2222222222222222222222222222222222222222', shares: 100n, minAssets: 99n },
        { pool: '0x3333333333333333333333333333333333333333', shares: 50n, minAssets: 49n },
      ],
      stellarRecipient: STELLAR_RECIPIENT,
      totalAssetsForBurn: 148n,
    })
    // Per pool: shares.approve(router) THEN router.withdraw — the router pulls shares via
    // transferFrom (live ERC20InsufficientAllowance without the approve, 2026-07-20).
    expect(calls).toHaveLength(6) // 2×(approve+withdraw) + 1 USDC approve + 1 burn
    expect(calls[0].to).toBe('0x2222222222222222222222222222222222222222') // shares approve
    expect(calls[1].to).toBe(YIELD_ROUTER_ADDRESS)
    expect(calls[2].to).toBe('0x3333333333333333333333333333333333333333')
    expect(calls[3].to).toBe(YIELD_ROUTER_ADDRESS)
    expect(calls[4].to).toBeDefined() // USDC.approve(TokenMessengerV2)
    expect(calls[5].to).toBeDefined() // TokenMessengerV2.depositForBurnWithHook
  })

  test('burn call requests FAST finality (1000) with a 1% maxFee cap (silent-degrade safe)', async () => {
    const { decodeFunctionData } = await import('viem')
    const calls = buildUnwindCalls({
      withdrawals: [
        { pool: '0x2222222222222222222222222222222222222222', shares: 100n, minAssets: 99n },
      ],
      stellarRecipient: STELLAR_RECIPIENT,
      totalAssetsForBurn: 1_000_000n, // 1 USDC
    })
    const burn = calls[calls.length - 1]
    const { args } = decodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'depositForBurnWithHook',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'amount', type: 'uint256' },
            { name: 'destinationDomain', type: 'uint32' },
            { name: 'mintRecipient', type: 'bytes32' },
            { name: 'burnToken', type: 'address' },
            { name: 'destinationCaller', type: 'bytes32' },
            { name: 'maxFee', type: 'uint256' },
            { name: 'minFinalityThreshold', type: 'uint32' },
            { name: 'hookData', type: 'bytes' },
          ],
          outputs: [{ type: 'uint64' }],
        },
      ],
      data: burn.data,
    })
    expect(args[6]).toBe(1000) // fast attestation — seconds, not Base L1 finality
    expect(args[5]).toBe(10_000n) // 1% of 1 USDC; actual corridor fee (0-14bps) is what's charged
  })

  test('rejects an empty withdrawals array', () => {
    expect(() =>
      buildUnwindCalls({
        withdrawals: [],
        stellarRecipient: STELLAR_RECIPIENT,
        totalAssetsForBurn: 0n,
      })
    ).toThrow(/at least one withdrawal/)
  })

  test('validates the hookData before it is embedded in the burn call (never emits a bad hookData call)', () => {
    // A recipient too short to be a plausible strkey should be rejected up front, BEFORE any
    // call array is returned — never silently embed a malformed hook.
    expect(() =>
      buildUnwindCalls({
        withdrawals: [
          { pool: '0x2222222222222222222222222222222222222222', shares: 1n, minAssets: 1n },
        ],
        stellarRecipient: 'short',
        totalAssetsForBurn: 1n,
      })
    ).toThrow(/strkey/)
  })
})

describe('signAndSubmitUnwind', () => {
  test('sends ONE owner-signed userOp containing the whole batch, returns its tx hash', async () => {
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
          receipt: { transactionHash: '0xUNWINDTX' },
        })),
      })),
    }

    const result = await signAndSubmitUnwind({
      ownerKernelAccount: { address: '0xOWNER' },
      publicClient: {},
      withdrawals: [
        { pool: '0x2222222222222222222222222222222222222222', shares: 100n, minAssets: 99n },
      ],
      stellarRecipient: STELLAR_RECIPIENT,
      totalAssetsForBurn: 99n,
      deps,
    })

    expect(result.unwindTxHash).toBe('0xUNWINDTX')
    expect(sentCallData[0].encoded).toHaveLength(4) // shares approve + withdraw + USDC approve + burn
  })

  test('throws if the userOp mines but does not succeed - never reports a fake success', async () => {
    const deps = {
      makeGaslessClient: vi.fn(() => ({
        account: { encodeCalls: vi.fn(async (calls) => ({ encoded: calls })) },
        sendUserOperation: vi.fn(async () => 'userop-hash-2'),
        waitForUserOperationReceipt: vi.fn(async () => ({
          success: false,
          receipt: { transactionHash: '0xFAILED' },
        })),
      })),
    }
    await expect(
      signAndSubmitUnwind({
        ownerKernelAccount: { address: '0xOWNER' },
        publicClient: {},
        withdrawals: [
          { pool: '0x2222222222222222222222222222222222222222', shares: 1n, minAssets: 1n },
        ],
        stellarRecipient: STELLAR_RECIPIENT,
        totalAssetsForBurn: 1n,
        deps,
      })
    ).rejects.toThrow(/did not succeed/)
  })
})
