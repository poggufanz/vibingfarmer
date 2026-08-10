import { describe, expect, it, vi } from 'vitest'
import { buildUnwindCalls, signAndSubmitUnwind } from './withdrawBatch.js'

describe('legacy Base unwind availability fence', () => {
  it('fails before hook validation or approval/call encoding', () => {
    expect(() =>
      buildUnwindCalls({
        positions: [{ pool: 'not-an-address', minAssets: 1 }],
        stellarRecipient: 'not-a-strkey',
        idleUsdc: 0,
        deadline: 0,
      })
    ).toThrow(expect.objectContaining({ code: 'BASE_CROSS_CHAIN_UNAVAILABLE' }))
  })

  it('fails before owner client construction, encode, send, or receipt polling', async () => {
    const makeGaslessClient = vi.fn(() => {
      throw new Error('client construction must remain unreachable')
    })

    await expect(
      signAndSubmitUnwind({
        ownerKernelAccount: null,
        publicClient: null,
        positions: [],
        stellarRecipient: 'not-a-strkey',
        idleUsdc: 0,
        deadline: 0,
        deps: { makeGaslessClient },
      })
    ).rejects.toMatchObject({ code: 'BASE_CROSS_CHAIN_UNAVAILABLE' })
    expect(makeGaslessClient).not.toHaveBeenCalled()
  })
})
