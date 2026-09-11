// Gateway auth. The Bearer vf_ key IS the authentication — no Origin requirement
// (third-party servers send no Origin). CORS allow-all on vf endpoints is set by
// the router; abuse is bounded per-key + per-scope-global + per-owner-fairness here.
import { verifyKey } from './_keystore.js'
import { verifyJwt } from './_jwt.js'

export const WINDOW_MS = 60_000
const DAY_MS = 86_400_000

const send = (res, status, obj, headers = {}) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  res.end(JSON.stringify(obj))
  return null
}

const bearer = (req) => {
  const h = req.headers?.authorization || ''
  return h.startsWith('Bearer ') ? h.slice(7).trim() : ''
}

// Sentinel log for gateway gate hits. Attributes public routing facts only
// (gate kind, scope, bucket, key id, portal owner address) - NEVER the Bearer
// token, JWT claims, or any secret payload.
const gateEvent = (kind, detail) => {
  try {
    console.warn('[vf-gateway] ' + kind + ' ' + detail)
  } catch {}
}

// Seconds until the next UTC midnight - the Retry-After for daily-budget 503s.
const retryAfterDay = (nowMs, dayStart) =>
  String(Math.max(1, Math.ceil((dayStart + DAY_MS - nowMs) / 1000)))

export async function requireVfKey(
  req,
  res,
  store,
  { scope, endpoint = scope, nowMs = Date.now() }
) {
  const token = bearer(req)
  if (!token) return send(res, 401, { error: 'Missing API key' })
  const v = await verifyKey(store, token, nowMs)
  if (!v.ok) return send(res, 401, { error: 'Invalid API key' }) // reason not echoed
  if (!v.scopes.includes(scope)) return send(res, 403, { error: 'Out of scope' })

  const windowStart = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS
  const count = await store.counters.bump(v.keyId, windowStart)
  if (count > v.rateLimit) {
    const retry = Math.ceil((windowStart + WINDOW_MS - nowMs) / 1000)
    gateEvent('429', 'per-key scope=' + scope + ' keyId=' + v.keyId)
    return send(res, 429, { error: 'Too many requests' }, { 'Retry-After': String(retry) })
  }

  const day = new Date(nowMs).toISOString().slice(0, 10)
  const dayStart = Date.parse(day)

  // Owner-first: the per-owner check runs BEFORE the shared global bump, so a
  // request already over its owner cap returns 503 without burning the budget
  // shared with all other owners. Owner here is the portal identity (public
  // Stellar address) - not a secret. Default 1000 reqs/owner/scope/day via
  // VF_OWNER_DAILY_CAP.
  const ownerCap = Number(process.env.VF_OWNER_DAILY_CAP || 1000)
  const ownerCount = await store.counters.bump(`__owner:${scope}:${v.owner}`, dayStart)
  if (ownerCount > ownerCap) {
    gateEvent('503', 'owner-budget scope=' + scope + ' owner=' + v.owner)
    return send(
      res,
      503,
      { error: 'Daily budget exhausted' },
      { 'Retry-After': retryAfterDay(nowMs, dayStart) }
    )
  }

  // Tradeoff: once the global cap below is exhausted, requests still consume owner budget first — harmless since both counters reset at the same dayStart.
  const cap = Number(process.env.VF_GLOBAL_DAILY_CAP || 5000)
  const globalCount = await store.counters.bump(`__global:${scope}`, dayStart)
  if (globalCount > cap) {
    gateEvent('503', 'daily-budget scope=' + scope)
    return send(
      res,
      503,
      { error: 'Daily budget exhausted' },
      { 'Retry-After': retryAfterDay(nowMs, dayStart) }
    )
  }

  await store.usage.log(v.keyId, day, endpoint)
  await store.keys.touch(v.keyId, Math.floor(nowMs / 1000))
  // lazy prune: drop windows older than 2 windows (keeps daily __global rows)
  await store.counters.pruneBefore(
    windowStart - 2 * WINDOW_MS > dayStart ? dayStart : windowStart - 2 * WINDOW_MS
  )
  return { keyId: v.keyId, scopes: v.scopes }
}

// Per-session (JWT sub) in-memory fixed-window throttle for portal key-management
// and usage reads. Deliberately in-memory rather than durable: portal traffic is
// low-volume and human-driven; the durable tiers stay reserved for gateway/data
// paths. Callers opt in via { max, windowMs, bucket }; omitted max = no throttle
// (backwards compatible with existing callers).
const JWT_WINDOW_MS = 60_000
const _jwtBuckets = new Map()
const MAX_JWT_BUCKETS = 5000

function jwtThrottle(res, sub, { max, windowMs, bucket }, nowMs) {
  if (_jwtBuckets.size > MAX_JWT_BUCKETS) {
    for (const [k, v] of _jwtBuckets) if (nowMs >= v.resetAt) _jwtBuckets.delete(k)
  }
  const key = bucket + ':' + sub
  const entry = _jwtBuckets.get(key)
  if (!entry || nowMs >= entry.resetAt) {
    _jwtBuckets.set(key, { count: 1, resetAt: nowMs + windowMs })
    return true
  }
  if (entry.count >= max) {
    const retry = Math.max(1, Math.ceil((entry.resetAt - nowMs) / 1000))
    gateEvent('429', 'jwt-session bucket=' + bucket + ' sub=' + sub)
    send(res, 429, { error: 'Too many requests' }, { 'Retry-After': String(retry) })
    return false
  }
  entry.count += 1
  return true
}

export async function requireJwt(
  req,
  res,
  { max, windowMs = JWT_WINDOW_MS, bucket = 'vf-jwt' } = {}
) {
  const secret = process.env.VF_JWT_SECRET
  if (!secret) return send(res, 503, { configured: false, error: 'Portal auth not configured' })
  const payload = await verifyJwt(bearer(req), secret)
  if (!payload?.sub) return send(res, 401, { error: 'Invalid session' })
  if (max != null && !jwtThrottle(res, payload.sub, { max, windowMs, bucket }, Date.now()))
    return null
  return payload
}
