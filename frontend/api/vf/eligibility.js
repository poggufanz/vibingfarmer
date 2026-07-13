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
  const ctx = await requireVfKey(req, res, storeFrom(req), {
    scope: 'market',
    endpoint: 'eligibility',
  })
  if (!ctx) return
  const { vault, amount, protocol } = req.body ?? {}
  let amt
  try {
    amt = BigInt(amount)
  } catch {
    return json(res, 400, { error: 'Invalid amount' })
  }
  if (typeof vault !== 'string' || !vault) return json(res, 400, { error: 'Missing vault' })
  // Fail-closed: resolve by explicit protocol, else treat vault as the slug. No silent default —
  // an unknown protocol must reject, never inherit another protocol's facts.
  let resolved
  try {
    resolved = resolveVaultFacts(typeof protocol === 'string' && protocol ? protocol : vault)
  } catch (err) {
    return json(res, 200, {
      allow: false,
      verdict: null,
      reasons: [`facts unavailable: ${err.message}`],
    })
  }
  const verdict = evaluate({ ...resolved, vault, amount: amt })
  json(res, 200, {
    allow: verdict.eligible ?? false,
    verdict,
    reasons: verdict.reasons ?? [],
  })
}
