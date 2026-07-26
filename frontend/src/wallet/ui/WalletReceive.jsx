// frontend/src/wallet/ui/WalletReceive.jsx
// VF Wallet Task 10, Step 2 -- Receive is a Home ACTION (a Back control back to Home), not a
// bottom-nav tab, so this wraps WalletShell without `nav` -- the same pattern
// WalletOnboarding.jsx already uses for its own back-able screens. Account type + shortened
// address come from WalletShell's own account chip; classic/ReceiveScreen.jsx supplies the
// QR/full-address/copy-confirmation content, reused for both account kinds (receiving works
// identically regardless of signer).
import { WalletShell } from './WalletShell.jsx'
import ReceiveScreen from './classic/ReceiveScreen.jsx'

export function WalletReceive({ account, onBack, status = null }) {
  return (
    <WalletShell heading="Receive" account={account} onBack={onBack} status={status}>
      <ReceiveScreen publicKey={account.address} />
    </WalletShell>
  )
}
