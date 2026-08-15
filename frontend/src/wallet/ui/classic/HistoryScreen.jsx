// frontend/src/wallet/ui/classic/HistoryScreen.jsx
// VF Wallet Task 4 -- truthful Activity. Recomposed onto the shared pc-* primitives
// (WalletShell.jsx owns the CSS). Renders the Stellar testnet leg of Activity; WalletActivity.jsx
// is the account-agnostic orchestrator that also has structural room for a Base Sepolia leg (see
// its own header for why the wallet extension has no live Base activity source to populate it
// with yet).
//
// Money-truth (Step 3): `items == null` means the read genuinely could not be attempted/completed
// -- rendered as "unavailable", never silently folded into the same empty state as a confirmed
// zero-transaction history (`items` as `[]`). Every row here comes from Horizon's payments
// collection, which by construction only ever lists successfully-applied, ledger-included
// operations -- there is no "pending"/"failed" Stellar row this data source can produce, so every
// row is honestly labeled Confirmed (not fabricated optimism; Horizon does not return anything
// else here).
//
// KNOWN GAP (documented, not silently ignored): wallet/history.js's fetchHistory() -- off-limits
// for this task (not in the Task 10 file list) -- internally catches its own fetch failures and
// resolves to `[]` rather than rejecting or returning null, so a TRUE network failure and a
// genuinely empty history are indistinguishable once they reach this component. This component is
// built to render the correct state for either input it receives (see HistoryScreen.jsx's sibling
// unit coverage via WalletActivity.test.jsx); popup.jsx initializes its `activity` state to `null`
// (not `[]`) so at least "never yet loaded" reads as unavailable rather than a false "no
// activity" -- the remaining silent-failure-to-empty gap lives in fetchHistory itself.
import { formatTokenUnits } from '../../../design/pocket-crew-foundation.js'

const ACTIVITY_STATES = new Set([
  'loading',
  'current',
  'confirmed',
  'partial',
  'error',
  'unknown',
  'unavailable',
])

function activityState(items) {
  if (Array.isArray(items)) return items.length === 0 ? 'empty' : 'current'
  const state = items?.state
  if (state === 'confirmed-empty' || state === 'empty') return 'empty'
  if (typeof state === 'string' && ACTIVITY_STATES.has(state)) return state
  return 'unavailable'
}

function activityRows(items) {
  if (Array.isArray(items)) return items
  return Array.isArray(items?.items) ? items.items : []
}

function assetCodeFor(item) {
  if (typeof item?.asset === 'string')
    return item.asset === 'XLM' ? 'XLM' : item.asset.split(':')[0]
  if (item?.asset && typeof item.asset.token === 'string') return item.asset.token
  return item?.code || 'Token'
}

function formatActivityAmount(item, assetCode) {
  const amount = item?.amount
  const tokenAmount =
    amount && typeof amount === 'object'
      ? amount
      : item?.units !== undefined
        ? { token: assetCode, units: item.units, decimals: item.decimals }
        : null

  if (tokenAmount) {
    try {
      if (
        typeof tokenAmount.token === 'string' &&
        (typeof tokenAmount.units === 'string' || typeof tokenAmount.units === 'bigint') &&
        Number.isInteger(tokenAmount.decimals) &&
        tokenAmount.decimals >= 0
      ) {
        return `${formatTokenUnits(tokenAmount.units, tokenAmount.decimals)} ${tokenAmount.token}`
      }
    } catch {
      return 'Unavailable'
    }
  }

  if (typeof amount === 'string' && amount.trim()) return `${amount} ${assetCode}`
  if (typeof amount === 'number' && Number.isFinite(amount)) return `${amount} ${assetCode}`
  return `Unavailable ${assetCode}`
}

function stateMessage(state) {
  if (state === 'loading') return 'Loading Stellar activity…'
  if (state === 'empty') {
    return 'No Stellar activity yet. Stellar transactions will appear here once you send or receive.'
  }
  return 'Stellar activity unavailable right now.'
}

export default function HistoryScreen({ items }) {
  const truncateAddress = (addr) => {
    if (!addr || typeof addr !== 'string') return '-'
    if (addr.length <= 12) return addr
    return `${addr.slice(0, 6)}…${addr.slice(-6)}`
  }

  const state = activityState(items)
  const rows = activityRows(items)

  if (state !== 'current' && state !== 'confirmed' && state !== 'partial') {
    return (
      <div className="pc-activity-state" data-testid="history-screen" data-state={state}>
        <p className="pc-field-help">{stateMessage(state)}</p>
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="pc-activity-state" data-testid="history-screen" data-state="empty">
        <p className="pc-field-help">{stateMessage('empty')}</p>
      </div>
    )
  }

  return (
    <ul className="pc-activity-list" data-testid="history-screen" data-state={state}>
      {rows.map((x, index) => {
        const isRecv = x.direction === 'in'
        const assetCode = assetCodeFor(x)
        const counterparty = isRecv ? x.from : x.to

        return (
          <li key={x.id ?? `${assetCode}-${index}`} className="pc-row">
            <span className="pc-network-badge">Stellar testnet</span>
            <div>
              <div>
                {isRecv ? 'Received' : 'Sent'} {assetCode}
              </div>
              <div className="pc-field-help">
                {isRecv ? 'From' : 'To'}:{' '}
                <span className="pc-technical">{truncateAddress(counterparty)}</span>
              </div>
              <div className="pc-field-help">
                {x.state ?? 'Confirmed'} · {x.createdAt ?? 'Unavailable'}
              </div>
            </div>
            <div>
              <div className="pc-technical">
                {isRecv ? '+' : '-'}
                {formatActivityAmount(x, assetCode)}
              </div>
              <a
                className="pc-field-help"
                href={`https://stellar.expert/explorer/testnet/op/${x.id}`}
                target="_blank"
                rel="noreferrer"
              >
                View
              </a>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
