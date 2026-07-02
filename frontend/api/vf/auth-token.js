import { rateLimit } from '../_guard.js'
import { verifyChallenge } from './_sep10.js'
import { signJwt } from './_jwt.js'

const json = (res, status, obj) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

export default async function handler(req, res) {
  if (!rateLimit(req, res, { max: 20, windowMs: 60_000, bucket: 'vf-auth' })) return
  const signingSecret = process.env.VF_AUTH_SIGNING_KEY
  const jwtSecret = process.env.VF_JWT_SECRET
  if (!signingSecret || !jwtSecret) return json(res, 503, { configured: false, error: 'Portal auth not configured' })
  const signedXdr = req.body?.transaction
  if (typeof signedXdr !== 'string' || !signedXdr) return json(res, 400, { error: 'Missing transaction' })
  const v = await verifyChallenge({
    signedXdr,
    signingSecret,
    homeDomain: process.env.VF_HOME_DOMAIN || 'localhost:5173',
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
  })
  if (!v.ok) return json(res, 401, { error: 'Challenge verification failed' })
  json(res, 200, { token: await signJwt({ sub: v.account }, jwtSecret, 3600) })
}
