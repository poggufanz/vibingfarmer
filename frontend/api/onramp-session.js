// Server-side Transak "Create Widget URL" session proxy (SP4 on-ramp, primary provider).
// Mints a short-lived, one-time widgetUrl so the TRANSAK_ACCESS_TOKEN secret never reaches
// the client bundle — mirrors this codebase's existing stellar-relay.js gasless-relay pattern
// (server holds the secret, client only ever calls this proxy).
// https://docs.transak.com/guides/migration-to-api-based-transak-widget-url
//
// Actions (POST body):
//   { provider: 'transak' (default), address, amount? }      → { widgetUrl }
//   { provider: 'coinbase-base', address, amount? }          → 501 (documented fallback,
//     deliberately not wired yet — see the branch below for why)

import { applyCors, rateLimit } from './_guard.js'

const API_KEY = () => process.env.TRANSAK_API_KEY || ''
const ACCESS_TOKEN = () => process.env.TRANSAK_ACCESS_TOKEN || ''
const ENVIRONMENT = () => process.env.TRANSAK_ENVIRONMENT || 'STAGING'
const REFERRER_DOMAIN = () => process.env.TRANSAK_REFERRER_DOMAIN || 'localhost'

// VERIFY: confirm these are still the current Session API hosts for both STAGING and
// PRODUCTION before go-live — https://docs.transak.com/api/public/end-points
const SESSION_API_URL = {
  STAGING: 'https://api-gateway-stg.transak.com/api/v2/auth/session',
  PRODUCTION: 'https://api-gateway.transak.com/api/v2/auth/session',
}

function isStellarAddress(addr) {
  return typeof addr === 'string' && /^G[A-Z2-7]{55}$/.test(addr)
}

function bad(res, msg) {
  res.statusCode = 400
  return res.end(JSON.stringify({ error: msg }))
}

/**
 * Build the Transak `widgetParams` body for a USDC-to-Stellar on-ramp session. Locks the
 * network/asset/destination so the widget can't be redirected to a different chain or wallet.
 * VERIFY: `disableWalletAddressForm` + `network:'stellar'` together — Transak's own examples
 * only show this combo with an EVM 0x… address; the crypto-currencies API confirms
 * network:'stellar' + USDC is a valid, buy-allowed pair, but the exact wallet-form-lock UX for
 * a non-EVM address format is worth a manual sandbox run before go-live.
 * https://docs.transak.com/guides/how-to-create-a-widget-url-and-test-different-scenarios
 * @param {{ address: string, amount?: number }} p
 * @returns {object}
 */
export function buildWidgetParams({ address, amount }) {
  const params = {
    apiKey: API_KEY(),
    referrerDomain: REFERRER_DOMAIN(),
    productsAvailed: 'BUY',
    network: 'stellar',
    cryptoCurrencyCode: 'USDC',
    walletAddress: address,
    disableWalletAddressForm: true,
  }
  if (amount) {
    params.fiatCurrency = 'USD'
    params.fiatAmount = amount
  }
  return params
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405
    return res.end(JSON.stringify({ error: 'Method not allowed' }))
  }
  if (!applyCors(req, res)) return
  if (!rateLimit(req, res, { max: 10, windowMs: 60_000, bucket: 'onramp-session' })) return
  res.setHeader('Content-Type', 'application/json')

  const apiKey = API_KEY()
  const accessToken = ACCESS_TOKEN()
  if (!apiKey || !accessToken) {
    res.statusCode = 503
    return res.end(JSON.stringify({ error: 'On-ramp not configured', configured: false }))
  }

  try {
    const body = await readBody(req)
    const provider = body.provider || 'transak'

    if (provider === 'coinbase-base') {
      // Documented fallback (spec §9) — deliberately NOT wired yet. Coinbase's Session Token
      // API authenticates with a CDP-key-signed JWT (a Secret API Key + cdpcurl-style signing),
      // a materially separate integration from Transak's static access-token header. Build this
      // branch only if Transak becomes unavailable for a target country/KYC tier.
      // https://docs.cdp.coinbase.com/onramp/introduction/quickstart
      res.statusCode = 501
      return res.end(
        JSON.stringify({ error: 'coinbase-base provider not yet implemented', configured: false })
      )
    }
    if (provider !== 'transak') {
      return bad(res, 'Unknown provider')
    }

    if (!isStellarAddress(body.address)) return bad(res, 'Invalid Stellar address')
    if (body.amount != null && (typeof body.amount !== 'number' || body.amount <= 0)) {
      return bad(res, 'Invalid amount')
    }

    const widgetParams = buildWidgetParams({ address: body.address, amount: body.amount })
    const sessionUrl = SESSION_API_URL[ENVIRONMENT()] || SESSION_API_URL.STAGING

    const upstream = await fetch(sessionUrl, {
      method: 'POST',
      headers: { 'access-token': accessToken, 'content-type': 'application/json' },
      body: JSON.stringify({ widgetParams }),
    })
    if (!upstream.ok) {
      res.statusCode = 502
      return res.end(JSON.stringify({ error: 'On-ramp session request failed' }))
    }
    const data = await upstream.json()
    // VERIFY: Transak's documented response nests as { response: { widgetUrl } } (confirmed,
    // see docs.transak.com/guides/migration-to-api-based-transak-widget-url) — the flat
    // fallback below is defensive only, in case they change the envelope shape.
    const widgetUrl = data?.response?.widgetUrl || data?.widgetUrl
    if (!widgetUrl) {
      res.statusCode = 502
      return res.end(JSON.stringify({ error: 'On-ramp session response missing widgetUrl' }))
    }
    return res.end(JSON.stringify({ widgetUrl }))
  } catch (err) {
    console.error('[api/onramp-session] error:', err?.message || err)
    res.statusCode = 502
    return res.end(JSON.stringify({ error: 'On-ramp session failed' }))
  }
}
