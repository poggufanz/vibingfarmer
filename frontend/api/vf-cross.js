// frontend/api/vf-cross.js
// Production proxy: browser -> Pages Function (origin allowlist + rate limit, _guard.js) ->
// cloudflared tunnel -> relayer VM. ALL relayer traffic (including local dev) goes through this
// same-origin path: `VITE_CROSS_RELAYER_BASE` is deliberately ignored by every client so the
// capability-cookie boundary below is never bypassed by a direct cross-origin URL.
//
// v3 capability boundary (cross-chain hardening Task 6): the relayer's one-time registration
// response installs EXACTLY ONE validated `__Host-vf-mandate-<32hex>` (or, for unwind jobs,
// `__Host-vf-unwind-<32hex>`) HttpOnly cookie. This proxy is the only component that ever sees
// the capability again: later fixed-path POSTs name the public mandateId/jobId in their JSON
// body, and the proxy maps the matching cookie onto an upstream `Authorization: Bearer` header.
// Browser-supplied Cookie/Authorization headers are always stripped; upstream bodies/headers
// that echo a capability are never reflected; every upstream Set-Cookie that is not the one
// exact validated contract fails closed.
import { applyCors, rateLimit } from './_guard.js'

const TIMEOUT_MS = 30_000 // relayer's per-request work is async (fire-and-forget jobs), so responses are quick
const MAX_CAPABILITY_AGE_SECONDS = 2_592_000 // the relayer's 30-day cookie cap

const CANONICAL_ID = /^[0-9a-f]{32}$/ // 128-bit lowercase hex mandate/job identity
const CANONICAL_CAPABILITY = /^[0-9a-f]{64}$/ // 256-bit lowercase hex capability
const CANONICAL_EVM_ADDRESS = /^0x[0-9a-f]{40}$/i
const CANONICAL_EVM_HASH = /^0x[0-9a-f]{64}$/

const UNWIND_RESERVE_FIELDS = ['jobId', 'capability', 'kernelAddress', 'recipientHint']
const UNWIND_ATTACH_FIELDS = ['jobId', 'userOpHash', 'unwindTxHash']
const UNWIND_STATUS_FIELDS = ['jobId']
const FARM_ATTACH_FIELDS = ['mandateId', 'jobId', 'burnTxHash']
const FARM_FIELDS = [
  'requestId',
  'sourceDomain',
  'mandateId',
  'stellarOwner',
  'kernelAddress',
  'bridgeAgent',
  'runId',
  'grantTxHash',
  'allocations',
]

// The only method+path pairs this proxy will ever open the relayer tunnel for. Everything else
// (legacy GET status paths, health probes, admin routes, wrong methods) is refused locally.
// `cookieIssue` marks the routes whose upstream response may carry a Set-Cookie at all.
const ROUTES = {
  'GET /config': { auth: null },
  'POST /mandate': { auth: null, cookieIssue: 'register' },
  'POST /unwind': {
    auth: null,
    cookieIssue: 'register',
    cookieKind: 'unwind',
    exactFields: UNWIND_RESERVE_FIELDS,
    noStore: true,
  },
  'POST /unwind/attach': {
    auth: 'unwind',
    exactFields: UNWIND_ATTACH_FIELDS,
    noStore: true,
  },
  'POST /mandate/status': { auth: 'mandate' },
  'POST /mandate/revoke': { auth: 'mandate', cookieIssue: 'revoke' },
  'POST /farm': { auth: 'mandate', exactFields: FARM_FIELDS },
  'POST /farm/attach': { auth: 'mandate', needsJob: true, exactFields: FARM_ATTACH_FIELDS },
  'POST /status': { auth: 'mandateOrJob', unwindFields: UNWIND_STATUS_FIELDS, noStore: true },
}

function subPath(url) {
  const pathname = new URL(url, 'http://local').pathname
  const i = pathname.indexOf('/api/vf-cross')
  return (i >= 0 ? pathname.slice(i + '/api/vf-cross'.length) : pathname) || '/'
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function capabilityCookieName(kind, id) {
  return `__Host-vf-${kind}-${id}`
}

// Resolve the canonical public identity a fixed-path request is allowed to act on. Returns
// { kind: 'mandate'|'unwind', id } or null when the body does not name exactly one canonical
// identity for this route — the caller rejects generically before any upstream state leak.
function canonicalIdentityFor(route, body) {
  if (!body || typeof body !== 'object') return null
  const { mandateId, jobId } = body
  const mandateOk = CANONICAL_ID.test(mandateId)
  const jobOk = CANONICAL_ID.test(jobId)
  if (route.needsJob && !jobOk) return null
  if (route.auth === 'mandate') return mandateOk ? { kind: 'mandate', id: mandateId } : null
  if (route.auth === 'unwind') return jobOk ? { kind: 'unwind', id: jobId } : null
  if (route.auth === 'mandateOrJob') {
    if (mandateId !== undefined) {
      return mandateOk && jobOk ? { kind: 'mandate', id: mandateId } : null
    }
    return jobOk ? { kind: 'unwind', id: jobId } : null
  }
  return null
}

function hasExactFields(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const keys = Object.keys(body)
  return keys.length === fields.length && keys.every((key) => fields.includes(key))
}

function isValidUnwindBody(path, body) {
  if (path === '/farm')
    return (
      hasExactFields(body, FARM_FIELDS) &&
      CANONICAL_ID.test(body.requestId) &&
      CANONICAL_ID.test(body.mandateId) &&
      Array.isArray(body.allocations)
    )
  if (path === '/farm/attach')
    return (
      hasExactFields(body, FARM_ATTACH_FIELDS) &&
      CANONICAL_ID.test(body.mandateId) &&
      CANONICAL_ID.test(body.jobId) &&
      /^[0-9a-f]{64}$/.test(body.burnTxHash)
    )
  if (path === '/unwind') {
    return (
      hasExactFields(body, UNWIND_RESERVE_FIELDS) &&
      CANONICAL_ID.test(body.jobId) &&
      CANONICAL_CAPABILITY.test(body.capability) &&
      CANONICAL_EVM_ADDRESS.test(body.kernelAddress) &&
      typeof body.recipientHint === 'string'
    )
  }
  if (path === '/unwind/attach') {
    return (
      hasExactFields(body, UNWIND_ATTACH_FIELDS) &&
      CANONICAL_ID.test(body.jobId) &&
      CANONICAL_EVM_HASH.test(body.userOpHash) &&
      CANONICAL_EVM_HASH.test(body.unwindTxHash)
    )
  }
  return hasExactFields(body, UNWIND_STATUS_FIELDS) && CANONICAL_ID.test(body.jobId)
}

// Select the ONE cookie named by the validated public identity. Unrelated cookies are ignored;
// zero or duplicate occurrences, or a noncanonical capability value, fail closed.
function parseCapabilityCookies(rawCookieHeader, exactName) {
  const matches = []
  for (const part of String(rawCookieHeader || '').split(';')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    if (trimmed.slice(0, eq) === exactName) matches.push(trimmed.slice(eq + 1))
  }
  if (matches.length !== 1) return null
  const [value] = matches
  return CANONICAL_CAPABILITY.test(value) ? value : null
}

// Validate the single upstream Set-Cookie against the exact capability-cookie contract:
// `__Host-` semantics (Secure, HttpOnly, SameSite=Strict, Path=/, no Domain, no other
// attributes), a canonical 64-hex capability with a bounded positive Max-Age for issue, or the
// exact empty-value Max-Age=0 clear form for revoke. Anything else is rejected, never
// forwarded "best effort".
function validateUpstreamSetCookie(setCookie, { kind, id, issue, expectedCapability }) {
  if (typeof setCookie !== 'string') return false
  const parts = setCookie.split(';').map((part) => part.trim())
  const [nameValue, ...attrs] = parts
  const eq = nameValue.indexOf('=')
  if (eq <= 0) return false
  if (nameValue.slice(0, eq) !== capabilityCookieName(kind, id)) return false
  const value = nameValue.slice(eq + 1)
  if (attrs.length !== 5 || new Set(attrs).size !== attrs.length) return false
  const fixed = ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']
  if (!fixed.every((attr) => attrs.includes(attr))) return false
  const maxAge = attrs.find((attr) => !fixed.includes(attr))
  const ageMatch = /^Max-Age=(\d+)$/.exec(maxAge || '')
  if (!ageMatch) return false
  const age = Number(ageMatch[1])
  if (issue === 'revoke') return value === '' && age === 0
  return (
    CANONICAL_CAPABILITY.test(value) &&
    (expectedCapability === undefined || value === expectedCapability) &&
    age >= 1 &&
    age <= MAX_CAPABILITY_AGE_SECONDS
  )
}

export default async function handler(req, res, { fetchImpl = fetch } = {}) {
  const path = subPath(req.url)
  const route = ROUTES[`${req.method} ${path}`]
  if (route?.noStore) res.setHeader('Cache-Control', 'no-store')

  if (!applyCors(req, res)) return
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    return res.end('')
  }
  if (!rateLimit(req, res, { max: 30, windowMs: 60_000, bucket: 'vf-cross' })) return

  if (new URL(req.url, 'http://local').search)
    return sendJson(res, 400, { error: 'invalid request' })
  if (!route) return sendJson(res, 404, { error: 'not found' })

  const origin = process.env.RELAYER_ORIGIN
  if (!origin) return sendJson(res, 503, { error: 'relayer not configured' })

  // Registration must name the mandate its cookie will be bound to; protected routes must name
  // exactly one canonical public identity. Malformed or missing identity is refused locally with
  // the same generic response whether or not such a mandate/job exists upstream.
  let body = req.method === 'GET' || req.method === 'HEAD' ? null : (req.body ?? null)
  if (
    (route.exactFields && !isValidUnwindBody(path, body)) ||
    (route.unwindFields && body?.mandateId === undefined && !isValidUnwindBody(path, body))
  ) {
    return sendJson(res, 400, { error: 'invalid request' })
  }
  if (path === '/unwind') body = { ...body, kernelAddress: body.kernelAddress.toLowerCase() }
  let identity = null
  if (route.cookieIssue === 'register') {
    const kind = route.cookieKind ?? 'mandate'
    const id = kind === 'unwind' ? body?.jobId : body?.mandateId
    if (!CANONICAL_ID.test(id)) {
      return sendJson(res, 400, { error: 'invalid request' })
    }
    identity = { kind, id }
  } else if (route.auth) {
    identity = canonicalIdentityFor(route, body)
    if (!identity) return sendJson(res, 400, { error: 'invalid request' })
  }

  // Cookie -> Bearer translation. The browser's own Cookie/Authorization headers never cross;
  // only the capability from the cookie named by the validated identity is injected upstream. A
  // request carrying NO Cookie header at all forwards without authority (the relayer itself
  // fails closed on it); a request carrying cookies that do not yield exactly one canonical
  // matching capability is refused locally — wrong/duplicate/forged capability material never
  // reaches the tunnel.
  let capability = null
  if (route.auth) {
    const rawCookie = req.headers?.cookie
    if (rawCookie !== undefined) {
      capability = parseCapabilityCookies(
        rawCookie,
        capabilityCookieName(identity.kind, identity.id)
      )
      if (!capability) return sendJson(res, 401, { error: 'unauthorized' })
    } else if (identity.kind === 'unwind') {
      return sendJson(res, 401, { error: 'unauthorized' })
    }
  }

  const init = {
    method: req.method,
    headers: {
      'content-type': 'application/json',
      'x-vf-relayer-key': process.env.RELAYER_PROXY_KEY || '',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }
  if (capability) init.headers.authorization = `Bearer ${capability}`
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = JSON.stringify(body ?? {})

  let upstream
  let text
  try {
    upstream = await fetchImpl(`${origin.replace(/\/$/, '')}/api/vf-cross${path}`, init)
    text = await upstream.text()
  } catch {
    // Never leak upstream/tunnel details to the browser.
    return sendJson(res, 502, { error: 'relayer unreachable' })
  }

  // Set-Cookie contract: exactly one cookie, only on a cookie-issuing route, matching the exact
  // validated form for THIS request's identity — zero/ambiguous/foreign cookies fail closed.
  const setCookies =
    typeof upstream.headers?.getSetCookie === 'function' ? upstream.headers.getSetCookie() : []
  if (setCookies.length > 0) {
    const valid =
      route.cookieIssue &&
      setCookies.length === 1 &&
      validateUpstreamSetCookie(setCookies[0], {
        kind: identity?.kind,
        id: identity?.id,
        issue: route.cookieIssue,
        // Unwind capability bytes are browser-generated and immediately erased after reserve.
        // The upstream cookie must preserve that exact authority or the durable job is orphaned.
        // Mandate registration retains its existing server-issued cookie semantics.
        expectedCapability:
          identity?.kind === 'unwind' && route.cookieIssue === 'register'
            ? body?.capability
            : undefined,
      })
    if (!valid) return sendJson(res, 502, { error: 'relayer response rejected' })
  }
  // A 202 registration is only meaningful WITH its capability cookie installed.
  if (route.cookieIssue === 'register' && upstream.status === 202 && setCookies.length !== 1) {
    return sendJson(res, 502, { error: 'relayer response rejected' })
  }
  // Never reflect a capability echoed back in an upstream body.
  const requestCapability = capability ?? body?.capability
  if (requestCapability && text.includes(requestCapability)) {
    return sendJson(res, 502, { error: 'relayer response rejected' })
  }

  // Upstream error bodies/headers are untrusted: forward the status with a generic body rather
  // than reflecting whatever the tunnel sent back.
  if (upstream.status >= 400) {
    return sendJson(res, upstream.status, { error: 'relayer request failed' })
  }
  res.statusCode = upstream.status
  res.setHeader('Content-Type', 'application/json')
  if (setCookies.length === 1) res.setHeader('Set-Cookie', setCookies[0])
  return res.end(text || '{}')
}

export const _test = {
  subPath,
  canonicalIdentityFor,
  parseCapabilityCookies,
  validateUpstreamSetCookie,
  capabilityCookieName,
}
