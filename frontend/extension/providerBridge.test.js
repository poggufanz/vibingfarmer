import { describe, it, expect, vi } from 'vitest'
import { handleProviderRequest, toSignRequest, toProviderResult } from './providerBridge.js'

describe('providerBridge — page RPC to SIGN_REQUEST mapping', () => {
  it('maps getAddress/isConnected to a connect SIGN_REQUEST', () => {
    expect(toSignRequest('getAddress', {})).toEqual({
      type: 'SIGN_REQUEST',
      action: 'connect',
      params: {},
    })
    expect(toSignRequest('isConnected')).toEqual({
      type: 'SIGN_REQUEST',
      action: 'connect',
      params: {},
    })
  })

  it('maps signTransaction/signAuthEntry to their own SIGN_REQUEST action, passing params through', () => {
    expect(toSignRequest('signTransaction', { xdr: 'X', opts: { address: 'C1' } })).toEqual({
      type: 'SIGN_REQUEST',
      action: 'signTransaction',
      params: { xdr: 'X', opts: { address: 'C1' } },
    })
    expect(toSignRequest('signAuthEntry', { authEntry: 'E' })).toEqual({
      type: 'SIGN_REQUEST',
      action: 'signAuthEntry',
      params: { authEntry: 'E' },
    })
  })

  it('returns null for an unsupported method (e.g. signMessage)', () => {
    expect(toSignRequest('signMessage', {})).toBeNull()
  })

  it('toProviderResult shapes a successful connect result as {address}', () => {
    expect(toProviderResult('getAddress', { ok: true, address: 'CACCT' })).toEqual({
      result: { address: 'CACCT' },
    })
    expect(toProviderResult('isConnected', { ok: true, address: 'CACCT' })).toEqual({
      result: true,
    })
  })

  it('toProviderResult shapes a successful signTransaction/signAuthEntry result', () => {
    expect(
      toProviderResult('signTransaction', { ok: true, signedTxXdr: 'SXDR', address: 'CACCT' })
    ).toEqual({ result: { signedTxXdr: 'SXDR', signerAddress: 'CACCT' } })
    expect(
      toProviderResult('signAuthEntry', { ok: true, signedAuthEntry: 'SENTRY', address: 'CACCT' })
    ).toEqual({ result: { signedAuthEntry: 'SENTRY', signerAddress: 'CACCT' } })
  })

  it('toProviderResult surfaces the ceremony error on failure', () => {
    expect(toProviderResult('getAddress', { ok: false, error: 'nope' })).toEqual({ error: 'nope' })
  })

  it('handleProviderRequest relays SIGN_REQUEST via sendMessage and posts the mapped result back', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, address: 'CACCT' }))
    const post = vi.fn()
    await handleProviderRequest(
      { channel: 'vf-wallet-rpc', dir: 'req', id: 'id1', method: 'getAddress', params: {} },
      { sendMessage, post }
    )
    expect(sendMessage).toHaveBeenCalledWith({ type: 'SIGN_REQUEST', action: 'connect', params: {} })
    expect(post).toHaveBeenCalledWith({
      channel: 'vf-wallet-rpc',
      dir: 'res',
      id: 'id1',
      result: { address: 'CACCT' },
      error: undefined,
    })
  })

  it('handleProviderRequest posts an error result when the ceremony fails', async () => {
    const sendMessage = vi.fn(async () => ({ ok: false, error: 'user cancelled' }))
    const post = vi.fn()
    await handleProviderRequest({ id: 'id2', method: 'signTransaction', params: {} }, { sendMessage, post })
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'id2', error: 'user cancelled' })
    )
  })

  it('handleProviderRequest posts an error when sendMessage itself rejects', async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error('boom')
    })
    const post = vi.fn()
    await handleProviderRequest({ id: 'id3', method: 'getAddress', params: {} }, { sendMessage, post })
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ id: 'id3', error: 'boom' }))
  })

  it('handleProviderRequest posts an unsupported-method error without calling sendMessage', async () => {
    const sendMessage = vi.fn()
    const post = vi.fn()
    await handleProviderRequest({ id: 'id4', method: 'signMessage', params: {} }, { sendMessage, post })
    expect(sendMessage).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'id4', error: expect.stringContaining('signMessage') })
    )
  })
})
