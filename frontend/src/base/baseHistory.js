// frontend/src/base/baseHistory.js
// On-chain Base activity for the dashboard (mirrors wallet/history.js's Horizon reader, which
// is Stellar-only — Base mints/deposits/withdrawals were invisible in every history surface).
// Source: Blockscout's tokentx index — the public sepolia.base.org RPC proved unreliable for
// log queries (returned empty for ranges Blockscout indexed fine, 2026-07-20). Fail-soft: any
// error -> [] so the dashboard renders without the section, same contract as loadBasePositions.
const BLOCKSCOUT_API = 'https://base-sepolia.blockscout.com/api'

export async function fetchBaseHistory({ account, fetchImpl = fetch, limit = 12 } = {}) {
  if (!account) return []
  try {
    const r = await fetchImpl(
      `${BLOCKSCOUT_API}?module=account&action=tokentx&address=${encodeURIComponent(account)}`
    )
    if (!r.ok) return []
    const j = await r.json()
    const rows = Array.isArray(j?.result) ? j.result : []
    const acct = account.toLowerCase()
    return rows.slice(0, limit).map((t) => {
      const isIn = (t.to || '').toLowerCase() === acct
      return {
        id: `${t.hash}-${t.tokenSymbol}-${t.from}-${t.value}`,
        hash: t.hash,
        time: Number(t.timeStamp) * 1000 || null,
        symbol: t.tokenSymbol || '?',
        amount: Number(t.value) / 10 ** Number(t.tokenDecimal || 6),
        direction: isIn ? 'in' : 'out',
      }
    })
  } catch {
    return []
  }
}
