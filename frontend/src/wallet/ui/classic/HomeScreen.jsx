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
import { formatTokenUnits } from '../../../design/pocket-crew-foundation.js'
import { TokenIcon, tokenName } from './tokenIcons.jsx'

const FACT_STATES = new Set([
  'loading',
  'current',
  'confirmed',
  'stale',
  'partial',
  'empty',
  'error',
  'unknown',
  'unavailable',
])

function formatUsd(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? `$${value.toFixed(2)}` : null
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return null

  const [whole, fraction = ''] = value.split('.')
  return `$${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`
}

function isTokenAmount(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.token === 'string' &&
    (typeof value.units === 'string' || typeof value.units === 'bigint') &&
    Number.isInteger(value.decimals) &&
    value.decimals >= 0
  )
}

function formatTokenAmount(amount, fallbackToken = 'Token') {
  if (!isTokenAmount(amount)) return null
  try {
    return `${formatTokenUnits(amount.units, amount.decimals)} ${amount.token || fallbackToken}`
  } catch {
    return null
  }
}

function formatRowBalance(row) {
  const amount =
    row?.amount ??
    (row?.units !== undefined
      ? { token: row.code || row.asset || 'Token', units: row.units, decimals: row.decimals }
      : null)
  const exact = formatTokenAmount(amount, row?.code || row?.asset)
  if (exact) return exact
  if (typeof row?.balance === 'string' && row.balance.trim()) return row.balance
  if (typeof row?.balance === 'number' && Number.isFinite(row.balance)) return String(row.balance)
  return 'Unavailable'
}

function portfolioState(portfolio) {
  if (portfolio == null) return 'unavailable'
  const requested = portfolio.state ?? portfolio.fact?.state
  if (typeof requested === 'string' && FACT_STATES.has(requested)) return requested
  if (portfolio.complete === false) return 'partial'
  return 'current'
}

function totalText(portfolio, state) {
  if (state === 'loading') return 'Loading'
  if (state === 'empty') return 'No balance yet'
  if (['error', 'unknown', 'unavailable'].includes(state)) return 'Unavailable'

  const exact = formatTokenAmount(portfolio?.amount ?? portfolio?.totalAmount)
  if (exact) return exact

  const formatted = formatUsd(portfolio?.total)
  if (!formatted) return 'Unavailable'
  return state === 'partial' || portfolio?.complete === false ? `~${formatted}` : formatted
}

export default function HomeScreen({
  publicKey,
  accountKind,
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

  const state = portfolioState(portfolio)
  const displayedTotal = totalText(portfolio, state)

  return (
    <div data-testid="home-screen">
      <div className="pc-wallet-balance pc-money-figure" data-pocket-money data-fact-state={state}>
        {displayedTotal}
      </div>
      {['error', 'unknown', 'unavailable'].includes(state) && (
        <p className="pc-field-help">Balance data could not be read right now.</p>
      )}
      {state === 'loading' && <p className="pc-field-help">Checking balance data…</p>}
      {(state === 'partial' || (portfolio != null && !portfolio.complete)) && (
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
          {onFund && (
            <button
              type="button"
              className="pc-button pc-button--secondary"
              disabled={busy}
              onClick={onFund}
            >
              Fund via Friendbot
            </button>
          )}
        </div>
      )}

      <div className="pc-wallet-actions">
        {onSend && (
          <button type="button" className="pc-button pc-button--primary" onClick={onSend}>
            Send
          </button>
        )}
        {onReceive && (
          <button type="button" className="pc-button pc-button--secondary" onClick={onReceive}>
            Receive
          </button>
        )}
        {onAddAsset && (
          <button type="button" className="pc-button pc-button--secondary" onClick={onAddAsset}>
            Add asset
          </button>
        )}
      </div>

      {accountKind === 'C' && !onSend && (
        <p className="pc-field-help">Send is not available yet for this account type.</p>
      )}

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
        {(Array.isArray(portfolio?.rows) ? portfolio.rows : []).map((r) => (
          <li key={r.asset} className="pc-row">
            <TokenIcon asset={r.asset} code={r.code || r.asset || '??'} />
            <div>
              <div>{r.code || r.asset || 'Token'}</div>
              <div className="pc-field-help">{tokenName(r.asset)}</div>
            </div>
            <div>
              <div className="pc-technical">{formatRowBalance(r)}</div>
              <div className="pc-field-help">
                {r.usd == null || !formatUsd(r.usd) ? 'Unavailable' : formatUsd(r.usd)}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
