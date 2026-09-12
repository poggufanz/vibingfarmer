// Key CRUD — JWT-gated (portal session), NOT vf-key-gated.
import { z } from 'zod'
import { storeFrom } from './_db.js'
import { requireJwt } from './_vfauth.js'
import { issueKey, revokeKey, SCOPES } from './_keystore.js'

const json = (res, status, obj, headers = {}) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  res.end(JSON.stringify(obj))
}

// Issuance policy (anti self-mint amplification: rateLimit x N keys is no longer
// unbounded - N itself is capped and issuance is throttled):
// - At most VF_MAX_KEYS_PER_OWNER active keys per owner (default 10). Over the
//   cap -> 403 { error: 'Key limit reached' } (quota, not a rate: no Retry-After).
// - The self-chosen per-minute rateLimit is capped per scope sensitivity: market
//   data may burst to 600, but execution-sensitive scopes are lower, and a
//   multi-scope key is bound by its strictest scope. Over the cap -> 400
//   (unchanged success/error contract).
// - Per-session issuance throttles (in-memory; portal traffic is human-driven):
//   POST /keys 10/min, DELETE /keys 30/min, GET /keys 60/min -> 429 + Retry-After.
const SCOPE_RATE_CAP = { market: 600, strategy: 120, tx: 120, scan: 120, submit: 60 }
const ISSUE_THROTTLE = { max: 10, bucket: 'vf-keys-issue' }
const REVOKE_THROTTLE = { max: 30, bucket: 'vf-keys-revoke' }
const LIST_THROTTLE = { max: 60, bucket: 'vf-keys-list' }

const maxKeysPerOwner = () => {
  const n = Number(process.env.VF_MAX_KEYS_PER_OWNER || 10)
  return Number.isSafeInteger(n) && n >= 1 ? n : 10
}

const IssueSchema = z.object({
  scopes: z.array(z.enum(SCOPES)).nonempty(),
  env: z.enum(['test', 'live']),
  rateLimit: z.number().int().min(1).max(600).default(60),
  expiresAt: z.number().int().positive().nullable().default(null),
})

export async function listKeys(req, res) {
  const session = await requireJwt(req, res, LIST_THROTTLE)
  if (!session) return
  json(res, 200, { keys: await storeFrom(req).keys.list(session.sub) })
}

export async function createKey(req, res) {
  const session = await requireJwt(req, res, ISSUE_THROTTLE)
  if (!session) return
  const parsed = IssueSchema.safeParse(req.body ?? {})
  if (!parsed.success) return json(res, 400, { error: 'Invalid key request' })
  const { scopes, env, rateLimit, expiresAt } = parsed.data
  const scopeCap = Math.min(...scopes.map((s) => SCOPE_RATE_CAP[s] ?? 60))
  if (rateLimit > scopeCap) return json(res, 400, { error: 'Invalid key request' })
  const store = storeFrom(req)
  const active = (await store.keys.list(session.sub)).filter((k) => k.enabled).length
  if (active >= maxKeysPerOwner()) return json(res, 403, { error: 'Key limit reached' })
  const out = await issueKey(store, {
    owner: session.sub,
    scopes,
    rateLimit,
    env,
    expiresAt,
  })
  json(res, 200, out) // { id, key (ONLY time plaintext leaves the server), hint }
}

export async function deleteKey(req, res) {
  const session = await requireJwt(req, res, REVOKE_THROTTLE)
  if (!session) return
  const id = req.body?.id
  if (typeof id !== 'string' || !id) return json(res, 400, { error: 'Missing id' })
  const ok = await revokeKey(storeFrom(req), id, session.sub)
  if (!ok) return json(res, 404, { error: 'Key not found' })
  json(res, 200, { revoked: true })
}
