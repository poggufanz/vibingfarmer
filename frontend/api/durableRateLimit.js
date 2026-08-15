import { clientIp, rateLimit } from './_guard.js'

const WINDOW_MS = 60_000

export const EDGE_LIMITS = Object.freeze({
  strictWrite: Object.freeze({ max: 30, windowMs: WINDOW_MS }),
  authenticatedStatus: Object.freeze({ max: 120, windowMs: WINDOW_MS }),
  publicRead: Object.freeze({ max: 240, windowMs: WINDOW_MS }),
})

const VF_CROSS_TIERS = new Map([
  ['GET /', EDGE_LIMITS.publicRead],
  ['GET /config', EDGE_LIMITS.publicRead],
  ['POST /mandate', EDGE_LIMITS.strictWrite],
  ['POST /mandate/status', EDGE_LIMITS.authenticatedStatus],
  ['POST /mandate/revoke', EDGE_LIMITS.strictWrite],
  ['POST /farm', EDGE_LIMITS.strictWrite],
  ['POST /farm/attach', EDGE_LIMITS.strictWrite],
  ['POST /farm/recover', EDGE_LIMITS.strictWrite],
  ['POST /status', EDGE_LIMITS.authenticatedStatus],
  ['POST /unwind', EDGE_LIMITS.strictWrite],
  ['POST /unwind/attach', EDGE_LIMITS.strictWrite],
])

const AGENT_INDEX_CROSS_TIERS = new Map([
  ['POST base-child-intent-batch', EDGE_LIMITS.strictWrite],
  ['POST base-child-evidence', EDGE_LIMITS.strictWrite],
  ['GET base-child-evidence', EDGE_LIMITS.publicRead],
  ['POST base-recovery-request', EDGE_LIMITS.strictWrite],
  ['POST base-recovery-claim', EDGE_LIMITS.strictWrite],
  ['POST base-recovery-renew', EDGE_LIMITS.strictWrite],
  ['POST base-recovery-release', EDGE_LIMITS.strictWrite],
  ['POST lease-acquire', EDGE_LIMITS.strictWrite],
  ['POST lease-release', EDGE_LIMITS.strictWrite],
  ['POST associate', EDGE_LIMITS.strictWrite],
  ['POST base-child-ready', EDGE_LIMITS.publicRead],
])

function hasPagesEnv(req) {
  return req?.env !== undefined && req?.env !== null && typeof req.env === 'object'
}

function runtimeValue(req, key, fallback = '') {
  if (hasPagesEnv(req)) {
    return Object.prototype.hasOwnProperty.call(req.env, key) ? req.env[key] : fallback
  }
  return process.env[key] ?? fallback
}

function productionRuntime(req) {
  const nodeEnv = String(runtimeValue(req, 'NODE_ENV', '')).toLowerCase()
  const vercelEnv = String(runtimeValue(req, 'VERCEL_ENV', '')).toLowerCase()
  return nodeEnv === 'production' || nodeEnv === 'staging' || vercelEnv === 'production'
}

function sendUnavailable(res) {
  res.statusCode = 503
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ error: 'Rate limit unavailable' }))
}

function policyFor(tier, bucket) {
  return { max: tier.max, windowMs: tier.windowMs, bucket }
}

export function resolveVfCrossLimit({ method, path }) {
  const key = `${method} ${path}`
  const tier = VF_CROSS_TIERS.get(key)
  return tier ? policyFor(tier, `vf-cross:${key}`) : null
}

export function resolveAgentIndexCrossLimit({ method, action }) {
  const key = `${method} ${action}`
  const tier = AGENT_INDEX_CROSS_TIERS.get(key)
  return tier ? policyFor(tier, `agent-index:${key}`) : null
}

// D1/SQLite both support this one-statement race boundary. Do not split this into SELECT then
// UPDATE: competing requests must each receive their own atomically incremented count.
export const RATE_LIMIT_UPSERT_SQL = `
  INSERT INTO vf_cross_rate_limits
    (route_bucket, client_ip, window_start_ms, request_count, updated_at_ms)
  VALUES (?, ?, ?, 1, ?)
  ON CONFLICT(route_bucket, client_ip) DO UPDATE SET
    window_start_ms = CASE
      WHEN excluded.window_start_ms > vf_cross_rate_limits.window_start_ms
      THEN excluded.window_start_ms
      ELSE vf_cross_rate_limits.window_start_ms
    END,
    request_count = CASE
      WHEN excluded.window_start_ms > vf_cross_rate_limits.window_start_ms
      THEN 1
      ELSE vf_cross_rate_limits.request_count + 1
    END,
    updated_at_ms = MAX(vf_cross_rate_limits.updated_at_ms, excluded.updated_at_ms)
  RETURNING route_bucket, client_ip, window_start_ms, request_count, updated_at_ms
`

function requestOptions(options = {}) {
  const max = Number(options.max)
  const windowMs = Number(options.windowMs)
  const bucket = String(options.bucket || 'default')
  if (!Number.isSafeInteger(max) || max < 1) throw new Error('invalid rate limit max')
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new Error('invalid rate limit window')
  if (!bucket || bucket.length > 256) throw new Error('invalid rate limit bucket')
  return { max, windowMs, bucket }
}

function validCounterRow(row, expected = {}) {
  if (
    !(
      row &&
      typeof row.route_bucket === 'string' &&
      typeof row.client_ip === 'string' &&
      Number.isSafeInteger(Number(row.window_start_ms)) &&
      Number(row.window_start_ms) >= 0 &&
      Number.isSafeInteger(Number(row.request_count)) &&
      Number(row.request_count) >= 1 &&
      Number.isSafeInteger(Number(row.updated_at_ms)) &&
      Number(row.updated_at_ms) >= 0
    )
  )
    return false

  const windowStartMs = Number(row.window_start_ms)
  const requestCount = Number(row.request_count)
  const updatedAtMs = Number(row.updated_at_ms)
  const hasExistingIncrement = requestCount >= 2
  if (expected.bucket !== undefined && row.route_bucket !== expected.bucket) return false
  if (expected.ip !== undefined && row.client_ip !== expected.ip) return false
  if (
    expected.nowMs !== undefined &&
    updatedAtMs !== expected.nowMs &&
    !(updatedAtMs > expected.nowMs && hasExistingIncrement)
  )
    return false
  if (expected.windowStartMs !== undefined) {
    // A strictly newer request starts a new window. A clock rollback may legitimately return an
    // existing newer window, but only after the atomic upsert incremented that row (never a fresh
    // count-one row from an unexpected future window).
    const isRequestedWindow = windowStartMs === expected.windowStartMs
    const isExistingNewerWindow = windowStartMs > expected.windowStartMs && requestCount >= 2
    if (!isRequestedWindow && !isExistingNewerWindow) return false
  }
  if (expected.windowMs !== undefined && windowStartMs % expected.windowMs !== 0) return false
  return true
}

/**
 * Construct an async durable limiter. `memoryLimit` is a seam only for plain non-production Vite
 * development; any Pages request or production/staging runtime without VF_DB fails closed.
 */
export function createDurableRateLimiter({ now = Date.now, memoryLimit = rateLimit } = {}) {
  return async function durableRateLimit(req, res, options = {}) {
    let policy
    try {
      policy = requestOptions(options)
    } catch {
      sendUnavailable(res)
      return false
    }

    const ip = clientIp(req)
    if (ip === null) {
      sendUnavailable(res)
      return false
    }

    const db = hasPagesEnv(req) ? req.env?.VF_DB : process.env.VF_DB
    if (!db) {
      if (hasPagesEnv(req) || productionRuntime(req)) {
        sendUnavailable(res)
        return false
      }
      return Boolean(await memoryLimit(req, res, policy))
    }

    const nowMs = Number(now())
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      sendUnavailable(res)
      return false
    }
    const windowStartMs = Math.floor(nowMs / policy.windowMs) * policy.windowMs
    let row
    try {
      row = await db
        .prepare(RATE_LIMIT_UPSERT_SQL)
        .bind(policy.bucket, ip, windowStartMs, nowMs)
        .first()
      if (
        !validCounterRow(row, {
          bucket: policy.bucket,
          ip,
          windowStartMs,
          nowMs,
          windowMs: policy.windowMs,
        })
      )
        throw new Error('malformed rate-limit row')
    } catch {
      sendUnavailable(res)
      return false
    }

    const count = Number(row.request_count)
    if (count > policy.max) {
      const resetAtMs = Number(row.window_start_ms) + policy.windowMs
      const retryAfter = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000))
      res.statusCode = 429
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Retry-After', String(retryAfter))
      res.end(JSON.stringify({ error: 'Too many requests' }))
      return false
    }
    return true
  }
}

export const durableRateLimit = createDurableRateLimiter()

export const _test = {
  hasPagesEnv,
  runtimeValue,
  productionRuntime,
  validCounterRow,
  requestOptions,
}
