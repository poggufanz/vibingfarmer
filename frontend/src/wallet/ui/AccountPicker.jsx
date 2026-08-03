// frontend/src/wallet/ui/AccountPicker.jsx
// VF Wallet Task 9. Renders the account choice presented when activeAccount.js's
// resolveActiveAccount returns { status: 'selection-required', accounts } (activeAccount.js:114)
// -- at most two possible entries, the oldest classic (G) wallet and the cached passkey (C)
// wallet (activeAccount.js:29-49, accountShape at :21-23). `accounts` is passed straight through
// from that resolution: only the public { version, id, network, address, kind, signer } shape
// ever exists on this object -- there is no field here that could carry a seed phrase, private
// key, or session key, so this component structurally cannot receive secret material even by
// mistake, and it renders exactly what it is given (no derived/cached copy of its own).
export function AccountPicker({ accounts, onSelect }) {
  return (
    <ul className="pc-account-picker" data-testid="account-picker">
      {accounts.map((account) => (
        <li key={account.id} className="pc-row">
          <span>{account.kind === 'C' ? 'Passkey' : 'Standard'}</span>
          <span className="pc-technical">
            {account.address.slice(0, 6)}…{account.address.slice(-4)}
          </span>
          <button
            type="button"
            className="pc-button pc-button--primary"
            onClick={() => onSelect(account)}
          >
            Use this wallet
          </button>
        </li>
      ))}
    </ul>
  )
}
