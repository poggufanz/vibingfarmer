// Portal usage report — JWT-gated (session), NOT vf-key-gated. Read-only over usage_log.
import { storeFrom } from './_db.js'
import { requireJwt } from './_vfauth.js'

const json = (res, status, obj) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

const WINDOW_DAYS = 30

// GET /usage is throttled per portal session (60/min, in-memory like the key
// endpoints): read-only, but unbounded polling is still read amplification.
// 429 + Retry-After on excess; the 200 contract is unchanged.
export default async function usage(req, res) {
  const session = await requireJwt(req, res, { max: 60, bucket: 'vf-usage' })
  if (!session) return
  const sinceDay = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString().slice(0, 10)
  const rows = await storeFrom(req).usage.listForOwner(session.sub, sinceDay)
  const cap = Number(process.env.VF_GLOBAL_DAILY_CAP || 5000)
  json(res, 200, { usage: rows, cap, sinceDay })
}
