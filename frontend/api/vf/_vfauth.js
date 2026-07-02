// Gateway auth. The Bearer vf_ key IS the authentication — no Origin requirement
// (third-party servers send no Origin). CORS allow-all on vf endpoints is set by
// the router; abuse is bounded per-key + per-scope-global here.
import { verifyKey } from './_keystore.js'
import { verifyJwt } from './_jwt.js'

export const WINDOW_MS = 60_000

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
    return send(res, 429, { error: 'Too many requests' }, { 'Retry-After': String(retry) })
  }

  const day = new Date(nowMs).toISOString().slice(0, 10)
  const dayStart = Date.parse(day)
  const cap = Number(process.env.VF_GLOBAL_DAILY_CAP || 5000)
  const globalCount = await store.counters.bump(`__global:${scope}`, dayStart)
  if (globalCount > cap) return send(res, 503, { error: 'Daily budget exhausted' })

  await store.usage.log(v.keyId, day, endpoint)
  await store.keys.touch(v.keyId, Math.floor(nowMs / 1000))
  // lazy prune: drop windows older than 2 windows (keeps daily __global rows)
  await store.counters.pruneBefore(
    windowStart - 2 * WINDOW_MS > dayStart ? dayStart : windowStart - 2 * WINDOW_MS
  )
  return { keyId: v.keyId, scopes: v.scopes }
}

export async function requireJwt(req, res) {
  const secret = process.env.VF_JWT_SECRET
  if (!secret) return send(res, 503, { configured: false, error: 'Portal auth not configured' })
  const payload = await verifyJwt(bearer(req), secret)
  if (!payload?.sub) return send(res, 401, { error: 'Invalid session' })
  return payload
}
