export default function HomeScreen({
  publicKey,
  portfolio,
  unfunded,
  onFund,
  onSend,
  onReceive,
  busy,
}) {
  return (
    <div className="vf-screen vf-home">
      <div className="vf-balance-card">
        <div className="vf-portfolio">
          {portfolio == null
            ? '—'
            : portfolio.complete
              ? `$${portfolio.total.toFixed(2)}`
              : `~$${portfolio.total.toFixed(2)} (partial)`}
        </div>
        <div className="vf-address" title={publicKey}>
          {publicKey.slice(0, 6)}…{publicKey.slice(-6)}
        </div>
      </div>

      {unfunded && (
        <div className="vf-fund">
          <p>This testnet account is not funded yet.</p>
          <button className="vf-btn" disabled={busy} onClick={onFund}>
            Fund via Friendbot
          </button>
        </div>
      )}

      <div className="vf-actions">
        <button className="vf-btn primary" onClick={onSend}>
          Send
        </button>
        <button className="vf-btn" onClick={onReceive}>
          Receive
        </button>
      </div>

      <ul className="vf-tokens">
        {(portfolio?.rows ?? []).map((r) => (
          <li key={r.asset}>
            <span>{r.code}</span>
            <span>{r.balance}</span>
            <span>{r.usd == null ? '—' : `$${r.usd.toFixed(2)}`}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
