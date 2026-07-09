// DeFiLlama coins API — keyless upstream. https://coins.llama.fi/prices/current/{coins}
import { storeFrom } from './_db.js'
import { requireVfKey } from './_vfauth.js'

const DEFAULT_COINS = 'coingecko:stellar,coingecko:usd-coin'

export default async function handler(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: 'market' })
  if (!ctx) return
  const coins = new URL(req.url, 'http://local').searchParams.get('coins') || DEFAULT_COINS
  res.setHeader('Content-Type', 'application/json')
  try {
    const upstream = await fetch(
      `https://coins.llama.fi/prices/current/${encodeURIComponent(coins)}`,
      { signal: AbortSignal.timeout(5000) }
    )
    if (!upstream.ok) throw new Error('bad status')
    res.statusCode = 200
    res.end(JSON.stringify(await upstream.json()))
  } catch {
    res.statusCode = 502
    res.end(JSON.stringify({ error: 'upstream' })) // never leak provider detail
  }
}
