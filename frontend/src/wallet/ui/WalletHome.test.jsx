// frontend/src/wallet/ui/WalletHome.test.jsx
// VF Wallet Task 10, Step 1 -- money-first Home, account-agnostic. WalletHome wires
// WalletShell (account chip + "Stellar testnet" text + the beginner Home/Activity/Settings nav)
// around the shared classic/HomeScreen.jsx widget (money-truth/action-gating behavior is
// exhaustively covered by HomeScreen.test.jsx; this file only checks the WIRING: the right props
// reach HomeScreen, the shell/nav/security-state render correctly around it).
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { WalletHome } from './WalletHome.jsx'

afterEach(cleanup)

const G_ACCOUNT = {
  kind: 'G',
  address: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXY',
}
const C_ACCOUNT = {
  kind: 'C',
  address: 'CZYXWVUTSRQPONMLKJIHGFEDCBA234567ZYXWVUTSRQPONMLKJIHGFEDCB',
}

describe('WalletHome — shell wiring', () => {
  it('shows the active account type + shortened address and the Stellar testnet text', () => {
    render(<WalletHome account={G_ACCOUNT} onNav={() => {}} />)
    expect(screen.getByText('Stellar testnet')).toBeTruthy()
    const chip = screen.getByTestId('wallet-account-chip')
    expect(chip.textContent).toContain('Standard')
    expect(chip.textContent).toContain('GABCDE')
  })

  it('renders exactly the Home/Activity/Settings nav with Home current', () => {
    render(<WalletHome account={G_ACCOUNT} onNav={() => {}} />)
    const bar = screen.getByRole('navigation')
    expect(
      within(bar)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['Home', 'Activity', 'Settings'])
    expect(within(bar).getByText('Home').getAttribute('aria-current')).toBe('page')
  })

  it('fires onNav with the tapped tab id', () => {
    const onNav = vi.fn()
    render(<WalletHome account={G_ACCOUNT} onNav={onNav} />)
    fireEvent.click(screen.getByText('Activity'))
    expect(onNav).toHaveBeenCalledWith('activity')
  })

  it('shows a Passkey account correctly', () => {
    render(<WalletHome account={C_ACCOUNT} onNav={() => {}} />)
    expect(screen.getByTestId('wallet-account-chip').textContent).toContain('Passkey')
  })

  it('keeps an unreadable Passkey balance unavailable and hides unsupported Send', () => {
    render(
      <WalletHome account={C_ACCOUNT} onNav={() => {}} portfolio={null} onReceive={() => {}} />
    )
    expect(screen.getByText(/unavailable/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^send$/i })).toBeNull()
    expect(screen.getByText(/send is not available yet/i)).toBeTruthy()
  })
})

describe('WalletHome — security/lock state', () => {
  it('renders the caller-supplied security label', () => {
    render(<WalletHome account={G_ACCOUNT} onNav={() => {}} securityLabel="Locked" />)
    expect(screen.getByTestId('wallet-security-state').textContent).toBe('Locked')
  })

  it('defaults to Unlocked when no label is supplied', () => {
    render(<WalletHome account={G_ACCOUNT} onNav={() => {}} />)
    expect(screen.getByTestId('wallet-security-state').textContent).toBe('Unlocked')
  })
})

describe('WalletHome — delegates money-first content to HomeScreen', () => {
  it('shows Unavailable (not a coerced zero) when the portfolio read failed', () => {
    render(<WalletHome account={G_ACCOUNT} onNav={() => {}} portfolio={null} />)
    expect(screen.getByText('Unavailable')).toBeTruthy()
  })

  it('renders the confirmed total when the portfolio is known and complete', () => {
    render(
      <WalletHome
        account={G_ACCOUNT}
        onNav={() => {}}
        portfolio={{ total: 12, complete: true, rows: [] }}
      />
    )
    expect(screen.getByText('$12.00')).toBeTruthy()
  })

  it('wires onSend/onReceive through to the Home actions', () => {
    const onSend = vi.fn()
    const onReceive = vi.fn()
    render(
      <WalletHome account={G_ACCOUNT} onNav={() => {}} onSend={onSend} onReceive={onReceive} />
    )
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^receive$/i }))
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onReceive).toHaveBeenCalledTimes(1)
  })

  it('does not offer Add asset when the caller has no real support for this account (no dead button)', () => {
    render(<WalletHome account={C_ACCOUNT} onNav={() => {}} />)
    expect(screen.queryByRole('button', { name: /add asset/i })).toBeNull()
  })

  it('offers Add asset when the caller supplies real support', () => {
    render(<WalletHome account={G_ACCOUNT} onNav={() => {}} onAddAsset={() => {}} />)
    expect(screen.getByRole('button', { name: /add asset/i })).toBeTruthy()
  })

  it('renders extra children after the Home content (e.g. HonestyLabels)', () => {
    render(
      <WalletHome account={G_ACCOUNT} onNav={() => {}}>
        <p data-testid="extra">extra disclosure</p>
      </WalletHome>
    )
    expect(screen.getByTestId('extra')).toBeTruthy()
  })
})
