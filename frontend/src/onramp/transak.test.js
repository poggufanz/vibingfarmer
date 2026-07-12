import { describe, it, expect, vi, beforeEach } from 'vitest'
import { open, launchWidget } from './transak.js'
import { Transak as MockTransak } from '@transak/ui-js-sdk'

// Vitest hoists vi.mock() above the imports above, so define the fake class inside the
// factory (referencing an outer variable here would hit a temporal-dead-zone error).
vi.mock('@transak/ui-js-sdk', () => {
  const listeners = {}
  class FakeTransak {
    constructor(config) {
      this.config = config
    }
    init() {}
    cleanup() {}
  }
  FakeTransak.EVENTS = {
    TRANSAK_ORDER_SUCCESSFUL: 'ORDER_SUCCESSFUL',
    TRANSAK_WIDGET_CLOSE: 'WIDGET_CLOSE',
  }
  FakeTransak.on = (event, cb) => {
    listeners[event] = cb
  }
  FakeTransak._listeners = listeners
  return { Transak: FakeTransak }
})

beforeEach(() => {
  vi.restoreAllMocks()
  for (const k of Object.keys(MockTransak._listeners)) delete MockTransak._listeners[k]
})

describe('transakOnRamp.open', () => {
  it('POSTs provider:transak with the Stellar address + amount, then resolves on order success', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ widgetUrl: 'https://global-stg.transak.com?sessionId=abc' }),
    }))
    const resultPromise = open({ address: 'GADDR', amount: 25 })
    await vi.waitFor(() => expect(MockTransak._listeners.ORDER_SUCCESSFUL).toBeDefined())
    MockTransak._listeners.ORDER_SUCCESSFUL({ id: 'order-123' })

    expect(await resultPromise).toEqual({
      completed: true,
      orderId: 'order-123',
      network: 'stellar',
    })
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('/api/onramp-session')
    expect(JSON.parse(opts.body)).toEqual({ provider: 'transak', address: 'GADDR', amount: 25 })
  })

  it('throws when the session endpoint is not ok', async () => {
    global.fetch = vi.fn(async () => ({ ok: false }))
    await expect(open({ address: 'GADDR' })).rejects.toThrow(/unavailable/)
  })

  it('throws when the response is missing widgetUrl', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    await expect(open({ address: 'GADDR' })).rejects.toThrow(/widgetUrl/)
  })
})

describe('launchWidget (SDK event wiring in isolation - no network, no DOM)', () => {
  it('resolves completed:true on TRANSAK_ORDER_SUCCESSFUL', async () => {
    const resultPromise = launchWidget('https://widget.example', { Transak: MockTransak })
    MockTransak._listeners.ORDER_SUCCESSFUL({ id: 'order-123' })
    expect(await resultPromise).toEqual({
      completed: true,
      orderId: 'order-123',
      network: 'stellar',
    })
  })

  it('resolves completed:false on TRANSAK_WIDGET_CLOSE', async () => {
    const resultPromise = launchWidget('https://widget.example', { Transak: MockTransak })
    MockTransak._listeners.WIDGET_CLOSE()
    expect(await resultPromise).toEqual({ completed: false, network: 'stellar' })
  })
})
