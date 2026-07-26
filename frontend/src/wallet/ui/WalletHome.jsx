// frontend/src/wallet/ui/WalletHome.jsx
// VF Wallet Task 10, Step 1 -- money-first Home, account-agnostic. Wires the shared WalletShell
// (account chip, "Stellar testnet" text, the beginner Home/Activity/Settings bottom nav -- see
// WalletShell.jsx's own header for why that nav lives there and not here) around
// classic/HomeScreen.jsx, which now does the actual balance/asset-row/action rendering for BOTH
// account kinds (money-truth and action-gating behavior belong to HomeScreen.test.jsx; this file
// only wires props through and adds the one thing HomeScreen has no opinion on: security/lock
// state).
//
// `securityLabel` is a caller-supplied STRING, not a boolean this component interprets -- popup.jsx
// (the composition root, which owns cw.unlocked for Standard accounts and knows a Passkey account
// has no persistent lock state at all) decides what the honest label is ("Locked", "Unlocked",
// "Secured by Face ID", ...). Keeping the decision at the composition root means this component
// never has to guess account-kind-specific security semantics it doesn't own.
import { WalletShell } from './WalletShell.jsx'
import HomeScreen from './classic/HomeScreen.jsx'

const NAV_TABS = [
  { id: 'home', label: 'Home' },
  { id: 'activity', label: 'Activity' },
  { id: 'settings', label: 'Settings' },
]

export function WalletHome({
  account,
  onNav,
  status = null,
  securityLabel = 'Unlocked',
  portfolio = null,
  unfunded = false,
  busy = false,
  onSend,
  onReceive,
  onAddAsset,
  onFund,
  onGetUsdc,
  children = null,
}) {
  return (
    <WalletShell
      heading="Home"
      account={account}
      status={status}
      nav={{ tabs: NAV_TABS, active: 'home', onNav }}
    >
      <p className="pc-field-help" data-testid="wallet-security-state">
        {securityLabel}
      </p>
      <HomeScreen
        publicKey={account.address}
        portfolio={portfolio}
        unfunded={unfunded}
        busy={busy}
        onSend={onSend}
        onReceive={onReceive}
        onAddAsset={onAddAsset}
        onFund={onFund}
        onGetUsdc={onGetUsdc}
      />
      {children}
    </WalletShell>
  )
}
