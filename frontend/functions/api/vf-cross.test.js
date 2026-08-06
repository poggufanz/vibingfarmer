import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import handler, { _test } from '../../api/vf-cross.js'

const MANDATE_ID = '11'.repeat(16)
const OTHER_ID = '33'.repeat(16)
const JOB_ID = '55'.repeat(16)
const CAPABILITY = '22'.repeat(32)
const OTHER_CAPABILITY = '44'.repeat(32)
const UNWIND_CAPABILITY = '77'.repeat(32)
const MANDATE_COOKIE = `__Host-vf-mandate-${MANDATE_ID}`
const OTHER_COOKIE = `__Host-vf-mandate-${OTHER_ID}`
const UNWIND_COOKIE = `__Host-vf-unwind-${JOB_ID}`
const VALID_SET_COOKIE = `${MANDATE_COOKIE}=${CAPABILITY}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`
let requestSequence = 1

function registrationBody(overrides = {}) {
  return {
    mandateId: MANDATE_ID,
    capability: CAPABILITY,
    serializedApproval: 'APPROVAL-ONE-TIME',
    sessionPrivateKey: 'PRIVATE-KEY-ONE-TIME',
    sessionKeyAddress: '0x0000000000000000000000000000000000000bb2',
    expiresAt: 2_000_007_200,
    stellarOwner: 'GUSER',
    kernelAddress: '0x0000000000000000000000000000000000000aa1',
    ...overrides,
  }
}

function fakeReq({
  method = 'POST',
  url = '/api/vf-cross/farm',
  body = { mandateId: MANDATE_ID },
  origin = 'http://localhost:5173',
  cookie,
  authorization,
} = {}) {
  const headers = { origin, 'content-type': 'application/json' }
  if (cookie !== undefined) headers.cookie = cookie
  if (authorization !== undefined) headers.authorization = authorization
  return {
    method,
    url,
    body,
    headers,
    socket: { remoteAddress: `1.2.3.${requestSequence++}` },
  }
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value
    },
    getHeader(key) {
      return this.headers[key.toLowerCase()]
    },
    end(body) {
      this.body = body || ''
    },
  }
}

function upstream({ status = 200, body = {}, setCookies = [], headers = {} } = {}) {
  return {
    status,
    headers: {
      getSetCookie: () => [...setCookies],
      entries: () => Object.entries(headers),
      get: (key) => headers[String(key).toLowerCase()] ?? null,
    },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

async function requestThrough({ req = fakeReq(), response = upstream(), fetchImpl } = {}) {
  const fetchSpy = fetchImpl ?? vi.fn(async () => response)
  const res = fakeRes()
  await handler(req, res, { fetchImpl: fetchSpy })
  return { res, fetchImpl: fetchSpy }
}

describe('/api/vf-cross proxy', () => {
  beforeEach(() => {
    process.env.RELAYER_ORIGIN = 'https://relayer.example.com'
    process.env.RELAYER_PROXY_KEY = 'proxy-key'
  })

  it('503 when RELAYER_ORIGIN is unset', async () => {
    delete process.env.RELAYER_ORIGIN
    const { res, fetchImpl } = await requestThrough({ fetchImpl: vi.fn() })
    expect(res.statusCode).toBe(503)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('502 when the relayer is unreachable without reflecting tunnel details', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED 10.0.0.1 bearer-secret')
    })
    const { res } = await requestThrough({ fetchImpl })
    expect(res.statusCode).toBe(502)
    expect(res.body).toBe(JSON.stringify({ error: 'relayer unreachable' }))
    expect(res.body).not.toMatch(/10\.0\.0\.1|bearer-secret/)
  })

  it('rejects a disallowed browser origin before upstream fetch', async () => {
    const fetchImpl = vi.fn()
    const { res } = await requestThrough({
      req: fakeReq({ origin: 'https://evil.example' }),
      fetchImpl,
    })
    expect(res.statusCode).toBe(403)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rate-limits one client before it can fan out relayer requests', async () => {
    const fetchImpl = vi.fn(async () => upstream({ body: { ok: true } }))
    let last
    for (let attempt = 0; attempt < 31; attempt += 1) {
      const req = fakeReq({ method: 'GET', url: '/api/vf-cross/config', body: undefined })
      req.socket.remoteAddress = '9.9.9.9'
      const result = await requestThrough({ req, fetchImpl })
      last = result.res
    }
    expect(last.statusCode).toBe(429)
    expect(fetchImpl).toHaveBeenCalledTimes(30)
  })

  it('keeps public config bodyless and does not require a capability cookie', async () => {
    const { res, fetchImpl } = await requestThrough({
      req: fakeReq({ method: 'GET', url: '/api/vf-cross/config', body: undefined }),
      response: upstream({ body: { ok: true } }),
    })
    expect(res.statusCode).toBe(200)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://relayer.example.com/api/vf-cross/config')
    expect(init.body).toBeUndefined()
  })

  it('_test.subPath preserves only the fixed relayer sub-path', () => {
    expect(_test.subPath('/api/vf-cross/mandate/status')).toBe('/mandate/status')
    expect(_test.subPath('/api/vf-cross')).toBe('/')
  })
})

describe('capability-cookie proxy', () => {
  beforeEach(() => {
    process.env.RELAYER_ORIGIN = 'https://relayer.example.com'
    process.env.RELAYER_PROXY_KEY = 'proxy-key'
  })

  it('forwards one exact canonical registration cookie and no alternate upstream headers', async () => {
    const registration = registrationBody()
    const body = {
      ok: true,
      status: 'pending_activation',
      mandateId: MANDATE_ID,
      bindingId: 'binding-1',
      bindingHash: 'binding-hash-1',
      relayerOrigin: 'https://relayer.example.com',
    }
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { res, fetchImpl } = await requestThrough({
      req: fakeReq({
        url: '/api/vf-cross/mandate',
        body: registration,
        cookie: 'tracking=x',
        authorization: 'Bearer browser-forged',
      }),
      response: upstream({
        status: 202,
        body,
        setCookies: [VALID_SET_COOKIE],
        headers: { 'x-upstream-secret': 'must-not-forward', authorization: 'Bearer leak' },
      }),
    })

    expect(res.statusCode).toBe(202)
    expect(res.getHeader('set-cookie')).toBe(VALID_SET_COOKIE)
    expect(res.getHeader('x-upstream-secret')).toBeUndefined()
    expect(res.getHeader('authorization')).toBeUndefined()
    expect(JSON.parse(res.body)).toEqual(body)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://relayer.example.com/api/vf-cross/mandate')
    expect(init.headers).not.toHaveProperty('authorization')
    expect(init.headers).not.toHaveProperty('cookie')
    expect(init.headers['x-vf-relayer-key']).toBe('proxy-key')
    expect(JSON.parse(init.body)).toEqual(registration)
    expect(init.body.match(new RegExp(CAPABILITY, 'g'))).toHaveLength(1)
    expect(`${url}${JSON.stringify(init.headers)}${res.body}`).not.toMatch(
      /APPROVAL-ONE-TIME|PRIVATE-KEY-ONE-TIME|22222222/
    )
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toMatch(
      /APPROVAL-ONE-TIME|PRIVATE-KEY-ONE-TIME|22222222/
    )
    consoleSpy.mockRestore()
  })

  it.each([
    ['uppercase ID', VALID_SET_COOKIE.replace(MANDATE_ID, 'AA'.repeat(16))],
    ['different ID', VALID_SET_COOKIE.replace(MANDATE_ID, OTHER_ID)],
    ['short capability', VALID_SET_COOKIE.replace(CAPABILITY, CAPABILITY.slice(2))],
    ['uppercase capability', VALID_SET_COOKIE.replace(CAPABILITY, 'BB'.repeat(32))],
    ['non-hex capability', VALID_SET_COOKIE.replace(CAPABILITY, `z${CAPABILITY.slice(1)}`)],
    ['missing Secure', VALID_SET_COOKIE.replace('; Secure', '')],
    ['duplicate Secure', `${VALID_SET_COOKIE}; Secure`],
    ['missing HttpOnly', VALID_SET_COOKIE.replace('; HttpOnly', '')],
    ['duplicate HttpOnly', `${VALID_SET_COOKIE}; HttpOnly`],
    ['wrong SameSite', VALID_SET_COOKIE.replace('SameSite=Strict', 'SameSite=Lax')],
    ['duplicate SameSite', `${VALID_SET_COOKIE}; SameSite=Strict`],
    ['missing Path', VALID_SET_COOKIE.replace('; Path=/', '')],
    ['wrong Path', VALID_SET_COOKIE.replace('Path=/', 'Path=/api')],
    ['duplicate Path', `${VALID_SET_COOKIE}; Path=/`],
    ['Domain', `${VALID_SET_COOKIE}; Domain=example.com`],
    ['unknown attribute', `${VALID_SET_COOKIE}; Priority=High`],
    ['zero registration age', VALID_SET_COOKIE.replace('Max-Age=3600', 'Max-Age=0')],
    ['negative registration age', VALID_SET_COOKIE.replace('Max-Age=3600', 'Max-Age=-1')],
    ['over 30-day age', VALID_SET_COOKIE.replace('Max-Age=3600', 'Max-Age=2592001')],
    ['missing Max-Age', VALID_SET_COOKIE.replace('; Max-Age=3600', '')],
    ['duplicate Max-Age', `${VALID_SET_COOKIE}; Max-Age=3600`],
  ])('fails closed and forwards no Set-Cookie for %s', async (_label, cookie) => {
    const { res } = await requestThrough({
      req: fakeReq({ url: '/api/vf-cross/mandate', body: registrationBody() }),
      response: upstream({ status: 202, setCookies: [cookie] }),
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.getHeader('set-cookie')).toBeUndefined()
    expect(res.body).not.toContain(CAPABILITY)
  })

  it('accepts only an exact matching revoke-clear cookie', async () => {
    const clear = `${MANDATE_COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
    const { res } = await requestThrough({
      req: fakeReq({
        url: '/api/vf-cross/mandate/revoke',
        body: { mandateId: MANDATE_ID, stellarOwner: 'GUSER', kernelAddress: '0xKERNEL' },
        cookie: `${MANDATE_COOKIE}=${CAPABILITY}`,
      }),
      response: upstream({ status: 200, body: { ok: true }, setCookies: [clear] }),
    })
    expect(res.getHeader('set-cookie')).toBe(clear)

    const wrong = clear.replace(MANDATE_ID, OTHER_ID)
    const rejected = await requestThrough({
      req: fakeReq({
        url: '/api/vf-cross/mandate/revoke',
        body: { mandateId: MANDATE_ID, stellarOwner: 'GUSER', kernelAddress: '0xKERNEL' },
        cookie: `${MANDATE_COOKIE}=${CAPABILITY}`,
      }),
      response: upstream({ status: 200, setCookies: [wrong] }),
    })
    expect(rejected.res.statusCode).toBeGreaterThanOrEqual(400)
    expect(rejected.res.getHeader('set-cookie')).toBeUndefined()
  })

  it.each([
    [
      'nonempty clear value',
      `${MANDATE_COOKIE}=${CAPABILITY}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    ],
    [
      'positive-age empty value',
      `${MANDATE_COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=60`,
    ],
  ])('rejects an invalid revoke-clear cookie with %s', async (_label, setCookie) => {
    const { res } = await requestThrough({
      req: fakeReq({
        url: '/api/vf-cross/mandate/revoke',
        body: { mandateId: MANDATE_ID, stellarOwner: 'GUSER', kernelAddress: '0xKERNEL' },
        cookie: `${MANDATE_COOKIE}=${CAPABILITY}`,
      }),
      response: upstream({ status: 200, setCookies: [setCookie] }),
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.getHeader('set-cookie')).toBeUndefined()
  })

  it.each([
    ['two capability cookies', [VALID_SET_COOKIE, VALID_SET_COOKIE]],
    ['capability plus tracking', [VALID_SET_COOKIE, 'tracking=x; Secure; HttpOnly; Path=/']],
    [
      'comma-folded ambiguity',
      [`${VALID_SET_COOKIE}, tracking=x; Secure; HttpOnly; SameSite=Strict; Path=/`],
    ],
  ])('rejects %s instead of guessing or splitting', async (_label, setCookies) => {
    const { res } = await requestThrough({
      req: fakeReq({ url: '/api/vf-cross/mandate', body: registrationBody() }),
      response: upstream({ status: 202, setCookies }),
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.getHeader('set-cookie')).toBeUndefined()
  })

  it('fails a 202 registration when upstream provides no capability cookie', async () => {
    const { res } = await requestThrough({
      req: fakeReq({ url: '/api/vf-cross/mandate', body: registrationBody() }),
      response: upstream({
        status: 202,
        body: { ok: true, status: 'pending_activation', capability: CAPABILITY },
        setCookies: [],
      }),
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.getHeader('set-cookie')).toBeUndefined()
    expect(res.body).not.toMatch(/pending_activation|22222222/)
  })

  it.each([
    ['/api/vf-cross/farm', { mandateId: MANDATE_ID, sourceDomain: 27 }, MANDATE_COOKIE, CAPABILITY],
    [
      '/api/vf-cross/farm/attach',
      { mandateId: MANDATE_ID, jobId: JOB_ID, messageHash: `0x${'66'.repeat(32)}` },
      MANDATE_COOKIE,
      CAPABILITY,
    ],
    [
      '/api/vf-cross/mandate/status',
      { mandateId: MANDATE_ID, stellarOwner: 'GUSER', kernelAddress: '0xKERNEL' },
      MANDATE_COOKIE,
      CAPABILITY,
    ],
    [
      '/api/vf-cross/mandate/revoke',
      { mandateId: MANDATE_ID, stellarOwner: 'GUSER', kernelAddress: '0xKERNEL' },
      MANDATE_COOKIE,
      CAPABILITY,
    ],
    ['/api/vf-cross/status', { mandateId: MANDATE_ID, jobId: JOB_ID }, MANDATE_COOKIE, CAPABILITY],
    ['/api/vf-cross/status', { jobId: JOB_ID }, UNWIND_COOKIE, UNWIND_CAPABILITY],
  ])(
    'selects only the identity-matched cookie for POST %s',
    async (url, body, _name, capability) => {
      const cookie = [
        'theme=dark',
        `${OTHER_COOKIE}=${OTHER_CAPABILITY}`,
        `${MANDATE_COOKIE}=${CAPABILITY}`,
        `${UNWIND_COOKIE}=${UNWIND_CAPABILITY}`,
      ].join('; ')
      const { res, fetchImpl } = await requestThrough({
        req: fakeReq({ url, body, cookie, authorization: 'Bearer browser-forged' }),
        response: upstream({ status: 200, body: { status: 'pending' } }),
      })
      expect(res.statusCode).toBe(200)
      const [, init] = fetchImpl.mock.calls[0]
      expect(init.headers.authorization).toBe(`Bearer ${capability}`)
      expect(init.headers).not.toHaveProperty('cookie')
      expect(JSON.stringify(init.headers)).not.toContain('browser-forged')
      const wrongCapabilities = [CAPABILITY, OTHER_CAPABILITY, UNWIND_CAPABILITY].filter(
        (candidate) => candidate !== capability
      )
      for (const wrong of wrongCapabilities) {
        expect(init.headers.authorization).not.toContain(wrong)
      }
    }
  )

  it('rejects an unsolicited upstream cookie on a non-cookie-issuing route', async () => {
    const { res } = await requestThrough({
      req: fakeReq({
        url: '/api/vf-cross/farm',
        body: { mandateId: MANDATE_ID },
        cookie: `${MANDATE_COOKIE}=${CAPABILITY}`,
      }),
      response: upstream({
        status: 200,
        body: { status: 'pending' },
        setCookies: ['tracking=x; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=60'],
      }),
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.getHeader('set-cookie')).toBeUndefined()
  })

  it.each([
    ['missing identity', {}, ''],
    [
      'malformed mandate identity',
      { mandateId: `0x${MANDATE_ID}` },
      `${MANDATE_COOKIE}=${CAPABILITY}`,
    ],
    ['missing matching cookie', { mandateId: MANDATE_ID }, `${OTHER_COOKIE}=${OTHER_CAPABILITY}`],
    [
      'duplicate matching cookie',
      { mandateId: MANDATE_ID },
      `${MANDATE_COOKIE}=${CAPABILITY}; ${MANDATE_COOKIE}=${CAPABILITY}`,
    ],
    [
      'noncanonical capability',
      { mandateId: MANDATE_ID },
      `${MANDATE_COOKIE}=${CAPABILITY.slice(2)}`,
    ],
  ])('rejects %s locally before upstream state disclosure', async (_label, body, cookie) => {
    const fetchImpl = vi.fn()
    const { res } = await requestThrough({
      req: fakeReq({ url: '/api/vf-cross/farm', body, cookie }),
      fetchImpl,
    })
    expect([400, 401]).toContain(res.statusCode)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(res.body).not.toMatch(/exists|missing job|mandate state|22222222/i)
  })

  it('uses the same pre-auth response for existing-looking and unknown mandate identities', async () => {
    const fetchImpl = vi.fn()
    const known = await requestThrough({
      req: fakeReq({ url: '/api/vf-cross/farm', body: { mandateId: MANDATE_ID }, cookie: '' }),
      fetchImpl,
    })
    const unknown = await requestThrough({
      req: fakeReq({ url: '/api/vf-cross/farm', body: { mandateId: OTHER_ID }, cookie: '' }),
      fetchImpl,
    })
    expect({ status: known.res.statusCode, body: known.res.body }).toEqual({
      status: unknown.res.statusCode,
      body: unknown.res.body,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    [
      '/api/vf-cross/status',
      { mandateId: MANDATE_ID, jobId: 'short' },
      `${MANDATE_COOKIE}=${CAPABILITY}`,
    ],
    ['/api/vf-cross/status', { jobId: `0x${JOB_ID}` }, `${UNWIND_COOKIE}=${OTHER_CAPABILITY}`],
    [
      '/api/vf-cross/farm/attach',
      { mandateId: MANDATE_ID, jobId: undefined },
      `${MANDATE_COOKIE}=${CAPABILITY}`,
    ],
  ])('rejects malformed fixed-path identity for %s before fetch', async (url, body, cookie) => {
    const fetchImpl = vi.fn()
    const { res } = await requestThrough({ req: fakeReq({ url, body, cookie }), fetchImpl })
    expect(res.statusCode).toBe(400)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not reflect upstream capability, Authorization, Cookie, or secret fields', async () => {
    const poison = `Bearer ${CAPABILITY}`
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { res } = await requestThrough({
      req: fakeReq({
        url: '/api/vf-cross/farm',
        body: { mandateId: MANDATE_ID },
        cookie: `${MANDATE_COOKIE}=${CAPABILITY}`,
      }),
      response: upstream({
        status: 500,
        body: {
          error: poison,
          authorization: poison,
          cookie: `${MANDATE_COOKIE}=${CAPABILITY}`,
          sessionPrivateKey: 'PRIVATE-SENTINEL',
        },
        headers: { authorization: poison, cookie: `${MANDATE_COOKIE}=${CAPABILITY}` },
      }),
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(
      `${res.body}${JSON.stringify(res.headers)}${JSON.stringify(consoleSpy.mock.calls)}`
    ).not.toMatch(/22222222|PRIVATE-SENTINEL|Authorization|Bearer|__Host-vf-mandate/i)
    consoleSpy.mockRestore()
  })

  it.each([
    ['GET', '/api/vf-cross/farm', { mandateId: MANDATE_ID }],
    ['GET', '/api/vf-cross/status', { mandateId: MANDATE_ID, jobId: JOB_ID }],
    ['GET', `/api/vf-cross/status/${JOB_ID}`, undefined],
    ['GET', '/api/vf-cross/status/health-probe', undefined],
    ['POST', '/api/vf-cross/config', {}],
    ['DELETE', '/api/vf-cross/mandate/revoke', { mandateId: MANDATE_ID }],
    ['POST', '/api/vf-cross/admin', { mandateId: MANDATE_ID }],
  ])(
    'rejects non-allowlisted %s %s before opening the relayer tunnel',
    async (method, url, body) => {
      const fetchImpl = vi.fn()
      const { res } = await requestThrough({
        req: fakeReq({
          method,
          url,
          body,
          cookie: `${MANDATE_COOKIE}=${CAPABILITY}`,
        }),
        fetchImpl,
      })
      expect([404, 405]).toContain(res.statusCode)
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )
})

describe('Cloudflare security header behavior', () => {
  it('ships a strict reviewed CSP for the app runtime inventory', () => {
    const text = readFileSync(new URL('../../public/_headers', import.meta.url), 'utf8')
    const stanza = text.split(/\n(?=\/)/).find((part) => part.trimStart().startsWith('/*')) || ''
    const cspLine = stanza
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.toLowerCase().startsWith('content-security-policy:'))
    expect(cspLine).toBeTruthy()
    const directives = Object.fromEntries(
      cspLine
        .slice(cspLine.indexOf(':') + 1)
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const [name, ...values] = part.split(/\s+/)
          return [name, values]
        })
    )
    expect(directives['default-src']).toEqual(["'self'"])
    expect(directives['script-src']).toEqual(["'self'"])
    expect(directives['object-src']).toEqual(["'none'"])
    expect(directives['base-uri']).toEqual(["'none'"])
    expect(directives['frame-ancestors']).toEqual(["'none'"])
    expect(directives['img-src']).toEqual(["'self'", 'data:', 'blob:'])
    expect(directives['style-src']).toEqual(["'self'", "'unsafe-inline'"])
    expect(directives['frame-src']).toEqual([
      'https://global-stg.transak.com',
      'https://global.transak.com',
    ])
    expect(directives['connect-src']).toEqual([
      "'self'",
      'https://soroban-testnet.stellar.org',
      'https://horizon-testnet.stellar.org',
      'https://friendbot.stellar.org',
      'https://sepolia.base.org',
      'https://rpc.zerodev.app',
      'https://passkeys.zerodev.app',
      'https://yields.llama.fi',
      'https://api.llama.fi',
      'https://coins.llama.fi',
      'https://base-sepolia.blockscout.com',
      'https://api.coingecko.com',
      'https://api.venice.ai',
      'https://api.deepseek.com',
      'https://api.tavily.com',
      'https://api.telegram.org',
      'https://discord.com',
      'https://smart-account-indexer.sdf-ecosystem.workers.dev',
    ])
    expect(cspLine).not.toMatch(/(?:^|\s)\*(?:\s|;|$)|'unsafe-eval'/)
  })
})
