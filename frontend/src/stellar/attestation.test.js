import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./client.js', () => ({
  buildInvokeTx: vi.fn(async () => ({ tx: {}, xdr: 'UNSIGNED_XDR' })),
  readContract: vi.fn(async () => 3),
}))
vi.mock('./walletKit.js', () => ({
  signTxXdr: vi.fn(async () => 'SIGNED_XDR'),
}))
vi.mock('./relay.js', () => ({
  submitViaRelay: vi.fn(async () => ({ hash: 'TXHASH', status: 'SUCCESS', relayer: 'GREL' })),
}))

import { attestOnChain, readAttestationCount } from './attestation.js'
import { buildInvokeTx } from './client.js'
import { signTxXdr } from './walletKit.js'
import { submitViaRelay } from './relay.js'

const ATTESTER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const HASH = '0x' + 'ab'.repeat(32)

describe('attestOnChain', () => {
  beforeEach(() => vi.clearAllMocks())

  it('builds attest invoke with source=attester, user-signs, relays', async () => {
    const out = await attestOnChain({ attester: ATTESTER, strategyHash: HASH, label: 'venice' })

    const call = buildInvokeTx.mock.calls[0][0]
    expect(call.source).toBe(ATTESTER)
    expect(call.method).toBe('attest')
    expect(call.args[0]).toEqual({ addr: ATTESTER })
    expect(call.args[1]).toEqual({ bytes32: HASH })
    expect(call.args[2]).toEqual({ symbol: 'venice' })

    expect(signTxXdr).toHaveBeenCalledWith('UNSIGNED_XDR')
    expect(submitViaRelay).toHaveBeenCalledWith({ xdr: 'SIGNED_XDR' })
    expect(out).toEqual({ hash: 'TXHASH', status: 'SUCCESS', relayer: 'GREL' })
  })

  it('truncates label to 9 chars (symbol_short limit) and defaults to "strategy"', async () => {
    await attestOnChain({ attester: ATTESTER, strategyHash: HASH, label: 'a-very-long-provider-name' })
    expect(buildInvokeTx.mock.calls[0][0].args[2]).toEqual({ symbol: 'a-very-lo' })

    await attestOnChain({ attester: ATTESTER, strategyHash: HASH })
    expect(buildInvokeTx.mock.calls[1][0].args[2]).toEqual({ symbol: 'strategy' })
  })
})

describe('readAttestationCount', () => {
  it('returns the decoded count as a number', async () => {
    expect(await readAttestationCount(ATTESTER, { server: {} })).toBe(3)
  })
})
