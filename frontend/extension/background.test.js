import { describe, it, expect, vi } from 'vitest'
import { handleMessage, handleProviderMessage, handleWindowRemoved } from './background.js'

describe('background router — action ceremony', () => {
  it('opens ceremony.html with the action and stashes params in session storage', async () => {
    const tabs = { create: vi.fn(async () => ({ id: 7 })) }
    const session = { set: vi.fn(async () => {}) }
    const pending = new Map()
    await handleMessage(
      { type: 'SIGN_REQUEST', action: 'deposit', params: { contractId: 'CACCT', amount: '1.5' } },
      { tabs, storageSession: session, pending },
      vi.fn()
    )
    expect(tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('action=deposit'), active: true })
    )
    expect(session.set).toHaveBeenCalledWith(
      expect.objectContaining({ ['vf_params_7']: { contractId: 'CACCT', amount: '1.5' } })
    )
  })

  it('persists CEREMONY_RESULT to session and forwards it to the popup', async () => {
    const session = { set: vi.fn(async () => {}) }
    const runtime = { sendMessage: vi.fn() }
    const pending = new Map()
    await handleMessage(
      {
        type: 'CEREMONY_RESULT',
        action: 'deposit',
        ok: true,
        hash: 'H',
        status: 'SUCCESS',
        sharesBefore: '0',
        sharesAfter: '5',
      },
      { storageSession: session, runtime, pending },
      vi.fn()
    )
    expect(session.set).toHaveBeenCalledWith(
      expect.objectContaining({ vf_last_result: expect.objectContaining({ ok: true, hash: 'H' }) })
    )
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SIGN_RESULT', ok: true, hash: 'H' })
    )
  })

  it('routes CEREMONY_RESULT reply to pending tab via reply callback', async () => {
    const session = { set: vi.fn(async () => {}) }
    const replyFn = vi.fn()
    const pending = new Map()
    pending.set(42, replyFn)
    await handleMessage(
      {
        type: 'CEREMONY_RESULT',
        tabId: 42,
        action: 'deposit',
        ok: true,
        hash: 'H',
        status: 'SUCCESS',
        sharesBefore: '0',
        sharesAfter: '5',
      },
      { storageSession: session, pending },
      vi.fn()
    )
    expect(replyFn).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SIGN_RESULT', ok: true, hash: 'H' })
    )
    expect(pending.has(42)).toBe(false)
  })

  it('passes through result fields for the generic wallet-kit actions (connect/signTransaction/signAuthEntry) without a fixed allow-list', async () => {
    const session = { set: vi.fn(async () => {}) }
    const replyFn = vi.fn()
    const pending = new Map()
    pending.set(7, replyFn)
    await handleMessage(
      {
        type: 'CEREMONY_RESULT',
        tabId: 7,
        action: 'signTransaction',
        ok: true,
        signedTxXdr: 'SXDR',
        address: 'CACCT',
      },
      { storageSession: session, pending },
      vi.fn()
    )
    expect(replyFn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SIGN_RESULT',
        ok: true,
        signedTxXdr: 'SXDR',
        address: 'CACCT',
      })
    )
    // tabId is routing metadata only — never leaks into the result payload the caller sees.
    expect(replyFn.mock.calls[0][0]).not.toHaveProperty('tabId')
  })
})

function fakeEnv({ allowlist = {}, address = null } = {}) {
  const local = { vf_allowlist: allowlist, vf_wallet_contract: address }
  const session = {}
  return {
    env: {
      storageLocal: {
        get: vi.fn(async (k) => ({ [k]: local[k] })),
        set: vi.fn(async (obj) => Object.assign(local, obj)),
      },
      storageSession: {
        get: vi.fn(async (k) => ({ [k]: session[k] })),
        set: vi.fn(async (obj) => Object.assign(session, obj)),
        remove: vi.fn(async (k) => delete session[k]),
      },
      windows: { create: vi.fn(async () => ({ id: 900 })) },
      uuid: vi.fn(() => 'rid-1'),
      dappPending: new Map(),
      queueHolder: { p: Promise.resolve() },
    },
    local,
    session,
  }
}
const SENDER = { origin: 'https://vibing-farmer.pages.dev', tab: { id: 3 } }
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('background router — PROVIDER_REQUEST (dapp path)', () => {
  it('answers isConnected silently: false for an unknown origin, no window', async () => {
    const { env } = fakeEnv({ address: 'CACCT' })
    const reply = vi.fn()
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'isConnected' },
      SENDER,
      env,
      reply
    )
    expect(reply).toHaveBeenCalledWith({ ok: true, connected: false, address: null })
    expect(env.windows.create).not.toHaveBeenCalled()
  })

  it('answers getAddress silently for an allowlisted origin with a stored wallet', async () => {
    const { env } = fakeEnv({
      allowlist: { 'https://vibing-farmer.pages.dev': { addedAt: 1 } },
      address: 'CACCT',
    })
    const reply = vi.fn()
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'getAddress' },
      SENDER,
      env,
      reply
    )
    expect(reply).toHaveBeenCalledWith({ ok: true, address: 'CACCT' })
    expect(env.windows.create).not.toHaveBeenCalled()
  })

  it('rejects a request without a verifiable http(s) sender origin', async () => {
    const { env } = fakeEnv({ address: 'CACCT' })
    const reply = vi.fn()
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'getAddress' },
      { origin: null },
      env,
      reply
    )
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: -3 }))
  })

  it('opens an approval popup for getAddress from a new origin and stashes vf_req_<rid>', async () => {
    const { env, session } = fakeEnv({ address: 'CACCT' })
    const reply = vi.fn()
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'getAddress', params: {} },
      SENDER,
      env,
      reply
    )
    await flush()
    expect(env.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('rid=rid-1'), type: 'popup' })
    )
    expect(session['vf_req_rid-1']).toEqual({
      method: 'getAddress',
      params: {},
      origin: 'https://vibing-farmer.pages.dev',
    })
    expect(reply).not.toHaveBeenCalled() // pending until the ceremony answers
  })

  it('CEREMONY_RESULT with rid resolves the pending dapp request and persists the allowlist', async () => {
    const { env, local } = fakeEnv({ address: 'CACCT' })
    const reply = vi.fn()
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'getAddress' },
      SENDER,
      env,
      reply
    )
    await flush()
    await handleMessage(
      { type: 'CEREMONY_RESULT', rid: 'rid-1', ok: true, address: 'CACCT' },
      env,
      vi.fn()
    )
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: true, address: 'CACCT' }))
    expect(local.vf_allowlist['https://vibing-farmer.pages.dev']).toBeTruthy()
    expect(env.dappPending.size).toBe(0)
  })

  it('closing the approval window rejects the pending request with SEP-43 -4', async () => {
    const { env } = fakeEnv({ address: 'CACCT' })
    const reply = vi.fn()
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'signTransaction', params: { xdr: 'X' } },
      SENDER,
      env,
      reply
    )
    await flush()
    handleWindowRemoved(900, env)
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, code: -4, error: 'User rejected the request' })
    )
  })

  it('serializes approval windows: the second opens only after the first settles', async () => {
    const { env } = fakeEnv({ address: 'CACCT' })
    env.uuid = vi.fn().mockReturnValueOnce('rid-1').mockReturnValueOnce('rid-2')
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'getAddress' },
      SENDER,
      env,
      vi.fn()
    )
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'signAuthEntry', params: { authEntry: 'E' } },
      SENDER,
      env,
      vi.fn()
    )
    await flush()
    expect(env.windows.create).toHaveBeenCalledTimes(1)
    await handleMessage(
      { type: 'CEREMONY_RESULT', rid: 'rid-1', ok: true, address: 'CACCT' },
      env,
      vi.fn()
    )
    await flush()
    expect(env.windows.create).toHaveBeenCalledTimes(2)
  })

  it('a failed windows.create settles the request with -1 and does not wedge the queue', async () => {
    const { env } = fakeEnv({ address: 'CACCT' })
    env.uuid = vi.fn().mockReturnValueOnce('rid-1').mockReturnValueOnce('rid-2')
    env.windows.create = vi
      .fn()
      .mockRejectedValueOnce(new Error('popup blocked'))
      .mockResolvedValueOnce({ id: 901 })
    const reply1 = vi.fn()
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'getAddress' },
      SENDER,
      env,
      reply1
    )
    await flush()
    expect(reply1).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: -1 }))
    const reply2 = vi.fn()
    await handleProviderMessage(
      { type: 'PROVIDER_REQUEST', method: 'getAddress' },
      SENDER,
      env,
      reply2
    )
    await flush()
    expect(env.windows.create).toHaveBeenCalledTimes(2)
  })
})
