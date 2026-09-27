import { HORIZON_URL } from '../stellar/config.js'

/**
 * Horizon payments for `publicKey`, newest first. Resolves to `null` (never `[]`) when the
 * network read itself fails — a genuinely empty history and an unreachable Horizon must stay
 * distinguishable (P1 G10): callers render `null` as "could not load", `[]` as "no activity".
 */
export async function fetchHistory(
  publicKey,
  { fetchImpl = fetch, limit = 20, horizonUrl = HORIZON_URL } = {}
) {
  try {
    const url = `${horizonUrl}/accounts/${publicKey}/payments?order=desc&limit=${limit}`
    const r = await fetchImpl(url)
    if (!r.ok) return null
    const j = await r.json()
    const recs = j?._embedded?.records ?? []
    return recs
      .filter((x) => x.type === 'payment' || x.type === 'create_account')
      .map((x) => {
        const to = x.to ?? x.account
        return {
          id: x.id,
          type: x.type,
          from: x.from ?? x.funder,
          to,
          asset:
            x.asset_type === 'native' || x.type === 'create_account'
              ? 'XLM'
              : `${x.asset_code}:${x.asset_issuer}`,
          amount: x.amount ?? x.starting_balance,
          createdAt: x.created_at,
          // The payment's own transaction hash — the unified /history feed links each row
          // to the explorer off exactly this, never a guessed URL.
          txHash: typeof x.transaction_hash === 'string' ? x.transaction_hash : null,
          direction: to === publicKey ? 'in' : 'out',
        }
      })
  } catch {
    return null
  }
}
