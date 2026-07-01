import { HORIZON_URL } from '../stellar/config.js'

export async function fetchHistory(
  publicKey,
  { fetchImpl = fetch, limit = 20, horizonUrl = HORIZON_URL } = {}
) {
  const url = `${horizonUrl}/accounts/${publicKey}/payments?order=desc&limit=${limit}`
  const r = await fetchImpl(url)
  if (!r.ok) return []
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
        direction: to === publicKey ? 'in' : 'out',
      }
    })
}
