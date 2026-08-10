import { beforeEach, describe, expect, it, vi } from 'vitest'
import handler from './vf-cross.js'

const ORIGIN = 'http://localhost:5173'
const RELAYER = 'https://relayer.internal'
const JOB_ID = '55'.repeat(16)
const CAPABILITY = '22'.repeat(32)
const DIFFERENT_CAPABILITY = '44'.repeat(32)
const KERNEL = '0x0000000000000000000000000000000000000aa1'
const CHECKSUMMED_KERNEL = '0x1234567890AbcdEF1234567890aBcdef12345678'
const RECIPIENT = 'GCXMZCDVYTAANBRASUGWS5GDKRGSQWNM5XHVB4JI7PXECZYKBG5OTTRK'
const USER_OP_HASH = `0x${'33'.repeat(32)}`
const UNWIND_TX_HASH = `0x${'77'.repeat(32)}`
const COOKIE_NAME = `__Host-vf-unwind-${JOB_ID}`
const SET_COOKIE = `${COOKIE_NAME}=${CAPABILITY}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`

let ip = 0

function request(path, body, headers = {}) {
  return {
    method: 'POST',
    url: `/api/vf-cross${path}`,
    body,
    headers: {
      origin: ORIGIN,
      'x-real-ip': `198.51.100.${++ip}`,
      ...headers,
    },
  }
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key] = value
    },
    end(body = '') {
      this.body = body
      return this
    },
  }
}

function upstream(status, body, { setCookies = [], cacheControl = 'no-store' } = {}) {
  return {
    status,
    headers: {
      getSetCookie: () => setCookies,
      get: (name) => (name.toLowerCase() === 'cache-control' ? cacheControl : null),
    },
    text: async () => JSON.stringify(body),
  }
}

beforeEach(() => {
  process.env.RELAYER_ORIGIN = RELAYER
  process.env.RELAYER_PROXY_KEY = 'server-proxy-key'
})

describe('Task 12 unwind capability proxy', () => {
  it('forwards an exact reservation without browser authority and installs one strict HttpOnly cookie', async () => {
    const body = {
      jobId: JOB_ID,
      capability: CAPABILITY,
      kernelAddress: CHECKSUMMED_KERNEL,
      recipientHint: RECIPIENT,
    }
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe(`${RELAYER}/api/vf-cross/unwind`)
      expect(init.headers).toEqual({
        'content-type': 'application/json',
        'x-vf-relayer-key': 'server-proxy-key',
      })
      expect(JSON.parse(init.body)).toEqual({
        ...body,
        kernelAddress: CHECKSUMMED_KERNEL.toLowerCase(),
      })
      return upstream(202, { jobId: JOB_ID, status: 'awaiting_burn' }, { setCookies: [SET_COOKIE] })
    })
    const res = response()

    await handler(
      request('/unwind', body, {
        authorization: 'Bearer browser-forged',
        cookie: 'unrelated=secret',
      }),
      res,
      { fetchImpl }
    )

    expect(res.statusCode).toBe(202)
    expect(res.headers['Set-Cookie']).toBe(SET_COOKIE)
    expect(res.headers['Cache-Control']).toBe('no-store')
    expect(JSON.parse(res.body)).toEqual({ jobId: JOB_ID, status: 'awaiting_burn' })
    expect(res.body).not.toContain(CAPABILITY)
  })

  it.each([
    ['missing', []],
    ['duplicate', [SET_COOKIE, SET_COOKIE]],
    [
      'different canonical capability',
      [
        `${COOKIE_NAME}=${DIFFERENT_CAPABILITY}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
      ],
    ],
    [
      'foreign',
      [
        `__Host-vf-unwind-${'66'.repeat(16)}=${CAPABILITY}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
      ],
    ],
    [
      'weak attributes',
      [`${COOKIE_NAME}=${CAPABILITY}; Secure; SameSite=Strict; Path=/; Max-Age=3600`],
    ],
  ])(
    'rejects a %s reservation Set-Cookie instead of accepting an unusable job',
    async (_label, setCookies) => {
      const fetchImpl = vi.fn(async () =>
        upstream(202, { jobId: JOB_ID, status: 'awaiting_burn' }, { setCookies })
      )
      const res = response()
      await handler(
        request('/unwind', {
          jobId: JOB_ID,
          capability: CAPABILITY,
          kernelAddress: KERNEL,
          recipientHint: RECIPIENT,
        }),
        res,
        { fetchImpl }
      )
      expect(res.statusCode).toBe(502)
      expect(res.headers['Set-Cookie']).toBeUndefined()
      expect(res.body).not.toContain(CAPABILITY)
    }
  )

  it('maps only the exact unwind cookie to Bearer for minimal attach and strips caller headers', async () => {
    const attach = { jobId: JOB_ID, userOpHash: USER_OP_HASH, unwindTxHash: UNWIND_TX_HASH }
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe(`${RELAYER}/api/vf-cross/unwind/attach`)
      expect(init.headers).toEqual({
        'content-type': 'application/json',
        'x-vf-relayer-key': 'server-proxy-key',
        authorization: `Bearer ${CAPABILITY}`,
      })
      expect(JSON.parse(init.body)).toEqual(attach)
      return upstream(202, { jobId: JOB_ID, status: 'relay_pending', unwindTxHash: UNWIND_TX_HASH })
    })
    const res = response()
    await handler(
      request('/unwind/attach', attach, {
        authorization: 'Bearer browser-forged',
        cookie: `unrelated=secret; ${COOKIE_NAME}=${CAPABILITY}; another=value`,
      }),
      res,
      { fetchImpl }
    )
    expect(res.statusCode).toBe(202)
    expect(res.headers['Cache-Control']).toBe('no-store')
    expect(JSON.parse(res.body)).toEqual({
      jobId: JOB_ID,
      status: 'relay_pending',
      unwindTxHash: UNWIND_TX_HASH,
    })
  })

  it.each([
    ['missing cookie', {}],
    ['wrong cookie', { cookie: `__Host-vf-unwind-${'66'.repeat(16)}=${CAPABILITY}` }],
    ['duplicate cookie', { cookie: `${COOKIE_NAME}=${CAPABILITY}; ${COOKIE_NAME}=${CAPABILITY}` }],
  ])('rejects attach with %s before opening the relayer tunnel', async (_label, headers) => {
    const fetchImpl = vi.fn()
    const res = response()
    await handler(
      request(
        '/unwind/attach',
        { jobId: JOB_ID, userOpHash: USER_OP_HASH, unwindTxHash: UNWIND_TX_HASH },
        headers
      ),
      res,
      { fetchImpl }
    )
    expect(res.statusCode).toBe(401)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    [
      'reserve',
      '/unwind',
      {
        jobId: JOB_ID,
        capability: CAPABILITY,
        kernelAddress: KERNEL,
        recipientHint: RECIPIENT,
        owner: KERNEL,
      },
      {},
    ],
    [
      'attach',
      '/unwind/attach',
      { jobId: JOB_ID, userOpHash: USER_OP_HASH, unwindTxHash: UNWIND_TX_HASH, burned: '1' },
      { cookie: `${COOKIE_NAME}=${CAPABILITY}` },
    ],
    [
      'status',
      '/status',
      { jobId: JOB_ID, capability: CAPABILITY },
      { cookie: `${COOKIE_NAME}=${CAPABILITY}` },
    ],
  ])('rejects unknown %s body fields locally', async (_label, path, body, headers) => {
    const fetchImpl = vi.fn()
    const res = response()
    await handler(request(path, body, headers), res, { fetchImpl })
    expect(res.statusCode).toBe(400)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('authenticates exact job-only status, forwards no cookies, and marks every response no-store', async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe(`${RELAYER}/api/vf-cross/status`)
      expect(init.headers.authorization).toBe(`Bearer ${CAPABILITY}`)
      expect(init.headers.cookie).toBeUndefined()
      expect(JSON.parse(init.body)).toEqual({ jobId: JOB_ID })
      return upstream(200, { jobId: JOB_ID, status: 'done', unwindTxHash: UNWIND_TX_HASH })
    })
    const res = response()
    await handler(
      request('/status', { jobId: JOB_ID }, { cookie: `${COOKIE_NAME}=${CAPABILITY}` }),
      res,
      { fetchImpl }
    )
    expect(res.statusCode).toBe(200)
    expect(res.headers['Cache-Control']).toBe('no-store')
    expect(res.headers['Access-Control-Allow-Origin']).toBe(ORIGIN)
    expect(res.headers['Access-Control-Allow-Origin']).not.toBe('*')
  })

  it('rejects any upstream Set-Cookie on attach and never reflects secret upstream errors', async () => {
    const fetchImpl = vi.fn(async () =>
      upstream(500, { error: `private ${CAPABILITY}` }, { setCookies: [SET_COOKIE] })
    )
    const res = response()
    await handler(
      request(
        '/unwind/attach',
        { jobId: JOB_ID, userOpHash: USER_OP_HASH, unwindTxHash: UNWIND_TX_HASH },
        { cookie: `${COOKIE_NAME}=${CAPABILITY}` }
      ),
      res,
      { fetchImpl }
    )
    expect(res.statusCode).toBe(502)
    expect(res.body).not.toContain(CAPABILITY)
    expect(res.headers['Set-Cookie']).toBeUndefined()
  })

  it.each(['?capability=secret', '?token=secret', '?debug=1'])(
    'rejects protected query strings (%s) before identity or tunnel handling',
    async (query) => {
      const fetchImpl = vi.fn()
      const res = response()
      await handler(
        request(
          `/unwind/attach${query}`,
          { jobId: JOB_ID, userOpHash: USER_OP_HASH, unwindTxHash: UNWIND_TX_HASH },
          { cookie: `${COOKIE_NAME}=${CAPABILITY}` }
        ),
        res,
        { fetchImpl }
      )
      expect(res.statusCode).toBe(400)
      expect(res.headers['Cache-Control']).toBe('no-store')
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(res.body).not.toMatch(/capability|token|debug|secret/i)
    }
  )
})
