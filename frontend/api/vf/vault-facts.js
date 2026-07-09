import { resolve as resolveVaultFacts } from '../../src/strategy/vaultFacts.js'
import { storeFrom } from './_db.js'
import { requireVfKey } from './_vfauth.js'

export default async function handler(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: 'market' })
  if (!ctx) return
  const protocol = new URL(req.url, 'http://local').searchParams.get('protocol') || 'blend-usdc'
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(resolveVaultFacts(protocol)))
}
