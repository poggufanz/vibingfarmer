const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd'

// Swappable price source. On CORS/limit failure returns null so callers degrade to balance-only.
// Production fallback (documented in HomeScreen wiring): route through the VF API gateway (/api/price) or a TTL cache.
export async function fetchXlmUsd({ fetchImpl = fetch, endpoint = COINGECKO } = {}) {
  try {
    const r = await fetchImpl(endpoint)
    if (!r.ok) return null
    const j = await r.json()
    return j?.stellar?.usd ?? null
  } catch {
    return null
  }
}

export function assetUsd(balance, xlmUsd) {
  if (balance.code === 'XLM') return xlmUsd == null ? null : Number(balance.balance) * xlmUsd
  if (balance.code === 'USDC') return Number(balance.balance) // testnet peg ~ $1 (indicative)
  return null
}

export function portfolioValue(balances, xlmUsd) {
  const rows = balances.map((b) => ({ ...b, usd: assetUsd(b, xlmUsd) }))
  const total = rows.reduce((s, r) => (r.usd == null ? s : s + r.usd), 0)
  const complete = rows.every((r) => r.usd != null)
  return { total, complete, rows }
}
