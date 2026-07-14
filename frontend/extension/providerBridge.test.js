import { describe, it, expect, vi } from 'vitest'
import { handleProviderRequest, toProviderRequest, toProviderResult } from './providerBridge.js'

describe('providerBridge — page RPC to PROVIDER_REQUEST mapping', () => {
  it('wraps supported methods verbatim in a PROVIDER_REQUEST', () => {
    expect(toProviderRequest('getAddress', {})).toEqual({
      type: 'PROVIDER_REQUEST',
      method: 'getAddress',
      params: {},
    })
    expect(toProviderRequest('isConnected')).toEqual({
      type: 'PROVIDER_REQUEST',
      method: 'isConnected',
      params: {},
    })
    expect(toProviderRequest('signTransaction', { xdr: 'X', opts: { address: 'C1' } })).toEqual({
      type: 'PROVIDER_REQUEST',
      method: 'signTransaction',
      params: { xdr: 'X', opts: { address: 'C1' } },
    })
    expect(toProviderRequest('signAuthEntry', { authEntry: 'E' })).toEqual({
      type: 'PROVIDER_REQUEST',
      method: 'signAuthEntry',
      params: { authEntry: 'E' },
    })
  })

  it('returns null for an unsupported method (e.g. signMessage)', () => {
    expect(toProviderRequest('signMessage', {})).toBeNull()
  })

  it('shapes isConnected from the silent background answer', () => {
    expect(
      toProviderResult('isConnected', { ok: true, connected: true, address: 'CACCT' })
    ).toEqual({ result: true })
    expect(toProviderResult('isConnected', { ok: true, connected: false, address: null })).toEqual({
      result: false,
    })
    // approval-path connect result carries address but no `connected` flag
    expect(toProviderResult('isConnected', { ok: true, address: 'CACCT' })).toEqual({
      result: true,
    })
  })

  it('shapes getAddress / sign results', () => {
    expect(toProviderResult('getAddress', { ok: true, address: 'CACCT' })).toEqual({
      result: { address: 'CACCT' },
    })
    expect(
      toProviderResult('signTransaction', { ok: true, signedTxXdr: 'SXDR', address: 'CACCT' })
    ).toEqual({ result: { signedTxXdr: 'SXDR', signerAddress: 'CACCT' } })
    expect(
      toProviderResult('signAuthEntry', { ok: true, signedAuthEntry: 'SENTRY', address: 'CACCT' })
    ).toEqual({ result: { signedAuthEntry: 'SENTRY', signerAddress: 'CACCT' } })
  })

  it('surfaces failures as structured {code, message} errors, defaulting code to -1', () => {
    expect(
      toProviderResult('getAddress', { ok: false, code: -4, error: 'User rejected the request' })
    ).toEqual({
      error: { code: -4, message: 'User rejected the request' },
    })
    expect(toProviderResult('getAddress', { ok: false, error: 'nope' })).toEqual({
      error: { code: -1, message: 'nope' },
    })
    expect(toProviderResult('getAddress', undefined)).toEqual({
      error: { code: -1, message: 'VF Wallet request failed' },
    })
  })

  it('handleProviderRequest relays PROVIDER_REQUEST via sendMessage and posts the mapped result', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, address: 'CACCT' }))
    const post = vi.fn()
    await handleProviderRequest(
      { channel: 'vf-wallet-rpc', dir: 'req', id: 'id1', method: 'getAddress', params: {} },
      { sendMessage, post }
    )
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'PROVIDER_REQUEST',
      method: 'getAddress',
      params: {},
    })
    expect(post).toHaveBeenCalledWith({
      channel: 'vf-wallet-rpc',
      dir: 'res',
      id: 'id1',
      result: { address: 'CACCT' },
      error: undefined,
    })
  })

  it('handleProviderRequest posts the structured error when the background reports failure', async () => {
    const sendMessage = vi.fn(async () => ({
      ok: false,
      code: -4,
      error: 'User rejected the request',
    }))
    const post = vi.fn()
    await handleProviderRequest(
      { id: 'id2', method: 'signTransaction', params: {} },
      { sendMessage, post }
    )
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'id2',
        error: { code: -4, message: 'User rejected the request' },
      })
    )
  })

  it('handleProviderRequest posts a -1 error when sendMessage itself rejects', async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error('boom')
    })
    const post = vi.fn()
    await handleProviderRequest(
      { id: 'id3', method: 'getAddress', params: {} },
      { sendMessage, post }
    )
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'id3', error: { code: -1, message: 'boom' } })
    )
  })

  it('handleProviderRequest posts a -3 unsupported-method error without calling sendMessage', async () => {
    const sendMessage = vi.fn()
    const post = vi.fn()
    await handleProviderRequest(
      { id: 'id4', method: 'signMessage', params: {} },
      { sendMessage, post }
    )
    expect(sendMessage).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'id4',
        error: { code: -3, message: expect.stringContaining('signMessage') },
      })
    )
  })
})
