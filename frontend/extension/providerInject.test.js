// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { createVfWalletProvider, CHANNEL } from './providerInject.js'

// Wires `post`/`listen` to a tiny in-memory loopback so we can drive the request/response
// round-trip exactly like providerBridge.js would (post a `req`, provider awaits a `res`).
function loopback() {
  let handler
  return {
    post: vi.fn(),
    listen: (fn) => {
      handler = fn
    },
    reply: (data) => handler({ source: 'window', data }),
  }
}

describe('createVfWalletProvider', () => {
  it('getAddress posts a req and resolves once a matching res arrives', async () => {
    const io = loopback()
    io.listen = (fn) => {
      io._handler = fn
    }
    const provider = createVfWalletProvider({ post: io.post, listen: io.listen })

    const pending = provider.getAddress()
    expect(io.post).toHaveBeenCalledOnce()
    const sent = io.post.mock.calls[0][0]
    expect(sent).toMatchObject({ channel: CHANNEL, dir: 'req', method: 'getAddress' })

    io._handler({
      source: window,
      data: { channel: CHANNEL, dir: 'res', id: sent.id, result: { address: 'CACCT' } },
    })
    expect(await pending).toEqual({ address: 'CACCT' })
  })

  it('rejects the pending call when the response carries an error', async () => {
    const io = loopback()
    io.listen = (fn) => {
      io._handler = fn
    }
    const provider = createVfWalletProvider({ post: io.post, listen: io.listen })

    const pending = provider.signTransaction('XDR', { address: 'CACCT' })
    const sent = io.post.mock.calls[0][0]
    expect(sent.params).toEqual({ xdr: 'XDR', opts: { address: 'CACCT' } })

    io._handler({
      source: window,
      data: { channel: CHANNEL, dir: 'res', id: sent.id, error: 'user cancelled' },
    })
    await expect(pending).rejects.toThrow('user cancelled')
  })

  it('ignores messages from a different channel or a different message source', async () => {
    const io = loopback()
    io.listen = (fn) => {
      io._handler = fn
    }
    const provider = createVfWalletProvider({ post: io.post, listen: io.listen })
    const pending = provider.getAddress()
    const sent = io.post.mock.calls[0][0]

    io._handler({
      source: window,
      data: { channel: 'other-channel', dir: 'res', id: sent.id, result: 'nope' },
    })
    io._handler({ source: {}, data: { channel: CHANNEL, dir: 'res', id: sent.id, result: 'nope' } })
    io._handler({
      source: window,
      data: { channel: CHANNEL, dir: 'res', id: sent.id, result: { address: 'REAL' } },
    })

    expect(await pending).toEqual({ address: 'REAL' })
  })

  it('rejects with an Error carrying the SEP-43 code when the bridge sends a structured error', async () => {
    const io = loopback()
    io.listen = (fn) => {
      io._handler = fn
    }
    const provider = createVfWalletProvider({ post: io.post, listen: io.listen })
    const pending = provider.signTransaction('XDR', {})
    const sent = io.post.mock.calls[0][0]

    io._handler({
      source: window,
      data: {
        channel: CHANNEL,
        dir: 'res',
        id: sent.id,
        error: { code: -4, message: 'User rejected the request' },
      },
    })
    await expect(pending).rejects.toMatchObject({ code: -4, message: 'User rejected the request' })
  })

  it('dispatches vfWallet#accountChanged when providerBridge pushes an accountChanged event', () => {
    const io = loopback()
    io.listen = (fn) => {
      io._handler = fn
    }
    const dispatchEvent = vi.fn()
    createVfWalletProvider({ post: io.post, listen: io.listen, dispatchEvent })

    io._handler({
      source: window,
      data: { channel: CHANNEL, dir: 'event', event: 'accountChanged', address: 'CNEW' },
    })

    expect(dispatchEvent).toHaveBeenCalledWith('vfWallet#accountChanged', { address: 'CNEW' })
  })

  it('accountChanged with no address (revoked/no account) still dispatches, address null', () => {
    const io = loopback()
    io.listen = (fn) => {
      io._handler = fn
    }
    const dispatchEvent = vi.fn()
    createVfWalletProvider({ post: io.post, listen: io.listen, dispatchEvent })

    io._handler({
      source: window,
      data: { channel: CHANNEL, dir: 'event', event: 'accountChanged' },
    })

    expect(dispatchEvent).toHaveBeenCalledWith('vfWallet#accountChanged', { address: null })
  })

  it('an accountChanged push never resolves/rejects an in-flight call', async () => {
    const io = loopback()
    io.listen = (fn) => {
      io._handler = fn
    }
    const provider = createVfWalletProvider({ post: io.post, listen: io.listen })
    const pending = provider.getAddress()
    const sent = io.post.mock.calls[0][0]

    io._handler({
      source: window,
      data: { channel: CHANNEL, dir: 'event', event: 'accountChanged', address: 'CNEW' },
    })
    io._handler({
      source: window,
      data: { channel: CHANNEL, dir: 'res', id: sent.id, result: { address: 'CREAL' } },
    })

    expect(await pending).toEqual({ address: 'CREAL' })
  })

  it('still rejects plain-string errors (legacy shape) without a code', async () => {
    const io = loopback()
    io.listen = (fn) => {
      io._handler = fn
    }
    const provider = createVfWalletProvider({ post: io.post, listen: io.listen })
    const pending = provider.getAddress()
    const sent = io.post.mock.calls[0][0]

    io._handler({
      source: window,
      data: { channel: CHANNEL, dir: 'res', id: sent.id, error: 'boom' },
    })
    await expect(pending).rejects.toThrow('boom')
  })
})
