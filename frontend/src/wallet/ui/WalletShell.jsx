// Shared VF Wallet shell. The popup document owns its visual contract through wallet.css.

const TAB_ICONS = {
  home: (
    <>
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </>
  ),
  activity: <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
}

export function WalletShell({
  heading,
  headingHidden = false,
  children,
  account = null,
  onBack = null,
  backLabel = 'Back',
  status = null,
  critical = false,
  nav = null,
}) {
  return (
    <div className="pc-wallet" data-pocket-critical={critical ? '' : undefined}>
      <div className="pc-wallet-shell">
        <header className="pc-wallet-header">
          <span className="pc-brand-lockup pc-brand-lockup--compact">
            <img src="./vibing_farmer.logo.svg" alt="" />
            VF Wallet
          </span>
          <span className="pc-network-badge">Stellar testnet</span>
        </header>
        <main className="pc-wallet-main">
          {onBack && (
            <button
              type="button"
              className="pc-button pc-button--secondary pc-wallet-back"
              onClick={onBack}
            >
              {backLabel}
            </button>
          )}
          {account && (
            <p className="pc-wallet-account-chip" data-testid="wallet-account-chip">
              {account.kind === 'C' ? 'Passkey' : 'Standard'} ·{' '}
              <span className="pc-technical">
                {account.address.slice(0, 6)}…{account.address.slice(-4)}
              </span>
            </p>
          )}
          <h1 className={headingHidden ? 'pc-visually-hidden' : undefined}>{heading}</h1>
          {children}
          <p
            role="status"
            aria-live="polite"
            className="pc-wallet-status"
            data-tone={status?.tone ?? 'info'}
          >
            {status?.message ?? ''}
          </p>
        </main>
        {nav && (
          <nav className="pc-wallet-nav" aria-label="Wallet">
            {nav.tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className="pc-wallet-tab"
                aria-current={tab.id === nav.active ? 'page' : undefined}
                onClick={() => nav.onNav(tab.id)}
              >
                {TAB_ICONS[tab.id] && (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    {TAB_ICONS[tab.id]}
                  </svg>
                )}
                {tab.label}
              </button>
            ))}
          </nav>
        )}
      </div>
    </div>
  )
}
