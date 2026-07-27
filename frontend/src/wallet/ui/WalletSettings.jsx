// frontend/src/wallet/ui/WalletSettings.jsx
// VF Wallet Task 11 -- money-first Settings, account-agnostic. Wires the shared WalletShell
// (account chip, "Stellar testnet" text, the beginner Home/Activity/Settings bottom nav) around
// classic/SettingsScreen.jsx (rendered only for the Standard/G account model -- Passkey has no
// password/lock state to manage, so no dead Lock/auto-lock/reset controls are ever offered to it),
// plus the pieces every account model shares: an account-switch link, the Base testnet mandate
// summary, a link to Advanced/Testnet, and the app-wide honesty labels.
//
// THE CENTRAL TRUTH REQUIREMENT THIS FILE EXISTS TO HONOR (VF Wallet Task 11 brief): the extension
// must not claim locally synchronized Base mandate status or a working revoke control here,
// because it has no authoritative web-storage/relayer channel -- baseBinding.js's owner/mandate
// records live in the WEB APP's window.localStorage (a different origin than this
// chrome-extension:// popup can read) and the relayer's mandate store is reachable only from the
// web app's own request flow, never from this extension. So this component renders NO status
// value (no "active"/"expired"/"revoked" claim, because it has no read path to know), and NO
// revoke button (because it has no write path to act on one) -- only a link out, in prose that
// says outright why setup/status/revoke all happen elsewhere and that nothing here can create or
// revoke anything on its own. This is the same fail-closed rule VFW9's Base stop-access
// (Stellar-only) and MM12's no-dead-Base-button already established for this wave; see
// StopAccessDialog.jsx's own `baseStopAccess.available === false` branch for the sibling case in
// the main app.
//
// The revoke description below also does not claim universal key destruction (VF Wallet Task 7's
// `POST /mandate/revoke`, relayer/src/httpRouter.mjs's REVOKE_NOTE constant): the relayer deletes
// only its OWN copy of the session key and says so explicitly -- the stellarOwner<->kernelAddress
// binding is an application/relayer association, not a cryptographic one, so if a copy of the key
// exists elsewhere the on-chain expiry timestamp remains the real worst-case bound, not an
// assumption that the key is gone from existence. Restating that "revoke destroys the key
// everywhere" here would be a claim this extension (and, per Task 7's own design, the relayer
// itself) cannot back up.
import { WalletShell } from './WalletShell.jsx'
import SettingsScreen from './classic/SettingsScreen.jsx'
import { HonestyLabels } from './HonestyLabels.jsx'

const NAV_TABS = [
  { id: 'home', label: 'Home' },
  { id: 'activity', label: 'Activity' },
  { id: 'settings', label: 'Settings' },
]

// README.md's own live-app link (the same origin extension/vite.config.extension.js defaults
// VF_API_BASE to) -- not a new constant invented for this task, the app's one canonical web
// origin.
const VF_WEB_APP_URL = 'https://vibing-farmer.pages.dev'

export function WalletSettings({
  account,
  onNav,
  status = null,
  securityLabel = null,
  autoLockMin,
  onSetAutoLock,
  onLock,
  onExport,
  onReset,
  onSwitchAccount = null,
  switchLabel = 'Switch wallet',
  onOpenAdvanced,
  children = null,
}) {
  return (
    <WalletShell
      heading="Settings"
      account={account}
      status={status}
      nav={{ tabs: NAV_TABS, active: 'settings', onNav }}
    >
      {securityLabel && (
        <p className="pc-field-help" data-testid="wallet-security-state">
          {securityLabel}
        </p>
      )}

      {/* Standard (G) only -- Passkey has no lock/password/reset-by-password model at all, so
          none of these controls are offered to it (no dead button; fail closed, the same rule
          WalletHome.jsx already applies to onAddAsset/onFund). */}
      {account?.kind === 'G' && onLock && (
        <SettingsScreen
          onLock={onLock}
          onExport={onExport}
          onReset={onReset}
          autoLockMin={autoLockMin}
          onSetAutoLock={onSetAutoLock}
        />
      )}

      {onSwitchAccount && (
        <button type="button" className="pc-button pc-button--secondary" onClick={onSwitchAccount}>
          {switchLabel}
        </button>
      )}

      <div className="pc-support" data-testid="base-mandate-summary">
        <h2>Base testnet mandate</h2>
        <p className="pc-field-help">
          Setting up, checking the status of, and revoking a Base testnet mandate all happen in the
          Vibing Farmer web app, not here. This extension has no synced copy of that status and no
          working revoke control for it -- it has no direct line to the web app&rsquo;s storage or
          to the relayer that actually holds the mandate. Leaving this extension open or closed does
          not create or revoke anything on its own.
        </p>
        <p className="pc-field-help">
          The web app shows your connected Stellar identity, the associated Base kernel, the
          relayer, the allowlisted calls and pools, the 10,000-USDC per-call (non-cumulative) cap,
          the seven-day expiry, the available-balance bound, and who custodies the session key.
          Revoking there deletes the relayer&rsquo;s own copy of that key; it does not guarantee the
          key is destroyed everywhere, and it is not the same as resetting this wallet.
        </p>
        {/* NOT .pc-button -- that class hard-codes `white-space: nowrap` + `min-width:
            max-content` (a deliberate contract choice for short button labels), which this
            37-character required-verbatim link text blows straight through at 320px (measured:
            .pc-wallet's own scrollWidth reached 350px with it as a button -- see the task report).
            .pc-field-help wraps normally like any other prose link, the same convention
            WalletActivity.jsx's/classic/HistoryScreen.jsx's "View" explorer links already use.
            VFW14 fix round 1 (owner decision #42): the de-blinded 44px sweep now measures every
            interactive element regardless of `display`, including this one -- a plain
            `display: inline` text run is genuinely 17px tall (line-height only), failing the
            touch-target guideline the coarse-pointer contract rule intends. Fixed here, not by
            widening the guard's exemption: `display: flex` (a block-level box, same as any
            `.pc-button`) with `min-height: var(--pc-touch-target)` gives the link a real 44px tap
            area while keeping `white-space` at its normal default -- the text still wraps freely
            at 320px, so the overflow this link was originally written to dodge does not return. */}
        <a
          className="pc-field-help"
          href={VF_WEB_APP_URL}
          target="_blank"
          rel="noreferrer"
          style={{ display: 'flex', alignItems: 'center', minHeight: 'var(--pc-touch-target)' }}
        >
          Manage Base testnet in Vibing Farmer
        </a>
      </div>

      <button type="button" className="pc-button pc-button--secondary" onClick={onOpenAdvanced}>
        Advanced / Testnet tools
      </button>

      <HonestyLabels scope="global" />

      <p className="pc-field-help">
        Vibing Farmer — Stellar testnet proof of concept. Not audited. Not for real funds.
      </p>

      {children}
    </WalletShell>
  )
}
