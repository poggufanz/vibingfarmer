// frontend/src/wallet/ui/WalletOnboarding.jsx
// VF Wallet Task 9 -- rebuilds onboarding and account choice around human consequences.
//
// This component is a PURE presentational router: it holds no state of its own (no useState/
// useEffect/useReducer/useContext anywhere in this file) and every prop it accepts is a primitive
// (string/boolean/function) or the public account-summary shape activeAccount.js already produces
// (id/address/kind/signer/network/version -- never secret material). It cannot accumulate, cache,
// or leak a seed phrase/private key/session key because it has nowhere to put one: `mnemonic` and
// `publicKey` pass straight through, unread and untransformed, from the caller's own transient
// state (popup.jsx's existing useState, per controller.js's show-once discipline) to
// BackupScreen/UnlockScreen -- never touching a new shared store, log, or DOM attribute here.
//
// Recomposes the already-tested classic controllers (classicAccount.js/controller.js, via their
// existing screen components) and the passkey controller (account.js, via the callbacks popup.jsx
// still owns) -- CreateScreen/ImportScreen/BackupScreen/UnlockScreen keep their own key-generation/
// import/backup wiring untouched; this file only supplies the shared shell (WalletShell), the
// Standard/Passkey branch (OnboardingScreen, repurposed), and the account picker (AccountPicker).
import { WalletShell } from './WalletShell.jsx'
import { AccountPicker } from './AccountPicker.jsx'
import { HonestyLabels } from './HonestyLabels.jsx'
import OnboardingScreen from './classic/OnboardingScreen.jsx'
import CreateScreen from './classic/CreateScreen.jsx'
import ImportScreen from './classic/ImportScreen.jsx'
import BackupScreen from './classic/BackupScreen.jsx'
import UnlockScreen from './classic/UnlockScreen.jsx'

const HEADING = {
  choose: 'Create or restore a wallet',
  'select-account': 'Choose an account',
  'standard-create': 'Create a Standard wallet',
  'standard-import': 'Restore a Standard wallet',
  'standard-backup': 'Save your recovery phrase',
  'standard-unlock': 'Unlock your wallet',
  'passkey-choose': 'Create or connect a Passkey wallet',
  'passkey-creating': 'Setting up your wallet',
}

export function WalletOnboarding(props) {
  const { view, status = null, account = null } = props
  const heading = HEADING[view] ?? ''

  if (view === 'select-account') {
    return (
      <WalletShell heading={heading} status={status} account={account}>
        <p className="pc-route-intro">
          More than one wallet is set up on this device. Pick which one to use.
        </p>
        <AccountPicker accounts={props.accounts} onSelect={props.onSelectAccount} />
      </WalletShell>
    )
  }

  if (view === 'standard-create') {
    return (
      <WalletShell
        heading={heading}
        onBack={props.onBack}
        status={status}
        account={account}
        critical
      >
        <CreateScreen
          busy={props.createBusy}
          error={props.createError}
          onCreate={props.onCreate}
          onGoImport={props.onGoImport}
        />
      </WalletShell>
    )
  }

  if (view === 'standard-import') {
    return (
      <WalletShell
        heading={heading}
        onBack={props.onBack}
        status={status}
        account={account}
        critical
      >
        <ImportScreen busy={props.importBusy} error={props.importError} onImport={props.onImport} />
      </WalletShell>
    )
  }

  if (view === 'standard-backup') {
    return (
      <WalletShell heading={heading} status={status} account={account} critical>
        <BackupScreen
          mnemonic={props.mnemonic}
          indices={props.indices}
          error={props.backupError}
          onConfirm={props.onConfirmBackup}
          onSkip={props.onSkipBackup}
        />
      </WalletShell>
    )
  }

  if (view === 'standard-unlock') {
    return (
      <WalletShell heading={heading} status={status} account={account} critical>
        <UnlockScreen
          publicKey={props.publicKey}
          busy={props.unlockBusy}
          error={props.unlockError}
          onUnlock={props.onUnlock}
        />
      </WalletShell>
    )
  }

  if (view === 'passkey-choose') {
    return (
      <WalletShell heading={heading} onBack={props.onBack} status={status} account={account}>
        <p className="pc-route-intro">
          Unlock with your device or password-manager passkey — Face ID, fingerprint, Windows Hello,
          or a synced passkey — instead of a password. This creates a smart contract account on
          Stellar testnet (its address starts with C) controlled by that passkey.
        </p>
        <p className="pc-route-intro">
          Honest limit: if you ever lose access to every device holding this passkey, this wallet
          cannot be recovered unless you set up additional recovery first.
        </p>
        {props.passkeyError && <p className="pc-field-error">{props.passkeyError}</p>}
        <button
          type="button"
          className="pc-button pc-button--primary"
          onClick={props.onCreatePasskey}
        >
          Create new wallet
        </button>
        <button
          type="button"
          className="pc-button pc-button--secondary"
          onClick={props.onConnectPasskey}
        >
          Connect an existing wallet
        </button>
        <HonestyLabels scope="global" />
      </WalletShell>
    )
  }

  if (view === 'passkey-creating') {
    return (
      <WalletShell
        heading={heading}
        status={status ?? { tone: 'info', message: 'Approve the passkey prompt if asked.' }}
        account={account}
        critical
      >
        <p className="pc-route-intro">Creating the passkey and funding it on Stellar testnet.</p>
      </WalletShell>
    )
  }

  // 'choose' -- the first screen: Standard vs Passkey, before any backup/recovery copy diverges.
  return (
    <WalletShell heading={heading} status={status} account={account}>
      <OnboardingScreen
        onChooseStandard={props.onChooseStandard}
        onChoosePasskey={props.onChoosePasskey}
      />
    </WalletShell>
  )
}
