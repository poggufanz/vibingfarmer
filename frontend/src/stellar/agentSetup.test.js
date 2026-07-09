// agentSetup.test.js
import { describe, test, expect, vi } from 'vitest'
vi.mock('./client.js', () => ({
  buildInvokeTx: vi.fn().mockResolvedValue({ tx: {}, xdr: 'UNSIGNED' }),
  submitUserTx: vi.fn().mockResolvedValue({ hash: 'h1', status: 'SUCCESS' }),
}))
vi.mock('./walletKit.js', () => ({ signTxXdr: vi.fn().mockResolvedValue('SIGNED') }))
import { authorizeAndFundAgent } from './agentSetup.js'
import { buildInvokeTx, submitUserTx } from './client.js'
import { signTxXdr } from './walletKit.js'

describe('authorizeAndFundAgent', () => {
  test('signs with the user wallet and submits the authorize + fund txs', async () => {
    const r = await authorizeAndFundAgent({
      owner: 'GUSER',
      agentAddress: 'CCRG...',
      vault: 'CCDX...',
      amount: 50_000_000n,
      capPerPeriod: 50_000_000n,
      periodDuration: 3600,
      expiry: 4000000000,
    })
    expect(signTxXdr).toHaveBeenCalledWith('UNSIGNED')
    expect(submitUserTx).toHaveBeenCalledWith(expect.objectContaining({ signedXdr: 'SIGNED' }))
    // Two user-signed txs: registry.authorize + token.transfer (fund).
    expect(buildInvokeTx).toHaveBeenCalledTimes(2)
    expect(submitUserTx).toHaveBeenCalledTimes(2)
    expect(r.status).toBe('SUCCESS')
  })
})
