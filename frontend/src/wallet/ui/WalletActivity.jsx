// frontend/src/wallet/ui/WalletActivity.jsx
// VF Wallet Task 4 -- truthful Activity, account-agnostic. Wires WalletShell (account
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
import { formatTokenUnits } from '../../design/pocket-crew-foundation.js'

function verifiedBaseRows(baseItems) {
  if (Array.isArray(baseItems)) return baseItems
  if (baseItems?.verified === true && Array.isArray(baseItems.items)) return baseItems.items
  return []
}

function formatBaseAmount(item) {
  const amount = item?.amount
  const candidate =
    amount && typeof amount === 'object'
      ? amount
      : item?.units !== undefined
        ? { token: item.asset || 'Token', units: item.units, decimals: item.decimals }
        : null
  if (candidate) {
    try {
      if (
        typeof candidate.token === 'string' &&
        (typeof candidate.units === 'string' || typeof candidate.units === 'bigint') &&
        Number.isInteger(candidate.decimals) &&
        candidate.decimals >= 0
      ) {
        return `${formatTokenUnits(candidate.units, candidate.decimals)} ${candidate.token}`
      }
    } catch {
      return 'Unavailable'
    }
  }
  if (typeof amount === 'string' && amount.trim()) return `${amount} ${item?.asset ?? 'Token'}`
  if (typeof amount === 'number' && Number.isFinite(amount))
    return `${amount} ${item?.asset ?? 'Token'}`
  return `Unavailable ${item?.asset ?? 'Token'}`
}

function baseAssetCode(item) {
  if (typeof item?.asset === 'string') return item.asset
  if (item?.asset && typeof item.asset.token === 'string') return item.asset.token
  return item?.code || 'Token'
}

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
  const baseRows = verifiedBaseRows(baseItems)

  return (
    <WalletShell
      heading="Activity"
      account={account}
      status={status}
      nav={{ tabs: NAV_TABS, active: 'activity', onNav }}
    >
      <HistoryScreen items={items} />

      {baseRows.length > 0 && (
        <div data-testid="base-activity">
          <h2>Base Sepolia</h2>
          <ul className="pc-activity-list">
            {baseRows.map((x, index) => (
              <li key={x.id ?? `base-${index}`} className="pc-row">
                <span className="pc-network-badge">Base Sepolia</span>
                <div>
                  <div>
                    {x.direction === 'in' ? 'Received' : 'Sent'} {baseAssetCode(x)}
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
                    {formatBaseAmount(x)}
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
