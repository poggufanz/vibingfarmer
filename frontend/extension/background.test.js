import { describe, it, expect, vi } from 'vitest'
import { handleMessage } from './background.js'

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
})
