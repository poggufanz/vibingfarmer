// frontend/src/wallet/ui/classic/HistoryScreen.jsx
// VF Wallet Task 10, Step 3 -- truthful Activity. Recomposed onto the shared pc-* primitives
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
export default function HistoryScreen({ items }) {
  const truncateAddress = (addr) => {
    if (!addr || typeof addr !== 'string') return '-'
    if (addr.length <= 12) return addr
    return `${addr.slice(0, 6)}…${addr.slice(-6)}`
  }

  if (items == null) {
    return (
      <div data-testid="history-screen">
        <p className="pc-field-help">Activity is unavailable right now.</p>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div data-testid="history-screen">
        <p className="pc-field-help">
          No activity yet. Transactions will appear here once you send or receive.
        </p>
      </div>
    )
  }

  return (
    <ul className="pc-activity-list" data-testid="history-screen">
      {items.map((x) => {
        const isRecv = x.direction === 'in'
        const assetCode = x.asset === 'XLM' ? 'XLM' : x.asset.split(':')[0]
        const counterparty = isRecv ? x.from : x.to

        return (
          <li key={x.id} className="pc-row">
            <span className="pc-network-badge">Stellar testnet</span>
            <div>
              <div>
                {isRecv ? 'Received' : 'Sent'} {assetCode}
              </div>
              <div className="pc-field-help">
                {isRecv ? 'From' : 'To'}:{' '}
                <span className="pc-technical">{truncateAddress(counterparty)}</span>
              </div>
              <div className="pc-field-help">Confirmed · {x.createdAt}</div>
            </div>
            <div>
              <div className="pc-technical">
                {isRecv ? '+' : '-'}
                {x.amount} {assetCode}
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
