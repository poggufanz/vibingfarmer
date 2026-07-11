// Portal usage report — JWT-gated (session), NOT vf-key-gated. Read-only over usage_log.
import { storeFrom } from './_db.js'
import { requireJwt } from './_vfauth.js'

const json = (res, status, obj) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

const WINDOW_DAYS = 30

export default async function usage(req, res) {
  const session = await requireJwt(req, res)
  if (!session) return
  const sinceDay = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString().slice(0, 10)
  const rows = await storeFrom(req).usage.listForOwner(session.sub, sinceDay)
  const cap = Number(process.env.VF_GLOBAL_DAILY_CAP || 5000)
  json(res, 200, { usage: rows, cap, sinceDay })
}
