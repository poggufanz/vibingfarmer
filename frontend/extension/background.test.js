import { describe, it, expect, vi } from 'vitest'
import { handleMessage } from './background.js'

describe('background message router', () => {
  it('opens a ceremony tab for SIGN_REQUEST and resolves with the assertion', async () => {
    const tabs = { create: vi.fn(async () => ({ id: 7 })) }
    const pending = new Map()
    const reply = vi.fn()
    await handleMessage(
      { type: 'SIGN_REQUEST', challenge: 'CH', rpId: 'localhost' },
      { tabs, pending },
      reply
    )
    expect(tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('ceremony.html') })
    )
    // ceremony tab posts the result back:
    await handleMessage(
      { type: 'CEREMONY_RESULT', tabId: 7, assertion: { signature: [1] } },
      { tabs, pending },
      reply
    )
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ type: 'SIGN_RESULT' }))
  })

  it('ignores CEREMONY_RESULT for unknown tabId', async () => {
    const tabs = { create: vi.fn(async () => ({ id: 99 })) }
    const pending = new Map()
    const reply = vi.fn()
    await handleMessage(
      { type: 'CEREMONY_RESULT', tabId: 999, assertion: { signature: [2] } },
      { tabs, pending },
      reply
    )
    expect(reply).not.toHaveBeenCalled()
  })

  it('removes pending entry after resolving', async () => {
    const tabs = { create: vi.fn(async () => ({ id: 42 })) }
    const pending = new Map()
    const reply = vi.fn()
    await handleMessage(
      { type: 'SIGN_REQUEST', challenge: 'C2', rpId: 'example.com' },
      { tabs, pending },
      reply
    )
    expect(pending.size).toBe(1)
    await handleMessage(
      { type: 'CEREMONY_RESULT', tabId: 42, assertion: { signature: [3] } },
      { tabs, pending },
      reply
    )
    expect(pending.size).toBe(0)
    expect(reply).toHaveBeenCalledWith({ type: 'SIGN_RESULT', assertion: { signature: [3] } })
  })
})
