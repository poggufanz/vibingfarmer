import { describe, it, expect, vi } from 'vitest'
import { nativeToScVal } from '@stellar/stellar-sdk'
import { i128ScVal } from './scval.js'
import { encodeArgs, readContract, submitUserTx } from './client.js'

describe('soroban client', () => {
  it('encodeArgs passes a pre-built raw ScVal through unchanged', () => {
    // js-xdr puts every union-arm accessor on ScVal's prototype, so `'i128' in scval` is true
    // for ANY ScVal — without a raw-ScVal guard this Vec<i128> would hit the i128 branch and throw.
    const vec = nativeToScVal([1n, 2n], { type: 'i128' })
    const [out] = encodeArgs([vec])
    expect(out).toBe(vec)
  })

  it('readContract simulates a read-only call and decodes the retval to native', async () => {
    // fake server: simulateTransaction returns a successful sim carrying an i128 retval
    const fakeServer = {
      simulateTransaction: vi.fn(async () => ({ result: { retval: i128ScVal(7n) } })),
    }
    const out = await readContract({
      contract: 'CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5',
      method: 'decimals',
      args: [],
      server: fakeServer,
    })
    expect(fakeServer.simulateTransaction).toHaveBeenCalledOnce()
    expect(out).toBe(7n)
  })

  it('readContract throws when the simulation errors', async () => {
    const fakeServer = {
      simulateTransaction: vi.fn(async () => ({ error: 'boom' })),
    }
    await expect(
      readContract({
        contract: 'CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5',
        method: 'decimals',
        server: fakeServer,
      })
    ).rejects.toThrow(/simulation failed/i)
  })

  it('submitUserTx sends the signed xdr and returns the hash + status', async () => {
    const fakeServer = {
      sendTransaction: vi.fn(async () => ({ status: 'PENDING', hash: 'abc123' })),
      getTransaction: vi.fn(async () => ({ status: 'SUCCESS' })),
    }
    const out = await submitUserTx({
      signedXdr: 'AAAA==',
      server: fakeServer,
      pollIntervalMs: 0,
    })
    expect(fakeServer.sendTransaction).toHaveBeenCalledOnce()
    expect(out).toEqual({ hash: 'abc123', status: 'SUCCESS' })
  })
})
