// Shared guard for the serverless API proxies (ai / relay / search).
// Files prefixed with `_` are NOT routed by Vercel — import-only.
//
// Two layers:
//   1. Origin allowlist — localhost dev origins trusted ONLY outside production;
//      prod origins come from ALLOWED_ORIGIN env so the deployed bundle never
//      trusts localhost.
//   2. In-memory rate limit — the Origin header is browser-enforced, not
//      attacker-enforced (curl forges it trivially), so the allowlist is NOT
//      authentication. A per-IP fixed-window cap blunts forged-Origin abuse:
//      cost drain on the DeepSeek/Tavily keys, gas-drain DoS on the funded
//      1Shot relayer wallet. Best-effort: state is per warm process.

const isProd =
  process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production'

const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:4173',
]

export function allowedOrigins() {
  const fromEnv = process.env.ALLOWED_ORIGIN
    ? process.env.ALLOWED_ORIGIN.split(',').map((o) => o.trim())
    : []
  return [...(isProd ? [] : DEV_ORIGINS), ...fromEnv].filter(Boolean)
}

/**
 * Enforce the origin allowlist and set CORS headers.
 * @returns {boolean} true if allowed (headers set), false if rejected (403 already sent)
 */
export function applyCors(req, res) {
  const origin = req.headers.origin || ''
  if (!allowedOrigins().includes(origin)) {
    res.statusCode = 403
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: 'Forbidden' }))
    return false
  }
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'POST')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  return true
}

// ─── In-memory fixed-window rate limit (per warm process) ───
const _buckets = new Map() // key → { count, resetAt }
const MAX_BUCKETS = 5000

// How many TRUSTED proxies sit in front of this process and APPEND to XFF.
// Default 1 (a single platform edge, e.g. Vercel). The first (leftmost) XFF
// entries are client-supplied and forgeable — trusting them lets an attacker
// mint a fresh rate-limit bucket per request. We instead read from the RIGHT.
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS ?? 1)

function clientIp(req) {
  // 1. Platform-guaranteed connecting IP. Vercel/most PaaS set `x-real-ip` to the
  //    real client and it is NOT an appendable chain, so a forged value can't hide
  //    behind it. Prefer it outright.
  const real = req.headers['x-real-ip']
  if (typeof real === 'string' && real.trim()) return real.trim()

  // 2. Raw XFF: trusted proxies append the true connecting IP to the RIGHT; an
  //    external attacker can only inject entries on the LEFT. Pick the entry the
  //    n-th trusted hop observed, counting from the right, so the spoofed prefix
  //    is ignored. With one edge this is simply the last entry.
  const xff = req.headers['x-forwarded-for']
  if (TRUST_PROXY_HOPS > 0 && typeof xff === 'string' && xff.trim()) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean)
    if (parts.length) {
      const idx = parts.length - TRUST_PROXY_HOPS
      return parts[idx >= 0 ? idx : 0]
    }
  }

  // 3. No trusted proxy headers — fall back to the socket peer.
  return req.socket?.remoteAddress || 'unknown'
}

function prune(now) {
  for (const [k, v] of _buckets) {
    if (now >= v.resetAt) _buckets.delete(k)
  }
}

/**
 * Per-IP fixed-window limit. Sends 429 + Retry-After when exceeded.
 * @returns {boolean} true if within limit, false if rejected (429 already sent)
 */
export function rateLimit(req, res, { max = 30, windowMs = 60_000, bucket = 'default' } = {}) {
  const now = Date.now()
  if (_buckets.size > MAX_BUCKETS) prune(now)
  const key = `${bucket}:${clientIp(req)}`
  const entry = _buckets.get(key)
  if (!entry || now >= entry.resetAt) {
    _buckets.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (entry.count >= max) {
    const retry = Math.ceil((entry.resetAt - now) / 1000)
    res.statusCode = 429
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Retry-After', String(retry))
    res.end(JSON.stringify({ error: 'Too many requests' }))
    return false
  }
  entry.count += 1
  return true
}
