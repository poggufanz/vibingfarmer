// Key CRUD — JWT-gated (portal session), NOT vf-key-gated.
import { z } from 'zod'
import { storeFrom } from './_db.js'
import { requireJwt } from './_vfauth.js'
import { issueKey, revokeKey, SCOPES } from './_keystore.js'

const json = (res, status, obj) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

const IssueSchema = z.object({
  scopes: z.array(z.enum(SCOPES)).nonempty(),
  env: z.enum(['test', 'live']),
  rateLimit: z.number().int().min(1).max(600).default(60),
  expiresAt: z.number().int().positive().nullable().default(null),
})

export async function listKeys(req, res) {
  const session = await requireJwt(req, res)
  if (!session) return
  json(res, 200, { keys: await storeFrom(req).keys.list(session.sub) })
}

export async function createKey(req, res) {
  const session = await requireJwt(req, res)
  if (!session) return
  const parsed = IssueSchema.safeParse(req.body ?? {})
  if (!parsed.success) return json(res, 400, { error: 'Invalid key request' })
  const { scopes, env, rateLimit, expiresAt } = parsed.data
  const out = await issueKey(storeFrom(req), {
    owner: session.sub,
    scopes,
    rateLimit,
    env,
    expiresAt,
  })
  json(res, 200, out) // { id, key (ONLY time plaintext leaves the server), hint }
}

export async function deleteKey(req, res) {
  const session = await requireJwt(req, res)
  if (!session) return
  const id = req.body?.id
  if (typeof id !== 'string' || !id) return json(res, 400, { error: 'Missing id' })
  const ok = await revokeKey(storeFrom(req), id, session.sub)
  if (!ok) return json(res, 404, { error: 'Key not found' })
  json(res, 200, { revoked: true })
}
