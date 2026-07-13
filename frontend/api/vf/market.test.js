import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import vfRouter from './_router.js'
import { storeFrom } from './_db.js'
import { issueKey } from './_keystore.js'

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
const mk = (method, url, body, key) => ({
  method,
  url,
  body,
  headers: { 'x-real-ip': '7.7.7.7', ...(key ? { authorization: `Bearer ${key}` } : {}) },
})

let key
beforeEach(async () => {
  ;({ key } = await issueKey(storeFrom({}), {
    owner: 'GMKT',
    scopes: ['market'],
    rateLimit: 100,
    env: 'test',
    expiresAt: null,
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('market endpoints', () => {
  it('all three 401 without a key', async () => {
    for (const [m, u] of [
      ['GET', '/vault-facts?protocol=blend-usdc'],
      ['POST', '/eligibility'],
      ['GET', '/prices'],
    ]) {
      const res = mockRes()
      await vfRouter(mk(m, u), res)
      expect(res.statusCode).toBe(401)
    }
  })
  it('vault-facts returns resolver output', async () => {
    const res = mockRes()
    await vfRouter(mk('GET', '/vault-facts?protocol=blend-usdc', undefined, key), res)
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    expect(out).toHaveProperty('protocol')
    expect(out).toHaveProperty('facts')
  })
  it('eligibility evaluates and returns allow/verdict/reasons', async () => {
    const res = mockRes()
    await vfRouter(
      mk(
        'POST',
        '/eligibility',
        { vault: 'CVAULT', amount: '10000000', protocol: 'blend-usdc' },
        key
      ),
      res
    )
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    expect(typeof out.allow).toBe('boolean')
    expect(Array.isArray(out.reasons)).toBe(true)
  })
  it('eligibility 400 on non-numeric amount', async () => {
    const res = mockRes()
    await vfRouter(mk('POST', '/eligibility', { vault: 'CVAULT', amount: 'xx' }, key), res)
    expect(res.statusCode).toBe(400)
  })
  it('eligibility fails closed on an unknown protocol - no silent blend-usdc default', async () => {
    const res = mockRes()
    await vfRouter(mk('POST', '/eligibility', { vault: 'CVAULT', amount: '10000000' }, key), res)
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    expect(out.allow).toBe(false)
    expect(out.reasons[0]).toMatch(/facts unavailable/)
  })
  it('prices proxies DeFiLlama and never echoes upstream errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ coins: { 'coingecko:stellar': { price: 0.5 } } }), {
            status: 200,
          })
      )
    )
    let res = mockRes()
    await vfRouter(mk('GET', '/prices?coins=coingecko:stellar', undefined, key), res)
    expect(JSON.parse(res.body).coins['coingecko:stellar'].price).toBe(0.5)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('SECRET-INTERNAL-DETAIL')
      })
    )
    res = mockRes()
    await vfRouter(mk('GET', '/prices', undefined, key), res)
    expect(res.statusCode).toBe(502)
    expect(res.body).not.toContain('SECRET-INTERNAL-DETAIL')
  })
})
