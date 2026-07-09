import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import vfRouter from './_router.js'
import { equalSplit, parseLlmPlan } from './strategy.js'
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
const mk = (body, key) => ({
  method: 'POST',
  url: '/strategy',
  body,
  headers: { 'x-real-ip': '4.4.4.4', ...(key ? { authorization: `Bearer ${key}` } : {}) },
})

let key
beforeEach(async () => {
  delete process.env.DEEPSEEK_API_KEY
  process.env.VF_VAULT_CATALOG = 'blend-usdc'
  ;({ key } = await issueKey(storeFrom({}), {
    owner: 'GST',
    scopes: ['strategy'],
    rateLimit: 50,
    env: 'test',
    expiresAt: null,
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('equalSplit', () => {
  it('splits 100 across min(count, catalog) with integer pcts summing to 100', () => {
    expect(equalSplit(['a', 'b', 'c'], 2)).toEqual([
      { protocol: 'a', pct: 50 },
      { protocol: 'b', pct: 50 },
    ])
    const three = equalSplit(['a', 'b', 'c'], 3)
    expect(three.reduce((s, x) => s + x.pct, 0)).toBe(100)
  })
})

describe('parseLlmPlan', () => {
  it('accepts a valid plan, rejects bad pct sums / unknown protocols / garbage', () => {
    const ok = parseLlmPlan(
      '{"allocations":[{"protocol":"blend-usdc","pct":100}],"reasoning":"r"}',
      ['blend-usdc']
    )
    expect(ok.allocations[0].pct).toBe(100)
    expect(
      parseLlmPlan('{"allocations":[{"protocol":"evil","pct":100}]}', ['blend-usdc'])
    ).toBeNull()
    expect(
      parseLlmPlan('{"allocations":[{"protocol":"blend-usdc","pct":80}]}', ['blend-usdc'])
    ).toBeNull()
    expect(parseLlmPlan('not json', ['blend-usdc'])).toBeNull()
  })
})

describe('POST /strategy', () => {
  it('falls back to equal split without DEEPSEEK_API_KEY', async () => {
    const res = mockRes()
    await vfRouter(mk({ amountUsd: 100, riskLevel: 'low', vaultCount: 1 }, key), res)
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    expect(out.source).toBe('fallback')
    expect(out.allocations).toEqual([{ protocol: 'blend-usdc', pct: 100 }])
  })
  it('uses the LLM plan when the upstream answers valid JSON', async () => {
    process.env.DEEPSEEK_API_KEY = 'k'
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      '{"allocations":[{"protocol":"blend-usdc","pct":100}],"reasoning":"solid"}',
                  },
                },
              ],
            }),
            { status: 200 }
          )
      )
    )
    const res = mockRes()
    await vfRouter(mk({ amountUsd: 100, riskLevel: 'medium', vaultCount: 1 }, key), res)
    const out = JSON.parse(res.body)
    expect(out.source).toBe('llm')
    expect(out.reasoning).toBe('solid')
  })
  it('falls back when the LLM returns garbage', async () => {
    process.env.DEEPSEEK_API_KEY = 'k'
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: 'nonsense' } }] }), {
            status: 200,
          })
      )
    )
    const res = mockRes()
    await vfRouter(mk({ amountUsd: 100, riskLevel: 'high', vaultCount: 1 }, key), res)
    expect(JSON.parse(res.body).source).toBe('fallback')
  })
  it('400 on invalid inputs', async () => {
    const res = mockRes()
    await vfRouter(mk({ amountUsd: -5, riskLevel: 'yolo', vaultCount: 0 }, key), res)
    expect(res.statusCode).toBe(400)
  })
})
