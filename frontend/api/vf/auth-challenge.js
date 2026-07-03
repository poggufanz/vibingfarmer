import { StrKey } from '@stellar/stellar-sdk'
import { rateLimit } from '../_guard.js'
import { buildChallenge } from './_sep10.js'

const json = (res, status, obj) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

export default async function handler(req, res) {
  if (!rateLimit(req, res, { max: 20, windowMs: 60_000, bucket: 'vf-auth' })) return
  const signingSecret = process.env.VF_AUTH_SIGNING_KEY
  if (!signingSecret)
    return json(res, 503, { configured: false, error: 'Portal auth not configured' })
  const account = new URL(req.url, 'http://local').searchParams.get('account') || ''
  if (!StrKey.isValidEd25519PublicKey(account)) return json(res, 400, { error: 'Invalid account' })
  const out = await buildChallenge({
    account,
    signingSecret,
    homeDomain: process.env.VF_HOME_DOMAIN || 'localhost:5173',
    networkPassphrase:
      process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
  })
  json(res, 200, out)
}
