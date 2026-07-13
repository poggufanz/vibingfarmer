import { useState } from 'react'

export default function HomeScreen({
  publicKey,
  portfolio,
  unfunded,
  onFund,
  onSend,
  onReceive,
  busy,
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard?.writeText(publicKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="vf-screen vf-home">
      <div className="vf-balance-card">
        <div className="vf-portfolio">
          {portfolio == null
            ? 'N/A'
            : portfolio.complete
              ? `$${portfolio.total.toFixed(2)}`
              : `~$${portfolio.total.toFixed(2)}`}
        </div>
        <div className="vf-address-container">
          <span className="vf-address" title={publicKey}>
            {publicKey.slice(0, 6)}…{publicKey.slice(-6)}
          </span>
          <button className="vf-address-copy-btn" onClick={handleCopy} title="Copy address">
            {copied ? (
              <span style={{ color: 'var(--ok)', fontWeight: 600 }}>Copied</span>
            ) : (
              <>
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
      </div>

      {unfunded && (
        <div className="vf-fund">
          <p style={{ margin: 0 }}>This testnet account is not funded yet.</p>
          <button className="vf-btn" disabled={busy} onClick={onFund}>
            Fund via Friendbot
          </button>
        </div>
      )}

      <div className="vf-actions">
        <button className="vf-btn primary" onClick={onSend}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="12" y1="19" x2="12" y2="5"></line>
            <polyline points="5 12 12 5 19 12"></polyline>
          </svg>
          Send
        </button>
        <button className="vf-btn" onClick={onReceive}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <polyline points="19 12 12 19 5 12"></polyline>
          </svg>
          Receive
        </button>
      </div>

      <ul className="vf-tokens">
        {(portfolio?.rows ?? []).map((r) => {
          const codeLower = r.code.toLowerCase()
          const isXlm = codeLower === 'xlm'
          const isUsdc = codeLower === 'usdc'
          const iconClass = isXlm ? 'xlm' : isUsdc ? 'usdc' : 'unknown'
          const tokenName = isXlm ? 'Stellar Lumens' : isUsdc ? 'USD Coin' : 'Token'

          return (
            <li key={r.asset} className="vf-token-row">
              <div className="vf-token-left">
                <div className={`vf-token-icon ${iconClass}`}>{r.code.slice(0, 2)}</div>
                <div className="vf-token-meta">
                  <span className="vf-token-code">{r.code}</span>
                  <span className="vf-token-name">{tokenName}</span>
                </div>
              </div>
              <div className="vf-token-right">
                <span className="vf-token-balance">{r.balance}</span>
                <span className="vf-token-usd">
                  {r.usd == null ? 'N/A' : `$${r.usd.toFixed(2)}`}
                </span>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
