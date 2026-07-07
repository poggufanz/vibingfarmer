import { describe, it, expect, vi, beforeEach } from 'vitest'
import handler, { buildWidgetParams } from './onramp-session.js'

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(s) {
      this.body = s ?? ''
      return this
    },
  }
}
function mockReq(body, { origin = 'http://localhost:5173', method = 'POST' } = {}) {
  return { method, headers: { origin, 'x-real-ip': '1.2.3.4' }, body }
}

const STELLAR_ADDR = 'GABC2W2NLWMOSVBUCDPI3TZAAWZFI5AV2GPQVKKD5FMDVJXENRJDBQVQ'

beforeEach(() => {
  vi.restoreAllMocks()
  delete process.env.TRANSAK_API_KEY
  delete process.env.TRANSAK_ACCESS_TOKEN
  process.env.ALLOWED_ORIGIN = 'http://localhost:5173'
  process.env.TRANSAK_REFERRER_DOMAIN = 'localhost'
})

describe('buildWidgetParams', () => {
  it('locks network=stellar + cryptoCurrencyCode=USDC + the destination wallet', () => {
    process.env.TRANSAK_API_KEY = 'test-key'
    const params = buildWidgetParams({ address: STELLAR_ADDR })
    expect(params).toMatchObject({
      apiKey: 'test-key',
      referrerDomain: 'localhost',
      productsAvailed: 'BUY',
      network: 'stellar',
      cryptoCurrencyCode: 'USDC',
      walletAddress: STELLAR_ADDR,
      disableWalletAddressForm: true,
    })
  })

  it('adds a locked USD amount when amount is provided', () => {
    const params = buildWidgetParams({ address: STELLAR_ADDR, amount: 50 })
    expect(params.fiatAmount).toBe(50)
    expect(params.fiatCurrency).toBe('USD')
  })

  it('omits fiat amount fields when amount is not provided', () => {
    const params = buildWidgetParams({ address: STELLAR_ADDR })
    expect(params.fiatAmount).toBeUndefined()
    expect(params.fiatCurrency).toBeUndefined()
  })
})

describe('/api/onramp-session handler', () => {
  it('returns 503 configured:false when Transak keys are unset', async () => {
    const res = mockRes()
    await handler(mockReq({ address: STELLAR_ADDR }), res)
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body)).toMatchObject({ configured: false })
  })

  it('rejects a disallowed origin (403)', async () => {
    process.env.TRANSAK_API_KEY = 'k'
    process.env.TRANSAK_ACCESS_TOKEN = 't'
    const res = mockRes()
    await handler(mockReq({ address: STELLAR_ADDR }, { origin: 'https://evil.example' }), res)
    expect(res.statusCode).toBe(403)
  })

  it('405 on non-POST', async () => {
    const res = mockRes()
    await handler(mockReq({}, { method: 'GET' }), res)
    expect(res.statusCode).toBe(405)
  })

  it('400 on an invalid Stellar address', async () => {
    process.env.TRANSAK_API_KEY = 'k'
    process.env.TRANSAK_ACCESS_TOKEN = 't'
    const res = mockRes()
    await handler(mockReq({ address: '0xNotStellar' }), res)
    expect(res.statusCode).toBe(400)
  })

  it('calls the Transak session API and returns { widgetUrl } on success', async () => {
    process.env.TRANSAK_API_KEY = 'k'
    process.env.TRANSAK_ACCESS_TOKEN = 't'
    global.fetch = vi.fn(async (url, opts) => {
      expect(url).toBe('https://api-gateway-stg.transak.com/api/v2/auth/session')
      expect(opts.headers['access-token']).toBe('t')
      const sentBody = JSON.parse(opts.body)
      expect(sentBody.widgetParams).toMatchObject({
        network: 'stellar',
        cryptoCurrencyCode: 'USDC',
        walletAddress: STELLAR_ADDR,
      })
      return {
        ok: true,
        json: async () => ({
          response: { widgetUrl: 'https://global-stg.transak.com?apiKey=k&sessionId=abc' },
        }),
      }
    })
    const res = mockRes()
    await handler(mockReq({ address: STELLAR_ADDR, amount: 50 }), res)
    expect(JSON.parse(res.body)).toEqual({
      widgetUrl: 'https://global-stg.transak.com?apiKey=k&sessionId=abc',
    })
  })

  it('502s when the upstream session request fails', async () => {
    process.env.TRANSAK_API_KEY = 'k'
    process.env.TRANSAK_ACCESS_TOKEN = 't'
    global.fetch = vi.fn(async () => ({ ok: false }))
    const res = mockRes()
    await handler(mockReq({ address: STELLAR_ADDR }), res)
    expect(res.statusCode).toBe(502)
  })

  it('501s for the documented-but-unwired coinbase-base fallback provider', async () => {
    process.env.TRANSAK_API_KEY = 'k'
    process.env.TRANSAK_ACCESS_TOKEN = 't'
    const res = mockRes()
    await handler(mockReq({ provider: 'coinbase-base', address: '0xBaseAddr' }), res)
    expect(res.statusCode).toBe(501)
    expect(JSON.parse(res.body)).toMatchObject({ configured: false })
  })

  it('400s for an unknown provider', async () => {
    process.env.TRANSAK_API_KEY = 'k'
    process.env.TRANSAK_ACCESS_TOKEN = 't'
    const res = mockRes()
    await handler(mockReq({ provider: 'nope', address: STELLAR_ADDR }), res)
    expect(res.statusCode).toBe(400)
  })
})
