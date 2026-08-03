// frontend/src/wallet/ui/WalletReceive.test.jsx
// VF Wallet Task 10, Step 2 -- Receive renders address/QR/account type and copy confirmation.
// Reached as an ACTION from Home (a Back control, not a bottom-nav tab -- the beginner nav is
// exactly Home/Activity/Settings), so this wraps WalletShell WITHOUT `nav`, the same pattern
// WalletOnboarding.jsx already uses for its own back-able screens.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WalletReceive } from './WalletReceive.jsx'

afterEach(cleanup)

const G_ACCOUNT = {
  kind: 'G',
  address: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXY',
}

describe('WalletReceive', () => {
  it('shows the account type + shortened address and the Stellar testnet text', () => {
    render(<WalletReceive account={G_ACCOUNT} onBack={() => {}} />)
    expect(screen.getByText('Stellar testnet')).toBeTruthy()
    const chip = screen.getByTestId('wallet-account-chip')
    expect(chip.textContent).toContain('Standard')
    expect(chip.textContent).toContain('GABCDE')
  })

  it('fires onBack exactly once per click', () => {
    const onBack = vi.fn()
    render(<WalletReceive account={G_ACCOUNT} onBack={onBack} />)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('renders no bottom nav (Receive is a Home action, not a nav tab)', () => {
    render(<WalletReceive account={G_ACCOUNT} onBack={() => {}} />)
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('shows the full address as technical text and offers a copy confirmation', async () => {
    render(<WalletReceive account={G_ACCOUNT} onBack={() => {}} />)
    expect(screen.getByTestId('receive-address').textContent).toBe(G_ACCOUNT.address)
    const copyButton = screen.getByRole('button', { name: /copy address/i })
    fireEvent.click(copyButton)
    expect(await screen.findByText(/copied to clipboard/i)).toBeTruthy()
  })

  // VF Wallet Task 10 -- real-browser 320px measurement (getBoundingClientRect, not a screenshot
  // alone) found this exact regression: the full 56-59 char address has no natural break point, so
  // without a word-break rule it forced the whole WalletShell CSS-grid column (header and nav
  // included) past the fixed 320/360px box, defeating `.pc-wallet`'s own overflow-x: clip (clip
  // hides the paint, not the grid track's content-based sizing). jsdom does no layout, so this
  // cannot re-run the geometry check itself -- it pins the CSS class carrying the fix instead, and
  // is mutation-provable: dropping the class from ReceiveScreen.jsx reproduces the exact reported
  // bug in a real browser and turns this red.
  it('marks the full address to break/wrap instead of forcing the shell wider (320px overflow fix)', () => {
    render(<WalletReceive account={G_ACCOUNT} onBack={() => {}} />)
    expect(screen.getByTestId('receive-address').className).toContain('pc-address-full')
  })
})
