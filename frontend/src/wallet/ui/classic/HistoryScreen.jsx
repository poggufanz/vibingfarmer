export default function HistoryScreen({ items }) {
  const truncateAddress = (addr) => {
    if (!addr || typeof addr !== 'string') return '—'
    if (addr.length <= 12) return addr
    return `${addr.slice(0, 6)}…${addr.slice(-6)}`
  }

  if (!items?.length)
    return (
      <div className="vf-screen" style={{ justifyContent: 'center', alignItems: 'center', minHeight: '240px', gap: '12px' }}>
        <div style={{
          width: 48, height: 48, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--bg-elev)', border: '1px solid var(--border)',
          boxShadow: '0 4px 16px rgba(0,0,0,.2)'
        }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
          </svg>
        </div>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '14px', fontWeight: '500' }}>No activity yet</p>
        <p style={{ margin: 0, color: 'var(--text-faint)', fontSize: '11px' }}>Transactions will appear here once you send or receive.</p>
      </div>
    )

  return (
    <ul className="vf-screen vf-history">
      {items.map((x) => {
        const isRecv = x.direction === 'in'
        const badgeClass = isRecv ? 'in' : 'out'
        const symbol = isRecv ? '↓' : '↑'
        const assetCode = x.asset === 'XLM' ? 'XLM' : x.asset.split(':')[0]
        const actionTitle = isRecv ? `Received ${assetCode}` : `Sent ${assetCode}`
        const counterparty = isRecv ? x.from : x.to
        const formattedCounterparty = isRecv
          ? `From: ${truncateAddress(counterparty)}`
          : `To: ${truncateAddress(counterparty)}`

        return (
          <li key={x.id}>
            <div className="vf-history-row">
              <div className="vf-history-left">
                <div className={`vf-history-badge ${badgeClass}`}>
                  {symbol}
                </div>
                <div className="vf-history-meta">
                  <span className="vf-history-title">{actionTitle}</span>
                  <span className="vf-history-address">{formattedCounterparty}</span>
                </div>
              </div>
              <div className="vf-history-right">
                <span className={`vf-history-amount ${badgeClass}`}>
                  {isRecv ? '+' : '-'}{x.amount} {assetCode}
                </span>
                <span className="vf-history-time">{x.createdAt}</span>
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
