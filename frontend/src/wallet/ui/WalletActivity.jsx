// frontend/src/wallet/ui/WalletActivity.jsx
// VF Wallet Task 10, Step 3 -- truthful Activity, account-agnostic. Wires WalletShell (account
// chip, "Stellar testnet" text, the beginner nav) around classic/HistoryScreen.jsx for the
// Stellar leg (money-truth: unavailable vs. genuinely empty is HistoryScreen's job, see its own
// header) and renders a structurally-separate Base Sepolia leg when given one.
//
// `baseItems` defaults to null and popup.jsx never populates it today: the browser-extension
// wallet has no live Base activity data source of its own (baseBinding.js -- read earlier during
// research -- is the MAIN APP's stellarOwner<->ZeroDev-kernel association store, not a transaction
// history feed, and there is no equivalent inside the extension). Rendering a fabricated or
// heuristic Base row here would violate the same money-truth rule this whole task is about,
// so this component is built to render the Base leg CORRECTLY the moment real data exists
// (network badge, direction, amount, state, time, explorer link, proxy/custody/no-yield wording
// -- exercised by fixture data in WalletActivity.test.jsx) without inventing one now. This is a
// documented scope decision, not a silently missing feature -- see the task report.
import { WalletShell } from './WalletShell.jsx'
import HistoryScreen from './classic/HistoryScreen.jsx'

// VF Wallet Task 12, Part A2 -- HistoryScreen.jsx's own empty-state copy ("No activity yet.
// Transactions will appear here once you send or receive.") sits under this component's
// unqualified "Activity" heading, but this component structurally cannot see Base activity (see
// this file's own header above) -- an unscoped "no activity" claim overclaims what was actually
// checked (Stellar only). HistoryScreen.jsx is not in this task's authorized file list (and its
// own empty-state string has no prop to override), so the fix lives here: intercept the exact
// "genuinely empty" case (items is a non-null, zero-length array) BEFORE handing off to
// HistoryScreen, and render the Stellar-scoped copy directly. The `items == null` (unavailable)
// and non-empty (real rows) cases still fall through to HistoryScreen unchanged.
const isGenuinelyEmpty = (items) => Array.isArray(items) && items.length === 0

const NAV_TABS = [
  { id: 'home', label: 'Home' },
  { id: 'activity', label: 'Activity' },
  { id: 'settings', label: 'Settings' },
]

export function WalletActivity({
  account,
  onNav,
  status = null,
  items = null,
  baseItems = null,
  children = null,
}) {
  return (
    <WalletShell
      heading="Activity"
      account={account}
      status={status}
      nav={{ tabs: NAV_TABS, active: 'activity', onNav }}
    >
      {isGenuinelyEmpty(items) ? (
        <div data-testid="history-screen">
          <p className="pc-field-help">
            No Stellar activity yet. Stellar transactions will appear here once you send or receive.
          </p>
        </div>
      ) : (
        <HistoryScreen items={items} />
      )}

      {baseItems != null && baseItems.length > 0 && (
        <div data-testid="base-activity">
          <h2>Base Sepolia</h2>
          <ul className="pc-activity-list">
            {baseItems.map((x) => (
              <li key={x.id} className="pc-row">
                <span className="pc-network-badge">Base Sepolia</span>
                <div>
                  <div>
                    {x.direction === 'in' ? 'Received' : 'Sent'} {x.asset}
                  </div>
                  <div className="pc-field-help">
                    {x.custodyNote ?? 'Custody-only proxy balance — no yield.'}
                  </div>
                  <div className="pc-field-help">
                    {x.state ?? 'Confirmed'} · {x.time}
                  </div>
                </div>
                <div>
                  <div className="pc-technical">
                    {x.direction === 'in' ? '+' : '-'}
                    {x.amount}
                  </div>
                  {x.explorerUrl && (
                    <a
                      className="pc-field-help"
                      href={x.explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {children}
    </WalletShell>
  )
}
