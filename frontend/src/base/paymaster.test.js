// frontend/src/base/paymaster.test.js
import { describe, test, expect, vi } from 'vitest'
import { createGaslessKernelClient } from './paymaster.js'

describe('createGaslessKernelClient', () => {
  test('wires the ZeroDev paymaster into the kernel account client (proven pattern from session-test.mjs)', () => {
    const fakePaymasterClient = { sponsorUserOperation: vi.fn(async () => ({ paymaster: '0xpm' })) }
    const fakeKernelClient = { account: { address: '0xACCT' } }
    const deps = {
      makePaymasterClient: vi.fn(() => fakePaymasterClient),
      makeAccountClient: vi.fn((args) => {
        expect(args.account).toEqual({ address: '0xACCT' })
        expect(args.paymaster).toBeDefined()
        return fakeKernelClient
      }),
    }

    const client = createGaslessKernelClient({
      account: { address: '0xACCT' },
      publicClient: { chain: 'fake' },
      projectId: 'test-project',
      deps,
    })

    expect(client).toBe(fakeKernelClient)
    expect(deps.makeAccountClient).toHaveBeenCalledTimes(1)
  })

  test('the paymaster getPaymasterData delegates to sponsorUserOperation', async () => {
    const fakePaymasterClient = { sponsorUserOperation: vi.fn(async (args) => ({ got: args })) }
    let capturedPaymaster
    const deps = {
      makePaymasterClient: vi.fn(() => fakePaymasterClient),
      makeAccountClient: vi.fn((args) => {
        capturedPaymaster = args.paymaster
        return {}
      }),
    }
    createGaslessKernelClient({ account: {}, publicClient: {}, projectId: 'test-project', deps })
    const result = await capturedPaymaster.getPaymasterData({ sender: '0xACCT' })
    expect(fakePaymasterClient.sponsorUserOperation).toHaveBeenCalledWith({
      userOperation: { sender: '0xACCT' },
    })
    // getPaymasterData wraps the userOperation and returns sponsorUserOperation's result verbatim.
    expect(result.got).toEqual({ userOperation: { sender: '0xACCT' } })
  })

  test('throws a clear error without VITE_ZERODEV_PROJECT_ID configured', () => {
    expect(() =>
      createGaslessKernelClient({ account: {}, publicClient: {}, projectId: '', deps: {} })
    ).toThrow(/ZERODEV_PROJECT_ID/)
  })
})
