// Shared guard for the serverless API proxies (ai / relay / search / cross-chain / index).
// Files prefixed with `_` are import-only.

const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:4173',
  'http://localhost:8788',
]

const _buckets = new Map() // key → { count, resetAt }
const MAX_BUCKETS = 5000

function hasPagesEnv(req) {
  return req?.env !== undefined && req?.env !== null && typeof req.env === 'object'
}

function runtimeEnv(req) {
  return hasPagesEnv(req) ? req.env : process.env
}

function runtimeValue(req, key, fallback = '') {
  const env = runtimeEnv(req)
  if (Object.prototype.hasOwnProperty.call(env, key)) return env[key]
  return fallback
}

function isProductionRuntime(req) {
  const nodeEnv = String(runtimeValue(req, 'NODE_ENV', '')).toLowerCase()
  const vercelEnv = String(runtimeValue(req, 'VERCEL_ENV', '')).toLowerCase()
  return nodeEnv === 'production' || nodeEnv === 'staging' || vercelEnv === 'production'
}

/** Return the request-local origin allowlist; never reuse a prior Pages request's env. */
export function allowedOrigins(req) {
  const rawOrigins = runtimeValue(req, 'ALLOWED_ORIGIN', '')
  const fromEnv = String(rawOrigins || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  return [...(isProductionRuntime(req) ? [] : DEV_ORIGINS), ...fromEnv]
}

function allowedExtensionOrigins(req) {
  return new Set(
    String(runtimeValue(req, 'ALLOWED_EXTENSION_ORIGINS', '') || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  )
}

function sendServiceUnavailable(res) {
  res.statusCode = 503
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ error: 'Rate limit unavailable' }))
}

/**
 * Cloudflare's CF-Connecting-IP is authoritative in Pages mode. Plain Vite/Node mode retains
 * the existing x-real-ip/XFF/socket order because those requests do not have a Pages binding.
 */
export function clientIp(req) {
  const headers = req?.headers || {}
  if (hasPagesEnv(req)) {
    const cf = headers['cf-connecting-ip'] ?? headers['CF-Connecting-IP']
    if (typeof cf !== 'string' || !isValidIp(cf)) return null
    return cf.trim()
  }

  const real = headers['x-real-ip']
  if (typeof real === 'string' && isValidIp(real)) return real.trim()

  const rawHops = runtimeValue(req, 'TRUST_PROXY_HOPS', '1')
  const trustedHops = Number(rawHops)
  const xff = headers['x-forwarded-for']
  if (Number.isSafeInteger(trustedHops) && trustedHops > 0 && typeof xff === 'string') {
    const parts = xff
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
    if (parts.length) {
      const idx = parts.length - trustedHops
      const candidate = parts[idx >= 0 ? idx : 0]
      if (isValidIp(candidate)) return candidate
    }
  }

  const socket = req?.socket?.remoteAddress
  return typeof socket === 'string' && socket.trim() ? socket.trim() : 'unknown'
}

function isValidIp(value) {
  const ip = String(value || '').trim()
  const hasUnsafeCharacter = [...ip].some((char) => {
    const code = char.charCodeAt(0)
    return /\s/.test(char) || code <= 31 || code === 127 || char === ','
  })
  if (!ip || ip !== value || hasUnsafeCharacter) return false
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    return ip.split('.').every((part) => Number(part) <= 255)
  }
  if (!ip.includes(':')) return false
  const compression = ip.indexOf('::')
  if (compression !== -1 && compression !== ip.lastIndexOf('::')) return false
  const groups = ip.split(':')
  if (compression !== -1) {
    // A compressed address must omit at least one 16-bit group. IPv4-mapped forms are accepted
    // after validating their dotted tail as four bytes.
    const nonEmpty = groups.filter(Boolean)
    if (nonEmpty.length > 7) return false
    return nonEmpty.every((group, index) => {
      if (group.includes('.')) {
        return index === nonEmpty.length - 1 && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(group)
      }
      return /^[0-9a-f]{1,4}$/i.test(group)
    })
  }
  if (groups.length !== 8) return false
  return groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))
}

/**
 * Enforce the origin allowlist and set CORS headers.
 * @returns {boolean} true if allowed (headers set), false if rejected (403 already sent)
 */
export function applyCors(req, res) {
  const headers = req?.headers || {}
  // Browsers omit Origin on same-origin GETs; use Referer's origin for that browser case. A
  // malformed Referer is intentionally not treated as a same-origin hint.
  let origin = headers.origin || ''
  if (!origin && headers.referer) {
    try {
      origin = new URL(headers.referer).origin
    } catch {
      origin = ''
    }
  }
  const isAllowed = allowedOrigins(req).includes(origin) || allowedExtensionOrigins(req).has(origin)
  if (!isAllowed) {
    res.statusCode = 403
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: 'Forbidden' }))
    return false
  }
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Methods', 'POST')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  return true
}

function prune(now) {
  for (const [key, value] of _buckets) {
    if (now >= value.resetAt) _buckets.delete(key)
  }
}

/**
 * Per-IP in-memory fixed-window limit for non- Pages local development and legacy APIs. Durable
 * cross-chain/Agent Index routes use api/durableRateLimit.js instead.
 * @returns {boolean} true if within limit, false if rejected (429/503 already sent)
 */
export function rateLimit(req, res, { max = 30, windowMs = 60_000, bucket = 'default' } = {}) {
  const ip = clientIp(req)
  if (ip === null) {
    sendServiceUnavailable(res)
    return false
  }
  const now = Date.now()
  if (_buckets.size > MAX_BUCKETS) prune(now)
  const key = `${bucket}:${ip}`
  const entry = _buckets.get(key)
  if (!entry || now >= entry.resetAt) {
    _buckets.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (entry.count >= max) {
    const retry = Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
    res.statusCode = 429
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Retry-After', String(retry))
    res.end(JSON.stringify({ error: 'Too many requests' }))
    return false
  }
  entry.count += 1
  return true
}

export const _test = { hasPagesEnv, runtimeEnv, runtimeValue, isValidIp }
