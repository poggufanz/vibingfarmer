// Single dispatcher for /api/vf/*. One vite mount + one Pages catch-all wrap this.
// Gateway endpoints authenticate with the Bearer vf_ key (requireVfKey inside each
// handler) — so CORS here is permissive (any browser origin may carry a key).
import authChallenge from './auth-challenge.js'
import authToken from './auth-token.js'
import { listKeys, createKey, deleteKey } from './keys.js'
import vaultFacts from './vault-facts.js'
import eligibility from './eligibility.js'
import prices from './prices.js'
import buildTx from './build-tx.js'
import simulate from './simulate.js'

export const routes = {
  'GET /auth/challenge': authChallenge,
  'POST /auth/token': authToken,
  'GET /keys': listKeys,
  'POST /keys': createKey,
  'DELETE /keys': deleteKey,
  'GET /vault-facts': vaultFacts,
  'POST /eligibility': eligibility,
  'GET /prices': prices,
  'POST /build-tx': buildTx,
  'POST /simulate': simulate,
  // Tasks 10-11 register: submit, scan, strategy
}

export function subPath(req) {
  const pathname = new URL(req.url, 'http://local').pathname
  const i = pathname.indexOf('/api/vf')
  return (i >= 0 ? pathname.slice(i + '/api/vf'.length) : pathname) || '/'
}

export default async function vfRouter(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    return res.end('')
  }
  const handler = routes[`${req.method} ${subPath(req)}`]
  if (!handler) {
    res.statusCode = 404
    res.setHeader('Content-Type', 'application/json')
    return res.end(JSON.stringify({ error: 'Not found' }))
  }
  return handler(req, res)
}
