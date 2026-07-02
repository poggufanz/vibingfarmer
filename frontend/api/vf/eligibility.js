import { evaluate } from '../../src/strategy/eligibilityGate.js'
import { resolve as resolveVaultFacts } from '../../src/strategy/vaultFacts.js'
import { storeFrom } from './_db.js'
import { requireVfKey } from './_vfauth.js'

const bigintSafe = (_, v) => (typeof v === 'bigint' ? v.toString() : v)
const json = (res, status, obj) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj, bigintSafe))
}

export default async function handler(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: 'market', endpoint: 'eligibility' })
  if (!ctx) return
  const { vault, amount, protocol } = req.body ?? {}
  let amt
  try {
    amt = BigInt(amount)
  } catch {
    return json(res, 400, { error: 'Invalid amount' })
  }
  if (typeof vault !== 'string' || !vault) return json(res, 400, { error: 'Missing vault' })
  const { facts } = resolveVaultFacts(protocol || 'blend-usdc')
  const verdict = evaluate({ vault, amount: amt, facts })
  json(res, 200, {
    allow: verdict.eligible ?? false,
    verdict,
    reasons: verdict.reasons ?? [],
  })
}
