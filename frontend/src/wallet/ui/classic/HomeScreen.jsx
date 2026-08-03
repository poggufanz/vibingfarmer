// frontend/src/wallet/ui/classic/HomeScreen.jsx
// VF Wallet Task 10 -- recomposed onto the shared Pocket Crew pc-* primitives (WalletShell.jsx is
// the source of truth for this surface's CSS; nothing here re-ports a rule it already has). Reused
// as the shared asset-list/actions widget for BOTH account kinds via WalletHome.jsx: a Standard
// (G) account gets `unfunded`/`onFund`/`onAddAsset` wired to the real friendbot/trustline paths, a
// Passkey (C) account gets `unfunded={false}` and omits `onFund`/`onAddAsset` entirely -- the
// existing "only render if the handler exists" pattern (already how onGetUsdc worked before this
// task) is now applied consistently to `onAddAsset` too, so the caller's per-account-kind support
// decision is the only thing that ever hides a button. No dead buttons; fail closed.
//
// Money-truth: `Unavailable` (never a bare "N/A", never a coerced $0.00) for a portfolio that
// could not be read at all or a per-asset price that did not resolve; `$0.00` only for a
// genuinely-confirmed zero; an incomplete portfolio total is prefixed `~` and paired with an
// adjacent note, never presented as if it were exact.
import { useState } from 'react'
import { TokenIcon, tokenName } from './tokenIcons.jsx'

function formatUsd(value) {
  return `$${value.toFixed(2)}`
}

export default function HomeScreen({
  publicKey,
  portfolio,
  unfunded,
  onFund,
  onSend,
  onReceive,
  onAddAsset,
  onGetUsdc,
  busy,
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard?.writeText(publicKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const totalText =
    portfolio == null
      ? 'Unavailable'
      : portfolio.complete
        ? formatUsd(portfolio.total)
        : `~${formatUsd(portfolio.total)}`

  return (
    <div data-testid="home-screen">
      <div className="pc-wallet-balance" data-pocket-money>
        {totalText}
      </div>
      {portfolio == null && (
        <p className="pc-field-help">Balance data is temporarily unavailable.</p>
      )}
      {portfolio != null && !portfolio.complete && (
        <p className="pc-field-help">Some prices unavailable — total is approximate.</p>
      )}

      <p className="pc-wallet-account-chip" data-testid="home-address">
        <span className="pc-technical">
          {publicKey.slice(0, 6)}…{publicKey.slice(-6)}
        </span>{' '}
        <button type="button" className="pc-button pc-button--secondary" onClick={handleCopy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </p>

      {unfunded && (
        <div className="pc-field">
          <p className="pc-field-help">This testnet account is not funded yet.</p>
          <button
            type="button"
            className="pc-button pc-button--secondary"
            disabled={busy}
            onClick={onFund}
          >
            Fund via Friendbot
          </button>
        </div>
      )}

      <div className="pc-wallet-actions">
        <button type="button" className="pc-button pc-button--primary" onClick={onSend}>
          Send
        </button>
        <button type="button" className="pc-button pc-button--secondary" onClick={onReceive}>
          Receive
        </button>
        {onAddAsset && (
          <button type="button" className="pc-button pc-button--secondary" onClick={onAddAsset}>
            Add asset
          </button>
        )}
      </div>

      {onGetUsdc && (
        <button
          type="button"
          className="pc-button pc-button--secondary"
          disabled={busy}
          onClick={onGetUsdc}
        >
          {busy ? 'Working…' : 'Get test USDC'}
        </button>
      )}

      <ul className="pc-asset-list">
        {(portfolio?.rows ?? []).map((r) => (
          <li key={r.asset} className="pc-row">
            <TokenIcon asset={r.asset} code={r.code} />
            <div>
              <div>{r.code}</div>
              <div className="pc-field-help">{tokenName(r.asset)}</div>
            </div>
            <div>
              <div className="pc-technical">{r.balance}</div>
              <div className="pc-field-help">
                {r.usd == null ? 'Unavailable' : formatUsd(r.usd)}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
